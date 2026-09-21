import { getQuote, NotYours } from '@/lib/store';
import { MarketGone, reprice } from '@/lib/reprice';
import { requireCaller, rateLimit } from '@/lib/identity';
import { handleRouteError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Re-prices an existing quote at the current book, on demand.
 *
 * The work is in `lib/reprice`, shared with the stream so that watching and
 * asking cannot disagree about the price.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const caller = requireCaller(request);
    rateLimit(caller, 'reprice', 30, 60_000);

    const { id } = await context.params;
    const previous = await getQuote(id, caller.id);
    const result = await reprice(previous, caller.id);

    return Response.json({
      quoteId: result.next.id,
      revision: result.next.revision,
      previousId: previous.id,
      /** Equal to the previous one when the book has not moved. */
      snapshotId: result.snapshotId,
      snapshotChanged: result.snapshotChanged,
      view: result.view,
    });
  } catch (error) {
    if (error instanceof NotYours) {
      return Response.json({ error: 'No such quote.', code: 'not_found' }, { status: 404 });
    }
    if (error instanceof MarketGone) {
      return Response.json(
        { error: 'That market is no longer listed.', code: 'gone' },
        { status: 409 },
      );
    }
    return handleRouteError('api/quote/reprice', error);
  }
}
