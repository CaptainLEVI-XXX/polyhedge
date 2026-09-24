import { hedgeQuality } from '../../apps/web/lib/hedge-quality.js';
import { parseDeadline, findNumbers } from '../../packages/intake/src/parse.js';
import { expect, it } from 'vitest';
import { exampleDraft } from '../../apps/web/lib/studio-examples.js';
import { field, newDraft, quoteFromDraft, readDraft, reply, sealDraft, setField } from '../../apps/web/lib/studio-draft.js';
import { holdingLoss } from '../../apps/web/lib/studio-input.js';
import { describeExposure, productHelp, updateDraft, updateAmounts, type StudioIntakeDeps } from '../../apps/web/lib/studio-intake.js';
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
  const eth=event('numeric');eth.title='Ethereum price on October 28?';
  expect(exampleDraft('eth',eth)!.description).toContain('10 ETH holdings');
  const arsenal=event('binary');arsenal.markets[0]!.question='Will Arsenal win the 2026-27 Premier League?';
  const sports=exampleDraft('arsenal',arsenal)!;
  expect(sports.request!.shape).toMatchObject({losses:[{lossCents:0},{lossCents:800000}]});
  // 2 BTC losing $8,000 by $64,000 starts losing at $68,000, at $2 per $1.
  const btc=quoteFromDraft(readDraft(sealDraft(exampleDraft('btc',event('numeric'))!)));
  expect(btc.shape).toEqual({templateId:'linear_strip',direction:'below',k1:64000,k2:68000,payoutUsd:8000});
});

it('constructs a gradual holding loss from a known ramp endpoint', () => {
  expect(holdingLoss({quantity:2,coin:'BTC'},'below',77000,8000)).toEqual({
    shape:{templateId:'linear_strip',direction:'below',k1:77000,k2:81000,payoutUsd:8000},
    trigger:'BTC below $81,000: loss grows $2 per $1 fall, reaching $8,000 at $77,000'});
  expect(holdingLoss({quantity:2,coin:'BTC'},'above',90000,8000).shape).toMatchObject({direction:'above',k1:86000,k2:90000});
});

