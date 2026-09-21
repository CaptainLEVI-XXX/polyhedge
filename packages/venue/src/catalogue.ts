import { GAMMA } from './client.js';

/** Walk all open categories using the venue cursor, not a volume-ranked cutoff. */
export async function* openEventPages(fetchImpl: typeof fetch = fetch): AsyncGenerator<unknown[]> {
  let cursor: string | undefined;
  const seen = new Set<string>();
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
    yield body.events;
    cursor = typeof body.next_cursor === 'string' && body.next_cursor !== '' ? body.next_cursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error('Event discovery cursor did not advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
}
