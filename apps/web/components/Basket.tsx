'use client';
import type { MarketHistories } from '@/lib/market-history-types';
import { BasketMovement } from './BasketMovement';
import { LiveNumber } from './LiveNumber';
import { HedgeCurve } from './HedgeCurve';
import { Positions } from './Positions';
import { type LiveQuote } from '@/lib/use-live-quote';
import { basketMetrics, money } from '@/lib/basket-metrics';
import type { CoverOptionView, QuotedView } from '@/lib/view-model';

/**
 * One hedge, in full.
 *
 * Ordered by the decision rather than by the pipeline: what it costs, what that
 * rate buys, what it pays when you are hurt, what is still on you — then the
 * picture, then what you would be buying.
 *
 * Everything on this page is live. `reprice()` re-solves the whole basket
 * against fresh books on every book move that reaches it, so the cost, the
 * share counts, the curve and even which legs are held can all change while it
 * is open. The job of the UI is to make that visible instead of silent.
 */
export function Basket({marketHistory,view,initialView,optionId,onBack,onStartOver,live}:{marketHistory:MarketHistories;view:QuotedView;initialView:QuotedView;optionId:string;onBack:()=>void;onStartOver:()=>void;live:LiveQuote}) {
  const option=view.options.find(o=>o.id===optionId);
  if(!option)return <section className="section"><p>This hedge is no longer available at current prices.</p><div className="detail-back-links"><button type="button" onClick={onBack}>Back to all hedges</button><button type="button" onClick={onStartOver}>Back to examples</button></div></section>;
  return <Detail marketHistory={marketHistory} initialOption={initialView.options.find(o=>o.id===optionId)} live={live} view={view} option={option} onBack={onBack} onStartOver={onStartOver}/>;
}

function Detail({marketHistory,initialOption,live,view,option,onBack,onStartOver}:{marketHistory:MarketHistories;initialOption:CoverOptionView|undefined;live:LiveQuote;view:QuotedView;option:CoverOptionView;onBack:()=>void;onStartOver:()=>void}) {
  const m=basketMetrics(option);
  const firstPayout=initialOption?basketMetrics(initialOption).maxPayout:0;
  const payoutMove=firstPayout>0?(m.maxPayout-firstPayout)/firstPayout*100:null;

  const overBudget=view.parsed.budgetUsd!==undefined&&option.costUsd>view.parsed.budgetUsd;
  // What a dollar of cover costs: the one figure that makes two hedges
  // comparable without arithmetic.
  const rate=m.maxPayout>0?option.costUsd/m.maxPayout:null;

  return <div className="basket-detail">
    <div className="detail-navigation">
      <div className="detail-back-links">
        <button type="button" className="back" onClick={onBack}>← All hedges</button>
        <button type="button" className="back" onClick={onStartOver}>← Back to examples</button>
      </div>
      <span className="feed-controls">
        <LiveBadge live={live}/><PricingWarning live={live}/>
      </span>
    </div>

    <h1 className="statement">{option.name==='Lowest loss without a budget cap'?'Lowest loss':option.name}</h1>
    <p className="settles-on">
      Pays on <strong>{view.event.title}</strong> · settles {view.event.settlesLabel.slice(0,10)} · resolved by Polymarket
    </p>

    <div className="live-figures">
      <BasketMovement points={live.history[option.id]??[]}/>
      <div className="fig lead">
        <div className="n"><LiveNumber text={option.costLabel}/></div>
        <div className="l">Current basket cost</div>

      </div>
      {rate!==null&&<div className="fig">
        <div className="n"><LiveNumber text={`${(rate*100).toFixed(2)}¢`}/></div>
        <div className="l">Per $1 maximum payout</div>
      </div>}
      <div className="fig">
        <div className="n"><LiveNumber text={money(m.maxPayout,'down')}/></div>
        <div className="l">Pays you at most</div>
        {payoutMove!==null&&<div className="h movement-percent">{Math.abs(payoutMove)<.005?'—':payoutMove>0?'▲':'▼'} <LiveNumber text={`${Math.abs(payoutMove).toFixed(2)}%`}/> since created</div>}
      </div>
      {option.trueCostUsd!=null&&<div className="fig" title="Purchase cost minus expected payout using market-implied probabilities. An estimate, not a fee or guaranteed return.">
        <div className="n"><LiveNumber text={money(option.trueCostUsd)}/></div>
        <div className="l">Market-implied net cost</div>
      </div>}
      <div className="fig bad">
        <div className="n"><LiveNumber text={money(m.netLoss)}/></div>
        <div className="l">Most you could still lose</div>
      </div>
      {m.beyondOwed>0&&<div className="fig over">
        <div className="n"><LiveNumber text={money(m.beyondOwed)}/></div>
        <div className="l">Paid beyond your loss</div>
      </div>}
    </div>

    {m.beyondOwed>0&&<p className="note warn">This hedge overshoots: in at least one outcome it pays more than you would lose. Compare its remaining loss and cost with the other baskets.</p>}
    {overBudget&&<p className="note warn">Costs more than your {money(view.parsed.budgetUsd!)} budget.</p>}

    <div className="detail-columns">
      <section className="detail-panel">
        <h3>What you are left with <span className="aside">by settlement outcome, after purchase cost</span></h3>
        <HedgeCurve option={option}/>
        {!option.ladder.heldCount&&<p className="note">The best solution within these limits buys no positions. Your target stays uncovered.</p>}
      </section>

      <Positions marketHistory={marketHistory} history={live.history} eventTitle={view.event.title} positions={option.ladder.positions} totalLabel={option.costLabel} reason={live.reason}/>
    </div>
  </div>;
}

export function LiveBadge({live}:{live:LiveQuote}) {
  const state=live.feed;
  const label=state==='live'?'Live book':state==='connecting'?'Connecting':state==='stale'?'Feed interrupted':'Updates stopped';
  return <span className={`live-badge ${state}`} role="status"><i aria-hidden/>{label}</span>;
}

export function PricingWarning({live}:{live:LiveQuote}) {
  return live.pricing==='failed'?<span className="live-times" role="status">Price update unavailable · showing last quote</span>:null;
}
