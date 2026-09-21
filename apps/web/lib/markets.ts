import { fetchEvent, type GammaEvent } from '@polyhedge/venue';
import { indexEvent, type IndexedEvent } from '@polyhedge/intake';

/**
 * The venue's open ladder markets, indexed once and shared.
 *
 * Discovery costs one list call per page plus one fetch per candidate event —
 * the list endpoint abridges its market objects and omits the description prose
 * the settlement instant is read out of. Doing that per submit would be minutes
 * of latency and hundreds of requests for data that changes on the order of
 * hours, so it is cached in-process behind a single in-flight promise.
 *
 * Deliberately no tag filter. An earlier version discovered only `tag_slug=crypto`,
 * which quietly confined the product to the two families the tag happens to
 * carry while the engine can price any ladder the venue publishes.
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

interface ListedEvent {
  id?: string;
  negRisk?: boolean;
  endDate?: string;
  markets?: unknown[];
}

/** Cheap pre-filter on the list payload, before paying for a per-event fetch. */
function worthFetching(raw: ListedEvent, now: number): boolean {
  if (raw.id === undefined || raw.negRisk !== true) return false;
  if ((raw.markets?.length ?? 0) < 3) return false;
  return raw.endDate !== undefined && Date.parse(raw.endDate) > now;
}

async function build(): Promise<MarketIndex> {
  const now = Date.now();
  const index: MarketIndex = {
    events: [],
    resolutionText: new Map(),
    bracketLabels: new Map(),
    byId: new Map(),
    builtAt: now,
  };

  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetch(
      `${GAMMA}/events?closed=false&limit=100&offset=${page * 100}&order=volume24hr&ascending=false`,
    );
    if (!res.ok) break;
    const listed = (await res.json()) as ListedEvent[];
    if (!Array.isArray(listed) || listed.length === 0) break;
    for (const raw of listed) if (worthFetching(raw, now)) ids.push(raw.id!);
  }

  // Bounded concurrency: enough to keep the build to seconds, few enough that a
  // cold start is not mistaken for an attack on the venue.
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
        try {
          const event = await fetchEvent(id);
          const one = indexEvent(event);
          // An event we cannot read as a ladder is one we must not quote.
          if (one === null) continue;
          index.events.push(one);
          index.byId.set(event.id, event);
          index.resolutionText.set(one.eventId, event.markets[0]?.description ?? '');
          index.bracketLabels.set(one.eventId, event.markets.map((m) => m.groupItemTitle));
        } catch {
          /* unparseable is unusable; it simply does not enter the index */
        }
      }
    }),
  );

  return index;
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
