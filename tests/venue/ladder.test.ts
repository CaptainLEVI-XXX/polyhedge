import { describe, expect, it } from 'vitest';
import { parseLadder, parseLadderLabel } from '../../packages/venue/src/ladder.js';

describe('parseLadderLabel', () => {
  it('inherits a multiplier the venue wrote only on the high side', () => {
    // "50-60M" means 50 million to 60 million. Reading the low side literally
    // makes the bracket span almost the entire axis and misprices every state.
    expect(parseLadderLabel('50-60M')).toMatchObject({ lo: 50_000_000, hi: 60_000_000 });
    expect(parseLadderLabel('940 - 950m')).toMatchObject({ lo: 940_000_000, hi: 950_000_000 });
  });

  it('reads a central-bank step as signed basis points', () => {
    // A cut is a negative move on the axis a borrower actually experiences.
    expect(parseLadderLabel('25 bps decrease')?.hi).toBeLessThan(0);
    expect(parseLadderLabel('25 bps hike')?.lo).toBeGreaterThan(0);
    expect(parseLadderLabel('No change')).toMatchObject({ lo: -12.5, hi: 12.5 });
  });

  it('refuses a label whose digits are not where a bracket puts them', () => {
    // The single rule that keeps scorelines out without knowing what a
    // scoreline is: a bracket starts with its number or its comparator.
    expect(parseLadderLabel('CA Lanús 0 - 0 Estudiantes de La Plata')).toBeNull();
    expect(parseLadderLabel('Gavin Newsom')).toBeNull();
  });
});

describe('parseLadder', () => {
  it('accepts the shapes the venue actually publishes', () => {
    const crypto = parseLadder(['<66,000', '66,000-68,000', '68,000-70,000', '>70,000']);
    expect(crypto?.span).toEqual({ lo: 66_000, hi: 70_000 });

    // Inclusive integer bounds: a one-unit hole at every boundary is notation.
    const counts = parseLadder(['<40', '40-64', '65-89', '90+']);
    expect(counts?.brackets[1]).toMatchObject({ lo: 40, hi: 65 });

    // The same convention in decimals, hole 0.1.
    const percent = parseLadder(['≤0.4%', '0.5% to 0.6%', '0.7% to 0.8%', '0.9%+']);
    expect(percent?.unit).toBe('%');
    expect(percent?.brackets[1]).toMatchObject({ lo: 0.5, hi: 0.7 });

    // Bare values whose widths are implied by their neighbours.
    const degrees = parseLadder(['20°C or below', '21°C', '22°C', '23°C or higher']);
    expect(degrees?.brackets[1]).toMatchObject({ lo: 21, hi: 22 });
  });

  it('rejects anything that does not tile the axis exactly once', () => {
    // Categorical lists never tile.
    expect(parseLadder(['Anthropic', 'Meta', 'Google'])).toBeNull();

    // A numeric ladder carrying a categorical escape hatch is not a partition
    // of a numeric axis — "no IPO" is not a price, and the engine cannot
    // express it as one.
    expect(parseLadder(['<$1.25T', '$1.25–$1.5T', '$1.5T+', 'No IPO by December 31, 2027'])).toBeNull();

    // An irregular hole is a real hole, not inclusive-bound notation.
    expect(parseLadder(['<10', '10-20', '25-30', '30+'])).toBeNull();

    // Two open tops is not a partition.
    expect(parseLadder(['<10', '10-20', '20+', '30+'])).toBeNull();

    // Overlapping brackets would pay twice in one state.
    expect(parseLadder(['<10', '5-20', '20+'])).toBeNull();

    // An inverted range is refused rather than silently swapped.
    expect(parseLadder(['<10', '20-10', '20+'])).toBeNull();
  });
});
