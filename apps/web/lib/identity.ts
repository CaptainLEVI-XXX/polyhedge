/**
 * Who is asking, and how often they may ask.
 *
 * Privy verification lands with the wallet work; until then this resolves an
 * anonymous but stable caller. The seam exists NOW rather than later because
 * the risk is not "we have no auth yet" — it is routes being written without an
 * ownership check and nobody noticing when real identity arrives. Every route
 * that touches user state goes through `requireCaller`, so adding verification
 * is a change in one file rather than an audit of all of them.
 *
 * What is NOT here: binding sessions, quotes and executions to an owner. There
 * is nothing stored yet to bind. That check belongs with the store that holds
 * them, and is stated in the spec so it cannot be forgotten when it arrives.
 */

export interface Caller {
  /** Stable per browser today; the Privy user id once verification lands. */
  id: string;
  verified: boolean;
}

export class TooManyRequests extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('rate limited');
    this.name = 'TooManyRequests';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Anonymous identity, derived from what the request already carries.
 *
 * Deliberately not a cookie we set: this is a throttling key, not a claim about
 * anybody, and treating it as an identity would be exactly the mistake the
 * `verified` flag exists to prevent.
 */
export function requireCaller(request: Request): Caller {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded !== undefined && forwarded !== '' ? forwarded : 'local';
  return { id: `anon:${ip}`, verified: false };
}

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/**
 * A fixed window per caller per route.
 *
 * Intake is expensive on our side — a Jev round trip plus venue fetches per
 * call — so it is the one endpoint where an unbounded caller costs real money
 * rather than just CPU. In-process is the right size for one instance; a shared
 * store is a problem to solve when there is more than one.
 */
export function rateLimit(caller: Caller, route: string, limit: number, windowMs: number): void {
  const key = `${route}:${caller.id}`;
  const now = Date.now();
  const existing = windows.get(key);

  if (existing === undefined || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  existing.count += 1;
  if (existing.count > limit) {
    throw new TooManyRequests(Math.ceil((existing.resetAt - now) / 1000));
  }
}

/** Prevents a large body being read into memory before it is rejected. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error('bad_request: body too large');
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('bad_request: body too large');
  return JSON.parse(text) as unknown;
}
