import { createHash } from 'node:crypto';
import {
  buildBasket, buildStateSpace, buildCategoricalStateSpace, dollarsToCents, levelsOf, priceMicros,
  type StateSpace, type Basket, type BookLevel, type Leg, type TargetShape, type TradableItem, type ProtectionGoal,
} from '@polyhedge/core';
import { eventSupport, type EventSelection, type EventSupport, parseLadder, parseLadderLabel, type ClobBook, type GammaEvent } from '@polyhedge/venue';

export class EventQuoteError extends Error {
  constructor(readonly code:'changed'|'unsupported',message:string){super(message);this.name='EventQuoteError';}
}

export interface QuoteRequest {
  eventId: string;
  selection?: EventSelection;
  ruleHash?: string;
  shape: TargetShape;
  budgetUsd?: number;
  /** Extra split points beyond the shape's own levels. */
  extraLevels?: number[];
  /** Over-hedge penalty override, e.g. to request a "shaped" alternative solve. */
  mu?: number;
  protectionGoal?: ProtectionGoal;
  /** Use venue minimum sizes and the execution adapter's quantity precision. */
  execution?: { quantityStep: number; maxLegs?: number };
  /**
   * Human-readable note on how this market's observation moment relates to
   * the user's deadline. Time basis risk, not merely "holding longer".
   */
  observationNote?: string;
}

export interface QuoteMeta {
  /** ISO timestamp. */
  quotedAt: string;
  /** Which calibration produced the inputs. */
  calibrationMapVersion: string;
  /** e.g. "jev-1.13.0" */
  jevModelVersion: string;
  /** What was passed in, so replay reproduces it. */
  ruleFlags: string[];
  correlationResidual: boolean;
}

export interface QuoteRecord {
  version: 1 | 2;
  request: QuoteRequest;
  resolved: {
    domain?: EventSupport;
    evidenceHash?: string;
    items: TradableItem[];
    legs: Leg[];
    feeRates: number[];
    snapshotId: string;
  };
  basket: Basket;
  meta: QuoteMeta;
}

