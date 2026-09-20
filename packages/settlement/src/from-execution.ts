import { verifyBinding, type BoundQuote, type ExecutionRecord } from '@polyhedge/execution';
import type { SettlementBasket } from './types.js';

/** Register only reconciled terminal holdings; uncertain orders are never treated as positions. */
export function basketFromExecution(
  accepted: BoundQuote,
  execution: ExecutionRecord,
  reference: { observedAt: string; source: string },
): SettlementBasket {
  verifyBinding(accepted);
  if (execution.quote.hash !== accepted.selected.hash || execution.authorization.quoteHash !== accepted.selected.hash ||
    JSON.stringify(execution.quote.legs) !== JSON.stringify(accepted.selected.legs)) throw new Error('Execution does not belong to accepted quote');
  if (execution.status !== 'complete' && execution.status !== 'stuck') throw new Error('Execution holdings are not terminal and reconciled');
  if (execution.legs.length !== accepted.selected.legs.length) throw new Error('Execution leg count changed');
  let costMicros = 0;
  const positions = execution.legs.flatMap(leg => {
    const selected = accepted.selected.legs.find(l => l.id === leg.leg.id);
    if (!selected || JSON.stringify(selected) !== JSON.stringify(leg.leg)) throw new Error('Execution leg changed');
    let sharesMicros = 0;
    for (const order of [...(leg.buy ? [leg.buy] : []), ...leg.unwinds]) {
      if (order.state === 'unknown' || order.state === 'pending') throw new Error('Execution still contains an uncertain order');
      if (order.state !== 'confirmed') continue;
      for (const fill of order.fills) {
        const sign = fill.side === 'BUY' ? 1 : -1;
        sharesMicros += sign * fill.sharesMicros;
        costMicros += sign * fill.cashMicros;
      }
    }
    if (!Number.isSafeInteger(sharesMicros) || sharesMicros < 0) throw new Error('Invalid confirmed inventory');
    return sharesMicros === 0 ? [] : [{ basketId: execution.id, wallet: execution.authorization.wallet,
      conditionId: leg.leg.conditionId, tokenId: leg.leg.tokenId, outcome: leg.leg.outcome, sharesMicros }];
  });
  if (!Number.isSafeInteger(costMicros)) throw new Error('Invalid confirmed cost');
  if (!positions.length) throw new Error('Execution has no positions to settle');
  return { id: execution.id, revision: 0, wallet: execution.authorization.wallet,
    quote: structuredClone(accepted.record), positions, costMicros,
    expectedObservationAt: reference.observedAt, expectedSource: reference.source,
    executionComplete: execution.status === 'complete' };
}
