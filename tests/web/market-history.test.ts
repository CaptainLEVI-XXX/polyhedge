import {expect,it,vi} from 'vitest';
import {createMarketHistoryCache,historyPoints} from '../../apps/web/lib/market-history.js';
it('validates and orders real history without filling missing periods or losing zero prices',()=>{
  const now=200_000_000;
  const points=historyPoints([{t:(now-1200_000)/1000,p:.5},{t:now/1000,p:0},{t:(now+1000)/1000,p:.8},{t:(now-90_000_000)/1000,p:.9}],now);
  expect(points).toEqual([{at:now-1200_000,cost:.5},{at:now-1200_000+1,cost:null},{at:now,cost:0}]);
  expect(()=>historyPoints([{t:now/1000,p:1.2}],now)).toThrow();
  expect(historyPoints([],now)).toEqual([]);
});
it('batches and shares concurrent token requests, then preserves stale history on upstream failure',async()=>{
  let now=200_000_000,fail=false;
  const fetcher=vi.fn(async(_input:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    expect(body.markets.length).toBeLessThanOrEqual(20);
    if(fail)return new Response('',{status:503});
    return Response.json({history:Object.fromEntries(body.markets.map((id:string)=>[id,[{t:now/1000,p:id==='1'?.8:.2}]]))});
  });
  const history=createMarketHistoryCache(fetcher as typeof fetch,()=>now);
  const ids=Array.from({length:21},(_,i)=>String(i));
  const [rows,shared]=await Promise.all([history(ids),history(['0','1'])]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(shared['0']!.points[0]!.cost).toBe(.2);
  expect(shared['1']!.points[0]!.cost).toBe(.8);
  await history(ids);expect(fetcher).toHaveBeenCalledTimes(2);
  now+=61_000;fail=true;
  const stale=await history(['0','new']);
  expect(stale['0']).toEqual({...rows['0'],status:'stale'});
  expect(stale['new']!.status).toBe('unavailable');
});
