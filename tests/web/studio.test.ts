import { findNumbers } from '../../packages/intake/src/parse.js';
import { expect, it } from 'vitest';
import { exampleDraft } from '../../apps/web/lib/studio-examples.js';
import { field, newDraft, quoteFromDraft, readDraft, reply, sealDraft, setField } from '../../apps/web/lib/studio-draft.js';
import { heldCoins, holdingLoss } from '../../apps/web/lib/studio-input.js';
import { describeExposure, productHelp, updateDraft, type StudioIntakeDeps } from '../../apps/web/lib/studio-intake.js';
import { eventListings, exposureListings } from '../../apps/web/lib/event-listings.js';
import { eventSupport, type GammaEvent } from '../../packages/venue/src/index.js';

function event(kind: 'numeric'|'binary'|'categorical'):GammaEvent {
  const description=kind==='categorical'?'Federal Open Market Committee: rounded up to the nearest 25; will resolve to the amount of basis points the upper bound changes; will resolve to the "No change" bracket; https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm':'Resolves using the published observation on the listed date.';
  const labels=kind==='categorical'?['50+ bps decrease','25 bps decrease','No change','25 bps increase','50+ bps increase']:kind==='numeric'?['<60,000','60,000-64,000','>64,000']:['Yes'];
  return {id:'100',slug:'example',title:'Fed Decision',description,negRisk:kind!=='binary',negRiskAugmented:false,negRiskMarketId:'group',endDate:'2099-10-28T23:59:00Z',tags:[],seriesTickers:[],markets:labels.map((label,i)=>({id:String(i+1),question:label,groupItemTitle:label,description,conditionId:`0x${String(i+1).padStart(64,'0')}`,slug:null,yesTokenId:String(i*2+1),noTokenId:String(i*2+2),yesPrice:.2,tickSize:.01,feeRate:0,endDate:'2099-10-28T23:59:00Z',negRisk:kind!=='binary',negRiskMarketId:'group',active:true,closed:false,acceptingOrders:true,enableOrderBook:true,outcomeLabels:['Yes','No'],yesOutcomeIndex:0}))};
}
const unused=()=>{throw new Error('An amount answer must not call a model or the venue');};
const deps:StudioIntakeDeps={index:{events:[],listings:[],categories:[],discoveredEvents:0,discoveryComplete:true,resolutionText:new Map(),bracketLabels:new Map(),byId:new Map(),builtAt:0},engine:{ask:unused},today:new Date('2026-09-22'),fetchEvent:unused};
it('complete examples bind real event rules and build all supported shape types without interpretation',()=>{
  const expired=event('numeric');expired.endDate='2000-01-01T00:00:00Z';expired.markets.forEach(m=>m.endDate=expired.endDate);
  expect(exampleDraft('weather',expired,'2099-10-28T23:59:00Z')).toBeNull();
  for(const [id,kind] of [['btc','numeric'],['weather','numeric'],['rates','categorical'],['event','binary']] as const){
    const e=event(kind);
    if(id==='weather')e.markets.forEach((m,i)=>m.groupItemTitle=['60°F or below','61-62°F','63°F or higher'][i]!);
    const d=exampleDraft(id,e);expect(d).not.toBeNull();
    expect(reply(d!).ready).toBe(true);
    const request=quoteFromDraft(readDraft(sealDraft(d!)));
    expect(request.selection?.kind).toBe(kind);
    expect(request.ruleHash).toBe(eventSupport(e,request.selection!).ruleHash);
    expect(request.budgetUsd).toBeGreaterThan(0);
    // A BTC holding loses gradually; an event-revenue loss happens all at once.
    expect(request.shape.templateId).toBe(id==='btc'?'linear_strip':kind==='numeric'?'threshold_digital':'outcome_losses');
    // Every Studio quote plans on part of the displayed depth.
    expect(request.planningDepth).toBe(0.9);
    expect(request.selectionPolicy).toBe('premium');
  }
  // 2 BTC losing $8,000 by $64,000 starts losing at $68,000, at $2 per $1.
  const btc=quoteFromDraft(readDraft(sealDraft(exampleDraft('btc',event('numeric'))!)));
  expect(btc.shape).toEqual({templateId:'linear_strip',direction:'below',k1:64000,k2:68000,payoutUsd:8000});
});

