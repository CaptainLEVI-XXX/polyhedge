import { fetchBooks, fetchEvent } from '@polyhedge/venue';
import { quote } from '@polyhedge/engine';
import { getQuote, NotYours, putQuote, putSnapshot } from '@/lib/store';
import { marketIndex } from '@/lib/markets';
import { requireCaller, rateLimit } from '@/lib/identity';
import { toOptionView, toQuotedView } from '@/lib/view-model';
import { handleRouteError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Re-prices an existing quote at the current book.
 *
 * It never mutates what it re-prices. The previous row stays exactly as the
 * user read it and the result is a NEW row pointing back at it — because the
 * question a frozen quote answers is "what did I agree to", and an edit would
 * destroy the answer.
 *
 * The snapshot id may well come back unchanged: it is a content hash, so an
 * unmoved book produces the same one. That is information, not a bug — it
 * means the market did not move.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const caller = requireCaller(request);
    rateLimit(caller, 'reprice', 30, 60_000);

    const { id } = await context.params;
    const previous = await getQuote(id, caller.id);

    const index = await marketIndex();
    const event = index.events.find((e) => e.eventId === previous.record.request.eventId);
    if (event === undefined) {
      return Response.json(
        { error: 'That market is no longer listed.', code: 'gone' },
        { status: 409 },
      );
    }

    const gamma = index.byId.get(event.eventId);
    const questionFor = (marketId: string): string =>
      gamma?.markets.find((m) => m.id === marketId)?.question ?? '';

    const record = await quote(previous.record.request, {
      fetchEvent: async (eventId) => index.byId.get(eventId) ?? (await fetchEvent(eventId)),
      fetchBooks,
      saveSnapshot: putSnapshot,
    });

    const unit = event.ladder.unit;
    const view = toQuotedView(
      record,
      event,
      [toOptionView('stop-0', previous.view.options[0]?.name ?? 'Your budget', '', record, unit, questionFor)],
      previous.view.assumptions,
    );

    const next = await putQuote(caller.id, record, view, previous.id, previous.revision + 1);

    return Response.json({
      quoteId: next.id,
      revision: next.revision,
      previousId: previous.id,
      /** Equal to the previous one when the book has not moved. */
      snapshotId: record.resolved.snapshotId,
      snapshotChanged: record.resolved.snapshotId !== previous.record.resolved.snapshotId,
      view,
    });
  } catch (error) {
    if (error instanceof NotYours) {
      return Response.json({ error: 'No such quote.', code: 'not_found' }, { status: 404 });
    }
    return handleRouteError('api/quote/reprice', error);
  }
}
