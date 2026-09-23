import { GAMMA } from './client.js';

/** Walk all open categories using the venue cursor, not a volume-ranked cutoff. */
export async function* openEventBatches(fetchImpl: typeof fetch = fetch, after?: string): AsyncGenerator<{ events: unknown[]; nextCursor: string | null }> {
  let cursor: string | undefined = after;
  const seen = new Set<string>(after ? [after] : []);
  do {
    const url = new URL(`${GAMMA}/events/keyset`);
    url.search = new URLSearchParams({ closed: 'false', limit: '100', order: 'id', ascending: 'true',
      ...(cursor ? { after_cursor: cursor } : {}) }).toString();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Event discovery failed: HTTP ${response.status}`);
    const body = await response.json() as { events?: unknown; next_cursor?: unknown };
    if (!body || !Array.isArray(body.events)
      || (body.next_cursor != null && typeof body.next_cursor !== 'string')) {
      throw new Error('Invalid event discovery page');
    }
    cursor = typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error('Event discovery cursor did not advance');
    if (cursor) seen.add(cursor);
    yield { events: body.events, nextCursor: cursor ?? null };
  } while (cursor);
}
