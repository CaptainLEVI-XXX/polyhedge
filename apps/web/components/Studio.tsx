'use client';
import { useEffect, useRef, useState } from 'react';
import { Connect } from './Session';
import { ProductFooter } from './ProductFooter';
import { Logo } from './Logo';
import { useMarketHistory } from '@/lib/use-market-history';
import { useLiveQuote } from '@/lib/use-live-quote';
import { useCostCurve } from '@/lib/use-cost-curve';
import { Basket, PricingWarning, LiveBadge } from './Basket';
import { Cards } from './Cards';
import { CostCurve } from './CostCurve';
import { fieldSuggestions } from '@/lib/studio-guidance';
import { isAmountField, type StudioReply, type StudioExample } from '@/lib/studio-types';

export function Studio() {
  const [draft,setDraft]=useState<StudioReply|null>(null);
  const [examples,setExamples]=useState<StudioExample[]>([]);
  const [exampleRevision,setExampleRevision]=useState(0);
  const [exampleStatus,setExampleStatus]=useState('Finding current examples…');
  const [turns,setTurns]=useState<{you:boolean;text:string}[]>([]);
  const [text,setText]=useState('');
  const [busy,setBusy]=useState(false);
  const lock=useRef(false);
  const [error,setError]=useState('');
  const [screen,setScreen]=useState<'exposure'|'baskets'|'detail'>('exposure');
  const [opened,setOpened]=useState('primary');
  const live=useLiveQuote(draft?.quoteId??'',!!draft?.quoteId&&screen!=='exposure');
  const currentView=live.view??draft?.view;
  const marketHistory=useMarketHistory(draft?.quoteId??'',live.quoteId||draft?.quoteId||'',currentView?.options.flatMap(o=>o.ladder.positions.map(p=>p.tokenId))??[],!!draft?.quoteId&&screen!=='exposure');
  const curve=useCostCurve(draft?.quoteId??'',live.quoteId||draft?.quoteId||'',!!draft?.quoteId&&screen==='baskets',currentView?.options??[],currentView?.parsed.budgetUsd);
  useEffect(()=>{window.scrollTo({top:0,behavior:'instant'});},[screen]);
  const [editing,setEditing]=useState<string|null>(null);
  // An example's prepared session, held until the composer is submitted. The
  // examples used to fire on click, which meant the one thing a first-time
  // visitor most needs to see — the sentence that produces a hedge — flashed
  // past before they could read it.
  const [staged,setStaged]=useState<StudioExample|null>(null);
  const [editValue,setEditValue]=useState('');
  const [amountValues,setAmountValues]=useState<Record<string,string>>({});
  useEffect(()=>{setAmountValues(Object.fromEntries((draft?.brief??[]).filter(f=>isAmountField(f.key)&&!f.readOnly).map(f=>[f.key,f.value])));},[draft?.session]);
  function startOver(){setDraft(null);setTurns([]);setEditing(null);setText('');setError('');setStaged(null);setAmountValues({});setScreen('exposure');window.scrollTo({top:0,behavior:'instant'});}

  useEffect(()=>{
    const controller=new AbortController();
    setExampleStatus('Finding current examples…');
    let timer:ReturnType<typeof setTimeout>|undefined;
    let attempts=0;
    async function load(){
      try{
        const r=await fetch('/api/studio',{signal:controller.signal});
        const b=await r.json();if(!r.ok)throw new Error(b.error??'Examples unavailable');
        if(controller.signal.aborted)return;
        setExamples(b.examples);
        setExampleStatus(b.examples.length?'':b.refreshing?'Finding current examples…':'No complete live examples are currently available. Describe your exposure below.');
        if(b.refreshing&&++attempts<12)timer=setTimeout(load,5000);
        else if(b.refreshing&&!b.examples.length)setExampleStatus('Examples are still updating. You can describe your exposure or refresh shortly.');
      }catch(e){if(!controller.signal.aborted)setExampleStatus(e instanceof Error?e.message:'Examples unavailable');}
    }
    void load();
    return()=>{controller.abort();clearTimeout(timer);};
  },[exampleRevision]);
  async function send(action:string,words='',session=draft?.session,field?:string,amounts?:Record<string,string>) {
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');
    if(words)setTurns(t=>[...t,{you:true,text:words}]);
    try {
      const res=await fetch('/api/studio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,text:words,session,field,amounts})});
      const body=await res.json();if(!res.ok||!body.result)throw new Error(body.error??'Could not complete that request. Please try again.');
      let next=body.result as StudioReply;
      // Retain the complete brief if pricing fails, so the user can edit or retry.
      if(next.kind==='brief'&&next.ready&&action!=='build'){
        setDraft(next);setEditing(null);setText('');setStaged(null);setScreen('exposure');
        const priced=await fetch('/api/studio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'build',session:next.session})});
        const result=await priced.json();
        if(!priced.ok||!result.result)throw new Error(result.error??'Pricing failed. Your details are saved below; try again.');
        next=result.result as StudioReply;
      }
      setTurns(t=>[...t,{you:false,text:next.question?.text??next.message}]);
      if(next.kind!=='help'){setDraft(next);setEditing(null);setScreen(next.kind==='quoted'?'baskets':'exposure');}
      setText('');setStaged(null);
    }catch(e){setError(e instanceof Error?e.message:'Please try again.');}
    finally{lock.current=false;setBusy(false);}
  }
  const quoted=draft?.kind==='quoted'&&draft.view&&draft.quoteId?draft:null;
  return <div className="wrap studio">
    <header className="bar"><Logo/><span className="brand">polyhedge</span><span className="tag">beta</span><span className="spacer"/><Connect/></header>
    <main className="studio-content">
    {screen==='detail'&&quoted?.view&&quoted.quoteId ? <Basket marketHistory={marketHistory} key={`${quoted.quoteId}:${opened}`} view={currentView!} initialView={quoted.view} optionId={opened} live={live} onBack={()=>setScreen('baskets')}/> : screen==='baskets'&&quoted?.view ? <>
      <h1 className="statement">Compare your hedges.</h1>
      <div className="comparison-live"><LiveBadge live={live}/><PricingWarning live={live}/></div>
      <Cards history={live.history} view={currentView!} onOpen={i=>{setOpened(currentView!.options[i]!.id);setScreen('detail');}} onRefine={()=>setScreen('exposure')}/>
      <CostCurve points={curve.points} loading={curve.loading} options={curve.options} budgetUsd={curve.budgetUsd} refreshing={curve.refreshing} refreshFailed={curve.refreshFailed}/>
    </> : <>
      {draft&&<button className="back" disabled={busy} onClick={startOver}>← New exposure</button>}
      <div className="studio-intro"><div className="eyebrow">Start with your exposure</div><h1 className="statement">What could lose you money?</h1><p className="lede">Tell us what could go wrong, when, and what you would lose. We’ll look for matching Polymarket events and show the protection available, its cost, and what remains uncovered.</p></div>
      {draft?.unavailable&&<section className="note warn" role="status"><strong>This market isn’t supported yet.</strong><p>{draft.unavailable}</p><span>Adding loss or budget amounts will not make this market eligible.</span></section>}
      {draft?.brief&&<section className="brief"><h3>Your exposure</h3><div className="brief-grid">
        {draft.brief.filter(f=>!isAmountField(f.key)||draft.collectAmounts).map(f=><div className="brief-field" key={f.key}>
          <label htmlFor={isAmountField(f.key)&&!f.readOnly?`amount-${f.key}`:undefined}>{f.label}</label>
          {isAmountField(f.key)&&!f.readOnly ? <>
            <input id={`amount-${f.key}`} form="protection-amounts" required inputMode="decimal" disabled={busy} value={amountValues[f.key]??''} onChange={e=>setAmountValues(v=>({...v,[f.key]:e.target.value}))} placeholder="Enter amount"/>
            <div className="field-suggestions"><small>Choose an amount or enter your own</small>
              {fieldSuggestions(f.key).map(c=><button type="button" key={c.value} disabled={busy} onClick={()=>setAmountValues(v=>({...v,[f.key]:c.value}))}>{c.label}</button>)}
              {f.key==='budgetUsd'&&<button type="button" disabled={busy} onClick={()=>setAmountValues(v=>({...v,budgetUsd:'no cap'}))}>No spending cap</button>}
            </div>
          </> : f.readOnly?<strong>{f.value||'Calculated from the outcome losses'}</strong>:editing===f.key?<form onSubmit={e=>{e.preventDefault();void send('edit',editValue,draft.session,f.key);}}>
            <input autoFocus aria-label={f.label} value={editValue} onChange={e=>setEditValue(e.target.value)} disabled={busy}/><button disabled={busy||!editValue.trim()}>Save</button><button type="button" disabled={busy} onClick={()=>setEditing(null)}>Cancel</button>
          </form>:<button disabled={busy} onClick={()=>{setEditing(f.key);setEditValue(f.value);}}><strong>{f.value||(f.key==='deadline'?'Confirm with the matched event':'Enter your own')}</strong><span className={`field-status ${f.status}`}>{f.status==='inferred'?'Confirm this':f.status==='missing'?'Add detail':'Edit'}</span></button>}
          {f.key==='trigger'&&draft.question?.key==='eventCondition'&&<div className="field-suggestions">{draft.question.choices?.map(c=><button key={c.value} disabled={busy} onClick={()=>void send('answer',c.value)}>{c.label}</button>)}</div>}
        </div>)}
      </div>
      {draft.collectAmounts&&<form id="protection-amounts" className="build-row" onSubmit={e=>{e.preventDefault();void send('amounts','',draft.session,undefined,amountValues);}}><p>Set your amounts together, then build your hedges.</p><button className="primary" disabled={busy||editing!==null}>{busy?'Building…':'Build hedges →'}</button></form>}
      </section>}
      {turns.length>0&&<div className="conversation" aria-live="polite">{turns.map((t,i)=><div className="turn" key={i}><span className="who">{t.you?'You':<Logo/>}</span><span className="msg">{t.text}</span></div>)}</div>}
      {draft?.rules&&<details className="section" open><summary>Settlement rules</summary>{draft.rules.map((r,i)=><p className="note" key={i}>{r}</p>)}</details>}
      {!draft?.collectAmounts&&draft?.question?.choices&&<div className="chips">{draft.question.choices.map(c=><button disabled={busy} key={c.value} onClick={()=>void send('answer',c.value)}>{c.label}</button>)}</div>}
      {!draft?.collectAmounts&&<form className="composer" onSubmit={e=>{e.preventDefault();const words=text.trim();if(staged){void send('example',words,staged.session);return;}void send(draft?.question?'answer':'describe',words);}}><textarea aria-label="Describe your exposure or ask a question" rows={3} maxLength={2000} value={text} disabled={busy} onChange={e=>setText(e.target.value)} placeholder={draft?.question?(draft.question.choices?'Choose an option above, or type your own answer here.':/outcome:|lossUsd|coverageUsd|budgetUsd/.test(draft.question.key)?'Enter a dollar amount, for example 5000. For an outcome with no loss, enter 0.':/date|deadline/i.test(draft.question.key)?'For example: September 30, 2026. Include the time and timezone if relevant.':'Describe the condition that would cause your loss, for example a rate increase of 25 basis points.'):'For example: I hold 2 BTC and would lose $8,000 if it falls below $77,000 in September. Or ask how hedging here works.'}/><button className="primary" disabled={busy||!text.trim()}>{busy?'Working…':draft?.question?'Send answer':'Continue'} <span aria-hidden>→</span></button></form>}
      {!draft&&<div className="example-list"><span className="eyebrow">Or start from an example · live market prices</span>{examples.map(e=><button className="chip" key={e.id} disabled={busy} onClick={()=>{setStaged(e);setText(e.description);}}>{e.label}</button>)}{exampleStatus&&<p className="note">{exampleStatus}</p>}<button disabled={busy||exampleStatus==='Finding current examples…'} onClick={()=>setExampleRevision(n=>n+1)}>Refresh examples</button></div>}
    </>}
    {busy&&<p role="status" className="note"><span className="spin"/> Working on your request…</p>}
    {error&&<p role="alert" className="note warn">{error}</p>}
    </main>
    <ProductFooter/>
  </div>;
}
