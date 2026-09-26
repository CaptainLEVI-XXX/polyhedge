import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogueStore, atomicJson, migrateSnapshot } from '../lib/catalogue-store.js';
import { refreshCatalogue } from '../lib/catalogue-refresh.js';
import { refreshExampleCache } from '../lib/studio-examples.js';

const store=catalogueStore(), lock=join(store,'catalogue-worker.lock');
await mkdir(store,{recursive:true});
// A single writer per store. OS process lifetime, not web hot reloads, owns it.
async function acquire():Promise<boolean>{
  try{const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();return true;}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const pid=Number(await readFile(lock,'utf8'));
    if(!Number.isInteger(pid)||pid<=0)return false;
    try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return false;}
    await unlink(lock).catch(()=>{});return acquire();
  }
}
// A previous server's worker may still be shutting down. Wait for its lock rather
// than exiting: a web server left without a worker lets examples expire for good.
while(!await acquire())await delay(5_000);
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>stop.abort());
const status=(refreshing:boolean,scannedEvents:number,error:string|null=null)=>atomicJson(join(store,'catalogue-status.json'),
  {refreshing,scannedEvents,error,updatedAt:Date.now()});
const request:typeof fetch=(input,init)=>fetch(input,{...init,signal:AbortSignal.any([stop.signal,...(init?.signal?[init.signal]:[])])});
try{
  let index=await migrateSnapshot(store);
  // Examples have their own refresh loop; neither a slow scan nor a failed family blocks the others.
  const examples=(async()=>{while(!stop.signal.aborted){
    try{await refreshExampleCache(index,store,request);}catch(error){console.error('[examples]',error instanceof Error?error.message:error);}
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
}finally{await unlink(lock).catch(()=>{});}
