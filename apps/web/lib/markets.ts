import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseEvent, openEventPages, type GammaEvent } from '@polyhedge/venue';
import { indexEvent, type IndexedEvent } from '@polyhedge/intake';

/** All open categories are discovered; compiler eligibility is checked separately. */
const TTL_MS = 10 * 60 * 1000;

/**
 * Where the built index is kept between restarts.
 *
 * Discovery walks the venue's open catalogue using cursor pagination and the result changes on the order of hours. Holding that only in
 * memory meant every restart re-read all of it, and in development that is
 * every file save. Persisting it turns a restart inside the TTL into a disk
 * read, and a restart outside the TTL into a stale-but-usable index that
 * refreshes behind the user rather than in front of them.
 */
// Inside the store directory, which is already gitignored — this is a cache of
// somebody else's public catalogue, not something to commit.
const CACHE_FILE = join(
  process.env.POLYHEDGE_STORE ?? join(process.cwd(), '.polyhedge-store'),
  'market-index.json',
);

export interface MarketCategory {
  slug: string;
  label: string;
  discoveredEvents: number;
  supportedEvents: number;
}

export interface MarketIndex {
  categories: MarketCategory[];
  discoveredEvents: number;
  /** False only for a legacy cache served while the complete catalogue refreshes. */
  discoveryComplete: boolean;
  events: IndexedEvent[];
  resolutionText: Map<string, string>;
  bracketLabels: Map<string, string[]>;
  byId: Map<string, GammaEvent>;
  builtAt: number;
}

let cached: MarketIndex | null = null;
let inFlight: Promise<MarketIndex> | null = null;
let fromDisk: Promise<MarketIndex | null> | null = null;
let scannedEvents = 0;
let refreshError: string | null = null;

export function discoveryStatus() {
  return { refreshing: inFlight !== null, scannedEvents, error: refreshError };
}

/**
 * Bumped whenever the shape of what is cached changes.
 *
 * Without it, adding a field to `GammaEvent` leaves every running instance
 * serving yesterday's shape from disk, with the new field silently absent —
 * which is exactly how market links shipped pointing at the event instead of
 * the bracket. A cache with no version is a cache that lies after a deploy.
 */
const CACHE_VERSION = 3;

/** Maps do not survive JSON, so they cross as entries and are rebuilt on read. */
interface OnDisk {
  categories?: MarketCategory[];
  discoveredEvents?: number;
  discoveryComplete?: boolean;
  version: number;
  builtAt: number;
  events: IndexedEvent[];
  resolutionText: [string, string][];
  bracketLabels: [string, string[]][];
  byId: [string, GammaEvent][];
}

async function readCache(): Promise<MarketIndex | null> {
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as OnDisk;
    if (raw.version !== CACHE_VERSION && raw.version !== 2) return null;
    if (!Array.isArray(raw.events) || raw.events.length === 0) return null;
    return {
      categories: raw.categories ?? [],
      discoveredEvents: raw.discoveredEvents ?? raw.events.length,
      discoveryComplete: raw.version === CACHE_VERSION && raw.discoveryComplete === true,
      events: raw.events,
      resolutionText: new Map(raw.resolutionText),
      bracketLabels: new Map(raw.bracketLabels),
      byId: new Map(raw.byId),
      builtAt: raw.builtAt,
    };
  } catch {
    // No cache, a partial write, or a shape from an older build. Any of those
    // means discovery runs — never that a request fails.
    return null;
  }
}

async function writeCache(index: MarketIndex): Promise<void> {
  const payload: OnDisk = {
    version: CACHE_VERSION,
    categories: index.categories,
    discoveredEvents: index.discoveredEvents,
    discoveryComplete: index.discoveryComplete,
    builtAt: index.builtAt,
    events: index.events,
    resolutionText: [...index.resolutionText],
    bracketLabels: [...index.bracketLabels],
    byId: [...index.byId],
  };
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    // Written beside and renamed: a crash mid-write would otherwise leave a
    // truncated file that parses as an index with a few hundred events missing.
    const temporary = `${CACHE_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(payload), 'utf8');
    await rename(temporary, CACHE_FILE);
  } catch {
    // A cache that cannot be written is a slow start, not a broken one.
  }
}

async function build(): Promise<MarketIndex> {
  scannedEvents = 0;
  refreshError = null;
  const index: MarketIndex = {
    categories: [], discoveredEvents: 0, discoveryComplete: false,
    events: [], resolutionText: new Map(), bracketLabels: new Map(), byId: new Map(), builtAt: Date.now(),
  };
  const categories = new Map<string, MarketCategory>();
  const seen = new Set<string>();
  for await (const page of openEventPages()) {
    for (const raw of page) {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid discovery event');
      const entry = raw as { id?: unknown; tags?: unknown };
      if (typeof entry.id !== 'string') throw new Error('Discovery event has no ID');
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      index.discoveredEvents++;
      scannedEvents = index.discoveredEvents;
      const tags = new Set<string>();
      if (Array.isArray(entry.tags)) {
        for (const tag of entry.tags) {
          if (!tag || typeof tag.slug !== 'string' || typeof tag.label !== 'string') continue;
          if (tags.has(tag.slug)) continue;
          tags.add(tag.slug);
          const category = categories.get(tag.slug) ?? {
            slug: tag.slug, label: tag.label, discoveredEvents: 0, supportedEvents: 0,
          };
          category.discoveredEvents++;
          categories.set(tag.slug, category);
        }
      }
      // Keep category coverage even when this event cannot be compiled.
      let event: GammaEvent;
      try { event = parseEvent(raw); } catch { continue; }
      const one = indexEvent(event);
      if (one === null) continue;
      for (const tag of tags) categories.get(tag)!.supportedEvents++;
      index.events.push(one);
      index.byId.set(event.id, event);
      index.resolutionText.set(one.eventId, event.markets[0]?.description ?? '');
      index.bracketLabels.set(one.eventId, event.markets.map(m => m.groupItemTitle));
    }
  }
  index.categories = [...categories.values()].sort((a, b) => a.label.localeCompare(b.label));
  index.discoveryComplete = true;
  index.builtAt = Date.now();
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

function refresh(): Promise<MarketIndex> {
  // Collapse concurrent cold starts onto one build rather than stampeding the
  // venue with identical discovery.
  inFlight ??= build()
    .then((built) => {
      cached = built;
      void writeCache(built);
      return built;
    })
    .catch((error: unknown) => {
      refreshError = error instanceof Error ? error.message : 'Catalogue refresh failed';
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function marketIndex(): Promise<MarketIndex> {
  if (cached !== null && cached.discoveryComplete && Date.now() - cached.builtAt < TTL_MS) return cached;

  if (cached === null) {
    fromDisk ??= readCache();
    const disk = await fromDisk;
    if (disk !== null) cached = disk;
  }

  if (cached !== null) {
    const age = Date.now() - cached.builtAt;
    if (cached.discoveryComplete && age < TTL_MS) return cached;
    // Stale but usable: serve it now and rebuild behind the request. A user
    // waiting eight seconds to be told about markets that have barely changed
    // is paying for our bookkeeping, not for their answer.
    void refresh().catch(() => {
      // The stale index stays served; the next request tries again.
    });
    return cached;
  }

  return refresh();
}

// Start discovery at import, so no request is the one that pays for it.
warmMarketIndex();
