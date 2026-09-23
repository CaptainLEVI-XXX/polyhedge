import type { ClobBook } from '@polyhedge/venue';

/**
 * Deciding when a quote is worth re-solving.
 *
 * Re-solving on every book message would be dozens of LP solves a second on a
 * churning book, for a number that did not move. Re-solving on nothing means
 * showing a price the market left behind. So the question is which changes
 * actually reach the basket.
 *
 * Two do, and the second is the one an earlier draft missed:
 *
 * 1. **A level moved at a price the basket consumed.** The fill this quote
 *    assumed no longer exists, so the price is wrong.
 * 2. **The best ask moved on ANY eligible token — not only the held ones.** A
 *    leg we did not buy can become the cheapest way to build the same
 *    protection. Watching only what is already held structurally cannot notice
 *    that, and quietly keeps someone in a worse basket than the market offers.
 */

export interface Watch {
  /** Every token the solver may choose from, not only the ones it did. */
  eligibleTokens: string[];
  /** Deepest ask price this basket actually consumed, per held token. */
  consumedTo: Map<string, number>;
  tickMicros: number;
}

export type ChangeVerdict =
  | { resolve: false; reason: 'unrelated' | 'deeper_than_consumed' | 'no_move' }
  | { resolve: true; reason: 'consumed_level_moved' | 'best_ask_moved' };

export function assess(watch: Watch, previous: ClobBook | undefined, next: ClobBook): ChangeVerdict {
  if (!watch.eligibleTokens.includes(next.assetId)) {
    return { resolve: false, reason: 'unrelated' };
  }

  const bestBefore = previous?.asks?.[0]?.priceMicros;
  const bestAfter = next.asks[0]?.priceMicros;

  if (bestBefore !== undefined && bestAfter !== undefined) {
    if (Math.abs(bestAfter - bestBefore) >= watch.tickMicros) {
      return { resolve: true, reason: 'best_ask_moved' };
    }
  } else if (bestBefore !== bestAfter) {
    // One side appearing or vanishing is a real change, not a rounding one.
    return { resolve: true, reason: 'best_ask_moved' };
  }

  const consumed = watch.consumedTo.get(next.assetId);
  if (consumed !== undefined) {
    const sizeAtOrBelow = (book: ClobBook | undefined): number =>
      (book?.asks ?? [])
        .filter((level) => level.priceMicros <= consumed)
        .reduce((sum, level) => sum + level.size, 0);

    if (Math.abs(sizeAtOrBelow(next) - sizeAtOrBelow(previous)) > 1e-9) {
      return { resolve: true, reason: 'consumed_level_moved' };
    }
    return { resolve: false, reason: 'deeper_than_consumed' };
  }

  return { resolve: false, reason: 'no_move' };
}

/**
 * Collapses a burst of changes into one solve.
 *
 * Leading-edge would re-solve on the first message of a burst and then show a
 * price from the middle of it. Trailing means the solve runs against where the
 * book actually settled.
 */
export function debounce(fn: () => void, ms: number, maxWaitMs?:number): { fire: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline:ReturnType<typeof setTimeout>|null=null;
  const flush=()=>{if(timer!==null)clearTimeout(timer);if(deadline!==null)clearTimeout(deadline);timer=null;deadline=null;fn();};
  return {
    fire: () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, ms);
      if(maxWaitMs!==undefined&&deadline===null)deadline=setTimeout(flush,maxWaitMs);
    },
    cancel: () => {
      if(deadline!==null)clearTimeout(deadline);deadline=null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Whether a finished solve may still be shown.
 *
 * Solves take time, so one can land after the user pinned the quote or moved
 * on. Applying it then would overwrite a frozen price with a later one the
 * user never agreed to — which is exactly the thing pinning exists to prevent,
 * arriving through the back door.
 */
export function mayApply(
  solveStartedAt: number,
  frozenAt: number | null,
  supersededAt: number | null,
): boolean {
  // Freezing is absolute. Not "solves started before the freeze are stale" —
  // a solve started a millisecond earlier is just as much a price the user
  // never saw. Once frozen, nothing lands.
  if (frozenAt !== null) return false;
  // A newer solve already landed; this one is describing an older book.
  if (supersededAt !== null && solveStartedAt < supersededAt) return false;
  return true;
}

/**
 * Builds the watch from the basket and the books it was actually priced
 * against.
 *
 * `avgPriceMicros` on a leg is tempting and wrong: it is the mean of the levels
 * consumed, so it sits BELOW the deepest one. Watching to the average would
 * leave the most expensive part of every fill unwatched — precisely the part
 * most likely to be taken by someone else first. Walking the snapshot gives the
 * real depth reached.
 */
export function watchFor(
  eligibleTokens: string[],
  held: { tokenId: string; shares: number }[],
  books: Map<string, ClobBook>,
  tickMicros = 10_000,
): Watch {
  const consumedTo = new Map<string, number>();

  for (const leg of held) {
    const asks = [...(books.get(leg.tokenId)?.asks ?? [])].sort(
      (a, b) => a.priceMicros - b.priceMicros,
    );
    let remaining = leg.shares;
    let deepest: number | null = null;
    for (const level of asks) {
      if (remaining <= 1e-9) break;
      deepest = level.priceMicros;
      remaining -= Math.min(remaining, level.size);
    }
    if (deepest !== null) consumedTo.set(leg.tokenId, deepest);
  }

  return { eligibleTokens, consumedTo, tickMicros };
}
