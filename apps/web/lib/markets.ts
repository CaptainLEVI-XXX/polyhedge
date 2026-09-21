import { fetchEvent, parseEvent, type GammaEvent } from '@polyhedge/venue';
import { indexEvent, type IndexedEvent } from '@polyhedge/intake';

/**
 * The venue's open ladder markets, indexed once and shared.
 *
 * An earlier version re-fetched every candidate event by id, on the belief
 * that the list endpoint abridged its markets and omitted the description the
 * settlement instant is read out of. **That was wrong** — the list payload
 * carries `description` and `groupItemTitle` already — and it cost around
 * seven hundred extra round trips on a cold start, for an index that came out
 * the same either way. Measured: 51 of 100 list entries parse directly and 15
 * index, which is what the per-event fetches were producing.
 *
 * So pages are parsed where they land and fetched in parallel. What is left is
 * bounded by the venue's own page latency rather than by our fan-out.
 *
 * Deliberately no tag filter. Discovering only `tag_slug=crypto` would quietly
 * confine the product to the families that tag happens to carry, while the
 * engine prices any ladder the venue publishes.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 15;

export interface MarketIndex {
  events: IndexedEvent[];
  resolutionText: Map<string, string>;
  bracketLabels: Map<string, string[]>;
  byId: Map<string, GammaEvent>;
  builtAt: number;
}

let cached: MarketIndex | null = null;
let inFlight: Promise<MarketIndex> | null = null;

const PAGES = 15;
const PAGE_CONCURRENCY = 6;

async function page(offset: number): Promise<unknown[]> {
  const res = await fetch(
    `${GAMMA}/events?closed=false&limit=100&offset=${offset}&order=volume24hr&ascending=false`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? body : [];
}

async function build(): Promise<MarketIndex> {
  const index: MarketIndex = {
    events: [],
    resolutionText: new Map(),
    bracketLabels: new Map(),
    byId: new Map(),
    builtAt: Date.now(),
  };

  const offsets = Array.from({ length: PAGES }, (_, i) => i * 100);
  const pages: unknown[][] = [];

  // Pages in parallel, with a bound: the venue is not ours to flood, and past
  // a handful at once its own latency is the floor anyway.
  for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
    const batch = offsets.slice(i, i + PAGE_CONCURRENCY);
    const got = await Promise.all(batch.map(page));
    pages.push(...got);
    // A short page means the listing ran out; nothing beyond it to ask for.
    if (got.some((p) => p.length === 0)) break;
  }

  for (const listed of pages) {
    for (const raw of listed) {
      let event: GammaEvent;
      try {
        event = parseEvent(raw);
      } catch {
        // An event we cannot parse is an event we must not quote.
        continue;
      }
      const one = indexEvent(event);
      if (one === null) continue;
      index.events.push(one);
      index.byId.set(event.id, event);
      index.resolutionText.set(one.eventId, event.markets[0]?.description ?? '');
      index.bracketLabels.set(one.eventId, event.markets.map((m) => m.groupItemTitle));
    }
  }

  return index;
}

/**
 * Builds the index without anybody waiting for it.
 *
 * Discovery takes seconds and changes on the order of hours, so making the
 * first person through the door pay for it is pure waste — they experience the
 * venue's entire catalogue being read as though it were the cost of their own
 * question. Called at module load, so by the time a request arrives the work is
 * usually done or already in flight.
 */
export function warmMarketIndex(): void {
  void marketIndex().catch(() => {
    // A failed warm is not an error: the next real request rebuilds, and
    // crashing a boot over a slow venue would be worse than a slow first quote.
  });
}

export async function marketIndex(): Promise<MarketIndex> {
  if (cached !== null && Date.now() - cached.builtAt < TTL_MS) return cached;
  // Collapse concurrent cold starts onto one build rather than stampeding the
  // venue with identical discovery.
  inFlight ??= build()
    .then((built) => {
      cached = built;
      return built;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// Start discovery at import, so no request is the one that pays for it.
warmMarketIndex();
