import { createHash } from 'node:crypto';
import { quote, quoteSession } from '@polyhedge/engine';
import { hedgeQuality } from './hedge-quality.js';
import { join } from 'node:path';
import { GAMMA, CLOB, parseBook, eventSupport, parseEvent, parseLadder, parseLadderLabel, type EventSelection, type GammaEvent } from '@polyhedge/venue';
import { indexEvent } from '@polyhedge/intake/retrieve';
import type { MarketIndex } from './markets.js';
import { atomicJson, catalogueStore, emptyIndex, readJson } from './catalogue-store.js';
import { newDraft, setField, sealDraft, quoteFromDraft, type StudioDraft } from './studio-draft.js';
import { holdingLoss } from './studio-input.js';
import { familyEnabled } from './event-family.js';
import type { StudioExample } from './studio-types.js';

const binaryExamplePatterns:Record<string,RegExp>={shutdown:/^Government shutdown by /i,oil:/Crude Oil.*new all.time high by /i};

export function exampleDraft(id:string,event:GammaEvent,observationAt?:string,level?:number):StudioDraft|null {
  const kind=id==='rates'?'categorical':(id==='event'||id==='arsenal'||id in binaryExamplePatterns)?'binary':'numeric';
  if(!familyEnabled(kind))return null;
  if(kind==='binary'&&!event.markets[0])return null;
  const binaryPattern=binaryExamplePatterns[id];
  const selected=binaryPattern?event.markets.filter(m=>binaryPattern.test(m.question)&&businessDateAllowed(m.endDate)).sort((a,b)=>horizonDistance(a.endDate)-horizonDistance(b.endDate))[0]:id==='arsenal'?event.markets.find(m=>/Arsenal.*win.*Premier League/i.test(m.question)):event.markets[0];
  if(kind==='binary'&&!selected)return null;
  const selection:EventSelection=kind==='binary'?{kind,marketId:selected!.id}:{kind};
  const support=eventSupport(event,selection);
  if(binaryPattern&&!businessDateAllowed(observationAt??support.observationAt))return null;
  if(!support.eligible||Date.parse(support.observationAt)<=Date.now()
    ||Date.parse(observationAt??support.observationAt)<=Date.now())return null;
  const d=newDraft('');d.exampleQualityRequired=true;
  d.event={id:event.id,selection,support};
  const payout=id==='weather'?12000:id==='rates'?10000:id==='eth'?5000:8000;
  const budget=id==='weather'?900:id==='rates'?1500:id==='shutdown'?1000:id==='oil'?1200:id==='eth'?500:id==='arsenal'?1000:id==='btc'?1500:600;
  let exposure:string,trigger:string;
  if(kind==='numeric') {
    // Use a real interior boundary of this listed partition, not a stale price.
    const labels=event.markets.map(m=>m.groupItemTitle);
    // parseLadder is shared with the compiler so units and boundaries agree.
    const ladder=parseLadder([...labels].sort((a,b)=>(parseLadderLabel(a)?.lo??-Infinity)-(parseLadderLabel(b)?.lo??-Infinity)));
    if(!ladder)return null;
    const bounds=ladder.brackets.flatMap(b=>b.lo===null?[]:[b.lo]);
    const k=level??bounds[Math.floor(bounds.length/2)];
    if(k!==undefined&&!bounds.includes(k))return null;
    if(k===undefined)return null;
    if(id==='weather') {
      exposure='Outdoor event revenue in Chicago';
      trigger=`Chicago daily high below ${k}${ladder.unit}; the daily high is an accepted proxy for my event`;
      d.request={eventId:event.id,selection,ruleHash:support.ruleHash,shape:{templateId:'threshold_digital',direction:'below',k,payoutUsd:payout}};
    } else {
      // A holding loses gradually as the price falls, not all at once at one level.
      const quantity=id==='eth'?10:2,coin=id==='eth'?'ETH':'BTC';
      const holding=holdingLoss({quantity,coin},'below',k,payout);
      exposure=`${quantity} ${coin} holdings`;
      trigger=`${holding.trigger}, under the listed price-source rules`;
      d.request={eventId:event.id,selection,ruleHash:support.ruleHash,shape:holding.shape};
    }
  } else {
    exposure=id==='shutdown'?`Government-contracting revenue lost if the listed event occurs: ${selected!.question}`:id==='oil'?`Delivery business fuel costs; the listed event is an accepted proxy for an $8,000 loss: ${selected!.question}`:id==='rates'?'$2M US floating-rate debt; Fed policy is an accepted proxy':id==='arsenal'?'Merchandise revenue lost if Arsenal does not win the 2026–27 Premier League':'Business exposure to the selected event';
    const losses=support.outcomes.map((o,i)=>({outcomeId:o.id,lossCents:id==='rates'?(o.label==='25 bps increase'?500000:o.label==='50+ bps increase'?1000000:0):id==='arsenal'?(o.side==='NO'?800000:0):binaryPattern?(o.side==='YES'?800000:0):i===0?800000:0}));
    if(!losses.some(l=>l.lossCents>0))return null;
    trigger=support.outcomes.map((o,i)=>`${o.label}: $${losses[i]!.lossCents/100} loss`).join('; ');
    d.request={eventId:event.id,selection,ruleHash:support.ruleHash,shape:{templateId:'outcome_losses',losses}};
    support.outcomes.forEach((o,i)=>setField(d,`outcome:${o.id}`,String(losses[i]!.lossCents/100),'stated',`${o.label} loss ($)`));
  }
  d.request.budgetUsd=budget;d.request.execution={quantityStep:.01};d.request.protectionGoal={kind:'minimize_net_loss'};
  const date=observationAt??support.observationAt;
  d.description=`${exposure}. ${trigger}. Protection date: ${date}. Potential loss $${payout}; cover target $${payout}; spending budget $${budget}.`;
  for(const [key,value] of Object.entries({exposure,trigger,deadline:date,lossUsd:payout,coverageUsd:payout,budgetUsd:budget}))setField(d,key,String(value));
  d.assumptions=['Complete example exposure: the quantities, loss amounts and budget are illustrative user inputs, not inferred from your own circumstances.',`Matched settlement event: ${support.title}. The published rules determine payouts; your actual business loss may differ.`,...new Set(support.rules.map(r=>r.description))];
  return d;
}
type ExamplePlan={id:string;label:string;query:string;rows:{id:string;at:string}[]};
const BUSINESS_MIN_LEAD=7*24*60*60_000;
const businessDateAllowed=(date:string)=>Date.parse(date)>=Date.now()+BUSINESS_MIN_LEAD;
const btcHorizonDistance=(date:string)=>Math.abs(Date.parse(date)-(Date.now()+30*24*60*60_000));
const EXAMPLE_HORIZON=90*24*60*60_000;
const horizonDistance=(date:string)=>Math.abs(Date.parse(date)-(Date.now()+EXAMPLE_HORIZON));
export function examplePlans(index:MarketIndex):ExamplePlan[] {
  const future=index.events.filter(e=>Date.parse(e.observationAt)>Date.now()+60_000).sort((a,b)=>horizonDistance(a.observationAt)-horizonDistance(b.observationAt));
  return [
    {id:'btc',label:'BTC holdings',query:'Bitcoin price',rows:future.filter(e=>/bitcoin price/i.test(e.title)).sort((a,b)=>btcHorizonDistance(a.observationAt)-btcHorizonDistance(b.observationAt)).slice(0,7).map(e=>({id:e.eventId,at:e.observationAt}))},
    ...Object.entries(binaryExamplePatterns).map(([id,pattern])=>({id,label:id==='shutdown'?'Government shutdown':'Oil costs',query:id==='shutdown'?'Government shutdown':'Crude oil all time high',rows:[...new Map(index.listings.filter(r=>r.kind==='binary'&&r.eligible&&pattern.test(r.title)&&businessDateAllowed(r.date)).sort((a,b)=>horizonDistance(a.date)-horizonDistance(b.date)).map(r=>[r.eventId,{id:r.eventId,at:r.date}])).values()].slice(0,3)})),
    {id:'eth',label:'ETH holdings',query:'Ethereum price',rows:future.filter(e=>/ethereum price/i.test(e.title)).slice(0,7).map(e=>({id:e.eventId,at:e.observationAt}))},
    {id:'arsenal',label:'Arsenal merchandise',query:'EPL 2027 Champion',rows:index.listings.filter(r=>r.kind==='binary'&&/Arsenal.*win.*2026-27.*Premier League/i.test(r.title)&&Date.parse(r.date)>Date.now()).slice(0,3).map(r=>({id:r.eventId,at:r.date}))},
    {id:'weather',label:'Chicago weather',query:'highest temperature in Chicago',rows:future.filter(e=>/highest temperature in chicago/i.test(e.title)).slice(0,3).map(e=>({id:e.eventId,at:e.observationAt}))},
    {id:'rates',label:'Borrowing costs',query:'Fed decision',rows:index.listings.filter(r=>r.kind==='categorical'&&r.eligible&&/fed decision/i.test(r.title)&&Date.parse(r.date)>Date.now()).sort((a,b)=>horizonDistance(a.date)-horizonDistance(b.date)).slice(0,3).map(r=>({id:r.eventId,at:r.date}))},
  ];
}
type CachedExample={id:string;label:string;draft:StudioDraft;checkedAt:number;quality?:ReturnType<typeof hedgeQuality>;qualityVersion?:1};
type ExampleDiagnostics={checkedAt:number;candidates:number;qualified:number;issues:{eventId:string|null;stage:string;message:string}[]};
type ExampleCache={version:1;updatedAt:number;refreshing:boolean;entries:CachedExample[];diagnostics?:Record<string,ExampleDiagnostics>};
const EXAMPLE_TTL=10*60_000;
/** HiGHS runs synchronous WASM in one worker thread. Starting every candidate
 * together lets unrelated solves consume each other's wall-clock deadlines. */
