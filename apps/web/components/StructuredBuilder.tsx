'use client';
import { useEffect, useRef, useState } from 'react';
import type { EventListing } from '@/lib/event-listings';
import type { EventSupport, EventSelection } from '@polyhedge/venue';
import type { QuotedView } from '@/lib/view-model';
type Detail=Omit<EventSupport,'rules'> & {eventId:string;selection:EventSelection;rules:{marketId:string;text:string}[];note:string};
export function StructuredBuilder({onQuote,onBusyChange}:{onQuote:(id:string,view:QuotedView)=>void;onBusyChange:(busy:boolean)=>void}) {
  const [showUnavailable,setShowUnavailable]=useState(false);const [refreshKey,setRefreshKey]=useState(0);const version=useRef('');const categoryVersion=useRef('');
  const [q,setQ]=useState('');const [category,setCategory]=useState('');const [kind,setKind]=useState('');const [date,setDate]=useState('');
  const [categories,setCategories]=useState<{slug:string;label:string;supportedEvents:number}[]>([]);
  const [rows,setRows]=useState<EventListing[]>([]);const [detail,setDetail]=useState<Detail|null>(null);
  const [losses,setLosses]=useState<Record<string,string>>({});const [budget,setBudget]=useState('');
  const [limit,setLimit]=useState('');const [maxLegs,setMaxLegs]=useState('');
  const [template,setTemplate]=useState('threshold_digital');const [direction,setDirection]=useState('below');
  const [level,setLevel]=useState('');const [upper,setUpper]=useState('');const [amount,setAmount]=useState('');
  const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');const [status,setStatus]=useState('');const [offset,setOffset]=useState(0);const [next,setNext]=useState<number|null>(null);
  const detailRequest=useRef(0);
  useEffect(()=>onBusyChange(busy),[busy,onBusyChange]);
  useEffect(()=>{version.current='';setOffset(0);setDetail(null);detailRequest.current++;},[q,category,kind,date,showUnavailable]);
  useEffect(()=>{
    const controller=new AbortController();let refreshTimer:ReturnType<typeof setTimeout>|undefined;setLoading(true);setError('');
    const timer=setTimeout(async()=>{
      try{
        const p=new URLSearchParams({q,category,kind,date,categoryVersion:categoryVersion.current,offset:String(offset),limit:'25',unsupported:showUnavailable?'1':'0',...(offset&&version.current?{version:version.current}:{})});
        const res=await fetch(`/api/markets?${p}`,{signal:controller.signal});const data=await res.json();
        if(res.status===409){version.current='';setOffset(0);throw new Error('Catalogue changed; showing the first page again.');}
        if(!res.ok)throw new Error(data.error??'Search unavailable.');
        if(controller.signal.aborted)return;
        version.current=data.version;
        setRows(data.events);if(data.categories){setCategories(data.categories);categoryVersion.current=data.catalogueVersion;}setNext(data.nextOffset);
        if(!data.discoveryComplete)refreshTimer=setTimeout(()=>setRefreshKey(v=>v+1),3000);
        setStatus(data.discovery?.error?'Catalogue refresh failed; available results may be incomplete.':data.discoveryComplete?`${data.total} matching selections`:'Catalogue is refreshing; results may be incomplete.');
      }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Search unavailable.');}
      finally{if(!controller.signal.aborted)setLoading(false);}
    },200);
    return()=>{clearTimeout(timer);clearTimeout(refreshTimer);controller.abort();};
  },[q,category,kind,date,offset,showUnavailable,refreshKey]);
  async function select(row:EventListing){
    const request=++detailRequest.current;setDetail(null);setError('');setConfirmed(false);
    try{
      const p=new URLSearchParams({kind:row.kind,...(row.selection.marketId?{marketId:row.selection.marketId}:{})});
      const res=await fetch(`/api/markets/${row.eventId}?${p}`);const data=await res.json();
      if(request!==detailRequest.current)return;
      if(!res.ok)throw new Error(data.error??'Market details unavailable.');
      setDetail(data);setLosses({});setLevel('');setUpper('');setAmount('');
    }catch(e){if(request===detailRequest.current)setError(e instanceof Error?e.message:'Market unavailable.');}
  }
  async function build(){
    if(!detail||!confirmed)return;setBusy(true);setError('');
    try{
      const shape=template==='threshold_digital'?{templateId:template,payoutUsd:Number(amount),direction,k:Number(level)}
        :template==='linear_strip'?{templateId:template,payoutUsd:Number(amount),direction,k1:Number(level),k2:Number(upper)}
        :{templateId:template,payoutUsd:Number(amount),low:Number(level),high:Number(upper)};
      const payload={eventId:detail.eventId,kind:detail.kind,marketId:detail.selection.marketId,ruleHash:detail.ruleHash,
        ...(detail.kind==='numeric'?{shape}:{losses:detail.outcomes.map(o=>({outcomeId:o.id,lossCents:Math.round(Number(losses[o.id])*100)}))}),
        ...(budget.trim()?{budgetUsd:Number(budget)}:{}),...(limit.trim()?{maxNetLossUsd:Number(limit)}:{}),...(maxLegs.trim()?{maxLegs:Number(maxLegs)}:{})};
      const res=await fetch('/api/hedges',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const data=await res.json();if(!res.ok)throw new Error(data.error??'Could not build hedge.');
      onQuote(data.result.quoteId,data.result.view);
    }catch(e){setError(e instanceof Error?e.message:'Could not build hedge.');}finally{setBusy(false);}
  }
  const valid=detail?.kind==='numeric'?amount.trim()!==''&&level.trim()!==''&&(template==='threshold_digital'||upper.trim()!=='')
    :detail?.outcomes.every(o=>losses[o.id]?.trim()!==''&&losses[o.id]!==undefined);
  return <section className="structured-builder" aria-label="Choose an event and describe your loss">
    <div className="event-filters">
      <label>Search events<input value={q} onChange={e=>setQ(e.target.value)} placeholder="BTC, weather, Fed…" disabled={busy}/></label>
      <label>Category<select value={category} onChange={e=>setCategory(e.target.value)} disabled={busy}><option value="">All categories</option>{categories.map(c=><option key={c.slug} value={c.slug}>{c.label}</option>)}</select></label>
      <label>Market type<select value={kind} onChange={e=>setKind(e.target.value)} disabled={busy}><option value="">All supported types</option><option value="binary">Two outcomes</option><option value="categorical">Multiple outcomes</option><option value="numeric">Numeric ranges</option></select></label>
      <label>Venue end date<input type="date" value={date} onChange={e=>setDate(e.target.value)} disabled={busy}/></label>
    </div>
    <label><input type="checkbox" checked={showUnavailable} disabled={busy} onChange={e=>setShowUnavailable(e.target.checked)}/> Show unavailable selections and reasons</label> <button type="button" disabled={loading||busy} onClick={()=>setRefreshKey(v=>v+1)}>Refresh search</button>
    <p className="note" aria-live="polite">{loading?'Searching…':status}</p>
    {!detail&&<div className="event-results">{rows.map(row=><button key={row.id} type="button" disabled={busy||!row.eligible} onClick={()=>void select(row)}>
      <strong>{row.title}</strong><span className="note">{row.kind} · {row.date.slice(0,10)}{row.reason?` · ${row.reason}`:''}</span>
    </button>)}{!loading&&rows.length===0&&<p>No supported selection matched. Try another subject or date.</p>}
      <div>{offset>0&&<button onClick={()=>setOffset(Math.max(0,offset-25))}>Previous</button>}{next!==null&&<button onClick={()=>setOffset(next)}>More results</button>}</div>
    </div>}
    {detail&&<fieldset disabled={busy} onChange={()=>setConfirmed(false)}><legend>{detail.title}</legend>
      <button type="button" onClick={()=>{setDetail(null);detailRequest.current++;}}>Choose another event</button>
      <p className="note">{detail.observationAt} · {detail.note}</p>
      {!detail.eligible?<p role="alert">{detail.reason}</p>:<>
        <details><summary>Read the settlement rules</summary>{detail.rules.map(r=><p key={r.marketId} style={{whiteSpace:'pre-wrap'}}>{r.text}</p>)}</details>
        {detail.kind==='numeric'?<div className="event-filters">
          <label>Loss shape<select value={template} onChange={e=>setTemplate(e.target.value)}><option value="threshold_digital">Fixed loss past a level</option><option value="range_protect">Loss outside a range</option><option value="linear_strip">Loss grows between levels</option></select></label>
          {template!=='range_protect'&&<label>Loss direction<select value={direction} onChange={e=>setDirection(e.target.value)}><option value="below">Below</option><option value="above">Above</option></select></label>}
          <label>{template==='threshold_digital'?'Level':'Lower level'} ({detail.unit||'market units'})<input type="number" step="any" value={level} onChange={e=>setLevel(e.target.value)}/></label>
          {template!=='threshold_digital'&&<label>Upper level ({detail.unit||'market units'})<input type="number" step="any" value={upper} onChange={e=>setUpper(e.target.value)}/></label>}
          <label>Maximum loss ($)<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
        </div>:<><p>Enter the loss you would have in each outcome. Enter 0 explicitly where you have no loss.</p><div className="event-filters">{detail.outcomes.map(o=><label key={o.id}>{o.label} — loss ($)<input type="number" min="0" step="0.01" value={losses[o.id]??''} onChange={e=>setLosses(v=>({...v,[o.id]:e.target.value}))}/></label>)}</div></>}
        <div className="event-filters">
          <label>Maximum spend ($, optional)<input type="number" min="0" step="0.01" value={budget} onChange={e=>setBudget(e.target.value)}/></label>
          <label>Maximum remaining loss ($, optional)<input type="number" min="0" step="0.01" value={limit} onChange={e=>setLimit(e.target.value)}/></label>
          <label>Maximum positions (optional)<input type="number" min="1" max="30" value={maxLegs} onChange={e=>setMaxLegs(e.target.value)}/></label>
        </div>
        <label><input type="checkbox" checked={confirmed} onChange={e=>{e.stopPropagation();setConfirmed(e.target.checked);}}/> I confirm these losses and that the published outcome, measurement and timing match the protection I want.</label>
        <p><button className="primary" disabled={!valid||!confirmed||busy} onClick={()=>void build()}>{busy?'Building hedge…':'Build hedge'}</button></p>
      </>}
    </fieldset>}
    {error&&<p role="alert" className="note warn">{error}</p>}
  </section>;
}
