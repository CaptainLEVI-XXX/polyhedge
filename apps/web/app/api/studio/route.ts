import { editExample } from '@/lib/studio-input';
import type { StudioDraft } from '@/lib/studio-draft';
import { fetchEvent } from '@polyhedge/venue';
import { EventQuoteError } from '@polyhedge/engine';
import { LpNotOptimalError } from '@polyhedge/core';
import { marketIndex } from '@/lib/markets';
import { describeExposure, productHelp, studioEngine, updateDraft } from '@/lib/studio-intake';
import { quoteFromDraft, readDraft, reply } from '@/lib/studio-draft';
import { cachedStudioExamples } from '@/lib/studio-examples';
import { structuredQuote } from '@/lib/structured-quote';
import { requireCaller, readJsonBody, rateLimit, TooManyRequests } from '@/lib/identity';
import { handleRouteError } from '@/lib/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:Request) {
  try {
    rateLimit(requireCaller(request),'examples',30,60_000);
    const examples=await cachedStudioExamples();
    return Response.json(examples,{headers:{'Cache-Control':'no-store'}});
  } catch(error){return failure(error);}
}
export async function POST(request:Request) {
  const started=performance.now();
  try {
    const caller=requireCaller(request);
    rateLimit(caller,'studio',60,60_000);
    const raw=await readJsonBody(request,160*1024);
    if(!raw||typeof raw!=='object')throw new Error('bad_request: invalid request');
    const b=raw as Record<string,unknown>;
    let action=b.action;
    const text=typeof b.text==='string'?b.text.trim():'';
    if(text.length>2000)throw new Error('bad_request: shorten the description to 2000 characters');
    let prepared:StudioDraft|undefined;
    if(action==='example'){
      const original=readDraft(b.session);
      prepared=(text?editExample(original,text):original)??undefined;
      if(!prepared)action='describe';
    }
    // Pasting the displayed example is equivalent to selecting it. Only an exact
    // scaffold match can reuse its event; changed dates or triggers are reinterpreted.
    if(action==='describe'){
      const {examples}=await cachedStudioExamples();
      for(const example of examples){
        const candidate=editExample(readDraft(example.session),text);
        if(candidate){prepared=candidate;action='example';break;}
      }
    }
    if(action==='describe'||action==='answer'){
      const help=productHelp(text);
      if(help)return Response.json({result:{kind:'help',message:help}});
    }
    if(action==='build'||action==='example') {
      rateLimit(caller,'studio-quote',12,60_000);
      const draft=prepared??readDraft(b.session);
      const ready=reply(draft);
      if(!ready.ready)return Response.json({result:ready});
      const {stored,view,timings}=await structuredQuote(quoteFromDraft(draft),caller.id,null,0,request.signal,draft.options);
      return Response.json({result:{...ready,kind:'quoted',quoteId:stored.id,view,message:'Compare the cost, payout and remaining target loss. All options use the same exposure and book snapshot.'},timings:{...timings,total:performance.now()-started}});
    }
    if(!text)throw new Error('bad_request: enter a description or answer');
    rateLimit(caller,'studio-read',24,60_000);
    const index=await marketIndex();
    // The engine is lazy: simple dollar answers and example quotes need no model.
    let engine:ReturnType<typeof studioEngine>|undefined;
    const deps={index,today:new Date(),fetchEvent:(id:string)=>fetchEvent(id,request.signal),engine:{ask:(...args:Parameters<ReturnType<typeof studioEngine>['ask']>)=>(engine??=studioEngine()).ask(...args)}};
    if(action==='describe')return Response.json({result:reply(await describeExposure(text,deps)),tookMs:performance.now()-started});
    if(action==='answer'||action==='edit') {
      const draft=readDraft(b.session);
      const key=action==='answer'?draft.pending?.key:b.field;
      if(typeof key!=='string')throw new Error('bad_request: select a field to edit');
      const next=await updateDraft(draft,key,text,deps);
      return Response.json({result:reply(next),tookMs:performance.now()-started});
    }
    throw new Error('bad_request: unknown action');
  } catch(error){return failure(error);}
}
function failure(error:unknown):Response {
  if(error instanceof TooManyRequests)return Response.json({error:'Please wait before trying again.'},{status:429,headers:{'Retry-After':String(error.retryAfterSeconds)}});
  if(error instanceof EventQuoteError)return Response.json({error:`${error.message} Start over or refresh the examples to use the latest conditions.`},{status:409});
  if(error instanceof LpNotOptimalError){
    console.warn('Basket pricing solver stopped',{phase:error.phase,status:error.status});
    return Response.json({error:'We could not finish pricing this comparison. Your budget may still support a hedge. Retry with refreshed prices.',code:'solver_incomplete'},{status:503});
  }
  const message=error instanceof Error?error.message:'';
  if(message.startsWith('bad_request:')||message.startsWith('unavailable:'))return Response.json({error:message.replace(/^[^:]+:\s*/, '')},{status:422});
  if(message==='catalogue_pending')return Response.json({error:'Market discovery is still updating. Please try again shortly; we cannot yet tell whether a matching market exists.',code:'catalogue_pending'},{status:503,headers:{'Retry-After':'5'}});
  if(message==='quote_busy')return Response.json({error:'The builder is busy. Please try again shortly.'},{status:503});
  return handleRouteError('studio',error);
}
