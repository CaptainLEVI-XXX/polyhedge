import type { ClobBook } from '@polyhedge/venue';

/**
 * What a held position is worth now, against the side it would actually sell
 * into.
 *
 * The engine has no concept of this: `quote()` prices a NEW basket by walking
 * **ask** depth, which is the wrong side and the wrong question. Selling hits
 * bids, and a bid price alone is not a valuation — the quantity has to fit in
 * the depth that is actually there.
 *
 * Where it does not fit, this says so rather than marking the whole position at
 * top of book. Marking 3,800 shares at the best bid when only 40 shares of bid
 * exist is not optimism, it is a wrong number a user would act on.
 */

export interface PositionValue {
  tokenId: string;
  shares: number;
  /** Proceeds for the part the book can actually absorb, before fees. */
  valuableUsd: number;
  /** Shares the bid side cannot take at any price. */
  unsellableShares: number;
  /** Best bid, for display only — never multiplied by the whole position. */
  topBidCents: number | null;
  /** When the book this was read from was observed. */
  at: string;
}

export type MarketStatus = 'open' | 'resolved' | 'unknown';

export function valuePosition(
  tokenId: string,
  shares: number,
  book: ClobBook | undefined,
  status: MarketStatus = 'open',
): PositionValue & { status: MarketStatus } {
  // A resolved market has no book to sell into. Reporting it as worthless would
  // be a different claim from reporting it as resolved, and only one of them is
  // true — a winning position pays a dollar a share once it is redeemed.
  if (status === 'resolved') {
    return {
      tokenId,
      shares,
      valuableUsd: 0,
      unsellableShares: shares,
      topBidCents: null,
      at: book?.timestamp ?? '',
      status: 'resolved',
    };
  }

  const bids = [...(book?.bids ?? [])].sort((a, b) => b.priceMicros - a.priceMicros);
  let remaining = shares;
  let proceeds = 0;

  for (const level of bids) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    proceeds += take * (level.priceMicros / 1_000_000);
    remaining -= take;
  }

  return {
    tokenId,
    shares,
    valuableUsd: proceeds,
    unsellableShares: remaining,
    topBidCents: bids[0] === undefined ? null : bids[0].priceMicros / 10_000,
    at: book?.timestamp ?? '',
    status: book === undefined ? 'unknown' : 'open',
  };
}

export interface BasketValue {
  positions: (PositionValue & { status: MarketStatus })[];
  /** Only what the book can absorb. Never the whole position at top of book. */
  valuableUsd: number;
  /** True when any part of the basket has no bid to sell into. */
  partlyUnvaluable: boolean;
}

export function valueBasket(
  holdings: { tokenId: string; shares: number }[],
  books: Map<string, ClobBook>,
  statuses: Map<string, MarketStatus> = new Map(),
): BasketValue {
  const positions = holdings.map((h) =>
    valuePosition(h.tokenId, h.shares, books.get(h.tokenId), statuses.get(h.tokenId) ?? 'open'),
  );
  return {
    positions,
    valuableUsd: positions.reduce((sum, p) => sum + p.valuableUsd, 0),
    partlyUnvaluable: positions.some((p) => p.unsellableShares > 1e-9),
  };
}
