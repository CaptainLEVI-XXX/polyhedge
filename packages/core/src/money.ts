export type Cents = number & { readonly __brand: 'Cents' };
export type PriceMicros = number & { readonly __brand: 'PriceMicros' };

/** Banker's rounding: ties to even, so repeated rounding does not drift up. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) throw new Error(`Cents must be an integer, got ${n}`);
  if (!Number.isSafeInteger(n)) throw new Error(`Cents out of safe range: ${n}`);
  return n as Cents;
}

export function dollarsToCents(d: number): Cents {
  // `d * 100` carries representation error that can hide a genuine half-cent
  // tie, so banker's rounding never fires and the value silently rounds down.
  // Snapping away sub-ULP noise first makes a true tie visible as one.
  return cents(roundHalfEven(Number((d * 100).toFixed(9))));
}

export function centsToDollars(c: Cents): number {
  return c / 100;
}

export function priceMicros(n: number): PriceMicros {
  if (!Number.isInteger(n)) throw new Error(`PriceMicros must be an integer, got ${n}`);
  if (n < 0 || n > 1_000_000) throw new Error(`PriceMicros out of range 0..1000000: ${n}`);
  return n as PriceMicros;
}

export function microsToDollars(p: PriceMicros): number {
  return p / 1_000_000;
}

/**
 * Split `total` proportionally to `weights` so the parts sum to exactly
 * `total`. Largest-remainder: floor every share, then hand leftover units
 * to the largest fractional parts, breaking ties by lower index so the
 * result is deterministic.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map((_, i) => cents(i === 0 ? total : 0));

  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map((x) => Math.floor(x));
  let remainder = total - out.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));

  const step = remainder >= 0 ? 1 : -1;
  let k = 0;
  while (remainder !== 0) {
    const idx = order[k % order.length]!.i;
    out[idx] = out[idx]! + step;
    remainder -= step;
    k += 1;
  }
  return out.map((n) => cents(n));
}
