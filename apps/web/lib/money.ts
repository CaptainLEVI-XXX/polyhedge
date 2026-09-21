/**
 * Formatting money and percentages, once, on the server.
 *
 * Rounding here is an honesty decision, not a display preference, which is why
 * it lives in one tested place rather than in every component that happens to
 * print a number:
 *
 * - **coverage rounds DOWN.** 0.4795 is "47%". Rounding it up to "48%" claims
 *   protection the user did not buy.
 * - **shortfall rounds UP.** Never show a friendlier gap than exists.
 * - **cost rounds UP.** Never show a cheaper price than will be charged.
 *
 * Every rule points the same way: when a number cannot be shown exactly, it is
 * shown in the direction that is worse for us and safer for the reader.
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

/** A shortfall, rounded up to the dollar. Never understate a gap. */
export function shortfallLabel(cents: number): string {
  return WHOLE_USD.format(Math.ceil(cents / 100));
}

/** A payout, rounded down to the dollar. Never overstate what arrives. */
export function payoutLabel(usd: number): string {
  return WHOLE_USD.format(Math.floor(usd));
}

/** Coverage, rounded down to a whole percent. Never overstate protection. */
export function coverageLabel(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  return `${Math.floor(clamped * 100)}%`;
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
