import { familyEnabled } from './event-family.js';
import { buildBasketOptions } from '@polyhedge/intake';
import { quote, quoteSession, type QuoteRequest, type QuoteRecord, type QuoteOptions } from '@polyhedge/engine';
import { fetchBooks, fetchEvent, type GammaEvent } from '@polyhedge/venue';
import { toOptionView, toEventQuotedView } from './view-model.js';
import { putQuote, putSnapshot } from './store.js';
import { linkForMarket } from './venue-links.js';
import { curveFor } from './cost-curve.js';
const optionId = (name:string) => `option-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`;
function structuredView(record:QuoteRecord,event:GammaEvent,others:{name:string;reason:string;record:QuoteRecord}[]) {
  const unit=record.resolved.domain?.unit??'';
  const questionFor=(id:string)=>event.markets.find(m=>m.id===id)?.question??'';
  const linkFor=(id:string)=>linkForMarket(event,id);
  const primaryReason=record.request.protectionGoal?.kind==='limit_net_loss'
    ?'Minimizes premium while meeting your stated remaining-loss limit, including venue fees.'
    :'Minimizes worst remaining stated loss, including premium and venue fees.';
  return toEventQuotedView(record,[
    toOptionView('primary','Your hedge',primaryReason,record,unit,questionFor,linkFor),
    ...others.map(o=>toOptionView(optionId(o.name),o.name,o.reason,o.record,unit,questionFor,linkFor)),
  ],[
    ...(record.request.observationNote ? [record.request.observationNote] : []),
    'Loss amounts are your stated exposure, not a measured business loss.',
    'The venue rules determine the observation and payment timing. Split or void resolution can fall outside this protection model.',
    'No polyhedge fee. Purchase cost and venue fees are included. Fills are not guaranteed.',
  ]);
}
async function buildStructuredQuote(request:QuoteRequest,owner:string, parent:string|null=null,revision=0,requestSignal?:AbortSignal,options?:QuoteOptions) {
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
  options??={jevModelVersion:'structured',calibrationMapVersion:'not-used'};
  const record=await quote(request,deps,options);
  const solveMs=performance.now()-start-metadataMs-booksMs;
  const alternativesStart=performance.now();
  const alternatives=(await buildBasketOptions(request,deps,options,record)).filter(o=>o.record!==record);
  const alternativesMs=performance.now()-alternativesStart;
  const view=structuredView(record,event,alternatives);
  const optionRecords:Record<string,QuoteRecord>={primary:record,...Object.fromEntries(alternatives.map(o=>[optionId(o.name),o.record]))};
  const stored=await putQuote(owner,record,view,parent,revision,optionRecords);
  // Start the curve now so it is ready when the comparison asks for it. Only for a
  // new quote: re-prices are frequent and their curves are solved on request.
  if(revision===0)void curveFor(stored).catch(()=>{});
  return {stored,view,timings:{total:performance.now()-start,metadata:metadataMs,books:booksMs,solve:solveMs,alternatives:alternativesMs,modelCalls:0}};
}

let active = 0;
/** Bounded admission, no unbounded queue behind the synchronous solver. */
export async function structuredQuote(request:QuoteRequest,owner:string,parent:string|null=null,revision=0,requestSignal?:AbortSignal,options?:QuoteOptions) {
  if(!request.selection || !familyEnabled(request.selection.kind))throw new Error('This market type is temporarily disabled.');
  if(active>=2)throw new Error('quote_busy');
  active++;
  try{return await buildStructuredQuote(request,owner,parent,revision,requestSignal,options);}finally{active--;}
}
