'use client';
import { PolymarketMark } from './PolymarketMark';
import { MiniMovement } from './MiniMovement';
import type { BasketHistory } from '@/lib/basket-tracking';
import { LiveNumber } from './LiveNumber';
import { basketMetrics, money } from '@/lib/basket-metrics';
import type { QuotedView } from '@/lib/view-model';

/**
 * The choice between whole hedges.
 *
 * Three numbers per card, not four: what it costs, what it pays when you are
 * hurt, and what is still on you. Coverage came off the face because the bar
 * underneath already carries it, and "minimum cover" plus "worst shortfall"
 * were one fact wearing two labels.
 */
export function Cards({view,history,onOpen,onRefine}:{view:QuotedView;history:BasketHistory;onOpen:(index:number)=>void;onRefine:(text:string)=>void}) {
  const options=view.options.map((option,index)=>({option,index,metrics:basketMetrics(option)})).sort((a,b)=>a.option.costUsd-b.option.costUsd);
  const name=(label:string)=>label==='Lowest loss without a budget cap'?'Lowest loss':label;
  const over=(costUsd:number)=>view.parsed.budgetUsd!==undefined&&costUsd>view.parsed.budgetUsd;
  return <>
    <div className="brief-strip">
      <div className="brief-summary">
        <strong>{view.parsed.subject}</strong>
        <span>{view.parsed.exposureLabel} · pays on {view.event.title} · settles {view.event.settlesLabel.slice(0,10)}{view.parsed.budgetLabel?` · budget ${view.parsed.budgetLabel}`:''}</span>
      </div>
      <button onClick={()=>onRefine('')}>Edit brief</button>
    </div>
    <section className="comparison">
      <div className="comparison-controls"><span>{options.length} hedges · lowest cost first</span></div>
      <div className="cards">{options.map(({option,index,metrics:m})=>
        <button className="card" key={option.id} onClick={()=>onOpen(index)}>
          <div className="card-heading">
            <span className="card-name">{name(option.name)}</span>
            {over(option.costUsd)&&<span className="budget-flag">Over budget</span>}
          </div>
          <div className="card-price-row"><div className="card-cost"><LiveNumber text={option.costLabel}/></div><MiniMovement points={history[option.id]??[]} label="Original basket price"/></div>
          <p>{m.netImprovement>0?`Worst target loss reduced by ${money(m.netImprovement,'down')} after costs.`:'This basket does not reduce your worst target loss after costs.'}</p>
          <div className="card-line"><span className="k">Pays you at most</span><span className="v covered"><LiveNumber text={money(m.maxPayout,'down')}/></span></div>
          <div className="card-line"><span className="k">Most you could still lose</span><span className="v short"><LiveNumber text={money(m.netLoss)}/></span></div>
          {option.trueCostUsd!=null&&<div className="card-line" title="Purchase cost minus expected payout using market-implied probabilities. An estimate, not a fee or guaranteed return."><span className="k">Market-implied net cost</span><span className="v"><LiveNumber text={money(option.trueCostUsd)}/></span></div>}
          {/* A hedge that overshoots reads as perfect on coverage alone. */}
          {m.beyondOwed>0&&<div className="card-line"><span className="k">Pays beyond your loss</span><span className="v warn">{money(m.beyondOwed)}</span></div>}
          <div className="meter" aria-hidden><span style={{width:`${m.minimumCoverage*100}%`}}/></div>
          <div className="card-go"><span>Look inside →</span><span className="venue-badge"><PolymarketMark/> Polymarket</span></div>
        </button>)}</div>
      <p className="comparison-caption">Cover is measured against your target. Prices include venue fees and move with the book.</p>
    </section>
  </>;
}
