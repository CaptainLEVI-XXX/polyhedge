import { fetchBooks, fetchEvent } from '@polyhedge/venue';
import { quote, quoteSession } from '@polyhedge/engine';
import { buildAlternatives, buildBasketOptions } from '@polyhedge/intake';
import { putQuote, putSnapshot, type StoredQuote } from './store.js';
import { marketIndex } from './markets.js';
import { composeView } from './compose.js';
import { linkForMarket } from './venue-links.js';
import type { QuotedView } from './view-model.js';

/**
 * Re-pricing one quote at the current book.
 *
 * Shared by the request route and the stream, because they must produce the
 * same thing. A stream that re-priced by a slightly different path would give a
 * user one number while watching and another on reload, with no way to say
 * which was real.
 *
 * It rebuilds **every** basket, not just the one being looked at. An earlier
 * version rebuilt a single hardcoded option, which quietly deleted the other
 * baskets on the first tick of the stream — and the comparison between baskets
 * is the entire decision this product exists to support.
 *
 * None of this calls the model. `intake()` does the language work once and
 * produces a `QuoteRequest`; everything here is solving against fresh books, so
 * a re-price costs venue latency and some WASM, not a model round trip.
 *
 * It never mutates what it re-prices. The previous row stays exactly as it was
 * read and the result is a NEW row pointing back at it — the question a quote
 * answers is "what did I agree to", and an edit destroys the answer.
 */

export class MarketGone extends Error {
  constructor() {
    super('that market is no longer listed');
    this.name = 'MarketGone';
  }
}

export interface Repriced {
  next: StoredQuote;
  view: QuotedView;
  snapshotId: string;
  /** False when the book has not moved: the id is a content hash. */
  snapshotChanged: boolean;
}

export async function reprice(previous: StoredQuote, owner: string): Promise<Repriced> {
  const index = await marketIndex();
  const event = index.events.find((e) => e.eventId === previous.record.request.eventId);
  if (event === undefined) throw new MarketGone();

  const gamma = index.byId.get(event.eventId);
  const questionFor = (marketId: string): string =>
    gamma?.markets.find((m) => m.id === marketId)?.question ?? '';

  const deps = quoteSession({
    fetchEvent: async (eventId: string) => index.byId.get(eventId) ?? (await fetchEvent(eventId)),
    fetchBooks,
    saveSnapshot: putSnapshot,
  });

  // The primary first: it is the record the quote is identified by, and every
  // alternative is re-measured against its target.
  const options = {
    calibrationMapVersion: previous.record.meta.calibrationMapVersion,
    jevModelVersion: previous.record.meta.jevModelVersion,
    ruleFlags: previous.record.meta.ruleFlags,
    correlationResidual: previous.record.meta.correlationResidual,
  };
  const primary = await quote(previous.record.request, deps, options);

  // `buildBasketOptions` pins one snapshot across its own solves, so the
  // baskets it returns are priced at the same instant and stay comparable.
  const stops = await buildBasketOptions(previous.record.request, deps, options, primary);
  const alternatives = primary.request.protectionGoal ? [] : await buildAlternatives(primary, deps, options);

  const { view, optionRecords } = composeView({
    primary,
    event,
    stops,
    alternatives,
    assumptions: previous.view.assumptions,
    questionFor,
    linkFor: (marketId) => linkForMarket(gamma, marketId),
  });

  const next = await putQuote(owner, primary, view, previous.id, previous.revision + 1, optionRecords);

  return {
    next,
    view,
    snapshotId: primary.resolved.snapshotId,
    snapshotChanged: primary.resolved.snapshotId !== previous.record.resolved.snapshotId,
  };
}
