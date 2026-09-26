import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyIndex, publishSnapshot, loadSnapshot } from '../../apps/web/lib/catalogue-store.js';
import { refreshCatalogue } from '../../apps/web/lib/catalogue-refresh.js';
import { exposureListings, listingIndex, type EventListing } from '../../apps/web/lib/event-listings.js';
import { describeExposure, type StudioIntakeDeps } from '../../apps/web/lib/studio-intake.js';
const folders:string[]=[];
afterEach(async()=>{vi.useRealTimers();for(const path of folders.splice(0))await rm(path,{recursive:true,force:true});});
async function store(){const path=await mkdtemp(join(tmpdir(),'polyhedge-catalogue-'));folders.push(path);return path;}

it('resumes after interruption without replacing the last complete snapshot or counting duplicates twice',async()=>{
  const path=await store();
  await publishSnapshot({...emptyIndex(),builtAt:123,discoveryComplete:true},path);
  const requests:string[]=[];
  let fail=true;
  const venue:typeof fetch=async input=>{
    const cursor=new URL(String(input)).searchParams.get('after_cursor')??'first';requests.push(cursor);
    if(cursor==='first')return Response.json({events:[{id:'1',tags:[{slug:'weather',label:'Weather'}]}],next_cursor:'next'});
    if(fail)throw new Error('network interrupted');
    return Response.json({events:[{id:'1'},{id:'2',tags:[{slug:'weather',label:'Weather'}]}],next_cursor:null});
  };
  await expect(refreshCatalogue(path,venue)).rejects.toThrow('interrupted');
  expect((await loadSnapshot(path)).builtAt).toBe(123);
  expect(JSON.parse(await readFile(join(path,'catalogue-checkpoint.json'),'utf8')).cursor).toBe('next');
  fail=false;const result=await refreshCatalogue(path,venue);
  expect(requests).toEqual(['first','next','next']);
  expect(result.discoveryComplete).toBe(true);expect(result.discoveredEvents).toBe(2);
  expect(result.categories).toEqual([{slug:'weather',label:'Weather',discoveredEvents:2,supportedEvents:0}]);
  expect((await loadSnapshot(path)).discoveredEvents).toBe(2);
  await expect(readFile(join(path,'catalogue-checkpoint.json'))).rejects.toThrow();
});

it('round trips binary-only catalogues and ignores unfinished replacement files',async()=>{
  const path=await store(),row=listing('1','Bitcoin election','2099-01-01T12:00:00Z',{searchText:'Parent event context: Bitcoin election'});
  await publishSnapshot({...emptyIndex(),listings:[row],builtAt:123,discoveryComplete:true},path);
  await writeFile(join(path,'catalogue.json.gz.crashed.tmp'),'truncated');
  const restored=await loadSnapshot(path);
  expect(restored.events).toEqual([]);expect(restored.listings).toEqual([row]);expect(restored.discoveryComplete).toBe(true);
});
function listing(id:string,title:string,date:string,extra:Partial<EventListing>={}):EventListing {
  return {id:`${id}:binary:m`,eventId:id,slug:id,categories:['politics'],selection:{kind:'binary',marketId:'m'},kind:'binary',title,date,eligible:true,reason:null,...extra};
}
it('indexes aliases and AND searches, bounds dates, removes expired/unsupported rows, and prefers categorical parents',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2099-01-01T12:00:00Z'));
  const rows=[listing('past','Bitcoin election','2099-01-01T11:59:59Z'),listing('valid','Bitcoin election','2099-01-01T12:00:01Z'),
    listing('tomorrow','Bitcoin election','2099-01-02T00:00:00Z'),listing('bad','Bitcoin election','2099-01-01T13:00:00Z',{eligible:false}),
    listing('family','Chicago temperature','2099-01-01T14:00:00Z'),
    listing('family','Chicago temperature','2099-01-01T14:00:00Z',{id:'family:categorical:',kind:'categorical',selection:{kind:'categorical'}})];
  expect(listingIndex(rows)('btc election').map(r=>r.eventId)).toEqual(['past','valid','tomorrow','bad']);
  expect(listingIndex(rows)('btc Chicago')).toEqual([]);
  expect(exposureListings(rows,'BTC exposure','2099-01-01').map(r=>r.eventId)).toEqual(['valid']);
  expect(exposureListings(rows,'Chicago weather','2099-01-01').map(r=>r.kind)).toEqual(['categorical']);
  vi.setSystemTime(new Date('2099-01-01T15:00:00Z'));
  expect(exposureListings(rows,'Chicago weather','2099-01-01')).toEqual([]);
});
it('does not report no match when the catalogue has not finished loading',async()=>{
  const unused=async():Promise<never>=>{throw new Error('Must not call model or venue');};
  const deps:StudioIntakeDeps={index:emptyIndex(),engine:{ask:unused},fetchEvent:unused,today:new Date('2026-09-23')};
  await expect(describeExposure('My business loses money if Chicago is cold by September 26 2026.',deps)).rejects.toThrow('catalogue_pending');
});

