import { familyEnabled } from './event-family.js';
import { buildBasketOptions } from '@polyhedge/intake';
import { quote, quoteSession, type QuoteRequest, type QuoteRecord } from '@polyhedge/engine';
import { fetchBooks, fetchEvent, type GammaEvent } from '@polyhedge/venue';
import { toOptionView, toEventQuotedView } from './view-model.js';
import { putQuote, putSnapshot } from './store.js';
import { linkForMarket } from './venue-links.js';
export function structuredView(record:QuoteRecord,event:GammaEvent, others: {name:string;reason:string;record:QuoteRecord}[] = []) {
  const option=toOptionView('primary','Your hedge',record.request.protectionGoal?.kind==='limit_net_loss'?'Minimizes premium while meeting your stated remaining-loss limit, including venue fees.':'Minimizes worst remaining stated loss, including premium and venue fees.',record,
    record.resolved.domain?.unit??'',id=>event.markets.find(m=>m.id===id)?.question??'',id=>linkForMarket(event,id));
  return toEventQuotedView(record,[option,...others.map((o,i)=>toOptionView(`option-${o.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,o.name,o.reason,o.record,record.resolved.domain?.unit??'',id=>event.markets.find(m=>m.id===id)?.question??'',id=>linkForMarket(event,id)))],[
    'Loss amounts are your stated exposure, not a measured business loss.',
    'The venue rules determine the observation and payment timing. Split or void resolution can fall outside this protection model.',
    'No PolyHedge fee. Purchase cost and venue fees are included. Fills are not guaranteed.',
  ]);
}
async function buildStructuredQuote(request:QuoteRequest,owner:string, parent:string|null=null,revision=0,requestSignal?:AbortSignal) {
  const start=performance.now();
  const deadlineAt=Date.now()+10_000;
  const timeout=AbortSignal.timeout(10_000);
  const signal=requestSignal?AbortSignal.any([timeout,requestSignal]):timeout;
  const event=await fetchEvent(request.eventId,signal);
  const metadataMs=performance.now()-start;
  let booksMs=0;
  const deps=quoteSession({deadlineAt,signal,fetchEvent:async()=>event,fetchBooks:async ids=>{
    const t=performance.now();try{return await fetchBooks(ids,signal);}finally{booksMs=performance.now()-t;}
  },saveSnapshot:putSnapshot});
  const record=await quote(request,deps,{jevModelVersion:'structured',calibrationMapVersion:'not-used'});
  const solveMs=performance.now()-start-metadataMs-booksMs;
  const alternativesStart=performance.now();
  const alternatives=(await buildBasketOptions(request,deps,{jevModelVersion:'structured',calibrationMapVersion:'not-used'},record)).filter(o=>o.record!==record);
  const alternativesMs=performance.now()-alternativesStart;
  const view=structuredView(record,event,alternatives);
  const optionRecords:Record<string,QuoteRecord>={primary:record};
  alternatives.forEach((o,i)=>{optionRecords[`option-${o.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`]=o.record;});
  const stored=await putQuote(owner,record,view,parent,revision,optionRecords);
  return {stored,view,timings:{total:performance.now()-start,metadata:metadataMs,books:booksMs,solve:solveMs,alternatives:alternativesMs,modelCalls:0}};
}

let active = 0;
/** Bounded admission, no unbounded queue behind the synchronous solver. */
export async function structuredQuote(request:QuoteRequest,owner:string,parent:string|null=null,revision=0,requestSignal?:AbortSignal) {
  if(!request.selection || !familyEnabled(request.selection.kind))throw new Error('This market type is temporarily disabled.');
  if(active>=2)throw new Error('quote_busy');
  active++;
  try{return await buildStructuredQuote(request,owner,parent,revision,requestSignal);}finally{active--;}
}
