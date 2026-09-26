import { fixedBasketCost } from '@/lib/basket-tracking';
import { randomUUID } from 'node:crypto';
import type { ClobBook } from '@polyhedge/venue';
import { getQuote, getSnapshot, NotYours } from '@/lib/store';
import { reprice } from '@/lib/reprice';
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
  let original: StoredQuote;
  try {
    current = await getQuote(id, caller.id);
    original=await getQuote(new URL(request.url).searchParams.get('baseline')??id,caller.id);
    if(original.record.request.eventId!==current.record.request.eventId) return Response.json({error:'Baseline event differs.'},{status:400});
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
  let priceTimer:ReturnType<typeof setTimeout>|null=null;
  const pendingPrices:Record<string,number|null>={};

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

      const buildWatch = async (record:StoredQuote) => {
        const records=[...Object.values(record.optionRecords??{primary:record.record}),...Object.values(original.optionRecords??{primary:original.record})];
        const shares=new Map<string,number>();
        for(const option of records)for(const leg of option.basket.legs)shares.set(leg.tokenId,Math.max(shares.get(leg.tokenId)??0,leg.shares));
        return watchFor([...new Set(records.flatMap(option=>option.resolved.legs.map(l=>l.tokenId)))],
          [...shares].map(([tokenId,shares])=>({tokenId,shares})),await booksFor(record));
      };

      const track=async(record:StoredQuote,initial=false)=>{
        const books=await booksFor(record);
        const costs:Record<string,number|null>={};
        for(const [key,base] of Object.entries(original.optionRecords??{primary:original.record}))costs[key]=fixedBasketCost(base,record.record,books);
        const prices:Record<string,number|null>={};
        for(const leg of record.record.resolved.legs){const asks=books.get(leg.tokenId)?.asks;prices[leg.tokenId]=asks?.length?Math.min(...asks.map(l=>l.priceMicros))/1_000_000:null;}
        send('tracking',{at:initial?Date.parse(original.createdAt):Date.parse(record.createdAt),costs,...(initial?{prices}:{}),initial});
      };
      const watch = await buildWatch(current);
      if(request.signal.aborted){closed=true;controller.close();return;}

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

      await track(original,true);
      if(current.id!==original.id)await track(current);
      unsubscribe = feed.add({
        id: watcherId,
        watch,
        notify: (state) => send('feed', { state }),
        marketPrice:(tokenId,ask)=>{
          pendingPrices[tokenId]=ask;
          // Bound UI traffic independently of solver speed; do not reset a
          // trailing timer on every tick and starve a busy market's chart.
          priceTimer??=setTimeout(()=>{
            priceTimer=null;
            const prices={...pendingPrices};
            for(const token of Object.keys(pendingPrices))delete pendingPrices[token];
            if(!closed&&frozenAt===null)send('market-prices',{at:Date.now(),prices});
          },500);
        },
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
          send('pricing',{state:'updating'});
          try {
            result = await reprice(latest, caller.id);
          } catch {
            send('pricing', { state: 'failed' });
            return;
          }

          // Checked on landing, not on starting. Between those two moments the
          // user may have frozen this quote, and a late result must not land on
          // top of the price they accepted.
          if (!mayApply(startedAt, frozenAt, supersededAt)) return;
          supersededAt = startedAt;
          current = result.next;
          await track(current);

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
        if(priceTimer!==null)clearTimeout(priceTimer);
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
      if(priceTimer!==null)clearTimeout(priceTimer);
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
