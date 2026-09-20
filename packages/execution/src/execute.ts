import { buildOrder, integer, OrderValidationError, validateBook } from './order.js';
import { assertReservation } from './reserve.js';
import type {
  Authorization, ConfirmedFill, ExecutionDeps, ExecutionRecord, ExecutionResult, LegRecord,
  OrderAttempt, OrderResolution, Position, SelectedQuote, MarketBook,
} from './types.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function fills(leg: LegRecord): ConfirmedFill[] {
  return [...(leg.buy?.fills ?? []), ...leg.unwinds.flatMap(order => order.fills)];
}
function heldShares(leg: LegRecord): number {
  return fills(leg).reduce((sum, fill) => sum + (fill.side === 'BUY' ? fill.sharesMicros : -fill.sharesMicros), 0);
}
function inventory(record: ExecutionRecord): Position[] {
  return record.legs.flatMap(leg => {
    const sharesMicros = heldShares(leg);
    return sharesMicros > 0 ? [{ tokenId: leg.leg.tokenId, conditionId: leg.leg.conditionId,
      outcome: leg.leg.outcome, sharesMicros }] : [];
  });
}
function spend(record: ExecutionRecord, buysOnly = false): number {
  return record.legs.flatMap(fills).reduce((sum, fill) => sum +
    (fill.side === 'BUY' ? fill.cashMicros : buysOnly ? 0 : -fill.cashMicros), 0);
}
function result(record: ExecutionRecord, reason?: string): ExecutionResult {
  const kind = record.status === 'complete' ? 'complete' : record.status === 'unwound' ? 'unwound'
    : record.status === 'stuck' ? 'partial' : record.status === 'rejected' ? 'rejected' : 'pending';
  const explanation = reason ?? record.reason;
  return { kind, record, held: inventory(record), netSpendMicros: spend(record),
    ...(record.authorizationViolation === undefined ? {} : { authorizationViolation: record.authorizationViolation }),
    ...(explanation === undefined ? {} : { reason: explanation }) };
}
function validate(quote: SelectedQuote, authorization: Authorization): void {
  if (!authorization.id || !authorization.wallet || !quote.hash || authorization.quoteHash !== quote.hash) {
    throw new OrderValidationError('Authorization does not identify the selected quote and wallet');
  }
  integer(authorization.maxSpendMicros, 'maximum spend');
  integer(authorization.maxUnwindLossMicros, 'maximum unwind loss');
  integer(authorization.maxUnwindAttempts, 'maximum unwind attempts');
  integer(authorization.slippageBps, 'slippage');
  if (authorization.slippageBps > 10_000 || !Number.isFinite(Date.parse(authorization.expiresAt))) {
    throw new OrderValidationError('Invalid authorization limits');
  }
  if (quote.legs.length === 0) throw new OrderValidationError('Cannot execute an empty basket');
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const leg of quote.legs) {
    if (!leg.id || !leg.tokenId || !leg.conditionId || ids.has(leg.id) || tokens.has(leg.tokenId)) {
      throw new OrderValidationError('Basket legs must have unique IDs and token IDs');
    }
    if (leg.outcome !== 'YES' && leg.outcome !== 'NO') throw new OrderValidationError('Invalid outcome');
    integer(leg.sharesMicros, 'leg quantity', false);
    integer(leg.referencePriceMicros, 'reference price', false);
    ids.add(leg.id); tokens.add(leg.tokenId);
  }
}

/** Reject malformed settlement evidence without dropping the uncertain order. */
function validateFills(attempt: OrderAttempt, confirmed: ConfirmedFill[]): void {
  if (confirmed.length === 0) throw new Error('Confirmed order has no fill evidence');
  const ids = new Set<string>();
  for (const fill of confirmed) {
    if (!fill.id || !fill.transactionHash || ids.has(fill.id) || fill.orderId !== attempt.envelope.orderId ||
      fill.tokenId !== attempt.intent.tokenId || fill.conditionId !== attempt.intent.conditionId ||
      fill.outcome !== attempt.intent.outcome || fill.side !== attempt.intent.side) {
      throw new Error('Settlement evidence does not match the persisted order');
    }
    integer(fill.sharesMicros, 'confirmed shares', false);
    integer(fill.cashMicros, 'confirmed cash'); integer(fill.feeMicros, 'confirmed fee');
    ids.add(fill.id);
  }
  const shares = confirmed.reduce((sum, fill) => integer(sum + fill.sharesMicros, 'total confirmed shares'), 0);
  if (shares > attempt.intent.sharesMicros) throw new Error('Confirmed quantity exceeds the signed order');
}

