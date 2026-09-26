import { fixedBasketCost } from '../../apps/web/lib/basket-tracking.js';
import type { QuoteRecord } from '../../packages/engine/src/index.js';
import { describe, expect, it, vi } from 'vitest';
import { assess, mayApply, watchFor } from '../../apps/web/lib/freshness.js';
import { MarketFeed } from '../../apps/web/lib/stream.js';
import type { ClobBook } from '../../packages/venue/src/index.js';

// The streaming group. Two rules here are the ones that cost real money if they
// are wrong: a late solve must not land on a price someone already agreed to,
// and a churning book must not turn into a solve per message.

const book = (assetId: string, asks: [number, number][]): ClobBook => ({
  market: 'm',
  assetId,
  timestamp: '2026-09-21T00:00:00Z',
  hash: 'h',
  bids: [],
  asks: asks.map(([priceMicros, size]) => ({ priceMicros, size })),
});

/** A socket that goes nowhere: these tests are about our rules, not the venue's. */
const noSocket = () =>
  ({ addEventListener: () => {}, send: () => {}, close: () => {} }) as unknown as WebSocket;

const frame = (assetId: string, asks: [number, number][]) =>
  JSON.stringify([
    {
      event_type: 'book',
      asset_id: assetId,
      market: 'm',
      asks: asks.map(([p, s]) => ({ price: String(p / 1_000_000), size: String(s) })),
      bids: [],
    },
  ]);

describe('deciding a quote is stale', () => {
  it('reprices sub-cent moves and redistribution within consumed depth',()=>{
    const previous=book('held',[[100000,10],[110000,10]]);
    const watch=watchFor(['held','unheld'],[{tokenId:'held',shares:20}],new Map([['held',previous]]));
    expect(assess(watch,book('unheld',[[100000,10]]),book('unheld',[[101000,10]])).resolve).toBe(true);
    expect(assess(watch,previous,book('held',[[100000,5],[110000,15]]))).toEqual({resolve:true,reason:'consumed_level_moved'});
  });
  it('never lets a late result overwrite a frozen quote', () => {
    const frozenAt = 1_000;
    // Started before the freeze and lands after it: the classic race.
    expect(mayApply(900, frozenAt, null)).toBe(false);
    // Started after it too — freezing is the end, not a cutoff to race against.
    expect(mayApply(1_100, frozenAt, null)).toBe(false);
    // And an older solve never lands on top of a newer one.
    expect(mayApply(900, null, 1_000)).toBe(false);
    expect(mayApply(1_100, null, 1_000)).toBe(true);
  });

  it('watches eligible tokens, not only the ones the basket holds', () => {
    const watch = watchFor(['held', 'unheld'], [{ tokenId: 'held', shares: 10 }], new Map());
    const moved = assess(watch, book('unheld', [[400_000, 50]]), book('unheld', [[380_000, 50]]));
    // An unheld leg getting cheaper can be the cheapest way to build the same
    // protection. Ignoring it keeps someone in a worse basket than exists.
    expect(moved).toEqual({ resolve: true, reason: 'best_ask_moved' });

    const elsewhere = assess(watch, undefined, book('other-event', [[400_000, 50]]));
    expect(elsewhere.resolve).toBe(false);
  });

  it('ignores depth below what the basket actually consumed', () => {
    const books = new Map([['t', book('t', [[400_000, 10], [450_000, 90]])]]);
    const watch = watchFor(['t'], [{ tokenId: 't', shares: 10 }], books);
    // Ten shares fill entirely at 400,000, so that is the depth that matters.
    expect(watch.consumedTo.get('t')).toBe(400_000);

    const deeper = assess(
      watch,
      books.get('t'),
      book('t', [[400_000, 10], [450_000, 5]]),
    );
    expect(deeper).toEqual({ resolve: false, reason: 'deeper_than_consumed' });

    const consumed = assess(watch, books.get('t'), book('t', [[400_000, 2], [450_000, 90]]));
    expect(consumed).toEqual({ resolve: true, reason: 'consumed_level_moved' });
  });
});

