'use client';
import type { MarketHistories } from '@/lib/market-history-types';
import { MiniMovement } from './MiniMovement';
import type { BasketHistory } from '@/lib/basket-tracking';
import { LiveNumber } from './LiveNumber';
import { useEffect, useRef, useState } from 'react';
import type { PositionRowView } from '@/lib/view-model';

/**
 * What you would actually buy, on Polymarket, right now.
 *
 * Every number here is live and always was — `reprice()` re-runs the whole
 * solve against fresh books, so share counts move, and the solver can change
 * its mind about which legs to hold at all when a cheaper route opens. What was
 * missing is any admission that it happened: rows silently reshuffled, which
 * is the fastest way to lose a user's trust in an order list.
 *
 * So changes are marked. Shares, price and cost each flash on their own, and a
 * leg the solver has just started buying is labelled rather than appearing from
 * nowhere. Eight prices moving at their own cadence is what makes a page read
 * as connected to an order book; one aggregate number blinking never will.
 */
export function Positions({
  positions,history,eventTitle,marketHistory,
  totalLabel,
  reason,
}: {
  positions: PositionRowView[];
  history:BasketHistory;
  marketHistory:MarketHistories;
  eventTitle:string;
  totalLabel: string;
  reason: string | null;
}) {
  const marks = useChanges(positions);

  return (
    <aside className="positions-panel">
      <div className="positions-head">
        <h3>Your positions <span className="aside">{positions.length} markets · Polymarket</span></h3>
        {reason === 'best_ask_moved' && (
          // Otherwise the list reshuffles and looks broken rather than helpful.
          <p className="positions-why">Market prices changed — this basket was recalculated.</p>
        )}
      </div>

      <div className="positions-list">
        {positions.map(p => {
          const mark = marks.get(p.tokenId);
          const historic=marketHistory[p.tokenId];
          const ask=history[`token:${p.tokenId}`]?.at(-1)?.cost;
          const title=p.question||`${eventTitle} · ${p.bracketLabel}`;
          return (
            <div className={`position-row${mark?.isNew === true ? ' is-new' : ''}`} key={p.tokenId}>
              <div className="position-top">
                {p.href
                  ? <a className="venue" href={p.href} target="_blank" rel="noreferrer noopener" title={title}>{title} ↗</a>
                  : <span title={title}>{title}</span>}
                <span className={`side ${p.side}`}>{p.side}</span>
              </div>
              <div className="position-numbers">
                <span className={`num${mark?.shares === true ? ' moved' : ''}`}><LiveNumber text={`${p.shares.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} sh`}/></span>
                <span title="Average fill price before venue fees" className={`num${mark?.price === true ? ' moved' : ''}`}><LiveNumber text={p.priceLabel}/></span>
                <span className="spacer" />
                <strong className={`num${mark?.cost === true ? ' moved' : ''}`}><LiveNumber text={p.costLabel}/></strong>
              </div>
              {historic?.points.length?<MiniMovement points={historic.points} label={`${p.side} · 24h history${historic.status==='stale'?' · stale':''}`} description="Polymarket historical token prices, sampled every five minutes. Change is between the available first and last samples, not the executable fill price."/>:<p className="history-status">{!historic?'Loading 24h history…':historic.status==='empty'?'No price history in the past 24h':'Price history unavailable'}</p>}
              <div className="market-current-ask">Latest {p.side} best ask {ask==null?'unavailable':`${(ask*100).toLocaleString('en-US',{maximumFractionDigits:4})}¢`}</div>
              {mark?.isNew === true && <span className="position-new">new</span>}
            </div>
          );
        })}
      </div>

      {/* Sticky, so the total and the action never scroll away from the list
          they describe. */}
      <div className="positions-foot">
        <div className="positions-total"><span>Total</span><strong className="num"><LiveNumber text={totalLabel}/></strong></div>
        <button className="buy-cover" disabled>Buy cover</button>
        <p className="detail-caption">Execution is not live yet. Venue fees included; polyhedge charges nothing.</p>
      </div>
    </aside>
  );
}

interface Mark { shares?: boolean; price?: boolean; cost?: boolean; isNew?: boolean }

/**
 * Which rows moved since the last solve.
 *
 * Compares the rendered labels rather than the raw numbers, so a change that
 * rounds away to the same text does not flash — a figure that flashes without
 * visibly changing teaches people to ignore the flashing.
 */
function useChanges(positions: PositionRowView[]): Map<string, Mark> {
  const previous = useRef<Map<string, { shares: number; price: string; cost: string }>>(new Map());
  const [marks, setMarks] = useState<Map<string, Mark>>(new Map());

  useEffect(() => {
    const before = previous.current;
    const next = new Map<string, { shares: number; price: string; cost: string }>();
    const changed = new Map<string, Mark>();

    for (const p of positions) {
      next.set(p.tokenId, { shares: p.shares, price: p.priceLabel, cost: p.costLabel });
      const was = before.get(p.tokenId);
      if (was === undefined) {
        // First render has nothing to compare against, and arriving is not moving.
        if (before.size > 0) changed.set(p.tokenId, { isNew: true });
        continue;
      }
      const mark: Mark = {
        shares: was.shares !== p.shares,
        price: was.price !== p.priceLabel,
        cost: was.cost !== p.costLabel,
      };
      if (mark.shares === true || mark.price === true || mark.cost === true) changed.set(p.tokenId, mark);
    }
    previous.current = next;

    if (changed.size === 0) return;
    setMarks(changed);
    const clear = setTimeout(() => setMarks(new Map()), 1400);
    return () => clearTimeout(clear);
  }, [positions]);

  return marks;
}
