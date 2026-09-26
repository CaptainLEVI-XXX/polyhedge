import { IntentProblem, signIntent } from '@/lib/intents';
import { requireCaller } from '@/lib/identity';
import { handleRouteError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Accepts one signature for one prepared order.
 *
 * Deliberately does NOT submit. Submitting is the irreversible step, and it
 * only ever runs against a signature that is already on disk — so the write
 * happens here and the send happens after, never in the same breath.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const caller = requireCaller(request);
    const { id } = await context.params;
    const body = (await request.json()) as { wallet?: unknown; signature?: unknown };

    if (typeof body.wallet !== 'string' || typeof body.signature !== 'string') {
      return Response.json(
        { error: 'A wallet and a signature are required.', code: 'bad_request' },
        { status: 400 },
      );
    }

    const intent = await signIntent(id, caller.id, body.wallet, body.signature);
    return Response.json({ intentId: intent.id, status: intent.status, legIndex: intent.legIndex });
  } catch (error) {
    if (error instanceof IntentProblem) {
      const status = error.code === 'not_found' ? 404 : 409;
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    return handleRouteError('api/intent/sign', error);
  }
}
