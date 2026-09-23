import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { eventSupport, type GammaEvent, type ClobBook } from '../../packages/venue/src/index.js';
import { quote, replay, revalidateQuote, type QuoteRequest } from '../../packages/engine/src/index.js';
import { bindQuote } from '../../packages/execution/src/quote-binding.js';
import { accountBasket } from '../../packages/settlement/src/accounting.js';
import { registerBasket, settlementFor } from '../../packages/settlement/src/service.js';
import { harness } from '../settlement/fixtures.js';
import type { SettlementBasket, ConditionRecord } from '../../packages/settlement/src/types.js';
import { eventListings, listingIndex } from '../../apps/web/lib/event-listings.js';
import { curvePoints, trueCostUsd } from '../../apps/web/lib/view-model.js';
import { costProtectionCurve } from '../../packages/intake/src/options.js';

const labels=['50+ bps decrease','25 bps decrease','No change','25 bps increase','50+ bps increase'];
function fixture(binary=false):GammaEvent {
  const description='Federal Open Market Committee: rounded up to the nearest 25; will resolve to the amount of basis points the upper bound changes; will resolve to the "No change" bracket; https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
  return {id:'100',slug:'fed-decision',title:'Fed Decision',description,negRisk:!binary,negRiskAugmented:false,
    negRiskMarketId:binary?null:'group',endDate:'2026-10-28T23:59:00Z',tags:['economics'],seriesTickers:[],
    markets:(binary?['Yes']:labels).map((label,i)=>({id:String(i+1),question:binary?'Will Bitcoin reach $100,000?':label,
      groupItemTitle:label,description,conditionId:`0x${String(i+1).padStart(64,'0')}`,slug:null,
      yesTokenId:String(i*2+1),noTokenId:String(i*2+2),yesPrice:.2,tickSize:.01,feeRate:0,endDate:'2026-10-28T23:59:00Z',
      negRisk:!binary,...(binary?{}:{negRiskMarketId:'group'}),active:true,closed:false,acceptingOrders:true,enableOrderBook:true,
      outcomeLabels:['Yes','No'],yesOutcomeIndex:0}))};
}
function setup(binary=false) {
  const event=fixture(binary);
  const selection=binary?{kind:'binary' as const,marketId:'1'}:{kind:'categorical' as const};
  const domain=eventSupport(event,selection);
  const request:QuoteRequest={eventId:event.id,selection,ruleHash:domain.ruleHash,
    shape:{templateId:'outcome_losses',losses:domain.outcomes.map((o,i)=>({outcomeId:o.id,lossCents:i===0?10000:0}))},
    execution:{quantityStep:0.01},protectionGoal:{kind:'minimize_net_loss'}};
  let books:ClobBook[]=[];
  const deps={fetchEvent:async()=>event,fetchBooks:async(ids:string[])=>books=ids.map(assetId=>({assetId,
    market:event.markets.find(m=>m.yesTokenId===assetId||m.noTokenId===assetId)!.conditionId!,timestamp:'1',hash:'h',bids:[],
    asks:[{priceMicros:assetId==='1'?200_000:990_000,size:10000}],minOrderSize:1})),
    saveSnapshot:async(b:ClobBook[])=>createHash('sha256').update(JSON.stringify([...b].sort((a,b)=>a.assetId.localeCompare(b.assetId)))).digest('hex')};
  return {event,domain,request,deps,books:()=>books};
}
it('binary and categorical hedges retain exact identity, $20 cost / $100 payout, replay and fail on changed rules',async()=>{
  for(const binary of [true,false]) {
    const f=setup(binary); const record=await quote(f.request,f.deps);
    expect(record.version).toBe(2);
    expect(record.basket.totalCostCents).toBeCloseTo(2000,0);
    expect(record.basket.worstNetLossCents).toBeCloseTo(2000,0);
    expect(record.basket.legs.filter(l=>l.shares>0)).toHaveLength(1);
    expect(record.basket.legs[0]!.shares).toBeCloseTo(100,4);
    expect((await replay(record,f.books())).target).toEqual(record.basket.target);
    expect(bindQuote(record,f.books(),[]).selected.legs[0]!.eventEvidence?.negRisk).toBe(!binary);
    expect(eventSupport({...f.event,markets:[...f.event.markets].reverse()},f.request.selection!).ruleHash).toBe(f.domain.ruleHash);
    await expect(revalidateQuote(record,async()=>({...f.event,description:'changed'}))).rejects.toThrow(/changed/);
    const bad=f.books().map(b=>({...b,market:`0x${'0'.repeat(64)}`}));
    await expect(quote(f.request,{...f.deps,fetchBooks:async()=>bad})).rejects.toThrow(/condition/);
    const altered=structuredClone(record);altered.resolved.domain!.outcomes[0]!.label='changed';
    await expect(replay(altered,f.books())).rejects.toThrow(/evidence/);
    const wrong=structuredClone(record);wrong.version=99 as 2;
    await expect(replay(wrong,f.books())).rejects.toThrow(/version/);
  }
  const f=setup(true);
  if(f.request.shape.templateId!=='outcome_losses')throw new Error('fixture');
  f.request.shape.losses.reverse(); // Input order must not select a different outcome.
  for(const l of f.request.shape.losses)l.lossCents=l.outcomeId.endsWith(':NO')?10000:0;
  const r=await quote(f.request,{...f.deps,fetchBooks:async ids=>(await f.deps.fetchBooks(ids)).map(b=>({...b,asks:[{priceMicros:b.assetId==='2'?200000:990000,size:10000}]}))});
  expect(r.basket.legs.filter(l=>l.shares>0).map(l=>l.side)).toEqual(['NO']);
  expect(r.basket.totalCostCents).toBeCloseTo(2000,0);
});
it('rejects ambiguous groups and incomplete losses, while discovery supports binary child selection and aliases',async()=>{
  const f=setup();
  expect(eventSupport(f.event,{kind:'numeric'}).eligible).toBe(false);
  await expect(quote({eventId:f.event.id,shape:{templateId:'threshold_digital',direction:'above',k:12.5,payoutUsd:100}},f.deps)).rejects.toThrow(/rounded decision/);
  expect(eventSupport({...f.event,negRiskAugmented:true},f.request.selection!).eligible).toBe(false);
  expect(eventSupport({...f.event,markets:f.event.markets.slice(1)},f.request.selection!).eligible).toBe(false);
  expect(eventSupport({...f.event,description:'Overlapping unrelated markets'},f.request.selection!).eligible).toBe(false);
  const req=structuredClone(f.request);
  if(req.shape.templateId!=='outcome_losses')throw new Error('fixture');
  req.shape.losses.pop();
  await expect(quote(req,f.deps)).rejects.toThrow(/loss|outcome/i);
  const rows=eventListings(fixture(true));
  expect(listingIndex(rows)('btc')).toHaveLength(1);
});
it('settlement observes unheld categorical conditions and refuses split, incomplete or contradictory winner evidence',async()=>{
  const f=setup();const record=await quote(f.request,f.deps);const h=harness();
  const descriptors=f.event.markets.map(m=>({conditionId:m.conditionId!,yesTokenId:m.yesTokenId,noTokenId:m.noTokenId,negRisk:true}));
  const basket:SettlementBasket={id:'cat',revision:0,wallet:'wallet',quote:record,costMicros:20_000_000,
    positions:[{basketId:'cat',wallet:'wallet',conditionId:descriptors[0]!.conditionId,tokenId:'1',outcome:'YES',sharesMicros:100_000_000}],
    expectedObservationAt:f.event.endDate,expectedSource:'ctf',executionComplete:true};
  await registerBasket(basket,descriptors,h);
  expect(h.store.conditions.size).toBe(5);
  expect((await settlementFor('cat',h)).boundAssessment).toBe('unknown');
  const conditions:ConditionRecord[]=[...h.store.conditions.values()].map((c,i)=>({...c,phase:'lost',payout:{yes:i===1?1:0,no:i===1?0:1,denominator:1}}));
  expect(accountBasket(basket,conditions)).toMatchObject({targetMicros:0,boundAssessment:'within'});
  expect(accountBasket(basket,conditions.slice(0,1)).boundAssessment).toBe('unknown');
  conditions[2]!.payout={yes:1,no:0,denominator:1};
  expect(accountBasket(basket,conditions).boundAssessment).toBe('outside_quote_model');
  conditions[2]!.payout={yes:1,no:1,denominator:2};
  expect(accountBasket(basket,conditions).boundAssessment).toBe('outside_quote_model');
});

