/**
 * Upstream failures become messages a stranger can act on.
 *
 * Three different things go wrong here — the model times out, the venue rate
 * limits us, a payload is malformed — and they need three different sentences.
 * None of them is a stack trace: the detail goes to the server log, where it is
 * useful, and never to the browser, where it is noise at best and a leak at
 * worst.
 */

export interface SafeError {
  status: number;
  /** Shown to the user. Plain register. */
  message: string;
  /** Machine-readable, for the client to branch on. Never displayed. */
  code: 'model_unavailable' | 'venue_unavailable' | 'bad_request' | 'catalogue_pending' | 'unknown';
}

const MODEL_HINTS = ['jev', 'typesafe', 'systemone', 'ai_gateway'];
const VENUE_HINTS = ['gamma', 'clob', 'polymarket', 'book'];

export function toSafeError(error: unknown): SafeError {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (raw === 'catalogue_pending') return { status:503, code:'catalogue_pending',
    message:'Market discovery is still updating. Please try again shortly; a matching market may still be available.' };

  if (lower.includes('api key') || lower.includes('ai_gateway_api_key')) {
    // Never echo anything key-shaped, even a complaint about one.
    return {
      status: 503,
      code: 'model_unavailable',
      message: 'This is not configured to read your words right now. Nothing was quoted.',
    };
  }

  if (MODEL_HINTS.some((h) => lower.includes(h)) || lower.includes('timeout')) {
    return {
      status: 503,
      code: 'model_unavailable',
      message: 'We could not read that just now. Try again in a moment — nothing was quoted.',
    };
  }

  if (VENUE_HINTS.some((h) => lower.includes(h)) || lower.includes('429')) {
    return {
      status: 503,
      code: 'venue_unavailable',
      message: 'Prices are not reachable from the exchange right now. Nothing was quoted.',
    };
  }

  return {
    status: 500,
    code: 'unknown',
    message: 'Something went wrong on our side. Nothing was quoted.',
  };
}

/** Logs the real thing, returns the safe thing. */
export function handleRouteError(where: string, error: unknown): Response {
  const safe = toSafeError(error);
  console.error(`[${where}]`, error);
  return Response.json({ error: safe.message, code: safe.code }, { status: safe.status });
}