import { cachedStudioExamples, refreshExampleCache } from '../../apps/web/lib/studio-examples.js';
import { readDraft } from '../../apps/web/lib/studio-draft.js';
it('bounds concurrent example candidates and still prices candidates queued behind slow requests',async()=>{
  const path=await store(),date='2099-10-28T23:59:00Z';
  const raw=(id:string)=>({id,title:'Bitcoin price',slug:id,negRisk:true,negRiskAugmented:false,negRiskMarketID:'group',endDate:date,tags:[],
    markets:['<60,000','60,000-64,000','>64,000'].map((label,i)=>({id:String(i+1),question:label,groupItemTitle:label,
      description:'Resolves using the published observation on the listed date.',endDate:date,
      clobTokenIds:JSON.stringify([String(i*2+1),String(i*2+2)]),outcomePrices:'["0.2","0.8"]',outcomes:'["Yes","No"]',
      orderPriceMinTickSize:.01,feeSchedule:{rate:0,takerOnly:true},conditionId:`0x${String(i+1).padStart(64,'0')}`,
      negRisk:true,negRiskMarketID:'group',active:true,closed:false,acceptingOrders:true,enableOrderBook:true}))});
  const started:string[]=[],release:(()=>void)[]=[];
  let active=0,peak=0;
  const venue:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/public-search')return Response.json({events:url.searchParams.get('q')==='Bitcoin price'?[{id:'a'},{id:'b'},{id:'c'}]:[]});
    if(url.pathname.startsWith('/events/')){
      const id=url.pathname.split('/').at(-1)!;started.push(id);active++;peak=Math.max(peak,active);
      if(started.length<=2)await new Promise<void>(resolve=>release.push(resolve));
      active--;
      return Response.json(raw(id));
    }
    if(url.pathname==='/books')return Response.json((JSON.parse(String(init?.body)) as {token_id:string}[]).map(({token_id})=>({
      market:`0x${String(Math.ceil(Number(token_id)/2)).padStart(64,'0')}`,asset_id:token_id,timestamp:String(Date.now()),hash:token_id,bids:[],min_order_size:5,
      asks:[{price:Number(token_id)%2?'0.03':'0.98',size:'100000'}],
    })));
    throw Error(`Unexpected request ${url}`);
  };
  const refreshing=refreshExampleCache(null,path,venue);
  try{
    await vi.waitFor(()=>expect(started).toHaveLength(2));
    expect(peak).toBe(2);
  }finally{release.forEach(done=>done());await refreshing;}
  expect(started).toEqual(['a','b','c']);
  const cache=JSON.parse(await readFile(join(path,'studio-examples.json'),'utf8'));
  expect(cache.entries).toHaveLength(1);
  expect(cache.diagnostics.btc).toMatchObject({candidates:3,qualified:3,issues:[]});
});

it('publishes a cold-start example before another family finishes; local reads re-sign it and discard expiry',async()=>{
  const path=await store(),date='2099-10-28T23:59:00Z';
  const raw={id:'btc',title:'Bitcoin price',slug:'btc',negRisk:true,negRiskAugmented:false,negRiskMarketID:'group',endDate:date,tags:[],
    markets:['<60,000','60,000-64,000','>64,000'].map((label,i)=>({id:String(i+1),question:label,groupItemTitle:label,
      description:'Resolves using the published observation on the listed date.',endDate:date,
      clobTokenIds:JSON.stringify([String(i*2+1),String(i*2+2)]),outcomePrices:'["0.2","0.8"]',outcomes:'["Yes","No"]',
      orderPriceMinTickSize:.01,feeSchedule:{rate:0,takerOnly:true},conditionId:`0x${String(i+1).padStart(64,'0')}`,
      negRisk:true,negRiskMarketID:'group',active:true,closed:false,acceptingOrders:true,enableOrderBook:true}))};
  let release!:()=>void;
  const slow=new Promise<Response>(resolve=>{release=()=>resolve(Response.json({events:[]}));});
  let bookMode:'good'|'outage'|'expensive'='good';
  const venue:typeof fetch=async (input,init)=>{
    const url=new URL(String(input));
    expect(url.pathname).not.toBe('/events/keyset');
    if(url.pathname==='/books'&&bookMode==='outage')throw Error('Temporary book outage');
    if(url.pathname==='/books')return Response.json((JSON.parse(String(init?.body)) as {token_id:string}[]).map(({token_id})=>({
      market:`0x${String(Math.ceil(Number(token_id)/2)).padStart(64,'0')}`,asset_id:token_id,timestamp:String(Date.now()),hash:token_id,bids:[],min_order_size:5,
      asks:[{price:bookMode==='expensive'?'0.98':Number(token_id)%2?'0.03':'0.98',size:'100000'}],
    })));
    if(url.pathname==='/events/btc')return Response.json(raw);
    if(url.searchParams.get('q')?.includes('Chicago'))return slow;
    return Response.json({events:url.searchParams.get('q')==='Bitcoin price'?[{id:'btc'}]:[]});
  };
  const refreshing=refreshExampleCache(null,path,venue);
  try{
    await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(path,'studio-examples.json'),'utf8')).entries).toHaveLength(1));
    const result=await cachedStudioExamples(path);
    expect(result.refreshing).toBe(true);expect(result.examples.map(e=>e.id)).toEqual(['btc']);
    expect(readDraft(result.examples[0]!.session).request?.eventId).toBe('btc');
  }finally{release();await refreshing;}
  const completed=JSON.parse(await readFile(join(path,'studio-examples.json'),'utf8'));
  expect(completed.diagnostics.btc).toMatchObject({candidates:1,qualified:1,issues:[]});
  bookMode='outage';await refreshExampleCache(null,path,venue);
  const outage=JSON.parse(await readFile(join(path,'studio-examples.json'),'utf8'));
  expect(outage.entries).toHaveLength(1);
  expect(outage.diagnostics.btc).toMatchObject({candidates:1,qualified:0});
  expect(outage.diagnostics.btc.issues).toContainEqual({eventId:'btc',stage:'quote',message:'Temporary book outage'});
  vi.useFakeTimers();vi.setSystemTime(Date.now()+11*60_000);
  expect((await cachedStudioExamples(path)).examples).toEqual([]);
  vi.useRealTimers();bookMode='expensive';await refreshExampleCache(null,path,venue);
  expect(JSON.parse(await readFile(join(path,'studio-examples.json'),'utf8')).entries).toEqual([]);
});
