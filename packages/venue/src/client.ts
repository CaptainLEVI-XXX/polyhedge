import { parseBook, parseEvent, type ClobBook, type GammaEvent } from './schemas.js';

export const GAMMA = 'https://gamma-api.polymarket.com';
export const CLOB = 'https://clob.polymarket.com';
const BOOKS_BATCH = 500; // documented cap

async function getJson(url: string, signal: AbortSignal = AbortSignal.timeout(8_000)): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchEvent(id: string, signal?: AbortSignal): Promise<GammaEvent> {
  return parseEvent(await getJson(`${GAMMA}/events/${id}`,signal));
}

export async function searchEvents(q: string): Promise<GammaEvent[]> {
  const raw = await getJson(`${GAMMA}/public-search?q=${encodeURIComponent(q)}`);
  const events = (raw as { events?: unknown[] }).events ?? [];
  // An event we cannot parse is an event we must not use.
  return events.flatMap((e) => { try { return [parseEvent(e)]; } catch { return []; } });
}

export async function fetchBook(tokenId: string): Promise<ClobBook> {
  return parseBook(await getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`));
}

export async function fetchBooks(tokenIds: string[], signal: AbortSignal = AbortSignal.timeout(8_000)): Promise<ClobBook[]> {
  const out: ClobBook[] = [];
  for (let i = 0; i < tokenIds.length; i += BOOKS_BATCH) {
    const res = await fetch(`${CLOB}/books`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tokenIds.slice(i, i + BOOKS_BATCH).map((token_id) => ({ token_id }))),
    });
    if (!res.ok) throw new Error(`POST /books -> ${res.status}`);
    out.push(...((await res.json()) as unknown[]).map(parseBook));
  }
  return out;
}
