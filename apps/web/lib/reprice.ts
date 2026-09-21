import { fetchBooks, fetchEvent } from '@polyhedge/venue';
import { quote } from '@polyhedge/engine';
import { putQuote, putSnapshot, type StoredQuote } from './store.js';
import { marketIndex } from './markets.js';
import { toOptionView, toQuotedView } from './view-model.js';
import type { QuotedView } from './view-model.js';

/**
 * Re-pricing one quote at the current book.
 *
 * Shared by the request route and the stream, because they must produce the
 * same thing. A stream that re-priced by a slightly different path would give a
 * user one number while watching and another on reload, and there would be no
 * way to say which was real.
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

  const record = await quote(previous.record.request, {
    fetchEvent: async (eventId) => index.byId.get(eventId) ?? (await fetchEvent(eventId)),
    fetchBooks,
    saveSnapshot: putSnapshot,
  });

  const view = toQuotedView(
    record,
    event,
    [
      toOptionView(
        'stop-0',
        previous.view.options[0]?.name ?? 'Your budget',
        '',
        record,
        event.ladder.unit,
        questionFor,
      ),
    ],
    previous.view.assumptions,
  );

  const next = await putQuote(owner, record, view, previous.id, previous.revision + 1);

  return {
    next,
    view,
    snapshotId: record.resolved.snapshotId,
    snapshotChanged: record.resolved.snapshotId !== previous.record.resolved.snapshotId,
  };
}
