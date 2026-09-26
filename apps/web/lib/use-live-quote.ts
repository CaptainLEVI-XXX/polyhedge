'use client';

import { useEffect, useRef, useState } from 'react';
import type { BasketHistory } from './basket-tracking';
import type { QuotedView } from './view-model.js';

/**
 * Follows one quote as the book behind it moves.
 *
 * The browser holds no market socket. It listens to our stream, which is the
 * only place the solver lives, and receives finished quotes rather than raw
 * book messages it would have no way to price.
 *
 * A pinned quote is not watched at all. That is the point of pinning: the
 * connection closes, and no later price can arrive to replace the one the
 * person is reading.
 */

export type FeedState = 'connecting' | 'live' | 'stale' | 'closed';

export interface LiveQuote {
  history:BasketHistory;
  quoteId: string;
  view: QuotedView | null;
  /** Why the last re-price happened, in the venue's terms. */
  reason: string | null;
  feed: FeedState;
  pricing:'idle'|'updating'|'failed';
}

export function useLiveQuote(initialId: string, enabled: boolean): LiveQuote {
  const [history,setHistory]=useState<BasketHistory>({});
  const [quoteId, setQuoteId] = useState(initialId);
  const [view, setView] = useState<QuotedView | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>('connecting');
  const [pricing,setPricing]=useState<LiveQuote['pricing']>('idle');
  const latest = useRef(initialId);
  const [viewFor,setViewFor]=useState(initialId);

  useEffect(() => {
    latest.current = initialId;setViewFor(initialId);
    setQuoteId(initialId);setHistory({});
    setView(null);
    setReason(null);
    setPricing('idle');
  }, [initialId]);

  useEffect(() => {
    if (!enabled) {
      setFeed('closed');
      return;
    }

    const source = new EventSource(`/api/quote/${latest.current}/stream?baseline=${encodeURIComponent(initialId)}`);
    setFeed('connecting');

    const receivePrices=(event:Event)=>{
      const body=JSON.parse((event as MessageEvent).data) as {at:number;costs?:Record<string,number|null>;prices?:Record<string,number|null>;initial:boolean};
      if(!Number.isFinite(body.at))return;
      setHistory(previous=>{
        const next={...previous};
        for(const [key,cost] of Object.entries({...(body.costs??{}),...Object.fromEntries(Object.entries(body.prices??{}).map(([id,value])=>[`token:${id}`,value]))})){
          if(cost!==null&&(!Number.isFinite(cost)||cost<0))continue;
          const points=next[key]??[];
          if(points.length&&body.at<=points[points.length-1]!.at)continue;
          const appended=[...points,{at:body.at,cost}];
          next[key]=appended.length>240?[appended[0]!,...appended.slice(-239)]:appended;
        }
        return next;
      });
    };
    source.addEventListener('tracking',receivePrices);
    source.addEventListener('market-prices',receivePrices);
    source.addEventListener('pricing',event=>{const {state}=JSON.parse((event as MessageEvent).data);if(state==='updating'||state==='failed')setPricing(state);});

    source.addEventListener('quote', (event) => {
      const body = JSON.parse((event as MessageEvent).data) as {
        quoteId: string;
        reason: string;
        view: QuotedView;
      };
      // The stream follows the chain of revisions, so later re-prices and any
      // explicit action must address the newest row, not the one we opened on.
      latest.current = body.quoteId;
      setQuoteId(body.quoteId);
      setView(body.view);setPricing('idle');
      setReason(body.reason);
    });

    source.addEventListener('feed', (event) => {
      const body = JSON.parse((event as MessageEvent).data) as { state: string };
      setFeed(body.state === 'stale' ? 'stale' : body.state==='reconnected'?'connecting':'live');
    });

    // Nothing further to watch, and not an error the user needs to see: the
    // price on screen is still the last true one.
    source.addEventListener('frozen', () => {
      setFeed('closed');
      source.close();
    });

    source.addEventListener('error', () => {
      // EventSource reconnects on its own. Saying "stale" rather than "broken"
      // is the accurate claim: we have a price, we just cannot vouch for it.
      setFeed('stale');
    });

    return () => source.close();
  }, [enabled, initialId]);

  return viewFor===initialId?{ history,quoteId, view, reason, feed,pricing }:{history:{},quoteId:initialId,view:null,reason:null,feed:'connecting',pricing:'idle'};
}
