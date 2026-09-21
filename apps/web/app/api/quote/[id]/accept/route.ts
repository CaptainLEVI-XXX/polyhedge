import { acceptQuote, NotYours } from '@/lib/store';
import { requireCaller } from '@/lib/identity';
import { handleRouteError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Freezes a quote. This is the boundary between exploring and consenting.
 *
 * Idempotent on purpose: a double-click is not a second decision, and a retry
 * after a dropped response must not create a second accepted thing. After this
 * the stored row is never written again — re-pricing creates a new row rather
 * than editing what the user read.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const caller = requireCaller(request);
    const { id } = await context.params;
    const accepted = await acceptQuote(id, caller.id);
    return Response.json({
      quoteId: accepted.id,
      acceptedAt: accepted.acceptedAt,
      snapshotId: accepted.record.resolved.snapshotId,
      quotedAt: accepted.record.meta.quotedAt,
    });
  } catch (error) {
    if (error instanceof NotYours) {
      // Same answer for "does not exist" and "not yours", so an id cannot be
      // probed for existence.
      return Response.json({ error: 'No such quote.', code: 'not_found' }, { status: 404 });
    }
    return handleRouteError('api/quote/accept', error);
  }
}