it('reads a coin holding and turns it into a gradual loss', () => {
  expect(heldCoins('I hold 2 BTC and would lose $8,000 if it falls below $77,000')).toEqual({quantity:2,coin:'BTC'});
  expect(heldCoins('10 SOL holdings')).toEqual({quantity:10,coin:'SOL'});
  expect(heldCoins('I have 2 kids and a mortgage')).toBeNull();
  expect(holdingLoss({quantity:2,coin:'BTC'},'below',77000,8000)).toEqual({
    shape:{templateId:'linear_strip',direction:'below',k1:77000,k2:81000,payoutUsd:8000},
    trigger:'BTC below $81,000: loss grows $2 per $1 fall, reaching $8,000 at $77,000'});
  expect(holdingLoss({quantity:2,coin:'BTC'},'above',90000,8000).shape).toMatchObject({direction:'above',k1:86000,k2:90000});
});

it('confirms an inferred reading as shown without reinterpreting it', async () => {
  const d=exampleDraft('btc',event('numeric'))!;
  setField(d,'trigger',field(d,'trigger'),'inferred');
  const next=await updateDraft(d,'trigger',field(d,'trigger'),deps);
  expect(next.fields.find(f=>f.key==='trigger')?.status).toBe('stated');
  expect(next.request?.shape).toEqual(d.request?.shape);
});
it('missing cover, budget and uncertain dates block pricing; explicit answers need no network and preserve the original loss',async()=>{
  const d=exampleDraft('btc',event('numeric'))!;
  setField(d,'coverageUsd','','missing');setField(d,'budgetUsd','','missing');setField(d,'deadline','2099-10-28','inferred');
  expect(reply(d).question?.key).toBe('coverageUsd');expect(()=>quoteFromDraft(d)).toThrow(/complete/);
  await updateDraft(d,'coverageUsd','4000',deps);expect(reply(d).question?.key).toBe('budgetUsd');
  await updateDraft(d,'budgetUsd','no cap',deps);expect(reply(d).question?.key).toBe('deadline');
  await updateDraft(d,'deadline','2099-10-28',deps);expect(reply(d).ready).toBe(true);
  const request=quoteFromDraft(d);expect(request.shape).toMatchObject({payoutUsd:4000});expect(request.budgetUsd).toBeUndefined();expect(request.observationNote).toContain('Potential maximum loss: $8000');
  await updateDraft(d,'lossUsd','2000',deps);expect(reply(d).question?.key).toBe('coverageUsd');
  expect(()=>readDraft(sealDraft(d)+'x')).toThrow();
});
it('binary followups require a loss for both outcomes and preserve explicit zero',async()=>{
  const e=event('binary'),selection={kind:'binary' as const,marketId:'1'};
  const routingDeps:StudioIntakeDeps={...deps,index:{...deps.index,listings:eventListings(e).map(r=>({...r,title:'Fed decision'}))},fetchEvent:async()=>e,engine:{ask:async()=>({modelVersion:'test',answers:{hedge:{kind:'boolean',probability:.99}}})}};
  const matched=await describeExposure('My business is exposed to the Fed decision by October 28 2099.',routingDeps);
  expect(reply(matched).question?.key).toBe('eventMatch');
  await updateDraft(matched,'eventMatch','0',routingDeps);
  expect(reply(matched).rules?.length).toBeGreaterThan(0);
  await updateDraft(matched,'eventRules','confirm',routingDeps);
  expect(reply(matched).question?.key).toContain('outcome:');
  const d=newDraft('Business exposure');d.event={id:e.id,selection,support:eventSupport(e,selection)};
  setField(d,'exposure','Business exposure');setField(d,'deadline','2099-10-28');
  const outcomes=d.event.support.outcomes;
  await updateDraft(d,`outcome:${outcomes[0]!.id}`,'12000',deps);
  expect(reply(d).question?.key).toBe(`outcome:${outcomes[1]!.id}`);
  await updateDraft(d,`outcome:${outcomes[1]!.id}`,'0',deps);
  expect(reply(d).question?.key).toBe('coverageUsd');
  await updateDraft(d,'coverageUsd','full',deps);reply(d);await updateDraft(d,'budgetUsd','900',deps);
  expect(reply(d).ready).toBe(true);expect(quoteFromDraft(d).shape).toMatchObject({losses:[{lossCents:1200000},{lossCents:0}]});
  expect(findNumbers('below 64 F or above 20 C').map(n=>n.unit)).toEqual(['°F','°C']);
  expect(productHelp('How does PolyHedge work?')).toContain('coming soon');
  expect(eventListings(e).some(r=>r.kind==='binary'&&r.eligible)).toBe(true);
});