function candidateQueue() {
  let active=0;
  const waiting:(()=>void)[]=[];
  return async function run<T>(work:()=>Promise<T>):Promise<T> {
    if(active>=2)await new Promise<void>(resolve=>waiting.push(resolve));
    else active++;
    try{return await work();}
    finally{const next=waiting.shift();if(next)next();else active--;}
  };
}
function usable(entry:CachedExample):boolean {
  return (!(entry.id in binaryExamplePatterns)||businessDateAllowed(entry.draft.fields.find(f=>f.key==='deadline')?.value??''))&&entry.qualityVersion===1&&entry.quality?.eligible===true&&Date.now()-entry.checkedAt<EXAMPLE_TTL && !!entry.draft.event && familyEnabled(entry.draft.event.selection.kind)
    && Date.parse(entry.draft.event.support.observationAt)>Date.now()+60_000
    && Date.parse(entry.draft.fields.find(f=>f.key==='deadline')?.value??'')>Date.now()+60_000;
}
/** Called only by the worker. Publish each family as soon as it is ready. */
export async function refreshExampleCache(index:MarketIndex|null,store:string,fetchImpl:typeof fetch=fetch):Promise<void> {
  const path=join(store,'studio-examples.json');
  let cache:ExampleCache={version:1,updatedAt:Date.now(),refreshing:true,entries:[],diagnostics:{}};
  try{const old=await readJson<ExampleCache>(path);if(old.version===1)cache.entries=old.entries.filter(usable);}catch{ /* First start. */ }
  await atomicJson(path,cache);
  let writes=Promise.resolve();
  const persist=()=>{const value=JSON.parse(JSON.stringify(cache));writes=writes.then(()=>atomicJson(path,value));return writes;};
  const runCandidate=candidateQueue();
  await Promise.all(examplePlans(index??emptyIndex()).map(async plan=>{
    const diagnostics:ExampleDiagnostics={checkedAt:Date.now(),candidates:0,qualified:0,issues:[]};
    cache.diagnostics![plan.id]=diagnostics;
    const issue=(eventId:string|null,stage:string,error:unknown)=>{
      const message=error instanceof Error?error.message:String(error);
      diagnostics.issues.push({eventId,stage,message});
      console.warn('[examples]',{family:plan.id,eventId,stage,message});
    };
    try{
      const candidateLimit=['btc','eth'].includes(plan.id)?7:3;
      let rows=plan.rows.map(r=>({id:r.id}));
      if(!rows.length){
        const url=new URL(`${GAMMA}/public-search`);
        url.search=new URLSearchParams({q:plan.query,events_status:'active',limit_per_type:String(candidateLimit),search_profiles:'false',search_tags:'false',keep_closed_markets:'0'}).toString();
        const response=await fetchImpl(url,{signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`Example discovery unavailable: HTTP ${response.status}`);
        const raw=await response.json() as {events?:{id?:unknown}[]};
        rows=(raw.events??[]).filter(e=>typeof e.id==='string').slice(0,candidateLimit).map(e=>({id:String(e.id)}));
      }
      diagnostics.candidates=rows.length;
      // Validate independently, then choose by measured protection.
      const results=await Promise.allSettled(rows.map(row=>runCandidate(async()=>{
        // Queue time is not network or solve time. Each active candidate gets
        // a bounded window for its detail, books and at most three variants.
        const signal=AbortSignal.timeout(60_000);
        const response=await fetchImpl(`${GAMMA}/events/${encodeURIComponent(row.id)}`,{signal});
        if(!response.ok)throw new Error(`Example detail unavailable: HTTP ${response.status}`);
        const event=parseEvent(await response.json());
        const pattern=plan.id==='btc'?/bitcoin price/i:plan.id==='eth'?/ethereum price/i:plan.id==='arsenal'?/EPL.*2027.*Champion|Premier League/i:plan.id==='weather'?/highest temperature in chicago/i:/fed decision/i;
        if(!(binaryExamplePatterns[plan.id]?event.markets.some(m=>binaryExamplePatterns[plan.id]!.test(m.question)):pattern.test(event.title)))throw new Error('Different event family');
        const numeric=['btc','eth','weather'].includes(plan.id)?indexEvent(event):null;
        if(['btc','eth','weather'].includes(plan.id)&&!numeric)throw new Error('Observation cannot be established');
        const observation=numeric?.observationAt;
        const draft=exampleDraft(plan.id,event,observation);
        if(!draft)throw new Error('Example is not supportable');
        const variants=[draft];
        if(numeric){
          const boundaries=[...new Set(event.markets.map(m=>parseLadderLabel(m.groupItemTitle)?.lo).filter((v):v is number=>v!==null&&v!==undefined))].sort((a,b)=>a-b);
          // Explore a bounded set of clearly stated loss thresholds, including
          // lower strikes. Never alter a real user's exposure to pass this gate.
          for(const k of boundaries.slice(0,2)){
            const alternative=exampleDraft(plan.id,event,observation,k);
            if(alternative&&alternative.description!==draft.description)variants.push(alternative);
          }
        }
        const session=quoteSession({signal,fetchEvent:async()=>event,fetchBooks:async ids=>{
          const response=await fetchImpl(`${CLOB}/books`,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify(ids.map(token_id=>({token_id})))});
          if(!response.ok)throw Error(`Example books unavailable: HTTP ${response.status}`);
          return (await response.json() as unknown[]).map(parseBook);
        },saveSnapshot:async books=>createHash('sha256').update(JSON.stringify(books)).digest('hex')});
        const accepted:{draft:StudioDraft;quality:ReturnType<typeof hedgeQuality>}[]=[];
        let failed=false;
        // Sequential solves reuse a single book snapshot and bound CPU work.
        for(const candidate of variants){
          try{
            const record=await quote(quoteFromDraft(candidate),{...session,deadlineAt:Date.now()+10_000});
            const quality=hedgeQuality(record.basket.target,record.basket.achievable,record.basket.totalCostCents);
            if(quality.eligible)accepted.push({draft:candidate,quality});
          }catch(error){ failed=true;issue(row.id,'quote',error); }
        }
        accepted.sort((a,b)=>b.quality.reduction-a.quality.reduction);
        if(!accepted.length&&failed)throw Error('Example quality could not be fully measured');
        return accepted[0]??null;
      })));
      const candidates=results.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]).sort((a,b)=>b.quality.reduction-a.quality.reduction||horizonDistance(a.draft.fields.find(f=>f.key==='deadline')!.value)-horizonDistance(b.draft.fields.find(f=>f.key==='deadline')!.value));
      diagnostics.qualified=candidates.length;
      results.forEach((result,i)=>{if(result.status==='rejected')issue(rows[i]!.id,'candidate',result.reason);});
      // A freshly measured failure replaces a previously good example. Network
      // failures may retain a recently verified one, bounded by its TTL.
      if(results.length&&results.every(r=>r.status==='fulfilled'))cache.entries=cache.entries.filter(e=>e.id!==plan.id);
      const best=candidates[0];
      if(best){
        cache.entries=cache.entries.filter(e=>e.id!==plan.id);
        cache.entries.push({id:plan.id,label:plan.label,...best,checkedAt:Date.now(),qualityVersion:1});
      }
      cache.updatedAt=Date.now();await persist();
    }catch(error){issue(null,'discovery',error); /* Retain only unexpired validated examples. */ }
    diagnostics.checkedAt=Date.now();
  }));
  cache.refreshing=false;cache.updatedAt=Date.now();await persist();
}
let exampleRead:Promise<ExampleCache|null>|null=null,exampleReadAt=0,exampleStore='';
/** Small local file only. Sign sessions now so persisted examples survive server restarts. */
export async function cachedStudioExamples(store=catalogueStore()):Promise<{examples:StudioExample[];refreshing:boolean}> {
  if(!exampleRead||store!==exampleStore||Date.now()-exampleReadAt>1000){
    exampleStore=store;exampleReadAt=Date.now();exampleRead=readJson<ExampleCache>(join(store,'studio-examples.json')).catch(()=>null);
  }
  const cache=await exampleRead;
  const entries=cache?.version===1?cache.entries.filter(usable):[];
  return { examples:entries.map(e=>({id:e.id,label:e.label,description:e.draft.description,session:sealDraft({...e.draft,expires:Date.now()+2*60*60_000})})),
    refreshing:!cache || (cache.refreshing && Date.now()-cache.updatedAt<30_000) };
}

/** Rebind only a cached fingerprint change, never silently accept changed settlement evidence. */
export function refreshExampleEvidence(original:StudioDraft,event:GammaEvent):StudioDraft {
  if(!original.event||!original.request)throw Error('bad_request: incomplete example');
  const current=eventSupport(event,original.event.selection);
  if(!current.eligible)throw Error(`unavailable: ${current.reason}`);
  const evidence=(support:typeof current)=>JSON.stringify({kind:support.kind,title:support.title,observationAt:support.observationAt,unit:support.unit,outcomes:support.outcomes,rules:support.rules,marketIds:support.marketIds});
  const draft=structuredClone(original);
  if(evidence(original.event.support)!==evidence(current)){
    delete draft.request;delete draft.options;
    draft.pending={key:'description',text:'This example’s settlement details have changed. Please describe your exposure again so we can match it to the updated event.'};
    return draft;
  }
  draft.event!.support=current;draft.request!.ruleHash=current.ruleHash;
  return draft;
}
