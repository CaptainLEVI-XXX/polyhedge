/** What the market title literally said, before normalization. */
export type LiteralOp = '<' | '<=' | '>' | '>=' | 'range';

/**
 * A half-open price interval `[lo, hi)`: `lo` included, `hi` excluded.
 * `null` means unbounded on that side.
 *
 * The convention is uniform so a ladder tiles the axis exactly. Titles like
 * `≤68,000` and `>86,000` do not literally match it, so `literalOp` records
 * what the title said and a later task can flag a resolution landing on a
 * boundary as rule-basis risk.
 */
export interface Bracket {
  lo: number | null;
  hi: number | null;
  literalOp: LiteralOp;
}

function num(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a Polymarket `groupItemTitle` into a normalized interval.
 * Returns null for anything it cannot read with certainty; callers exclude
 * those markets rather than guess.
 */
export function parseBracketTitle(title: string): Bracket | null {
  const t = title.trim().replace(/[‒-―]/g, '-');
  if (t === '') return null;

  const less = /^(<=|≤|<)\s*(.+)$/.exec(t);
  if (less) {
    const hi = num(less[2]!);
    if (hi === null) return null;
    return { lo: null, hi, literalOp: less[1] === '<' ? '<' : '<=' };
  }

  const greater = /^(>=|≥|>)\s*(.+)$/.exec(t);
  if (greater) {
    const lo = num(greater[2]!);
    if (lo === null) return null;
    return { lo, hi: null, literalOp: greater[1] === '>' ? '>' : '>=' };
  }

  const range = /^(.+?)\s*-\s*(.+)$/.exec(t);
  if (range) {
    const lo = num(range[1]!);
    const hi = num(range[2]!);
    if (lo === null || hi === null || lo >= hi) return null;
    return { lo, hi, literalOp: 'range' };
  }

  return null;
}

/**
 * Check the brackets tile the axis: unbounded at both ends, contiguous, and
 * disjoint. Under `[lo, hi)` that reduces to `cur.hi === next.lo` for every
 * adjacent pair. Anything else is not a usable state space.
 */
export function validateLadder(brackets: Bracket[]): { ok: true } | { ok: false; reason: string } {
  if (brackets.length === 0) return { ok: false, reason: 'ladder is empty' };

  const sorted = [...brackets].sort((a, b) => {
    if (a.lo === null) return -1;
    if (b.lo === null) return 1;
    return a.lo - b.lo;
  });

  if (sorted[0]!.lo !== null || sorted[sorted.length - 1]!.hi !== null) {
    return { ok: false, reason: 'ladder is not unbounded at both ends' };
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (cur.hi === null || next.lo === null) {
      return { ok: false, reason: 'unbounded bracket in the middle of the ladder' };
    }
    if (cur.hi < next.lo) return { ok: false, reason: `gap between ${cur.hi} and ${next.lo}` };
    if (cur.hi > next.lo) return { ok: false, reason: `overlap between ${cur.hi} and ${next.lo}` };
  }

  return { ok: true };
}