export interface QuoteDeps {
  fetchEvent(id: string): Promise<GammaEvent>;
  fetchBooks(tokenIds: string[]): Promise<ClobBook[]>;
  saveSnapshot(books: ClobBook[]): Promise<string>;
  now?: () => Date;
  /** Server deadline, never accepted as a client quote field. */
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface QuoteOptions {
  ruleFlags?: string[];
  correlationResidual?: boolean;
  calibrationMapVersion?: string;
  jevModelVersion?: string;
}

/** The only place venue's plain numbers become core's branded types. */
function toCoreBook(book: ClobBook | undefined): BookLevel[] {
  return (book?.asks ?? []).map((l) => ({ priceMicros: priceMicros(l.priceMicros), size: l.size }));
}

function executionConstraints(request: QuoteRequest, legs: Leg[], byToken: Map<string, ClobBook>) {
  if (!request.execution) return {};
  const minShares = legs.map(leg => {
    const minimum = byToken.get(leg.tokenId)?.minOrderSize;
    if (minimum === undefined) throw new Error(`book ${leg.tokenId} has no minimum order size; cannot claim an executable quote`);
    return minimum;
  });
  return { execution: { ...request.execution, minShares } };
}

/**
 * Resolve an event into the tradable items and legs a basket is built from.
 * Both YES and NO legs are offered so the solver can take the neg-risk
 * complement when the book prices it better.
 */
function resolveEvent(event: GammaEvent): { items: TradableItem[]; legs: Leg[]; feeRates: number[] } {
  if(event.markets.some(m=>/bps?\s+(decrease|increase|cut|hike)/i.test(m.groupItemTitle) && /rounded up to the nearest 25/.test(m.description))) {
    throw new EventQuoteError('unsupported','This rounded decision market requires explicit outcome losses; use the event picker.');
  }
  if (!event.negRisk) {
    throw new Error(`event ${event.id} is not a neg-risk partition; refusing to quote`);
  }

  // Ordered by the low edge before the ladder is validated: the venue publishes
  // markets in whatever order it likes, and `parseLadder` checks that brackets
  // TILE, which is an ordered property. Sorting first means a correct ladder
  // listed out of order is still priced, while a set with a real hole is still
  // rejected.
  const ordered = event.markets
    .map((m) => ({ market: m, edge: parseLadderLabel(m.groupItemTitle) }))
    .sort((a, b) => {
      if (a.edge === null || b.edge === null) return 0;
      if (a.edge.lo === null) return -1;
      if (b.edge.lo === null) return 1;
      return a.edge.lo - b.edge.lo;
    });

  // One parse for the whole event, not one per market. A bracket title only
  // means something next to its neighbours: `parseLadder` is what establishes
  // that these outcomes partition an axis exactly once, which is the assumption
  // every downstream price depends on.
  const ladder = parseLadder(ordered.map((o) => o.market.groupItemTitle));
  if (ladder === null) {
    throw new Error(
      `event ${event.id} does not publish a numeric ladder its outcomes tile; refusing to quote`,
    );
  }

  const items: TradableItem[] = [];
  const legs: Leg[] = [];
  const feeRates: number[] = [];

  ordered.forEach(({ market: m }, i) => {
    const bracket = ladder.brackets[i];
    if (bracket === undefined) {
      throw new Error(`event ${event.id} ladder lost bracket ${i}`);
    }
    if (m.feeRate === null) {
      throw new Error(`market ${m.id} reports no fee schedule; fee is unknown, not zero`);
    }
    items.push({ key: m.id, bracket: { lo: bracket.lo, hi: bracket.hi } });
    // RULING C: marketId is the venue id; the bracket title is a display label.
    legs.push({ id: `${m.id}_yes`, marketId: m.id, label: m.groupItemTitle, tokenId: m.yesTokenId, side: 'YES', tradableKey: m.id });
    feeRates.push(m.feeRate);
    legs.push({ id: `${m.id}_no`, marketId: m.id, label: m.groupItemTitle, tokenId: m.noTokenId, side: 'NO', tradableKey: m.id });
    feeRates.push(m.feeRate);
  });

  return { items, legs, feeRates };
}

export async function quote(
  request: QuoteRequest,
  deps: QuoteDeps,
  options?: QuoteOptions,
): Promise<QuoteRecord> {
  const checkDeadline=()=>{deps.signal?.throwIfAborted();if(deps.deadlineAt!==undefined && Date.now()>=deps.deadlineAt)throw new Error('quote_deadline');};
  checkDeadline();
  const event = await deps.fetchEvent(request.eventId);
  checkDeadline();
  const domain = request.selection ? eventSupport(event, request.selection) : undefined;
  if(domain && !domain.eligible) throw new EventQuoteError('unsupported',domain.reason ?? 'Unsupported event');
  if(domain && request.ruleHash !== domain.ruleHash)throw new EventQuoteError('changed','Market rules changed; refresh the details and confirm your losses again.');
  const { items, legs, feeRates } = domain && domain.kind !== 'numeric' ? resolveOutcomes(event, domain) : resolveEvent(event);

  const books = await deps.fetchBooks(legs.map((l) => l.tokenId));
  if (domain) {
    const seen = new Set(books.map(b => b.assetId));
    if (seen.size !== books.length || books.length !== legs.length) throw new Error('Incomplete or duplicate books');
    for (const leg of legs) {
      const b = books.find(b => b.assetId === leg.tokenId);
      const o = domain.outcomes.find(o => o.marketId === leg.marketId);
      if (!b || !o || b.market.toLowerCase() !== o.conditionId.toLowerCase()) throw new Error('Book condition does not match the selected event');
    }
  }
  const snapshotId = await deps.saveSnapshot(books);
  const byToken = new Map(books.map((b) => [b.assetId, b]));

  const stateSpace = domain && domain.kind !== 'numeric'
    ? buildCategoricalStateSpace(domain.outcomes.map(o => ({ key:o.id, label:o.label })))
    : buildStateSpace(items, [...levelsOf(request.shape), ...(request.extraLevels ?? [])]);
  if (domain && (domain.kind === 'numeric') === (request.shape.templateId === 'outcome_losses')) throw new Error('Target and event type disagree');

  const ruleFlags = options?.ruleFlags ?? [];
  const correlationResidual = options?.correlationResidual ?? false;
  const calibrationMapVersion = options?.calibrationMapVersion ?? 'unfitted';
  const jevModelVersion = options?.jevModelVersion ?? 'unknown';
  const now = deps.now ?? (() => new Date());

  checkDeadline();
  const basket = await buildBasket({
    shape: request.shape,
    stateSpace,
    legs,
    books: legs.map((l) => toCoreBook(byToken.get(l.tokenId))),
    feeRates,
    budgetCents: request.budgetUsd === undefined ? null : dollarsToCents(request.budgetUsd),
    ruleFlags,
    correlationResidual,
    ...(request.mu !== undefined ? { mu: request.mu } : {}),
    ...(request.protectionGoal ? { protectionGoal: request.protectionGoal } : {}),
    ...executionConstraints(request, legs, byToken),
  });

  checkDeadline();
  return {
    version: domain ? 2 : 1,
    request,
    resolved: { ...(domain ? { domain, evidenceHash:evidenceHash({domain,items,legs,feeRates}) } : {}), items, legs, feeRates, snapshotId },
    basket,
    meta: {
      quotedAt: now().toISOString(),
      calibrationMapVersion,
      jevModelVersion,
      ruleFlags,
      correlationResidual,
    },
  };
}

/** Re-solve a stored quote from its pinned books. No network. */
export async function replay(record: QuoteRecord, books: ClobBook[]): Promise<Basket> {
  const byToken = new Map(books.map((b) => [b.assetId, b]));
  const stateSpace = quoteStateSpace(record);
  return buildBasket({
    shape: record.request.shape,
    stateSpace,
    legs: record.resolved.legs,
    books: record.resolved.legs.map((l) => toCoreBook(byToken.get(l.tokenId))),
    feeRates: record.resolved.feeRates,
    budgetCents: record.request.budgetUsd === undefined
      ? null
      : dollarsToCents(record.request.budgetUsd),
    ruleFlags: record.meta.ruleFlags,
    correlationResidual: record.meta.correlationResidual,
    mu: record.basket.mu,
    ...(record.request.protectionGoal ? { protectionGoal: record.request.protectionGoal } : {}),
    ...executionConstraints(record.request, record.resolved.legs, byToken),
  });
}

function evidenceHash(evidence: {domain: EventSupport;items:TradableItem[];legs:Leg[];feeRates:number[]}):string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
export function quoteStateSpace(record: QuoteRecord): StateSpace {
  if (record.version !== 1 && record.version !== 2) throw new Error('Unsupported quote version');
  const d = record.resolved.domain;
  if (record.version === 1 && (d || record.request.selection)) throw new Error('Unsupported legacy event record');
  if (record.version === 2 && (!d || !d.eligible || d.ruleHash !== record.request.ruleHash || d.kind !== record.request.selection?.kind ||
    record.resolved.evidenceHash !== evidenceHash({domain:d,items:record.resolved.items,legs:record.resolved.legs,feeRates:record.resolved.feeRates}))) throw new Error('Invalid pinned market evidence');
  return d && d.kind !== 'numeric' ? buildCategoricalStateSpace(d.outcomes.map(o => ({ key:o.id, label:o.label })))
    : buildStateSpace(record.resolved.items, [...levelsOf(record.request.shape), ...(record.request.extraLevels ?? [])]);
}
function resolveOutcomes(event: GammaEvent, domain: EventSupport) {
  const items: TradableItem[] = domain.outcomes.map(o => ({ key:o.id, bracket:{ lo:null, hi:null } }));
  const legs: Leg[] = [];
  const feeRates: number[] = [];
  for (const id of domain.marketIds) {
    const m = event.markets.find(m => m.id === id)!;
    const key = domain.outcomes.find(o => o.marketId === id && o.side === 'YES')!.id;
    for (const side of ['YES','NO'] as const) {
      legs.push({ id:`${id}_${side.toLowerCase()}`, marketId:id, label:domain.kind === 'binary' ? m.question : m.groupItemTitle,
        tokenId:side === 'YES' ? m.yesTokenId : m.noTokenId, side, tradableKey:key });
      feeRates.push(m.feeRate!);
    }
  }
  return { items, legs, feeRates };
}
export async function revalidateQuote(record: QuoteRecord, fetchEvent: QuoteDeps['fetchEvent']): Promise<void> {
  quoteStateSpace(record);
  if (record.version !== 2) return;
  if (!record.request.selection || !record.resolved.domain) throw new Error('Missing event selection');
  const current = eventSupport(await fetchEvent(record.request.eventId), record.request.selection);
  if (!current.eligible || current.ruleHash !== record.request.ruleHash) throw new EventQuoteError('changed','Market rules or availability changed; rebuild the hedge.');
}
