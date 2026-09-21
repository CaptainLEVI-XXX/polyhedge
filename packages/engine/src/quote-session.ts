import type { QuoteDeps } from './quote.js';

const sessions = new WeakSet<QuoteDeps>();

/** One comparison/reprice operation, never a cross-request price cache. */
export function quoteSession(deps: QuoteDeps): QuoteDeps {
  if (sessions.has(deps)) return deps;
  const events = new Map<string, ReturnType<QuoteDeps['fetchEvent']>>();
  const books = new Map<string, ReturnType<QuoteDeps['fetchBooks']>>();
  const snapshots = new Map<string, Promise<string>>();
  const session: QuoteDeps = {
    ...deps,
    fetchEvent(id) {
      let pending = events.get(id);
      if (!pending) { pending = deps.fetchEvent(id); events.set(id, pending); }
      return pending;
    },
    fetchBooks(ids) {
      const sorted = [...new Set(ids)].sort();
      const key = JSON.stringify(sorted);
      let pending = books.get(key);
      if (!pending) { pending = deps.fetchBooks(sorted); books.set(key, pending); }
      return pending;
    },
    saveSnapshot(value) {
      // Different token sets must never inherit another set's snapshot ID.
      const key = JSON.stringify([...value].sort((a, b) => a.assetId.localeCompare(b.assetId)));
      let pending = snapshots.get(key);
      if (!pending) { pending = deps.saveSnapshot(value); snapshots.set(key, pending); }
      return pending;
    },
  };
  sessions.add(session);
  return session;
}
