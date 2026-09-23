import { join } from 'node:path';
import { GAMMA, eventSupport, parseEvent, parseLadder, parseLadderLabel, type EventSelection, type GammaEvent } from '@polyhedge/venue';
import { indexEvent } from '@polyhedge/intake/retrieve';
import type { MarketIndex } from './markets.js';
import { atomicJson, catalogueStore, emptyIndex, readJson } from './catalogue-store.js';
import { newDraft, setField, sealDraft, type StudioDraft } from './studio-draft.js';
import { holdingLoss } from './studio-input.js';
import { familyEnabled } from './event-family.js';
import type { StudioExample } from './studio-types.js';

export function exampleDraft(id:string,event:GammaEvent,observationAt?:string):StudioDraft|null {
  const kind=id==='rates'?'categorical':id==='event'?'binary':'numeric';
  if(!familyEnabled(kind))return null;
  if(kind==='binary'&&!event.markets[0])return null;
  const selection:EventSelection=kind==='binary'?{kind,marketId:event.markets[0]!.id}:{kind};
  const support=eventSupport(event,selection);
  if(!support.eligible||Date.parse(support.observationAt)<=Date.now()
    ||Date.parse(observationAt??support.observationAt)<=Date.now())return null;
  const d=newDraft('');
  d.event={id:event.id,selection,support};
  const payout=id==='weather'?12000:id==='rates'?10000:8000;
  const budget=id==='weather'?900:id==='rates'?800:600;
  let exposure:string,trigger:string;
  if(kind==='numeric') {
    // Use a real interior boundary of this listed partition, not a stale price.
    const labels=event.markets.map(m=>m.groupItemTitle);
    // parseLadder is shared with the compiler so units and boundaries agree.
    const ladder=parseLadder([...labels].sort((a,b)=>(parseLadderLabel(a)?.lo??-Infinity)-(parseLadderLabel(b)?.lo??-Infinity)));
    if(!ladder)return null;
    const bounds=ladder.brackets.flatMap(b=>b.lo===null?[]:[b.lo]);
    const k=bounds[Math.floor(bounds.length/2)];
    if(k===undefined)return null;
    if(id==='weather') {
      exposure='Outdoor event revenue in Chicago';
      trigger=`Chicago daily high below ${k}${ladder.unit}; the daily high is an accepted proxy for my event`;
      d.request={eventId:event.id,selection,ruleHash:support.ruleHash,shape:{templateId:'threshold_digital',direction:'below',k,payoutUsd:payout}};
    } else {
      // A holding loses gradually as the price falls, not all at once at one level.
      const holding=holdingLoss({quantity:2,coin:'BTC'},'below',k,payout);
      exposure='2 BTC holdings';
      trigger=`${holding.trigger}, under the listed price-source rules`;
      d.request={eventId:event.id,selection,ruleHash:support.ruleHash,shape:holding.shape};
    }
  } else {
    exposure=id==='rates'?'$2M US floating-rate debt; Fed policy is an accepted proxy':'Business exposure to the selected event';
    const losses=support.outcomes.map((o,i)=>({outcomeId:o.id,lossCents:id==='rates'?(o.label==='25 bps increase'?500000:o.label==='50+ bps increase'?1000000:0):i===0?800000:0}));
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
function examplePlans(index:MarketIndex):ExamplePlan[] {
  const future=index.events.filter(e=>Date.parse(e.observationAt)>Date.now()+60_000).sort((a,b)=>a.observationAt.localeCompare(b.observationAt));
  return [
    {id:'btc',label:'BTC holdings',query:'Bitcoin price',rows:future.filter(e=>/bitcoin price/i.test(e.title)).slice(0,3).map(e=>({id:e.eventId,at:e.observationAt}))},
    {id:'weather',label:'Chicago weather',query:'highest temperature in Chicago',rows:future.filter(e=>/highest temperature in chicago/i.test(e.title)).slice(0,3).map(e=>({id:e.eventId,at:e.observationAt}))},
    {id:'rates',label:'Borrowing costs',query:'Fed decision',rows:index.listings.filter(r=>r.kind==='categorical'&&r.eligible&&/fed decision/i.test(r.title)&&Date.parse(r.date)>Date.now()).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3).map(r=>({id:r.eventId,at:r.date}))},
  ];
}
type CachedExample={id:string;label:string;draft:StudioDraft;checkedAt:number};
type ExampleCache={version:1;updatedAt:number;refreshing:boolean;entries:CachedExample[]};
const EXAMPLE_TTL=10*60_000;
function usable(entry:CachedExample):boolean {
  return Date.now()-entry.checkedAt<EXAMPLE_TTL && !!entry.draft.event && familyEnabled(entry.draft.event.selection.kind)
    && Date.parse(entry.draft.event.support.observationAt)>Date.now()+60_000
    && Date.parse(entry.draft.fields.find(f=>f.key==='deadline')?.value??'')>Date.now()+60_000;
}
/** Called only by the worker. Publish each family as soon as it is ready. */
export async function refreshExampleCache(index:MarketIndex|null,store:string,fetchImpl:typeof fetch=fetch):Promise<void> {
  const path=join(store,'studio-examples.json');
  let cache:ExampleCache={version:1,updatedAt:Date.now(),refreshing:true,entries:[]};
  try{const old=await readJson<ExampleCache>(path);if(old.version===1)cache.entries=old.entries.filter(usable);}catch{ /* First start. */ }
  await atomicJson(path,cache);
  let writes=Promise.resolve();
  const persist=()=>{const value=JSON.parse(JSON.stringify(cache));writes=writes.then(()=>atomicJson(path,value));return writes;};
  await Promise.all(examplePlans(index??emptyIndex()).map(async plan=>{
    try{
      const signal=AbortSignal.timeout(10_000);
      let rows=plan.rows.map(r=>({id:r.id}));
      if(!rows.length){
        const url=new URL(`${GAMMA}/public-search`);
        url.search=new URLSearchParams({q:plan.query,events_status:'active',limit_per_type:'3',search_profiles:'false',search_tags:'false',keep_closed_markets:'0'}).toString();
        const response=await fetchImpl(url,{signal});if(!response.ok)throw new Error('Example discovery unavailable');
        const raw=await response.json() as {events?:{id?:unknown}[]};
        rows=(raw.events??[]).filter(e=>typeof e.id==='string').slice(0,3).map(e=>({id:String(e.id)}));
      }
      // Bounded parallel detail reads: one slow candidate cannot hold up a usable one.
      await Promise.any(rows.map(async row=>{
        const response=await fetchImpl(`${GAMMA}/events/${encodeURIComponent(row.id)}`,{signal});
        if(!response.ok)throw new Error('Example detail unavailable');
        const event=parseEvent(await response.json());
        const pattern=plan.id==='btc'?/bitcoin price/i:plan.id==='weather'?/highest temperature in chicago/i:/fed decision/i;
        if(!pattern.test(event.title))throw new Error('Different event family');
        const numeric=indexEvent(event);
        if(plan.id!=='rates'&&!numeric)throw new Error('Observation cannot be established');
        const observation=numeric?.observationAt;
        const draft=exampleDraft(plan.id,event,observation);
        if(!draft)throw new Error('Example is not supportable');
        return draft;
      })).then(async draft=>{
        cache.entries=cache.entries.filter(e=>e.id!==plan.id);
        cache.entries.push({id:plan.id,label:plan.label,draft,checkedAt:Date.now()});
        cache.updatedAt=Date.now();await persist();
      });
    }catch{ /* Retain the last validated, unexpired example for this family. */ }
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
