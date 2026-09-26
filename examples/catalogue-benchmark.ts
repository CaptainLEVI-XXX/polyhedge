import { performance } from 'node:perf_hooks';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSnapshot } from '../apps/web/lib/catalogue-store.js';
import { listingIndex, exposureListings } from '../apps/web/lib/event-listings.js';
const store=process.env.POLYHEDGE_STORE??join(process.cwd(),'apps/web/.polyhedge-store');
const start=performance.now(),index=await loadSnapshot(store),loaded=performance.now();
const search=listingIndex(index.listings),built=performance.now();
const samples:number[]=[];
const date=new Date().toISOString().slice(0,10);
for(let i=0;i<1000;i++){
  const start=performance.now();
  search(['BTC','Chicago weather','Fed decision','election'][i%4]!);
  exposureListings(index.listings,'Chicago weather exposure',date);
  samples.push(performance.now()-start);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({selections:index.listings.length,snapshotBytes:(await stat(join(store,'catalogue.json.gz'))).size,
  loadMs:loaded-start,buildLookupMs:built-loaded,warmSearchPairP50Ms:samples[500],warmSearchPairP95Ms:samples[950],
  note:'Local search only; excludes model, venue validation, prices and optimization.'},null,2));
