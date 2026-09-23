'use client';
import {useEffect,useRef,useState} from 'react';
import type {MarketHistories} from './market-history-types';
/** Started on comparison, retained across detail navigation. Never blocks pricing. */
export function useMarketHistory(rootId:string,quoteId:string,tokens:string[],enabled:boolean):MarketHistories{
  const latest=useRef(quoteId);latest.current=quoteId;
  const [state,setState]=useState<{root:string;rows:MarketHistories}>({root:rootId,rows:{}});
  const tokenKey=[...new Set(tokens)].sort().join(',');
  useEffect(()=>{
    if(!enabled||!rootId)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      if(document.visibilityState!=='hidden'){
        try{
          const response=await fetch(`/api/quote/${latest.current}/history`,{signal:controller.signal});
          if(!response.ok)throw Error('History unavailable');
          const body=await response.json();
          if(!controller.signal.aborted)setState(old=>({root:rootId,rows:{...(old.root===rootId?old.rows:{}),...body.histories}}));
        }catch{
          if(!controller.signal.aborted)setState(old=>{
            const rows={...(old.root===rootId?old.rows:{})};
            for(const id of tokenKey.split(',').filter(Boolean)){const previous=rows[id];rows[id]={points:previous?.points??[],fetchedAt:previous?.fetchedAt??0,status:previous?.points.length?'stale':'unavailable'};}
            return {root:rootId,rows};
          });
        }
      }
      if(!controller.signal.aborted)timer=setTimeout(()=>void refresh(),60_000);
    }
    void refresh();
    return()=>{controller.abort();clearTimeout(timer);};
  },[rootId,tokenKey,enabled]);
  return state.root===rootId?state.rows:{};
}
