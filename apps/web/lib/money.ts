/**
 * Formatting money once, on the server.
 *
 * Rounding here is an honesty decision, not a display preference: when a
 * number cannot be shown exactly, it is shown in the direction that is worse
 * for us and safer for the reader. Cost rounds UP, payout rounds DOWN.
 */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const WHOLE_USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** A cost, rounded up to the cent. Never quote cheaper than reality. */
export function costLabel(cents: number): string {
  return USD.format(Math.ceil(cents) / 100);
}

/** A payout, rounded down to the dollar. Never overstate what arrives. */
export function payoutLabel(usd: number): string {
  return WHOLE_USD.format(Math.floor(usd));
}

/** A level on the ladder's own axis — a price, a temperature, a rate. */
export function levelLabel(value: number, unit: string): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 1 : 2;
  const num = value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (unit === '' || unit === '$') return `$${num}`;
  return `${num}${unit}`;
}
