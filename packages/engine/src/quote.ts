import {
  buildBasket, buildStateSpace, dollarsToCents, levelsOf, priceMicros,
  type Basket, type BookLevel, type Leg, type TargetShape, type TradableItem,
} from '@polyhedge/core';
import { parseBracketTitle, type ClobBook, type GammaEvent } from '@polyhedge/venue';

export interface QuoteRequest {
  eventId: string;
  shape: TargetShape;
  budgetUsd?: number;
  /** Extra split points beyond the shape's own levels. */
  extraLevels?: number[];
}

export interface QuoteRecord {
  version: 1;
  request: QuoteRequest;
  resolved: {
    items: TradableItem[];
    legs: Leg[];
    feeRates: number[];
    snapshotId: string;
  };
  basket: Basket;
}

export interface QuoteDeps {
  fetchEvent(id: string): Promise<GammaEvent>;
  fetchBooks(tokenIds: string[]): Promise<ClobBook[]>;
  saveSnapshot(books: ClobBook[]): Promise<string>;
}

/** The only place venue's plain numbers become core's branded types. */
function toCoreBook(book: ClobBook | undefined): BookLevel[] {
  return (book?.asks ?? []).map((l) => ({ priceMicros: priceMicros(l.priceMicros), size: l.size }));
}

/**
 * Resolve an event into the tradable items and legs a basket is built from.
 * Both YES and NO legs are offered so the solver can take the neg-risk
 * complement when the book prices it better.
 */
function resolveEvent(event: GammaEvent): { items: TradableItem[]; legs: Leg[]; feeRates: number[] } {
  if (!event.negRisk) {
    throw new Error(`event ${event.id} is not a neg-risk partition; refusing to quote`);
  }

  const items: TradableItem[] = [];
  const legs: Leg[] = [];
  const feeRates: number[] = [];

  for (const m of event.markets) {
    const bracket = parseBracketTitle(m.groupItemTitle);
    if (bracket === null) {
      throw new Error(`market ${m.id} has an unparseable bracket title "${m.groupItemTitle}"`);
    }
    if (m.feeRate === null) {
      throw new Error(`market ${m.id} reports no fee schedule; fee is unknown, not zero`);
    }
    items.push({ key: m.id, bracket });
    // RULING C: marketId is the venue id; the bracket title is a display label.
    legs.push({ id: `${m.id}_yes`, marketId: m.id, label: m.groupItemTitle, tokenId: m.yesTokenId, side: 'YES', tradableKey: m.id });
    feeRates.push(m.feeRate);
    legs.push({ id: `${m.id}_no`, marketId: m.id, label: m.groupItemTitle, tokenId: m.noTokenId, side: 'NO', tradableKey: m.id });
    feeRates.push(m.feeRate);
  }

  return { items, legs, feeRates };
}

export async function quote(request: QuoteRequest, deps: QuoteDeps): Promise<QuoteRecord> {
  const event = await deps.fetchEvent(request.eventId);
  const { items, legs, feeRates } = resolveEvent(event);

  const books = await deps.fetchBooks(legs.map((l) => l.tokenId));
  const snapshotId = await deps.saveSnapshot(books);
  const byToken = new Map(books.map((b) => [b.assetId, b]));

  const stateSpace = buildStateSpace(
    items,
    [...levelsOf(request.shape), ...(request.extraLevels ?? [])],
  );

  const basket = await buildBasket({
    shape: request.shape,
    stateSpace,
    legs,
    books: legs.map((l) => toCoreBook(byToken.get(l.tokenId))),
    feeRates,
    budgetCents: request.budgetUsd === undefined ? null : dollarsToCents(request.budgetUsd),
    ruleFlags: [],
    correlationResidual: false,
  });

  return { version: 1, request, resolved: { items, legs, feeRates, snapshotId }, basket };
}

/** Re-solve a stored quote from its pinned books. No network. */
export async function replay(record: QuoteRecord, books: ClobBook[]): Promise<Basket> {
  const byToken = new Map(books.map((b) => [b.assetId, b]));
  const stateSpace = buildStateSpace(
    record.resolved.items,
    [...levelsOf(record.request.shape), ...(record.request.extraLevels ?? [])],
  );
  return buildBasket({
    shape: record.request.shape,
    stateSpace,
    legs: record.resolved.legs,
    books: record.resolved.legs.map((l) => toCoreBook(byToken.get(l.tokenId))),
    feeRates: record.resolved.feeRates,
    budgetCents: record.request.budgetUsd === undefined
      ? null
      : dollarsToCents(record.request.budgetUsd),
    ruleFlags: [],
    correlationResidual: false,
    mu: record.basket.mu,
  });
}
