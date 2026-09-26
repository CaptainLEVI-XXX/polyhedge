import { getQuote, NotYours } from '@/lib/store';
import { curveFor } from '@/lib/cost-curve';
import { requireCaller, rateLimit, TooManyRequests } from '@/lib/identity';
import { handleRouteError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The cost-versus-protection curve for one quote. Separate from pricing so the cards never wait for it. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const caller = requireCaller(request);
    rateLimit(caller, 'curve', 30, 60_000);
    const { id } = await context.params;
    const points = await curveFor(await getQuote(id, caller.id));
    return Response.json({ points }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof NotYours) return Response.json({ error: 'No such quote.' }, { status: 404 });
    if (error instanceof TooManyRequests) return Response.json({ error: 'Please retry shortly.' }, { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } });
    return handleRouteError('api/quote/curve', error);
  }
}
