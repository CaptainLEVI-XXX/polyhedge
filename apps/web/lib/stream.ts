import type { ClobBook } from '@polyhedge/venue';
import { assess, debounce, type Watch } from './freshness.js';

/**
 * One socket to the venue, shared by everyone watching it.
 *
 * Two decisions here are worth stating, because the obvious alternatives are
 * both worse.
 *
 * **The socket lives on the server, not in the browser.** Re-pricing runs the
 * LP solver, which is server-side, so a browser socket would only be able to
 * forward what it heard back to us. It would also expose the whole subscription
 * surface per tab and multiply the venue's load by the number of open tabs.
 *
 * **What arrives here triggers a re-price; it never becomes the price.** The
 * book this module maintains from `price_change` deltas is good enough to
 * answer "did anything that matters move", and that is all it is asked. Every
 * quote is still priced by `quote()` against a freshly fetched, content-hashed
 * snapshot. So a delta we applied imperfectly can cost a redundant solve or a
 * late one — it can never produce a number a user sees. Maintaining a book well
 * enough to *price* from is a different and much more dangerous job, and this
 * does not attempt it.
 */

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** No traffic for this long and we say so rather than implying freshness. */
const STALE_AFTER_MS = 30_000;
const DEBOUNCE_MS = 750;
const MAX_CONCURRENT_SOLVES = 4;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface Watcher {
  id: string;
  watch: Watch;
  /** Runs a re-price. Resolves when the result has been delivered or dropped. */
  resolve(reason: string): Promise<void>;
  /** Feed-level notices, distinct from a new price. */
  notify(state: 'live' | 'stale' | 'reconnected'): void;
}

interface BookMessage {
  event_type: 'book';
  asset_id: string;
  market: string;
  timestamp?: string;
  hash?: string;
  asks?: { price: string; size: string }[];
  bids?: { price: string; size: string }[];
}

interface PriceChangeMessage {
  event_type: 'price_change';
  asset_id: string;
  changes?: { price: string; size: string; side: string }[];
}

interface TickSizeMessage {
  event_type: 'tick_size_change';
  asset_id: string;
  new_tick_size?: string;
}

/**
 * Frames arrive as whatever the venue sends, which is not ours to declare. So
 * they are read as loose records and narrowed by `event_type` at the point of
 * use — an unknown frame is skipped rather than coerced into a shape we assumed.
 */
type Frame = Record<string, unknown> & { event_type?: unknown };

function toBook(msg: BookMessage): ClobBook {
  const level = (l: { price: string; size: string }) => ({
    priceMicros: Math.round(Number(l.price) * 1_000_000),
    size: Number(l.size),
  });
  return {
    market: msg.market,
    assetId: msg.asset_id,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    hash: msg.hash ?? '',
    asks: (msg.asks ?? []).map(level).sort((a, b) => a.priceMicros - b.priceMicros),
    bids: (msg.bids ?? []).map(level).sort((a, b) => b.priceMicros - a.priceMicros),
  };
}

/** Applies a delta to a tracked book. Trigger fidelity only — never a price. */
function applyChange(book: ClobBook, change: { price: string; size: string; side: string }): ClobBook {
  const priceMicros = Math.round(Number(change.price) * 1_000_000);
  const size = Number(change.size);
  const side = change.side.toUpperCase() === 'SELL' ? 'asks' : 'bids';
  const rest = book[side].filter((l) => l.priceMicros !== priceMicros);
  // Size zero is a removal, which is exactly the event that invalidates a fill
  // we were counting on. Dropping it would be the worst thing to drop.
  const levels = size > 0 ? [...rest, { priceMicros, size }] : rest;
  levels.sort((a, b) => (side === 'asks' ? a.priceMicros - b.priceMicros : b.priceMicros - a.priceMicros));
  return { ...book, [side]: levels, timestamp: new Date().toISOString() };
}

export class MarketFeed {
  private socket: WebSocket | null = null;
  private readonly watchers = new Map<string, Watcher>();
  private readonly books = new Map<string, ClobBook>();
  private readonly pending = new Map<string, { fire: () => void; cancel: () => void }>();
  private readonly reasons = new Map<string, string>();
  private inFlight = 0;
  private queue: string[] = [];
  private attempt = 0;
  private lastMessageAt = Date.now();
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private resubscribe: { fire: () => void; cancel: () => void } | null = null;
  private announcedStale = false;

  constructor(private readonly connect: (url: string) => WebSocket = (url) => new WebSocket(url)) {}

  add(watcher: Watcher): () => void {
    this.watchers.set(watcher.id, watcher);
    // One reconnect for a burst of arrivals, not one per arrival.
    this.resubscribe ??= debounce(() => this.open(), 100);
    this.resubscribe.fire();
    this.startStaleClock();
    return () => this.remove(watcher.id);
  }

  private remove(id: string): void {
    this.watchers.delete(id);
    this.pending.get(id)?.cancel();
    this.pending.delete(id);
    this.reasons.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
    if (this.watchers.size === 0) this.close();
  }

  /** Every token any watcher may care about, held or merely eligible. */
  private tokens(): string[] {
    const all = new Set<string>();
    for (const w of this.watchers.values()) for (const t of w.watch.eligibleTokens) all.add(t);
    return [...all];
  }

