import type { Bracket, EvalState, StateSpace, TradableItem, TradableState } from './types.js';

/** Symmetric total order: two unbounded-below brackets compare equal rather
 *  than each claiming to precede the other. An asymmetric comparator leaves
 *  their order engine-dependent, and the partition check below runs after
 *  the sort. */
function byLo(a: TradableItem, b: TradableItem): number {
  const al = a.bracket.lo;
  const bl = b.bracket.lo;
  if (al === null && bl === null) return 0;
  if (al === null) return -1;
  if (bl === null) return 1;
  return al - bl;
}

function assertPartition(sorted: Bracket[]): void {
  if (sorted.length === 0) throw new Error('state space: ladder is empty');
  if (sorted[0]!.lo !== null || sorted[sorted.length - 1]!.hi !== null) {
    throw new Error('state space: ladder is not unbounded at both ends');
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (cur.hi === null || next.lo === null) {
      throw new Error('state space: unbounded bracket in the middle of the ladder');
    }
    if (cur.hi < next.lo) throw new Error(`state space: gap between ${cur.hi} and ${next.lo}`);
    if (cur.hi > next.lo) throw new Error(`state space: overlap between ${cur.hi} and ${next.lo}`);
  }
}

function label(lo: number | null, hi: number | null): string {
  if (lo === null) return `<${hi}`;
  if (hi === null) return `>${lo}`;
  return `${lo}-${hi}`;
}

/**
 * Build the two partitions.
 *
 * Tradable states are the brackets, sorted ascending, each keeping the
 * caller's key so markets are never re-joined by array position.
 *
 * Evaluation states subdivide each bracket at any level falling strictly
 * inside it. A bracket leg pays across all of its evaluation states, so
 * this invents no instrument — it lets the target be computed exactly
 * where a threshold cuts through a bracket instead of guessed from a
 * single point.
 */
export function buildStateSpace(items: TradableItem[], levels: number[]): StateSpace {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) throw new Error(`state space: duplicate key ${item.key}`);
    seen.add(item.key);
  }

  const sorted = [...items].sort(byLo);
  assertPartition(sorted.map((i) => i.bracket));

  const tradable: TradableState[] = sorted.map((i) => ({
    key: i.key,
    label: label(i.bracket.lo, i.bracket.hi),
    bracket: i.bracket,
  }));

  const uniqueLevels = [...new Set(levels)].sort((a, b) => a - b);
  const evals: EvalState[] = [];

  for (const t of tradable) {
    const inside = uniqueLevels.filter(
      (v) => (t.bracket.lo === null || v > t.bracket.lo) &&
             (t.bracket.hi === null || v < t.bracket.hi),
    );
    const edges: (number | null)[] = [t.bracket.lo, ...inside, t.bracket.hi];
    for (let i = 0; i < edges.length - 1; i += 1) {
      const lo = edges[i]!;
      const hi = edges[i + 1]!;
      evals.push({ id: `e${evals.length}`, label: label(lo, hi), lo, hi, tradableKey: t.key });
    }
  }

  return { tradable, evals };
}

export function buildCategoricalStateSpace(
  items: { key: string; label: string }[],
): StateSpace {
  if (items.length === 0 || new Set(items.map(i => i.key)).size !== items.length) throw new Error('Categorical outcomes must be distinct and complete');
  return {
    tradable: items.map((i) => ({
      key: i.key, label: i.label, bracket: { lo: null, hi: null },
    })),
    evals: items.map((i, idx) => ({
      id: `e${idx}`, label: i.label, lo: null, hi: null, tradableKey: i.key,
    })),
  };
}
