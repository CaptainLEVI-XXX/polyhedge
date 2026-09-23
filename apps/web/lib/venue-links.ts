import type { GammaEvent } from '@polyhedge/venue';

/**
 * Where a position can be checked at source.
 *
 * Every number on the page is ours — our solve, our rounding, our wording of
 * the venue's question. A link to the venue's own page for the bracket is the
 * one thing on screen that is not, which is exactly why it belongs there: it
 * lets someone verify the claim rather than take it.
 *
 * Slugs are only ever used as published. A path assembled from a title would be
 * a 404 at best and, if it happened to collide, somebody else's market at
 * worst — so a missing market slug falls back to the event page rather than to
 * a guess.
 */
const VENUE = 'https://polymarket.com';

export function linkForMarket(event: GammaEvent | undefined, marketId: string): string | null {
  if (event === undefined) return null;
  const market = event.markets.find((m) => m.id === marketId);
  return market?.slug != null && market.slug !== ''
    ? `${VENUE}/event/${event.slug}/${market.slug}`
    : `${VENUE}/event/${event.slug}`;
}