  private open(): void {
    if (this.watchers.size === 0) return;
    this.close();

    const socket = this.connect(WS_URL);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      socket.send(JSON.stringify({ type: 'market', assets_ids: this.tokens() }));
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      this.lastMessageAt = Date.now();
      if (this.announcedStale) {
        this.announcedStale = false;
        for (const w of this.watchers.values()) w.notify('live');
      }
      this.ingest(String(event.data));
    });

    socket.addEventListener('close', () => this.retry());
    socket.addEventListener('error', () => this.retry());
  }

  private retry(): void {
    if (this.watchers.size === 0) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    this.attempt += 1;
    setTimeout(() => {
      if (this.watchers.size === 0) return;
      // A reconnect re-subscribes, and the venue answers with a full `book` per
      // token. So the gap closes itself: we never resume from a book that went
      // stale while we were away, we replace it.
      this.books.clear();
      for (const w of this.watchers.values()) w.notify('reconnected');
      this.open();
    }, wait);
  }

  private startStaleClock(): void {
    this.staleTimer ??= setInterval(() => {
      if (this.watchers.size === 0 || this.announcedStale) return;
      if (Date.now() - this.lastMessageAt < STALE_AFTER_MS) return;
      // Silence is not calm. A quiet socket and a quiet market look identical
      // from here, so we say which one we cannot tell rather than letting the
      // last price sit there looking current.
      this.announcedStale = true;
      for (const w of this.watchers.values()) w.notify('stale');
    }, 5_000);
  }

  private close(): void {
    if (this.socket === null) return;
    const socket = this.socket;
    this.socket = null;
    try {
      socket.close();
    } catch {
      // Closing an already-dead socket is not a failure worth propagating.
    }
    if (this.watchers.size === 0 && this.staleTimer !== null) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  /** Exposed for tests: feed a raw frame without a socket. */
  ingest(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const frames: Frame[] = Array.isArray(parsed) ? (parsed as Frame[]) : [parsed as Frame];

    for (const frame of frames) {
      if (typeof frame?.asset_id !== 'string') continue;
      const assetId = frame.asset_id;

      if (frame.event_type === 'book') {
        this.observe(toBook(frame as unknown as BookMessage));
      } else if (frame.event_type === 'price_change') {
        const current = this.books.get(assetId);
        // No tracked book yet means the next `book` frame will establish one.
        // Guessing from a delta alone would invent depth that was never quoted.
        if (current === undefined) continue;
        let next = current;
        for (const change of (frame as unknown as PriceChangeMessage).changes ?? []) {
          next = applyChange(next, change);
        }
        this.observe(next);
      } else if (frame.event_type === 'tick_size_change') {
        const tick = Number((frame as unknown as TickSizeMessage).new_tick_size ?? 0);
        if (!Number.isFinite(tick) || tick <= 0) continue;
        // A wider tick changes what counts as a move at all, so every watcher
        // of this token is re-priced once rather than silently judged by the
        // old granularity.
        for (const w of this.watchers.values()) {
          if (!w.watch.eligibleTokens.includes(assetId)) continue;
          w.watch.tickMicros = Math.round(tick * 1_000_000);
          this.schedule(w.id, 'tick size changed');
        }
      }
    }
  }

  private observe(next: ClobBook): void {
    const previous = this.books.get(next.assetId);
    this.books.set(next.assetId, next);

    for (const watcher of this.watchers.values()) {
      const verdict = assess(watcher.watch, previous, next);
      if (!verdict.resolve) continue;
      this.schedule(watcher.id, verdict.reason);
    }
  }

  private schedule(id: string, reason: string): void {
    this.reasons.set(id, reason);
    let timer = this.pending.get(id);
    if (timer === undefined) {
      timer = debounce(() => this.run(id), DEBOUNCE_MS);
      this.pending.set(id, timer);
    }
    timer.fire();
  }

  private run(id: string): void {
    if (!this.watchers.has(id)) return;
    if (this.inFlight >= MAX_CONCURRENT_SOLVES) {
      // Queue rather than pile up: an unbounded fan-out of solves on a busy
      // book would starve the request path that people are actually waiting on.
      if (!this.queue.includes(id)) this.queue.push(id);
      return;
    }
    const watcher = this.watchers.get(id);
    if (watcher === undefined) return;

    this.inFlight += 1;
    const reason = this.reasons.get(id) ?? 'book moved';
    this.reasons.delete(id);

    void watcher
      .resolve(reason)
      .catch(() => {
        // A failed re-price leaves the last good quote on screen. It is old,
        // and the stale notice says so; replacing it with an error would throw
        // away the only usable number the user has.
      })
      .finally(() => {
        this.inFlight -= 1;
        const nextId = this.queue.shift();
        if (nextId !== undefined) this.run(nextId);
      });
  }

  /** Exposed for tests and the health check. */
  get size(): number {
    return this.watchers.size;
  }
}

let shared: MarketFeed | null = null;

export function marketFeed(): MarketFeed {
  shared ??= new MarketFeed();
  return shared;
}
