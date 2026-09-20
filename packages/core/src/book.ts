import { microsToDollars, type PriceMicros } from './money.js';

export interface BookLevel {
  priceMicros: PriceMicros;
  size: number;
}

/**
 * Cost of one share including the taker fee: `p + rate*p*(1-p)`.
 *
 * As a share of premium the fee is `rate*(1-p)`, so cheap hedges carry the
 * heaviest drag. Linear in shares at a fixed price, which is what keeps the
 * LP's cost term linear.
 */
export function unitCostDollars(priceMicros: PriceMicros, feeRate: number): number {
  const p = microsToDollars(priceMicros);
  return p + feeRate * p * (1 - p);
}

export interface WalkResult {
  /** Dollars, not cents: per-share fees are fractions of a cent and must
   *  survive the sum before any rounding. */
  costDollars: number;
  filled: number;
  avgPriceMicros: number;
}

/** Walk the asks to buy `shares`. Never prices at mid. A partial fill is
 *  reported, never disguised. */
export function walkBook(levels: BookLevel[], shares: number, feeRate: number): WalkResult {
  let remaining = shares;
  let costDollars = 0;
  let premiumDollars = 0;
  let filled = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    costDollars += take * unitCostDollars(level.priceMicros, feeRate);
    premiumDollars += take * microsToDollars(level.priceMicros);
    filled += take;
    remaining -= take;
  }

  return {
    costDollars,
    filled,
    avgPriceMicros: filled === 0 ? 0 : (premiumDollars / filled) * 1_000_000,
  };
}