it('binds business examples to the correct future YES market, not the first child',()=>{
  for(const [id,question,budget] of [['shutdown','Government shutdown by October 1?',1000],['oil','Will Crude Oil reach a new all-time high by December 31?',1200]] as const){
    const e=event('binary');
    const selected={...e.markets[0]!,id:'selected',question};
    e.markets=[{...e.markets[0]!,question:'Unrelated market'},selected];
    const draft=exampleDraft(id,e)!;
    expect(reply(draft).ready).toBe(true);
    const request=quoteFromDraft(draft);
    expect(request.selection).toEqual({kind:'binary',marketId:'selected'});
    expect(request.budgetUsd).toBe(budget);
    expect(draft.description).toContain(question);
    const outcomes=draft.event!.support.outcomes;
    expect(request.shape).toEqual({templateId:'outcome_losses',losses:outcomes.map(o=>({outcomeId:o.id,lossCents:o.side==='YES'?800000:0}))});
    selected.endDate=new Date(Date.now()+86400000).toISOString();
    expect(exampleDraft(id,e)).toBeNull();
  }
  expect(quoteFromDraft(exampleDraft('rates',event('categorical'))!).budgetUsd).toBe(1500);
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
  const routingDeps:StudioIntakeDeps={...deps,index:{...deps.index,listings:eventListings(e).map(r=>({...r,title:'Fed decision'}))},fetchEvent:async()=>e,engine:{ask:async()=>({modelVersion:'test',answers:{match_0:{kind:'boolean',probability:.99},hedge:{kind:'boolean',probability:.99}}})}};
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
import { exposureSummary, normalizeExposure } from '../../apps/web/lib/studio-input.js';
it('routes a parsed but unsupported rates ladder to outcome losses instead of asking for one conflicting loss',async()=>{
  const e=event('categorical');
  const indexed=indexEvent(e);expect(indexed).not.toBeNull();
  const routing={...deps,index:{...deps.index,events:[indexed!],listings:eventListings(e)},fetchEvent:async()=>e,engine:{ask:async()=>({modelVersion:'test',answers:{match_0:{kind:'boolean' as const,probability:.99}}})}};
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

import { holdingCandidates, withHoldingQuestions, interpretHolding } from '../../apps/web/lib/studio-semantics.js';
import type { Answer } from '../../packages/questions/src/types.js';
const choice = (value:string,confidence=.99):Answer => ({kind:'choice',choice:value,confidence,probabilities:{[value]:confidence}});
it('batches holding semantics into extraction and keeps ambiguous loss shapes blocked until a user chooses',async()=>{
  let calls=0,reading:Parameters<typeof interpretHolding>[2];
  const engine=withHoldingQuestions({ask:async(_state,questions)=>{
    calls++;expect(questions.holdingQuantity?.kind).toBe('choice');expect(questions.holdingMeaning?.kind).toBe('choice');
    return {modelVersion:'test',answers:{holdingQuantity:choice('h0'),holdingMeaning:choice('unclear')}};
  }},r=>{reading=r;});
  await engine.ask('My portfolio contains 2 BTC. I lose $8000 below $77000.',{lossDirection:{kind:'choice',instructions:'Direction',criteria:{below:'Below'}}});
  expect(calls).toBe(1);
  expect(holdingCandidates('My portfolio contains 1,200.5 ETH; not $500 BTC.')).toEqual([{quantity:1200.5,coin:'ETH'}]);
  const draft=()=>{const d=exampleDraft('btc',event('numeric'))!;d.request!.shape={templateId:'threshold_digital',direction:'below',k:77000,payoutUsd:8000};return d;};
  for(const [meaning,k1,k2] of [['starts',73000,77000],['reaches',77000,81000]] as const){
    const d=draft();interpretHolding(d,'Bitcoin price?',reading);
    expect(reply(d).question?.key).toBe('holdingMeaning');expect(()=>quoteFromDraft(d)).toThrow(/complete/);
    await updateDraft(d,'holdingMeaning',meaning,deps);
    expect(d.request!.shape).toMatchObject({templateId:'linear_strip',k1,k2,payoutUsd:8000});
    expect(reply(d).ready).toBe(true);
  }
  const fixed=draft();interpretHolding(fixed,'Bitcoin price?',reading);await updateDraft(fixed,'holdingMeaning','fixed',deps);
  expect(fixed.request!.shape.templateId).toBe('threshold_digital');
  const uncertain=draft();interpretHolding(uncertain,'Bitcoin price?',{...reading!,answers:{holdingQuantity:choice('h0',.5)}});
  expect(reply(uncertain).question?.key).toBe('holdingQuantity');
  await updateDraft(uncertain,'holdingQuantity','none',deps);expect(uncertain.request!.shape.templateId).toBe('threshold_digital');
  const otherAsset=draft();interpretHolding(otherAsset,'Ethereum price?',reading);expect(otherAsset.pending).toBeUndefined();
  const inferred=draft();interpretHolding(inferred,'Bitcoin price?',{...reading!,answers:{holdingQuantity:choice('h0'),holdingMeaning:choice('reaches')}});
  expect(inferred.fields.find(f=>f.key==='trigger')?.status).toBe('inferred');expect(reply(inferred).ready).toBe(false);
});

import { explicitHoldingRamp } from '../../apps/web/lib/studio-input.js';
import { examplePlans, refreshExampleEvidence } from '../../apps/web/lib/studio-examples.js';
it('reads edited ramp examples without Jev, explains inconsistent math, and confirms an earlier market under the date ceiling',async()=>{
  const e=event('numeric');e.title='Bitcoin price on October 28?';
  const source=exampleDraft('btc',e)!.description;
  const ramp=explicitHoldingRamp(source)!;expect(ramp.error).toBeUndefined();
  expect(explicitHoldingRamp(source+' Actually hedge something else.')).toBeNull();
  const indexed=indexEvent(e)!;
  const routing:StudioIntakeDeps={...deps,index:{...deps.index,events:[indexed],listings:eventListings(e)},fetchEvent:async()=>e};
  const same=await describeExposure(source,routing);
  expect(reply(same).ready).toBe(true);expect(same.request!.shape).toEqual(ramp.shape);
  const compact=await describeExposure(source.replace('2 BTC holdings','2BTC holdings'),routing);
  expect(reply(compact).ready).toBe(true);expect(field(compact,'trigger')).toBe(ramp.trigger);
  const quantityConflict=await describeExposure(source.replace('2 BTC holdings','24BTC holdings'),routing);
  expect(field(quantityConflict,'trigger')).toBe(ramp.trigger);
  expect(reply(quantityConflict).ready).toBe(false);
  expect(reply(quantityConflict).question?.text).toContain('You wrote 24 BTC');
  const overcover=await describeExposure(source.replace(/cover target \$[\d,]+/,'cover target $10000'),routing);
  expect(reply(overcover).question?.text).toContain('$10,000 cover target exceeds your $8,000');
  await updateDraft(overcover,'coverageUsd','full',routing);
  expect(reply(overcover).ready).toBe(true);

  const later=source.replace('2099-10-28','2099-11-28');
  const next=await describeExposure(later,routing);
  expect(field(next,'trigger')).toBe(ramp.trigger);expect(reply(next).question?.key).toBe('numericDate');
  expect(()=>quoteFromDraft(next)).toThrow(/complete/);
  await updateDraft(next,'numericDate','confirm',routing);expect(reply(next).ready).toBe(true);
  expect(quoteFromDraft(next).observationNote).toContain('User accepted observation');
  const earlier=await describeExposure(source.replace('2099-10-28','2099-10-27'),routing);
  expect(reply(earlier).question?.key).toBe('deadline');expect(field(earlier,'trigger')).toBe(ramp.trigger);expect(earlier.request).toBeUndefined();
  const changed=await updateDraft(same,'deadline','2099-11-28',routing);expect(reply(changed).question?.key).toBe('numericDate');
  const bad=source.replace('below $68,000','below $90,000');
  const conflict=await describeExposure(bad,routing);
  expect(reply(conflict).question?.text).toContain('implies $52,000');
  const correction=reply(conflict).question!.choices![0]!;
  const fixed=await updateDraft(conflict,'description',correction.value,routing);
  expect(reply(fixed).ready).toBe(true);expect(fixed.request!.shape).toMatchObject({k1:86000,k2:90000,payoutUsd:8000});
});
it('prefers a longer-lived supported example rather than the nearest expiry',()=>{
  const e=event('numeric');e.title='Bitcoin price on October 28?';
  const indexed=indexEvent(e)!;
  const rows=[1,8,30,85].map((days,i)=>({...indexed,eventId:String(i),observationAt:new Date(Date.now()+days*86400000).toISOString()}));
  const plans=examplePlans({...deps.index,events:rows});
  expect(plans.find(p=>p.id==='btc')!.rows.map(r=>r.id)).toEqual(['2','1','0','3']);
  const dates=[1,2,3,4,5,6,8,9].map((days,i)=>({...indexed,eventId:String(i),observationAt:new Date(Date.now()+days*86400000).toISOString()}));
  expect(examplePlans({...deps.index,events:dates}).find(p=>p.id==='btc')!.rows.map(r=>r.id)).toEqual(['7','6','5','4','3','2','1']);
});


it('discovers a named season before demanding a date, rejects wrong events, and confirms the listed date before mapping losses',async()=>{
  const e=event('binary');e.title='2026–27 Premier League winner';
  e.endDate='2027-05-30T23:59:00Z';e.markets[0]!.endDate=e.endDate;
  e.markets[0]!.question='Will Arsenal win the 2026–27 Premier League?';
  const wrong=event('binary');wrong.id='wrong';wrong.endDate=e.endDate;wrong.markets[0]!.endDate=e.endDate;wrong.markets[0]!.question='Will Arsenal be relegated from the 2026–27 Premier League?';
  let calls=0;
  const routing:StudioIntakeDeps={...deps,index:{...deps.index,listings:[...eventListings(wrong),...eventListings(e)]},fetchEvent:async()=>e,engine:{ask:async(_text,qs)=>{
    calls++;
    return {modelVersion:'test',answers:Object.fromEntries(Object.entries(qs).map(([key,q])=>[key,key.startsWith('match_')?{kind:'boolean',probability:q.instructions.includes('relegated from')?.01:.99}:key==='hedge'?{kind:'boolean',probability:.99}:choice('unknown')]))};
  }}};
  const d=await describeExposure('> My merchandise business loses money if Arsenal does not win the 2026–27 Premier League. Can you protect that > revenue?',routing);
  expect(field(d,'trigger')).toContain('does not win');expect(field(d,'lossUsd')).toBe('');
  expect(reply(d).question?.key).toBe('eventMatch');expect(d.matches).toHaveLength(1);
  expect(d.matches![0]!.id).toBe(e.id);expect(calls).toBe(1);
  await expect(updateDraft(d,'trigger','$50000',routing)).rejects.toThrow('not a dollar amount');
  await updateDraft(d,'eventMatch','0',routing);expect(reply(d).question?.key).toBe('eventRules');expect(reply(d).ready).toBe(false);
  await updateDraft(d,'eventRules','confirm',routing);expect(reply(d).question?.key).toMatch(/^outcome:/);
  expect(field(d,'deadline')).toBe(e.endDate);
  expect(exposureListings(routing.index.listings,'Arsenal 2025–26 Premier League',null,true)).toEqual([]);
});
it('keeps copied dates and outcome-specific losses intact, and reports an unsupported matching event instead of offering another risk',async()=>{
  expect(parseDeadline(normalizeExposure('> My latest > protection date is December 31, 2026.'),deps.today)?.value).toBe('2026-12-31');
  expect(normalizeExposure('ETH > $3,000')).toBe('ETH > $3,000');
  expect(normalizeExposure('price > reference price')).toBe('price > reference price');
  const e=event('categorical');e.title='Fed Decision in December?';e.endDate='2099-12-10T23:59:00Z';e.markets.forEach(m=>m.endDate=e.endDate);
  const routing:StudioIntakeDeps={...deps,index:{...deps.index,listings:eventListings(e)},fetchEvent:async()=>e,engine:{ask:async(_text,qs)=>({modelVersion:'test',answers:Object.fromEntries(Object.entries(qs).map(([key,q])=>[key,key.startsWith('match_')||key==='hedge'?{kind:'boolean',probability:.99}:choice(q.kind==='choice'&&/"(?:25|50\+) bps increase"/.test(q.instructions)?Object.entries(q.criteria).find(([,v])=>v.startsWith(`Stated loss ${q.instructions.includes('"25 bps increase"')?'$5,000':'$10,000'};`))![0]:'zero')]))})}};
  const d=await describeExposure('I have floating-rate debt. For the December 2099 Fed decision, a 25-basis-point increase costs $5,000; an increase of 50 basis points or more costs $10,000. No change or a decrease causes no loss. Cover target $10,000; > budget $800.',routing);
  expect(reply(d).question?.key).toBe('eventMatch');expect(field(d,'lossUsd')).toBe('');expect(field(d,'trigger')).toContain('$10,000');
  await updateDraft(d,'eventMatch','0',routing);await updateDraft(d,'eventRules','confirm',routing);
  expect(field(d,'lossUsd')).toBe('10000');expect(reply(d).ready).toBe(true);
  expect(quoteFromDraft(d).shape).toMatchObject({losses:[{lossCents:0},{lossCents:0},{lossCents:0},{lossCents:500000},{lossCents:1000000}]});
  const unsupported={...routing,index:{...routing.index,listings:eventListings(e).map(r=>({...r,eligible:false,reason:'Unverified outcome set'}))}};
  const unavailable=await describeExposure('Fed decision December 2099',unsupported);
  expect(reply(unavailable).question?.text).toContain('Unverified outcome set');expect(unavailable.request).toBeUndefined();
});

it('submits amount forms atomically without discovery, preserving the match and validating combined outcome losses',()=>{
  const numeric=exampleDraft('btc',event('numeric'))!;
  setField(numeric,'coverageUsd','','missing');setField(numeric,'budgetUsd','','missing');
  expect(reply(numeric).collectAmounts).toBe(true);
  const filled=updateAmounts(numeric,{lossUsd:'8000',coverageUsd:'5000',budgetUsd:'500'});
  expect(reply(filled).ready).toBe(true);expect(filled.event).toEqual(numeric.event);
  expect(field(numeric,'coverageUsd')).toBe('');
  expect(()=>updateAmounts(numeric,{coverageUsd:'9000',budgetUsd:'500'})).toThrow(/exceed/);
  expect(()=>updateAmounts(numeric,{deadline:'2099-01-01'})).toThrow(/invalid amount/);
  const binary=exampleDraft('event',event('binary'))!;
  const keys=binary.fields.filter(f=>f.key.startsWith('outcome:')).map(f=>f.key);
  keys.forEach(key=>setField(binary,key,'','missing'));
  delete binary.request;binary.pending={key:keys[0]!,text:'Enter losses'};
  expect(reply(binary).collectAmounts).toBe(true);
  const complete=updateAmounts(binary,{[keys[0]!]: '0',[keys[1]!]: '6000',coverageUsd:'6000',budgetUsd:'300'});
  expect(reply(complete).ready).toBe(true);
  expect(quoteFromDraft(complete).shape).toMatchObject({losses:[{lossCents:0},{lossCents:600000}]});
  expect(()=>updateAmounts(binary,{[keys[0]!]:'0',[keys[1]!]:'0'})).toThrow(/at least one/);
  expect(field(binary,keys[0]!)).toBe('');
  numeric.unavailable='Unsupported outcome set';
  expect(reply(numeric).collectAmounts).toBe(false);
  expect(()=>updateAmounts(numeric,{coverageUsd:'5000'})).toThrow(/confirm/);
});

it('refreshes stale example fingerprints only when settlement evidence is unchanged',()=>{
  const e=event('categorical'),original=exampleDraft('rates',e)!;
  original.request!.ruleHash='old-validator-fingerprint';original.event!.support.ruleHash='old-validator-fingerprint';
  const updated=refreshExampleEvidence(original,e);
  expect(reply(updated).ready).toBe(true);expect(updated.request!.ruleHash).toBe(eventSupport(e,original.event!.selection).ruleHash);
  expect(original.request!.ruleHash).toBe('old-validator-fingerprint');
  const changed=structuredClone(e);changed.markets[0]!.description+=' Revised settlement source.';
  // Binary rules can change while the selected condition remains eligible.
  const b=event('binary'),binary=exampleDraft('event',b)!;b.markets[0]!.description+=' Revised settlement source.';
  const stopped=refreshExampleEvidence(binary,b);
  expect(reply(stopped).ready).toBe(false);expect(stopped.request).toBeUndefined();expect(stopped.pending?.key).toBe('description');
  expect(()=>refreshExampleEvidence(original,changed)).toThrow(/unavailable/);
});

it('judges example quality by net loss reduction and every loss scenario, not a large headline payout',()=>{
  expect(hedgeQuality([8000,0],[400.5,0],398.48).eligible).toBe(false);
  expect(hedgeQuality([8000,0],[8000,8000],7999).eligible).toBe(false);
  expect(hedgeQuality([8000,4000,0],[8000,0,0],500).eligible).toBe(false);
  expect(hedgeQuality([8000,4000,0],[6000,3000,0],600)).toMatchObject({eligible:true,reduction:.675,minimumCover:.75});
  expect(hedgeQuality([8000,0],[6000,3000],600).eligible).toBe(false);
  for(const [target,payout,cost] of [[[],[],0],[[8000],[NaN],600],[[8000],[],600],[[0],[0],0],[[8000],[6000],Infinity]] as const)expect(hedgeQuality(target,payout,cost).eligible).toBe(false);
});
