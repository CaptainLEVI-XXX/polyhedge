import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogueStore, atomicJson, migrateSnapshot } from '../lib/catalogue-store.js';
import { refreshCatalogue } from '../lib/catalogue-refresh.js';
import { refreshExampleCache } from '../lib/studio-examples.js';
import { acquireWorkerLock, workerLockPath } from '../lib/worker-lock.js';

const store=catalogueStore();
await mkdir(store,{recursive:true});
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>stop.abort());
console.info('[catalogue-worker] starting',{pid:process.pid,store,lock:workerLockPath(store)});
let release:(()=>Promise<void>)|null=null;
while(!stop.signal.aborted && !(release=await acquireWorkerLock(store))){
  console.info('[catalogue-worker] waiting for another local worker');
  await delay(5_000,undefined,{signal:stop.signal}).catch(()=>{});
}
if(!release)process.exit(0);
console.info('[catalogue-worker] acquired lock');
const status=(refreshing:boolean,scannedEvents:number,error:string|null=null)=>atomicJson(join(store,'catalogue-status.json'),
  {refreshing,scannedEvents,error,updatedAt:Date.now()});
const request:typeof fetch=(input,init)=>fetch(input,{...init,signal:AbortSignal.any([stop.signal,...(init?.signal?[init.signal]:[])])});
try{
  let index=await migrateSnapshot(store);
  // Examples have their own refresh loop; neither a slow scan nor a failed family blocks the others.
  const examples=(async()=>{while(!stop.signal.aborted){
    try{
      console.info('[examples] refresh started');
      await refreshExampleCache(index,store,request);
      console.info('[examples] refresh completed');
    }catch(error){console.error('[examples]',error instanceof Error?error.message:error);}
    await delay(60_000,undefined,{signal:stop.signal}).catch(()=>{});
  }})();
  try{
    while(!stop.signal.aborted){
      if(!index?.discoveryComplete||Date.now()-index.builtAt>=10*60_000){
        try{
          await status(true,0);
          index=await refreshCatalogue(store,request,count=>status(true,count));
          await status(false,index.discoveredEvents);
        }catch(error){
          if(!stop.signal.aborted){console.error('[catalogue]',error instanceof Error?error.message:error);await status(false,index?.discoveredEvents??0,'Catalogue refresh interrupted; retrying shortly.');}
        }
      }else await status(false,index.discoveredEvents);
      await delay(30_000,undefined,{signal:stop.signal}).catch(()=>{});
    }
  }finally{stop.abort();await examples;}
}finally{await release();console.info('[catalogue-worker] stopped');}
