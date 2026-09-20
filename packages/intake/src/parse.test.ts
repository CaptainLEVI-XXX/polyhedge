import { describe, expect, it } from 'vitest';
import { findNumbers, parseDeadline, parseUnderlying } from './parse.js';

describe('findNumbers', () => {
  it('extracts four numbers with distinguishable context', () => {
    const text = 'I hold $40k of BTC, could lose $8k below $60k, and can spend $300 on protection';
    const candidates = findNumbers(text);

    expect(candidates).toHaveLength(4);

    expect(candidates[0]?.value).toBe(40_000);
    expect(candidates[0]?.context).toContain('hold');

    expect(candidates[1]?.value).toBe(8_000);
    expect(candidates[1]?.context).toContain('lose');

    expect(candidates[2]?.value).toBe(60_000);
    expect(candidates[2]?.context).toContain('below');

    expect(candidates[3]?.value).toBe(300);
    expect(candidates[3]?.context).toContain('spend');
  });
});

describe('parseDeadline', () => {
  const today = new Date('2026-09-20T00:00:00Z');

  it('infers the year for "by Dec 31" when it has not passed yet', () => {
    const result = parseDeadline('Hedge this by Dec 31 please', today);

    expect(result?.value).toBe('2026-12-31');
    expect(result?.provenance).toBe('inferred');
    expect(result?.raw).toBe('Dec 31');
  });

  it('marks the year stated when it is written in the text', () => {
    const result = parseDeadline('by December 31 2027', today);

    expect(result?.value).toBe('2027-12-31');
    expect(result?.provenance).toBe('stated');
  });

  it('rolls a past month/day forward to next year and keeps it inferred', () => {
    const result = parseDeadline('by Jan 5', today);

    expect(result?.value).toBe('2027-01-05');
    expect(result?.provenance).toBe('inferred');
  });
});

describe('parseUnderlying', () => {
  it('declines unsupported assets as OTHER instead of null', () => {
    expect(parseUnderlying('I hold $40k of SOL alts')).toBe('OTHER');
  });
});
