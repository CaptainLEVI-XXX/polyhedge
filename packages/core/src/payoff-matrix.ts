import type { StateSpace } from './types.js';

export interface Leg {
  id: string;
  /** The venue's market id. */
  marketId: string;
  /** Human-readable bracket label, e.g. "<68,000". Display only. */
  label: string;
  tokenId: string;
  side: 'YES' | 'NO';
  /** Identity of the tradable state this leg resolves YES in. Never an index. */
  tradableKey: string;
}

/**
 * Rows per leg, columns per EVALUATION state.
 *
 * YES pays across every evaluation state inside its own bracket —
 * subdividing for evaluation does not change what a bracket pays. NO pays
 * everywhere else, which is the neg-risk complement and the reason both
 * sides are offered as columns.
 */
export function payoffMatrix(legs: Leg[], stateSpace: StateSpace): number[][] {
  const known = new Set(stateSpace.tradable.map((t) => t.key));
  return legs.map((leg) => {
    if (!known.has(leg.tradableKey)) {
      throw new Error(`payoffMatrix: leg ${leg.id} names unknown tradable ${leg.tradableKey}`);
    }
    return stateSpace.evals.map((e) =>
      leg.side === 'YES'
        ? (e.tradableKey === leg.tradableKey ? 1 : 0)
        : (e.tradableKey === leg.tradableKey ? 0 : 1),
    );
  });
}