it('prices true cost and the cost/protection curve for binary and categorical hedges', async () => {
  for (const binary of [true, false]) {
    const f = setup(binary);
    const record = await quote(f.request, f.deps);
    // Binary odds are YES and its complement; a categorical partition's are its YES prices.
    expect(Object.values(record.resolved.probabilities!)).toEqual(binary ? [0.2, 0.8] : [0.2, 0.2, 0.2, 0.2, 0.2]);
    // $20 buys $100 in an outcome the market gives 20%: fairly priced, so nothing is lost on average.
    expect(trueCostUsd(record)).toBeCloseTo(0, 6);
    // Paying the same $20 when the market thinks the outcome is only 10% likely costs $10 on average.
    const doubtful = structuredClone(record);
    doubtful.resolved.probabilities = binary ? { [f.domain.outcomes[0]!.id]: 0.1, [f.domain.outcomes[1]!.id]: 0.9 }
      : Object.fromEntries(f.domain.outcomes.map((o, i) => [o.id, i === 0 ? 0.1 : 0.225]));
    expect(trueCostUsd(doubtful)).toBeCloseTo(10, 6);

    const points = curvePoints(await costProtectionCurve(f.request, f.deps, undefined, [record]));
    expect(points[0]).toEqual({ costUsd: 0, worstLossUsd: 100, trueCostUsd: 0 });
    expect(points.at(-1)).toMatchObject({ worstLossUsd: 20 });
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.costUsd).toBeGreaterThan(points[i - 1]!.costUsd);
      expect(points[i]!.worstLossUsd).toBeLessThan(points[i - 1]!.worstLossUsd);
    }
  }
});