import { editExample, labeledAmounts } from '../../apps/web/lib/studio-input.js';
import { amount } from '../../apps/web/lib/studio-draft.js';
it('preserves all supported example types for amount edits but rematches changed dates, triggers and categorical loss mappings',()=>{
  for(const [id,kind] of [['btc','numeric'],['weather','numeric'],['rates','categorical'],['event','binary']] as const){
    const original=exampleDraft(id,event(kind))!;
    for(const value of ['$1,000.50','$1k','$1000']){
      const text=original.description.replace(/spending budget \$\d+/,`spending budget ${value}`);
      const edited=editExample(original,text)!;
      expect(reply(edited).ready).toBe(true);
      expect(quoteFromDraft(edited).budgetUsd).toBe(value==='$1,000.50'?1000.5:1000);
      expect(edited.event).toEqual(original.event);
      expect(original.description).not.toBe(text);
    }
    expect(editExample(original,original.description.replace('2099-10-28','2099-10-29'))).toBeNull();
    expect(editExample(original,original.description+' Actually protect something else.')).toBeNull();
    const over=editExample(original,original.description.replace(/cover target \$\d+/,'cover target $999999'))!;
    expect(reply(over).ready).toBe(false);
    if(kind!=='numeric')expect(editExample(original,original.description.replace(/Potential loss \$\d+/,'Potential loss $3000'))).toBeNull();
  }
  expect(labeledAmounts('Potential loss: $8,000; cover target $4k; spending budget: $1,000.50.')).toEqual({lossUsd:8000,coverageUsd:4000,budgetUsd:1000.5});
  expect(labeledAmounts('budget $1000; budget $2000').budgetUsd).toBeUndefined();
  expect(labeledAmounts('budget $1,00.00').budgetUsd).toBeUndefined();
  for(const value of ['$1,000.','1k.','1 k','1000 USD.'])expect(amount(value)).toBe(1000);
  expect(amount('1,00')).toBeNull();expect(amount('1000 or 2000')).toBeNull();
});

import { indexEvent } from '../../packages/intake/src/retrieve.js';
import { exposureSummary } from '../../apps/web/lib/studio-input.js';
it('routes a parsed but unsupported rates ladder to outcome losses instead of asking for one conflicting loss',async()=>{
  const e=event('categorical');
  const indexed=indexEvent(e);expect(indexed).not.toBeNull();
  const routing={...deps,index:{...deps.index,events:[indexed!],listings:eventListings(e)},fetchEvent:async()=>e};
  const d=await describeExposure('> I have $2 million of floating-rate debt. I want protection against the Fed decision by October 28 2099. A 25-basis-point increase costs $5,000; a 50-basis-point increase costs $10,000. Cover target $10,000; budget $800.',routing);
  expect(reply(d).question?.key).toBe('eventMatch');
  expect(d.numeric).toBeUndefined();
  expect(reply(d).brief?.find(f=>f.key==='lossUsd')?.readOnly).toBe(false);
  expect(d.fields.find(f=>f.key==='exposure')?.value).toBe('I have $2 million of floating-rate debt');
  expect(exposureSummary('4 BTC holdings. BTC ends below 80,000. Potential loss $80000; budget $10000.')).toBe('4 BTC holdings');
  expect(exposureSummary('I hold 2.5 ETH and would lose $500 if it falls.')).toBe('I hold 2.5 ETH');
});

it('ranks the exposure subject ahead of budget wording across numeric and binary markets',()=>{
  const btc=event('numeric');btc.id='btc';btc.title='Bitcoin price on October 28?';
  const distractor=event('binary');distractor.id='call';distractor.markets[0]!.question='Will Costco say Spending during its earnings call?';
  const rows=[...eventListings(distractor),...eventListings(btc)];
  const text='4 BTC holdings. BTC ends below 80,000 under the listed price-source rules. Protection date: 2099-10-28. Potential loss $80000; cover target $80000; spending budget $10000.';
  expect(exposureListings(rows,text,'2099-10-28',true)[0]?.eventId).toBe('btc');
  expect(exposureListings(rows,text,'2099-10-28',true).some(r=>r.eventId==='call')).toBe(false);
});

it('offers weather conditions without inventing a threshold, date or loss',async()=>{
  const d=await describeExposure('I run an outdoor restaurant in London. Bad weather would hurt my business.',deps);
  expect(reply(d).question).toMatchObject({key:'eventCondition',choices:[{value:'Cold temperatures'},{value:'High temperatures'},{value:'Rainfall'}]});
  expect(d.request).toBeUndefined();
  await updateDraft(d,'lossUsd','5000',deps);
  await updateDraft(d,'budgetUsd','500',deps);
  const next=await updateDraft(d,'eventCondition','Rainfall',deps);
  expect(reply(next).question?.key).toBe('eventDate');
  expect(next.fields.find(f=>f.key==='lossUsd')?.value).toBe('5000');
  expect(next.fields.find(f=>f.key==='budgetUsd')?.value).toBe('500');
  const custom=await updateDraft(next,'trigger','Strong winds',deps);
  expect(custom.fields.find(f=>f.key==='trigger')?.value).toBe('Strong winds');
});
