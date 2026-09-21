'use client';

import { useEffect, useRef, useState } from 'react';
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
  quoteId: string;
  view: QuotedView | null;
  /** Why the last re-price happened, in the venue's terms. */
  reason: string | null;
  /** True when the book genuinely moved, rather than a solve repeating itself. */
  moved: boolean;
  feed: FeedState;
}

export function useLiveQuote(initialId: string, enabled: boolean): LiveQuote {
  const [quoteId, setQuoteId] = useState(initialId);
  const [view, setView] = useState<QuotedView | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const [feed, setFeed] = useState<FeedState>('connecting');
  const latest = useRef(initialId);

  useEffect(() => {
    latest.current = initialId;
    setQuoteId(initialId);
    setView(null);
    setReason(null);
    setMoved(false);
  }, [initialId]);

  useEffect(() => {
    if (!enabled) {
      setFeed('closed');
      return;
    }

    const source = new EventSource(`/api/quote/${latest.current}/stream`);
    setFeed('connecting');

    source.addEventListener('open', () => setFeed('live'));

    source.addEventListener('quote', (event) => {
      const body = JSON.parse((event as MessageEvent).data) as {
        quoteId: string;
        snapshotChanged: boolean;
        reason: string;
        view: QuotedView;
      };
      // The stream follows the chain of revisions, so later re-prices and any
      // explicit action must address the newest row, not the one we opened on.
      latest.current = body.quoteId;
      setQuoteId(body.quoteId);
      setView(body.view);
      setReason(body.reason);
      setMoved(body.snapshotChanged);
      setFeed('live');
    });

    source.addEventListener('feed', (event) => {
      const body = JSON.parse((event as MessageEvent).data) as { state: string };
      setFeed(body.state === 'stale' ? 'stale' : 'live');
    });

    // Both mean there is nothing further to watch, and neither is an error the
    // user needs to see: the price on screen is still the last true one.
    source.addEventListener('frozen', () => {
      setFeed('closed');
      source.close();
    });
    source.addEventListener('gone', () => {
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

  return { quoteId, view, reason, moved, feed };
}
