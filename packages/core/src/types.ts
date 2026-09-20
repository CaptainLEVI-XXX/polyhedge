/**
 * A half-open price interval `[lo, hi)`: `lo` included, `hi` excluded,
 * `null` unbounded on that side. The convention is uniform, which is what
 * lets a ladder tile the axis exactly and makes contiguity a plain
 * `cur.hi === next.lo`.
 */
export interface Bracket {
  lo: number | null;
  hi: number | null;
}

/** A bracket plus the caller's identity for it — normally a market id. */
export interface TradableItem {
  key: string;
  bracket: Bracket;
}

/** Something you can buy. Never subdivided. */
export interface TradableState {
  key: string;
  label: string;
  bracket: Bracket;
}

/** Where the target is computed. Refines a tradable state; never traded. */
export interface EvalState {
  id: string;
  label: string;
  lo: number | null;
  hi: number | null;
  tradableKey: string;
}

export interface StateSpace {
  tradable: TradableState[];
  evals: EvalState[];
}
