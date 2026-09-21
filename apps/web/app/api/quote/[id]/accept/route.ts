import { acceptQuote, NotYours, QuoteImmutable } from '@/lib/store';
import { requireCaller, readJsonBody } from '@/lib/identity';
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
    const body = await readJsonBody(request, 2048) as { optionId?: unknown };
    if (!body || typeof body.optionId !== 'string') throw new Error('bad_request: select a basket');
    const accepted = await acceptQuote(id, caller.id, body.optionId);
    return Response.json({
      quoteId: accepted.id,
      acceptedAt: accepted.acceptedAt,
      snapshotId: accepted.record.resolved.snapshotId,
      quotedAt: accepted.record.meta.quotedAt,
    });
  } catch (error) {
    if (error instanceof QuoteImmutable) return Response.json({ error: 'Another basket was already pinned.' }, { status: 409 });
    if (error instanceof Error && error.message.startsWith('bad_request')) {
      return Response.json({ error: 'That basket cannot be pinned. Rebuild the quote and select a basket.' }, { status: 400 });
    }
    if (error instanceof NotYours) {
      // Same answer for "does not exist" and "not yours", so an id cannot be
      // probed for existence.
      return Response.json({ error: 'No such quote.', code: 'not_found' }, { status: 404 });
    }
    return handleRouteError('api/quote/accept', error);
  }
}
