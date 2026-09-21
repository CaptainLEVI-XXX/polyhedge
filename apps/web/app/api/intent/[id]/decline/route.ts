import { declineIntent, IntentProblem } from '@/lib/intents';
import { requireCaller } from '@/lib/identity';
import { handleRouteError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Records that the user refused this order.
 *
 * Refusing is a real outcome, not a timeout to wait out: the basket stops here
 * and whatever was already filled is reported as held, rather than the app
 * retrying a prompt somebody has already said no to.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const caller = requireCaller(request);
    const { id } = await context.params;
    const intent = await declineIntent(id, caller.id);
    return Response.json({ intentId: intent.id, status: intent.status });
  } catch (error) {
    if (error instanceof IntentProblem) {
      const status = error.code === 'not_found' ? 404 : 409;
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    return handleRouteError('api/intent/decline', error);
  }
}
