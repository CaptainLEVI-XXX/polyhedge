import {
  buildBasket, buildStateSpace, dollarsToCents, levelsOf, priceMicros,
  type Basket, type BookLevel, type Leg, type TargetShape, type TradableItem, type ProtectionGoal,
} from '@polyhedge/core';
import { parseLadder, parseLadderLabel, type ClobBook, type GammaEvent } from '@polyhedge/venue';

export interface QuoteRequest {
  eventId: string;
  shape: TargetShape;
  budgetUsd?: number;
  /** Extra split points beyond the shape's own levels. */
  extraLevels?: number[];
  /** Over-hedge penalty override, e.g. to request a "shaped" alternative solve. */
  mu?: number;
  protectionGoal?: ProtectionGoal;
  /** Use venue minimum sizes and the execution adapter's quantity precision. */
  execution?: { quantityStep: number; maxLegs?: number };
  /**
   * Human-readable note on how this market's observation moment relates to
   * the user's deadline. Time basis risk, not merely "holding longer".
   */
  observationNote?: string;
}

export interface QuoteMeta {
  /** ISO timestamp. */
  quotedAt: string;
  /** Which calibration produced the inputs. */
  calibrationMapVersion: string;
  /** e.g. "jev-1.13.0" */
  jevModelVersion: string;
  /** What was passed in, so replay reproduces it. */
  ruleFlags: string[];
  correlationResidual: boolean;
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
  meta: QuoteMeta;
}

export interface QuoteDeps {
  fetchEvent(id: string): Promise<GammaEvent>;
  fetchBooks(tokenIds: string[]): Promise<ClobBook[]>;
  saveSnapshot(books: ClobBook[]): Promise<string>;
  now?: () => Date;
}

export interface QuoteOptions {
  ruleFlags?: string[];
  correlationResidual?: boolean;
  calibrationMapVersion?: string;
  jevModelVersion?: string;
}

/** The only place venue's plain numbers become core's branded types. */
function toCoreBook(book: ClobBook | undefined): BookLevel[] {
  return (book?.asks ?? []).map((l) => ({ priceMicros: priceMicros(l.priceMicros), size: l.size }));
}

function executionConstraints(request: QuoteRequest, legs: Leg[], byToken: Map<string, ClobBook>) {
  if (!request.execution) return {};
  const minShares = legs.map(leg => {
    const minimum = byToken.get(leg.tokenId)?.minOrderSize;
    if (minimum === undefined) throw new Error(`book ${leg.tokenId} has no minimum order size; cannot claim an executable quote`);
    return minimum;
  });
  return { execution: { ...request.execution, minShares } };
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

  // Ordered by the low edge before the ladder is validated: the venue publishes
  // markets in whatever order it likes, and `parseLadder` checks that brackets
  // TILE, which is an ordered property. Sorting first means a correct ladder
  // listed out of order is still priced, while a set with a real hole is still
  // rejected.
  const ordered = event.markets
    .map((m) => ({ market: m, edge: parseLadderLabel(m.groupItemTitle) }))
    .sort((a, b) => {
      if (a.edge === null || b.edge === null) return 0;
      if (a.edge.lo === null) return -1;
      if (b.edge.lo === null) return 1;
      return a.edge.lo - b.edge.lo;
    });

  // One parse for the whole event, not one per market. A bracket title only
  // means something next to its neighbours: `parseLadder` is what establishes
  // that these outcomes partition an axis exactly once, which is the assumption
  // every downstream price depends on.
  const ladder = parseLadder(ordered.map((o) => o.market.groupItemTitle));
  if (ladder === null) {
    throw new Error(
      `event ${event.id} does not publish a numeric ladder its outcomes tile; refusing to quote`,
    );
  }

  const items: TradableItem[] = [];
  const legs: Leg[] = [];
  const feeRates: number[] = [];

  ordered.forEach(({ market: m }, i) => {
    const bracket = ladder.brackets[i];
    if (bracket === undefined) {
      throw new Error(`event ${event.id} ladder lost bracket ${i}`);
    }
    if (m.feeRate === null) {
      throw new Error(`market ${m.id} reports no fee schedule; fee is unknown, not zero`);
    }
    items.push({ key: m.id, bracket: { lo: bracket.lo, hi: bracket.hi } });
    // RULING C: marketId is the venue id; the bracket title is a display label.
    legs.push({ id: `${m.id}_yes`, marketId: m.id, label: m.groupItemTitle, tokenId: m.yesTokenId, side: 'YES', tradableKey: m.id });
    feeRates.push(m.feeRate);
    legs.push({ id: `${m.id}_no`, marketId: m.id, label: m.groupItemTitle, tokenId: m.noTokenId, side: 'NO', tradableKey: m.id });
    feeRates.push(m.feeRate);
  });

  return { items, legs, feeRates };
}

export async function quote(
  request: QuoteRequest,
  deps: QuoteDeps,
  options?: QuoteOptions,
): Promise<QuoteRecord> {
  const event = await deps.fetchEvent(request.eventId);
  const { items, legs, feeRates } = resolveEvent(event);

  const books = await deps.fetchBooks(legs.map((l) => l.tokenId));
  const snapshotId = await deps.saveSnapshot(books);
  const byToken = new Map(books.map((b) => [b.assetId, b]));

  const stateSpace = buildStateSpace(
    items,
    [...levelsOf(request.shape), ...(request.extraLevels ?? [])],
  );

  const ruleFlags = options?.ruleFlags ?? [];
  const correlationResidual = options?.correlationResidual ?? false;
  const calibrationMapVersion = options?.calibrationMapVersion ?? 'unfitted';
  const jevModelVersion = options?.jevModelVersion ?? 'unknown';
  const now = deps.now ?? (() => new Date());

  const basket = await buildBasket({
    shape: request.shape,
    stateSpace,
    legs,
    books: legs.map((l) => toCoreBook(byToken.get(l.tokenId))),
    feeRates,
    budgetCents: request.budgetUsd === undefined ? null : dollarsToCents(request.budgetUsd),
    ruleFlags,
    correlationResidual,
    ...(request.mu !== undefined ? { mu: request.mu } : {}),
    ...(request.protectionGoal ? { protectionGoal: request.protectionGoal } : {}),
    ...executionConstraints(request, legs, byToken),
  });

  return {
    version: 1,
    request,
    resolved: { items, legs, feeRates, snapshotId },
    basket,
    meta: {
      quotedAt: now().toISOString(),
      calibrationMapVersion,
      jevModelVersion,
      ruleFlags,
      correlationResidual,
    },
  };
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
    ruleFlags: record.meta.ruleFlags,
    correlationResidual: record.meta.correlationResidual,
    mu: record.basket.mu,
    ...(record.request.protectionGoal ? { protectionGoal: record.request.protectionGoal } : {}),
    ...executionConstraints(record.request, record.resolved.legs, byToken),
  });
}
