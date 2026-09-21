import { SCALE, type ExecutionLeg, type MarketBook, type OrderIntent } from './types.js';

export class OrderValidationError extends Error {}

export function integer(value: number, name: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new OrderValidationError(`${name} must be a ${allowZero ? 'nonnegative' : 'positive'} safe integer`);
  }
  return value;
}

/** Integer multiplication/division avoids binary-float errors at quantity boundaries. */
export function mulDiv(a: number, b: number, divisor: number, roundUp = false): number {
  integer(a, 'multiplicand'); integer(b, 'multiplier'); integer(divisor, 'divisor', false);
  const product = BigInt(a) * BigInt(b);
  const d = BigInt(divisor);
  return integer(Number((product + (roundUp ? d - 1n : 0n)) / d), 'computed amount');
}

export function validateBook(book: MarketBook, tokenId: string, now: Date, maxAgeMs: number): void {
  if (book.tokenId !== tokenId) throw new OrderValidationError('Book token does not match the requested token');
  const age = now.getTime() - Date.parse(book.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) throw new OrderValidationError('Book is stale or has an invalid timestamp');
  integer(book.tickMicros, 'tick', false);
  integer(book.shareStepMicros, 'share step', false);
  integer(book.minSharesMicros, 'minimum shares');
  integer(book.feeBps, 'fee basis points');
  if (book.tickMicros >= SCALE || book.feeBps > 10_000) throw new OrderValidationError('Invalid market constraints');
  for (const level of [...book.asks, ...book.bids]) {
    integer(level.priceMicros, 'book price', false);
    integer(level.sharesMicros, 'book quantity');
    if (level.priceMicros >= SCALE) throw new OrderValidationError('Book price must be below one dollar');
  }
}

export function buildOrder(
  leg: ExecutionLeg,
  side: 'BUY' | 'SELL',
  book: MarketBook,
  slippageBps: number,
  now: Date,
  maxAgeMs = 10_000,
): OrderIntent {
  validateBook(book, leg.tokenId, now, maxAgeMs);
  integer(leg.sharesMicros, 'shares', false);
  integer(leg.referencePriceMicros, 'reference price', false);
  integer(slippageBps, 'slippage basis points');
  if (slippageBps > 10_000 || leg.referencePriceMicros >= SCALE) throw new OrderValidationError('Invalid price authorization');
  if (leg.sharesMicros % book.shareStepMicros !== 0 || leg.sharesMicros < book.minSharesMicros) {
    throw new OrderValidationError('Quoted shares are not representable at venue precision; requote required');
  }
  const levels = [...(side === 'BUY' ? book.asks : book.bids)]
    .sort((a, b) => side === 'BUY' ? a.priceMicros - b.priceMicros : b.priceMicros - a.priceMicros);
  let remaining = leg.sharesMicros;
  let deepest = 0;
  for (const level of levels) {
    if (level.sharesMicros === 0) continue;
    remaining -= Math.min(remaining, level.sharesMicros);
    deepest = level.priceMicros;
    if (remaining === 0) break;
  }
  if (remaining !== 0) throw new OrderValidationError('Insufficient book depth for the full leg');
  const limitPriceMicros = (side === 'BUY' ? Math.ceil(deepest / book.tickMicros) : Math.floor(deepest / book.tickMicros)) * book.tickMicros;
  if (limitPriceMicros <= 0 || limitPriceMicros >= SCALE) throw new OrderValidationError('Rounded limit is outside the tradable price range');
  const bound = side === 'BUY'
    ? mulDiv(leg.referencePriceMicros, 10_000 + slippageBps, 10_000)
    : mulDiv(leg.referencePriceMicros, 10_000 - slippageBps, 10_000, true);
  if (side === 'BUY' ? limitPriceMicros > bound : limitPriceMicros < bound) {
    throw new OrderValidationError('Executable limit exceeds the authorized slippage');
  }
  const notional = mulDiv(leg.sharesMicros, limitPriceMicros, SCALE, side === 'BUY');
  const fee = mulDiv(notional, book.feeBps, 10_000, true);
  const maxCashMicros = side === 'BUY' ? integer(notional + fee, 'maximum debit') : Math.max(0, notional - fee);
  return { ...(leg.eventEvidence ? {eventEvidence:leg.eventEvidence} : {}), tokenId: leg.tokenId, conditionId: leg.conditionId, outcome: leg.outcome, side,
    sharesMicros: leg.sharesMicros, limitPriceMicros, maxCashMicros };
}