describe('re-pricing a watched quote', () => {
  it('collapses two moves inside the debounce window into one solve', async () => {
    vi.useFakeTimers();
    try {
      const feed = new MarketFeed(noSocket);
      const resolve = vi.fn(async () => {});
      feed.add({
        id: 'w',
        watch: { eligibleTokens: ['t'], consumedTo: new Map() },
        resolve,
        notify: () => {},
      });

      feed.ingest(frame('t', [[400_000, 100]]));
      await vi.advanceTimersByTimeAsync(200);
      feed.ingest(frame('t', [[380_000, 100]]));
      await vi.advanceTimersByTimeAsync(200);
      feed.ingest(frame('t', [[360_000, 100]]));

      // Still inside the window: nothing has run yet.
      await vi.advanceTimersByTimeAsync(700);
      expect(resolve).not.toHaveBeenCalled();

      // Past it, and the burst is one solve — against where the book settled,
      // not where it was when the burst started.
      await vi.advanceTimersByTimeAsync(100);
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops re-pricing a quote whose watcher has gone', async () => {
    vi.useFakeTimers();
    try {
      const feed = new MarketFeed(noSocket);
      const resolve = vi.fn(async () => {});
      const stop = feed.add({
        id: 'w',
        watch: { eligibleTokens: ['t'], consumedTo: new Map() },
        resolve,
        notify: () => {},
      });

      feed.ingest(frame('t', [[400_000, 100]]));
      stop();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resolve).not.toHaveBeenCalled();
      expect(feed.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('processes batched price changes without starving or overlapping solves during continuous traffic',async()=>{
  vi.useFakeTimers();
  let stop:()=>void=()=>{};
  try{
    const feed=new MarketFeed(noSocket);
    let release:()=>void=()=>{};
    const resolve=vi.fn(()=>new Promise<void>(done=>{release=done;}));
    stop=feed.add({id:'burst',watch:{eligibleTokens:['t'],consumedTo:new Map([['t',500000]])},resolve,notify:()=>{}});
    await vi.advanceTimersByTimeAsync(100);
    feed.ingest(frame('t',[[400000,100]]));
    for(let i=0;i<16;i++){
      await vi.advanceTimersByTimeAsync(100);
      feed.ingest(JSON.stringify({event_type:'price_change',market:'m',price_changes:[{asset_id:'t',price:'0.4',size:String(100-i),side:'SELL'}]}));
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolve).toHaveBeenCalledTimes(1);
    release();await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    release();
  }finally{stop();vi.useRealTimers();}
});

describe('original basket price tracking',()=>{
  it('keeps original quantities when the optimizer changes allocations, walks depth and includes current fees',()=>{
    const original={basket:{legs:[{tokenId:'t',shares:10}]}} as unknown as QuoteRecord;
    const current={basket:{legs:[{tokenId:'other',shares:200}]},resolved:{legs:[{tokenId:'t'}],feeRates:[.1]}} as unknown as QuoteRecord;
    const books=new Map([['t',book('t',[[600_000,6],[400_000,4]])]]);
    expect(fixedBasketCost(original,current,books)).toBeCloseTo(5.44,10);
    books.set('t',book('t',[[400_000,9]]));
    expect(fixedBasketCost(original,current,books)).toBeNull();
    expect(fixedBasketCost(original,{...current,resolved:{...current.resolved,feeRates:[]}},books)).toBeNull();
  });
});

it('streams sub-cent best-ask moves while a basket solve is still pending, without inventing size-only moves',async()=>{
  vi.useFakeTimers();
  const feed=new MarketFeed(noSocket);
  const marketPrice=vi.fn();
  let release=()=>{};
  const resolve=vi.fn(()=>new Promise<void>(done=>{release=done;}));
  const stop=feed.add({id:'prices',watch:{eligibleTokens:['t'],consumedTo:new Map()},resolve,notify:()=>{},marketPrice});
  try{
    await vi.advanceTimersByTimeAsync(100);
    feed.ingest(frame('t',[[400000,100]]));
    await vi.advanceTimersByTimeAsync(800);
    expect(resolve).toHaveBeenCalledTimes(1);
    marketPrice.mockClear();
    feed.ingest(JSON.stringify({event_type:'price_change',price_changes:[{asset_id:'t',price:'0.399',size:'10',side:'SELL'}]}));
    expect(marketPrice).toHaveBeenLastCalledWith('t',.399,expect.any(Number));
    feed.ingest(JSON.stringify({event_type:'price_change',price_changes:[{asset_id:'t',price:'0.399',size:'20',side:'SELL'}]}));
    expect(marketPrice).toHaveBeenCalledTimes(1);
    feed.ingest(frame('t',[]));
    expect(marketPrice).toHaveBeenLastCalledWith('t',null,expect.any(Number));
    feed.ingest(frame('other',[[500000,10]]));
    expect(marketPrice).toHaveBeenCalledTimes(2);
  }finally{stop();release();vi.useRealTimers();}
});
