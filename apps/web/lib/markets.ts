import { listingIndex, type EventListing } from './event-listings.js';
import type { GammaEvent } from '@polyhedge/venue';
import type { IndexedEvent } from '@polyhedge/intake';
import { emptyIndex, loadSnapshot, snapshotStamp } from './catalogue-store.js';

export interface MarketCategory {
  slug: string;
  label: string;
  discoveredEvents: number;
  supportedEvents: number;
}

export interface MarketIndex {
  listings: EventListing[];
  categories: MarketCategory[];
  discoveredEvents: number;
  /** False until a full catalogue walk has completed. */
  discoveryComplete: boolean;
  events: IndexedEvent[];
  resolutionText: Map<string, string>;
  bracketLabels: Map<string, string[]>;
  byId: Map<string, GammaEvent>;
  builtAt: number;
}


// Instrumentation and route bundles can contain separate module instances.
// Share the immutable generation and in-flight read across those bundles.
type CatalogueState = { cached:MarketIndex; stamp:number; checkedAt:number; loading:Promise<void>|null };
const host=globalThis as typeof globalThis & { polyhedgeCatalogueV5?:CatalogueState };
const state=host.polyhedgeCatalogueV5??={cached:emptyIndex(),stamp:0,checkedAt:0,loading:null};
/** Only local IO. The separate worker owns discovery and publishing. */
export async function marketIndex(): Promise<MarketIndex> {
  if (Date.now() - state.checkedAt >= 1000) {
    state.loading ??= (async () => {
      try {
        const next = await snapshotStamp();
        if (next && next !== state.stamp) {
          const replacement = await loadSnapshot();
          // Construct search indexes once, before making this generation visible.
          listingIndex(replacement.listings);
          state.cached = replacement; state.stamp = next;
        }
      } catch (error) {
        console.error('[catalogue]', error instanceof Error ? error.message : error);
      } finally { state.checkedAt = Date.now(); state.loading = null; }
    })();
    if (!state.stamp) await state.loading;
  }
  return state.cached;
}