/**
 * Advances a durable basket until completed or external progress is required.
 * Calling again with the same confirmation reconciles first; it never creates
 * another buy for an order whose submission or settlement is uncertain.
 */
export async function execute(quote: SelectedQuote, authorization: Authorization, deps: ExecutionDeps): Promise<ExecutionResult> {
  validate(quote, authorization);
  return deps.journal.withWalletLock(authorization.wallet, async () => {
    let record = await deps.journal.load(authorization.id);
    if (record !== null) {
      if (stable(record.authorization) !== stable(authorization) || stable(record.quote) !== stable(quote)) {
        throw new OrderValidationError('Confirmation ID already belongs to a different quote or authorization');
      }
    } else {
      const timestamp = deps.now().toISOString();
      record = { id: authorization.id, revision: 0, authorization: structuredClone(authorization),
        quote: structuredClone(quote), status: 'buying',
        legs: quote.legs.map(leg => ({ leg: structuredClone(leg), unwinds: [] })),
        createdAt: timestamp, updatedAt: timestamp };
      await deps.journal.create(record);
    }
    const r = record;
    const save = async (): Promise<void> => {
      const revision = r.revision;
      r.revision += 1;
      r.updatedAt = deps.now().toISOString();
      await deps.journal.save(r, revision);
    };
    const finish = async (status: ExecutionRecord['status'], reason?: string): Promise<ExecutionResult> => {
      r.status = status;
      if (reason !== undefined) r.reason = reason;
      await save();
      return result(r);
    };
    const recover = async (reason: string): Promise<void> => {
      r.status = inventory(r).length === 0 ? 'rejected' : 'unwinding';
      r.reason = reason;
      await save();
    };
    const settle = async (attempt: OrderAttempt, resolution: OrderResolution): Promise<void> => {
      if (resolution.kind === 'confirmed') {
        try {
          validateFills(attempt, resolution.fills);
        } catch (error) {
          attempt.state = 'unknown';
          attempt.reason = error instanceof Error ? error.message : 'Invalid fill evidence';
          await save();
          return;
        }
        attempt.fills = resolution.fills;
        attempt.state = 'confirmed';
        if (attempt.intent.side === 'SELL') {
          const proceeds = resolution.fills.reduce((sum, fill) => sum + fill.cashMicros, 0);
          const fullyUnwound = inventory(r).length === 0;
          const violations: string[] = [];
          if (proceeds < attempt.intent.maxCashMicros) {
            violations.push(`Confirmed SELL proceeds ${proceeds} are below authorized minimum ${attempt.intent.maxCashMicros} micros`);
          }
          if (fullyUnwound && spend(r) > authorization.maxUnwindLossMicros) {
            violations.push(`Actual unwind loss ${spend(r)} exceeds authorized maximum ${authorization.maxUnwindLossMicros} micros`);
          }
          if (violations.length) {
            // These fills already happened. Preserve them and halt, rather than retrying
            // an anomalous sell or implying its actual proceeds satisfied authorization.
            r.authorizationViolation = violations.join('; ');
            r.reason = r.authorizationViolation;
            r.status = fullyUnwound ? 'unwound' : 'stuck';
          }
        }
      } else {
        attempt.state = resolution.kind;
        attempt.reason = resolution.reason;
      }
      await save();
    };
    const active = (): OrderAttempt | undefined => r.legs.flatMap(leg => [...(leg.buy ? [leg.buy] : []), ...leg.unwinds])
      .find(attempt => attempt.state === 'unknown' || attempt.state === 'pending');
    const submit = async (leg: LegRecord, intent: OrderAttempt['intent']): Promise<OrderAttempt> => {
      const envelope = await deps.venue.prepare(authorization.wallet, intent);
      if (!envelope.orderId) throw new Error('Signer did not return an order ID');
      const attempt: OrderAttempt = { intent, envelope, state: 'unknown', fills: [] };
      if (intent.side === 'BUY') leg.buy = attempt;
      else leg.unwinds.push(attempt);
      // Persist signature, order hash and unknown status before any network submission.
      await save();
      if (deps.now().getTime() >= Date.parse(authorization.expiresAt)) {
        await settle(attempt, { kind: 'failed', reason: 'Authorization expired before submission; signed order was not submitted' });
        return attempt;
      }
      let resolution: OrderResolution;
      try { resolution = await deps.venue.post(authorization.wallet, envelope); }
      catch { resolution = { kind: 'unknown', reason: 'Submission outcome unknown; reconciliation required' }; }
      await settle(attempt, resolution);
      return attempt;
    };
    const terminal = (): boolean => ['complete', 'unwound', 'stuck', 'rejected'].includes(r.status);
    if (terminal()) return result(r);

    const unresolved = active();
    if (unresolved !== undefined) {
      let resolution: OrderResolution;
      try { resolution = await deps.venue.reconcile(authorization.wallet, unresolved.envelope); }
      catch { return result(r, 'Reconciliation unavailable; the existing order remains uncertain'); }
      await settle(unresolved, resolution);
      if (active()) return result(r, unresolved.reason);
    }

    const maxAge = deps.maxBookAgeMs ?? 10_000;
    while (!terminal()) {
      // Inspect settled buy results before starting any new trade.
      if (r.status === 'buying') {
        const failed = r.legs.find(leg => leg.buy?.state === 'failed' || (leg.buy?.state === 'confirmed' &&
          (heldShares(leg) !== leg.leg.sharesMicros || leg.buy.fills.reduce((sum, fill) => sum + fill.cashMicros, 0) > leg.buy.intent.maxCashMicros)));
        if (failed) { await recover(failed.buy?.reason ?? 'Confirmed fill differs from the authorized FOK order'); continue; }
        if (r.legs.every(leg => leg.buy?.state === 'confirmed')) return finish('complete');
      }
      if (r.status === 'unwinding' && inventory(r).length === 0) return finish('unwound');
      if (deps.now().getTime() >= Date.parse(authorization.expiresAt)) {
        return finish(inventory(r).length ? 'stuck' : 'rejected', 'Execution authorization expired');
      }
      let state;
      try { state = await deps.venue.state(authorization.wallet); }
      catch { return result(r, 'Venue state unavailable; execution paused'); }
      if (!state.sessionValid || !state.approvalsReady) return result(r, 'Wallet session or approvals are not ready');
      // Cancel-only cannot submit a SELL either. Wait, without pretending unwind is available.
      if (state.mode !== 'open') return result(r, `Venue is ${state.mode}; no new orders submitted`);

      if (r.status === 'buying') {
        const remaining = r.legs.filter(leg => leg.buy === undefined);
        let plans: { leg: LegRecord; book: MarketBook; intent: OrderAttempt['intent']; depth: number }[];
        try {
          plans = await Promise.all(remaining.map(async leg => {
            const book = await deps.venue.book(leg.leg.tokenId);
            const intent = buildOrder(leg.leg, 'BUY', book, authorization.slippageBps, deps.now(), maxAge);
            const depth = book.asks.filter(level => level.priceMicros <= intent.limitPriceMicros)
              .reduce((sum, level) => sum + level.sharesMicros, 0) / leg.leg.sharesMicros;
            return { leg, book, intent, depth };
          }));
          assertReservation(plans.map(plan => plan.intent.maxCashMicros), state.availableCashMicros,
            authorization.maxSpendMicros - spend(r, true));
        } catch (error) {
          if (!(error instanceof OrderValidationError)) return result(r, 'Fresh books unavailable; execution paused');
          await recover(error.message); continue;
        }
        plans.sort((a, b) => a.depth - b.depth || a.leg.leg.id.localeCompare(b.leg.leg.id));
        const next = plans[0]!;
        try { validateBook(next.book, next.leg.leg.tokenId, deps.now(), maxAge); }
        catch (error) { await recover(error instanceof Error ? error.message : 'Book stale'); continue; }
        const attempt = await submit(next.leg, next.intent);
        if (active()) return result(r, attempt.reason);
      } else {
        const held = r.legs.filter(leg => heldShares(leg) > 0);
        if (held.some(leg => leg.unwinds.length >= authorization.maxUnwindAttempts)) {
          return finish('stuck', 'Authorized unwind attempts exhausted');
        }
        let plans: { leg: LegRecord; intent: OrderAttempt['intent'] }[];
        try {
          plans = await Promise.all(held.map(async leg => {
            const book = await deps.venue.book(leg.leg.tokenId);
            // Unwind authorization is a cash-loss bound, not the original buy slippage.
            // Use a one-micro reference and unrestricted SELL slippage to derive depth.
            const intent = buildOrder({ ...leg.leg, sharesMicros: heldShares(leg), referencePriceMicros: 1 },
              'SELL', book, 10_000, deps.now(), maxAge);
            return { leg, intent };
          }));
          const minimumRecovery = plans.reduce((sum, plan) => integer(sum + plan.intent.maxCashMicros, 'minimum recovery'), 0);
          if (spend(r) - minimumRecovery > authorization.maxUnwindLossMicros) {
            return finish('stuck', 'Available unwind exceeds the authorized maximum loss');
          }
        } catch (error) {
          return finish('stuck', error instanceof Error ? error.message : 'Unwind books unavailable');
        }
        const next = plans[0]!;
        const attempt = await submit(next.leg, next.intent);
        if (active()) return result(r, attempt.reason);
      }
    }
    return result(r);
  });
}
