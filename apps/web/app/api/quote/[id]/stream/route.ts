import { randomUUID } from 'node:crypto';
import type { ClobBook } from '@polyhedge/venue';
import { getQuote, getSnapshot, NotYours } from '@/lib/store';
import { MarketGone, reprice } from '@/lib/reprice';
import { marketFeed } from '@/lib/stream';
import { mayApply, watchFor } from '@/lib/freshness';
import { requireCaller } from '@/lib/identity';
import type { StoredQuote } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A live price for one quote, for as long as the browser is listening.
 *
 * Server-sent rather than a socket because everything here travels one way: the
 * browser has nothing to say that a normal request could not carry, and SSE
 * reconnects by itself.
 *
 * The rule this route exists to enforce is the last one: **a result that
 * finishes after the quote is frozen is discarded.** Freezing is what makes
 * "what did I agree to" answerable, and a solve already in flight when the user
 * accepted would quietly overwrite that answer with a price they never saw.
 * `mayApply` is checked when the solve LANDS, not when it starts.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const caller = requireCaller(request);
  const { id } = await context.params;

  let current: StoredQuote;
  try {
    current = await getQuote(id, caller.id);
  } catch (error) {
    if (error instanceof NotYours) {
      return Response.json({ error: 'No such quote.', code: 'not_found' }, { status: 404 });
    }
    throw error;
  }

  const encoder = new TextEncoder();
  const feed = marketFeed();
  const watcherId = randomUUID();

  let frozenAt: number | null = current.acceptedAt === null ? null : Date.now();
  let supersededAt: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The browser went away mid-write. Nothing to recover, and nothing
          // was placed, so there is nothing to undo either.
          closed = true;
        }
      };

      const booksFor = async (record: StoredQuote): Promise<Map<string, ClobBook>> => {
        try {
          const books = await getSnapshot(record.record.resolved.snapshotId);
          return new Map(books.map((b) => [b.assetId, b]));
        } catch {
          // Without the snapshot we cannot say how deep the fill went, so the
          // watch falls back to best-ask moves only. Fewer triggers, never a
          // wrong price.
          return new Map();
        }
      };

      const buildWatch = async (record: StoredQuote) =>
        watchFor(
          // Every leg the solver could have taken, not only the ones it did: an
          // unheld YES or NO can become the cheapest way to build the same
          // protection, and watching only holdings structurally misses that.
          record.record.resolved.legs.map((l) => l.tokenId),
          record.record.basket.legs.map((l) => ({ tokenId: l.tokenId, shares: l.shares })),
          await booksFor(record),
        );

      const watch = await buildWatch(current);

      send('open', {
        quoteId: current.id,
        revision: current.revision,
        watching: watch.eligibleTokens.length,
        frozen: frozenAt !== null,
      });

      if (frozenAt !== null) {
        // An accepted quote is finished. Saying so and closing is honest;
        // holding the connection open would imply a price that may still move.
        send('frozen', { quoteId: current.id });
        controller.close();
        closed = true;
        return;
      }

      unsubscribe = feed.add({
        id: watcherId,
        watch,
        notify: (state) => send('feed', { state }),
        resolve: async (reason) => {
          const startedAt = Date.now();
          const from = current;

          // Re-read before solving: the quote may have been accepted in another
          // tab since the last message, and an accepted quote is never re-priced.
          const latest = await getQuote(from.id, caller.id).catch(() => null);
          if (latest === null) return;
          if (latest.acceptedAt !== null) {
            frozenAt = Date.parse(latest.acceptedAt);
            send('frozen', { quoteId: latest.id });
            unsubscribe?.();
            return;
          }

          let result;
          try {
            result = await reprice(latest, caller.id);
          } catch (error) {
            if (error instanceof MarketGone) {
              send('gone', { reason: 'That market is no longer listed.' });
              unsubscribe?.();
              return;
            }
            send('feed', { state: 'stale' });
            return;
          }

          // Checked on landing, not on starting. Between those two moments the
          // user may have frozen this quote, and a late result must not land on
          // top of the price they accepted.
          if (!mayApply(startedAt, frozenAt, supersededAt)) return;
          supersededAt = startedAt;
          current = result.next;

          // Re-derive the watch: a new basket consumes different depth, and
          // watching the old fill would miss the new one.
          const nextWatch = await buildWatch(current);
          watch.eligibleTokens = nextWatch.eligibleTokens;
          watch.consumedTo = nextWatch.consumedTo;

          send('quote', {
            quoteId: result.next.id,
            revision: result.next.revision,
            previousId: from.id,
            snapshotId: result.snapshotId,
            snapshotChanged: result.snapshotChanged,
            reason,
            view: result.view,
          });
        },
      });

      request.signal.addEventListener('abort', () => {
        closed = true;
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed by the platform; nothing to do.
        }
      });
    },
    cancel() {
      closed = true;
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer by default, which turns a live price into a
      // batch delivered when the connection ends.
      'x-accel-buffering': 'no',
    },
  });
}
