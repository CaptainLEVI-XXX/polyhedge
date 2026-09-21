import { requireCaller, rateLimit } from '@/lib/identity';
import { handleRouteError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLOB = 'https://clob.polymarket.com';
const TTL_MS = 5 * 60 * 1000;

interface Cached { at: number; points: number[] }
const cache = new Map<string, Cached>();

/**
 * Recent price history for one outcome token.
 *
 * Proxied rather than fetched from the browser so the cache is shared and the
 * venue sees one caller instead of one per open tab. Verified against the live
 * endpoint: a single bracket returns around 159 points over a week.
 *
 * A failure here degrades to no sparkline. Price history is context, not part
 * of the quote, and losing context must never cost someone their basket.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const caller = requireCaller(request);
    rateLimit(caller, 'history', 120, 60_000);

    const { token } = await context.params;
    if (!/^\d+$/.test(token)) {
      return Response.json({ error: 'bad token', code: 'bad_request' }, { status: 400 });
    }

    const hit = cache.get(token);
    if (hit !== undefined && Date.now() - hit.at < TTL_MS) {
      return Response.json({ points: hit.points, cached: true });
    }

    const res = await fetch(`${CLOB}/prices-history?market=${token}&interval=1w&fidelity=180`);
    if (!res.ok) return Response.json({ points: [], unavailable: true });

    const body = (await res.json()) as { history?: { t: number; p: number }[] };
    const points = (body.history ?? []).map((h) => h.p);
    cache.set(token, { at: Date.now(), points });
    return Response.json({ points, cached: false });
  } catch (error) {
    // Context, not the quote: never fail the page over it.
    if (error instanceof Error && error.message === 'rate limited') {
      return Response.json({ points: [], unavailable: true });
    }
    return handleRouteError('api/history', error);
  }
}
