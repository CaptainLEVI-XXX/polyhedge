import type { MarketHistory, MarketHistories } from './market-history-types.js';
import type { PricePoint } from './basket-tracking.js';
const DAY=86_400_000;
/** Validate venue data, preserve zero prices, and leave gaps rather than inventing a path. */
export function historyPoints(raw:unknown,now:number):PricePoint[] {
  if(!Array.isArray(raw)||raw.length>5000)throw Error('Invalid price history');
  const byTime=new Map<number,number>();
  for(const row of raw){
    if(!row||typeof row.t!=='number'||typeof row.p!=='number'||!Number.isFinite(row.t)||!Number.isFinite(row.p)||row.p<0||row.p>1)throw Error('Invalid history point');
    const at=row.t*1000;
    if(at>=now-DAY&&at<=now)byTime.set(at,row.p);
  }
  const points:PricePoint[]=[];
  for(const [at,cost] of [...byTime].sort((a,b)=>a[0]-b[0])){
    const before=points.at(-1);
    if(before&&at-before.at>15*60_000)points.push({at:before.at+1,cost:null});
    points.push({at,cost});
  }
  return points;
}
/** Token-keyed cache and in-flight collapsing shared across visitors. No solver dependency. */
export function createMarketHistoryCache(fetcher:typeof fetch=fetch,now:()=>number=Date.now){
  const cache=new Map<string,{value:MarketHistory;expires:number}>();
  const pending=new Map<string,Promise<MarketHistory>>();
  async function batch(tokens:string[]):Promise<MarketHistories>{
    const at=now(),out:MarketHistories={};
    let history:Record<string,unknown>={};
    try{
      const response=await fetcher('https://clob.polymarket.com/batch-prices-history',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({markets:tokens,start_ts:Math.floor((at-DAY)/1000),end_ts:Math.floor(at/1000),fidelity:5}),signal:AbortSignal.timeout(6000),cache:'no-store',
      });
      if(!response.ok)throw Error('History unavailable');
      const body=await response.json();
      if(!body.history||typeof body.history!=='object'||Array.isArray(body.history))throw Error('Invalid history response');
      history=body.history;
    }catch{ /* Failure is a chart state, never a failed basket. */ }
    for(const token of tokens){
      let value:MarketHistory;
      try{
        const points=historyPoints(history[token],at);
        value={points,status:points.length?'ready':'empty',fetchedAt:at};
      }catch{
        const old=cache.get(token)?.value;
        const points=old?.points.filter(p=>p.at>=at-DAY)??[];
        value={points,status:points.length?'stale':'unavailable',fetchedAt:old?.fetchedAt??0};
      }
      cache.delete(token);cache.set(token,{value,expires:at+(value.status==='unavailable'||value.status==='stale'?30_000:60_000)});
      while(cache.size>512)cache.delete(cache.keys().next().value!);
      out[token]=value;
    }
    return out;
  }
  return async(tokens:string[]):Promise<MarketHistories>=>{
    const ids=[...new Set(tokens)];
    const missing=ids.filter(id=>!pending.has(id)&&(!cache.has(id)||cache.get(id)!.expires<=now()));
    // Each quote contains a bounded set of held positions. Batch up to 20 tokens per venue request.
    for(let i=0;i<missing.length;i+=20){
      const group=missing.slice(i,i+20),work=batch(group);
      for(const token of group){const task=work.then(rows=>rows[token]!).finally(()=>pending.delete(token));pending.set(token,task);}
    }
    return Object.fromEntries(await Promise.all(ids.map(async id=>[id,await(pending.get(id)??Promise.resolve(cache.get(id)!.value))])));
  };
}
export const marketHistories=createMarketHistoryCache();
