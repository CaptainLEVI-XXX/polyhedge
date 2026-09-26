import { withHoldingQuestions, interpretHolding, selectHolding, applyHoldingMeaning, type HoldingReading } from './studio-semantics.js';
import { explicitHoldingRamp, exposureSummary, labeledAmounts, normalizeExposure, statedTrigger } from './studio-input.js';
import { createJevEngine, type Question, type QuestionEngine } from '@polyhedge/questions';
import { indexEvent, candidatesForText, findNumbers, intake, parseDeadline, type IntakeDeps, type TypedExposure } from '@polyhedge/intake';
import { eventSupport, type GammaEvent } from '@polyhedge/venue';
import type { MarketIndex } from './markets.js';
import { exposureListings, eventListings } from './event-listings.js';
import { familyEnabled } from './event-family.js';
import { isAmountField } from './studio-types.js';
import { amount, field, newDraft, setField, type StudioDraft } from './studio-draft.js';

export function productHelp(text:string):string|null {
  if(/^(?:how (?:does|do|can)|what (?:is|are|does)|explain|help me understand)\b/i.test(text.trim())&&!/\b(?:lose|loss if|exposed|my position)\b/i.test(text)) {
    if(/fees?|cost/i.test(text))return 'polyhedge charges no platform fee. A basket costs the purchase price of its positions plus any venue fees. Your spending budget limits what you pay; your cover target is how much loss you want to protect.';
    if(/cover|budget/i.test(text))return 'Potential loss is what you could lose. Cover target is the part you want to protect. Spending budget is the most you want to pay for that protection. The basket comparison shows what remains uncovered; coverage is not guaranteed.';
    return 'Describe an existing holding, expense or business risk. polyhedge identifies supported event markets and compares baskets that may pay when that risk causes a loss. We ask only for missing or uncertain details. Settlement rules and basis risk can leave a gap between the market payout and your actual loss. You can explore a complete example without signing in; execution is coming soon.';
  }
  return null;
}
export interface StudioIntakeDeps { index:MarketIndex; engine:QuestionEngine; today:Date; fetchEvent(id:string):Promise<GammaEvent>; }
export function studioEngine() {
  const apiKey=process.env.AI_GATEWAY_API_KEY;
  if(!apiKey)throw new Error('AI_GATEWAY_API_KEY is not set');
  return createJevEngine({apiKey});
}
function optionalAmounts(d:StudioDraft) {
  for(const [key,value] of Object.entries(labeledAmounts(d.description)))if(!field(d,key))setField(d,key,String(value));
  const budget=/\b(?:spend|pay up to)\s*\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*[km]?)(?![\d,]|\.\d)/i.exec(d.description)?.[1];
  if(!field(d,'budgetUsd')&&budget&&amount(budget)!==null)setField(d,'budgetUsd',String(amount(budget)));
  if(!field(d,'coverageUsd')&&field(d,'lossUsd')&&/\b(?:full|entire|all of (?:the|my))\s+(?:loss|cover|amount)|\bcover (?:it all|all of it|in full)\b/i.test(d.description))setField(d,'coverageUsd',field(d,'lossUsd'));
}
function numericFields(d:StudioDraft,e:Partial<TypedExposure>) {
  d.known=e;
  setField(d,'exposure',exposureSummary(d.description));
  if(e.deadline)setField(d,'deadline',e.deadline.value,e.deadline.provenance==='inferred'?'inferred':'stated');
  if(e.lossUsd)setField(d,'lossUsd',String(e.lossUsd.value));
  if(e.budgetUsd)setField(d,'budgetUsd',String(e.budgetUsd.value));
  if(e.levels?.length&&e.direction)setField(d,'trigger',`${/daily high/i.test(d.description)?'daily high ':/daily low/i.test(d.description)?'daily low ':''}${e.direction} ${e.levels.map(l=>l.unit==='$'?`$${l.value.toLocaleString('en-US')}`:`${l.value}${l.unit??''}`).join(' to ')}`);
  optionalAmounts(d);
}
const numericUniverses = new WeakMap<MarketIndex, MarketIndex['events']>();
function numericUniverse(index:MarketIndex) {
  let events=numericUniverses.get(index);
  if(!events){
    const eligible=new Set(index.listings.filter(r=>r.kind==='numeric'&&r.eligible).map(r=>r.eventId));
    events=index.events.filter(e=>eligible.has(e.eventId));
    numericUniverses.set(index,events);
  }
  return events;
}
export async function describeExposure(text:string,deps:StudioIntakeDeps,previous?:StudioDraft):Promise<StudioDraft> {
  text=normalizeExposure(text);
  const d=previous??newDraft(text);
  if(!previous){
    const trigger=statedTrigger(text);if(trigger)setField(d,'trigger',trigger);
    const date=parseDeadline(text,deps.today);if(date)setField(d,'deadline',date.value,date.provenance);
  }
  if(!previous)optionalAmounts(d);
  const ramp=explicitHoldingRamp(d.description);
  if(ramp){
    setField(d,'exposure',exposureSummary(d.description));setField(d,'trigger',ramp.trigger);
    const parsedDate=parseDeadline(d.description,deps.today);
    if(parsedDate)setField(d,'deadline',parsedDate.value,parsedDate.provenance);
    if(ramp.error){d.pending={key:'description',text:ramp.error,...(ramp.corrections?{choices:ramp.corrections}:{})};return d;}
    if(parsedDate)return prepareExplicitRamp(d,ramp,parsedDate.value,deps);
  }
  const events=numericUniverse(deps.index).filter(e=>Date.parse(e.observationAt)>deps.today.getTime());
  const deadline=parseDeadline(d.description,deps.today);
  const ranked=deadline?exposureListings(deps.index.listings,d.description,deadline.value,true,'ceiling').filter(r=>familyEnabled(r.kind)):[];
  const terminalNumeric=deadline&&/\b(?:ends?|closes?|settles?|daily (?:high|low))\b/i.test(d.description)
    ?exposureListings(deps.index.listings,d.description,deadline.value,'only','ceiling').filter(r=>familyEnabled(r.kind)):[];
  const preferred=terminalNumeric[0]??ranked[0];
  const numericMatch=!!deadline&&(preferred?events.some(e=>e.eventId===preferred.eventId):false)||!!deadline&&candidatesForText(d.description,events).some(e=>/\bprice on\b/i.test(e.title));
  if((d.numeric||numericMatch)&&candidatesForText(d.description,events).length>0) {
    const never=async():Promise<never>=>{throw new Error('Preparation must not read books or solve');};
    let holdingReading:HoldingReading|undefined;
    const intakeDeps:IntakeDeps={engine:withHoldingQuestions(deps.engine,reading=>{holdingReading=reading;}),events,today:deps.today,newSessionId:()=>crypto.randomUUID(),
      resolutionTextFor:id=>deps.index.resolutionText.get(id)??'',bracketLabelsFor:id=>deps.index.bracketLabels.get(id)??[],
      fetchEvent:deps.fetchEvent,fetchBooks:never,saveSnapshot:never,combinedShape:true,prepareOnly:true,deadlineMode:'ceiling',
      protectionGoal:{kind:'minimize_net_loss'},execution:{quantityStep:.01}};
    const modelText=/\b(?:lose|loss)\b/i.test(text)?text.replace(/\b(?:cover(?:age)?(?: target)?(?: is| of)?|protect)\s*\$[\d,.]+\s*[km]?/gi,'requested cover recorded separately'):text;
    const result=await intake(modelText,intakeDeps,d.numeric);
    if(result.kind==='follow_up') {
      d.numeric=result.session;
      numericFields(d,result.session.confirmed);
      d.pending={key:result.session.pending!.field,text:result.question};
      return d;
    }
    if(result.kind==='prepared') {
      numericFields(d,result.exposure);
      const gamma=deps.index.byId.get(result.request.eventId)??await deps.fetchEvent(result.request.eventId);
      const selection={kind:'numeric'} as const;
      const support=eventSupport(gamma,selection);
      if(!support.eligible||!familyEnabled('numeric'))throw new Error('unavailable: This numeric event is not currently available.');
      d.event={id:gamma.id,selection,support};
      d.request={...result.request,selection,ruleHash:support.ruleHash};
      d.options=result.options;
      d.assumptions=result.assumptions.filter(a=>!a.startsWith('Assumed you want to cover the full'));
      delete d.numeric;delete d.pending;
      const observed=indexEvent(gamma)?.observationAt;
      const requested=result.exposure.deadline.value;
      const cutoff=Date.parse(requested.includes('T')?requested:`${requested}T23:59:59.999Z`);
      if(!observed||Date.parse(observed)<=deps.today.getTime()||Date.parse(observed)>cutoff)throw Error('unavailable: The market observation no longer fits your date ceiling. Refresh and try again.');
      if(observed&&(requested.includes('T')?Date.parse(observed)!==Date.parse(requested):observed.slice(0,10)!==requested.slice(0,10)))d.numericDate={requested,observed};
      interpretHolding(d,support.title,holdingReading);
      return d;
    }
    if(result.kind==='declined')throw new Error(`unavailable: ${result.reason}`);
    if(!deps.index.discoveryComplete)throw new Error('catalogue_pending');
    throw new Error('unavailable: No suitable market is listed for that exposure and date.');
  }
  delete d.numeric;
  return prepareEvent(d,deps);
}

async function prepareExplicitRamp(d:StudioDraft,ramp:NonNullable<ReturnType<typeof explicitHoldingRamp>>,date:string,deps:StudioIntakeDeps):Promise<StudioDraft>{
  const aliases:Record<string,string>={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',XRP:'xrp',DOGE:'dogecoin'};
  const subject=new RegExp(`\\b(${ramp.coin}|${aliases[ramp.coin]})\\b`,'i');
  const rows=exposureListings(deps.index.listings,d.description,date,'only','ceiling').filter(r=>familyEnabled(r.kind)&&subject.test(r.title)&&/\bprice on\b/i.test(r.title));
  if(!rows.length){
    if(!deps.index.discoveryComplete)throw Error('catalogue_pending');
    d.pending={key:'deadline',text:'Your loss trigger is understood, but no supported price market was found on or before that date. Change the protection date or exposure.'};return d;
  }
  const event=await deps.fetchEvent(rows[0]!.eventId),selection={kind:'numeric'} as const;
  const support=eventSupport(event,selection),indexed=indexEvent(event);
  const cutoff=Date.parse(date.includes('T')?date:`${date}T23:59:59.999Z`);
  if(!support.eligible||!indexed||!subject.test(event.title)||!/\bprice on\b/i.test(event.title)||Date.parse(indexed.observationAt)<=deps.today.getTime()||Date.parse(indexed.observationAt)>cutoff)throw Error('unavailable: The matched price market is no longer eligible for that date. Refresh the examples or change the date.');
  d.event={id:event.id,selection,support};
  d.request={eventId:event.id,selection,ruleHash:support.ruleHash,shape:ramp.shape,execution:{quantityStep:.01},protectionGoal:{kind:'minimize_net_loss'}};
  d.assumptions=[`Market observation: ${indexed.observationAt}. The published price-source rules determine payout.`,...new Set(support.rules.map(r=>r.description))];
  delete d.pending;
  const same=date.includes('T')?Date.parse(date)===Date.parse(indexed.observationAt):date.slice(0,10)===indexed.observationAt.slice(0,10);
  if(!same)d.numericDate={requested:date,observed:indexed.observationAt};
  return d;
}
async function prepareEvent(d:StudioDraft,deps:StudioIntakeDeps):Promise<StudioDraft> {
  setField(d,'exposure',exposureSummary(d.description));
  const condition=/Risk condition: ([^.!?]+)/i.exec(d.description)?.[1];
  if(condition)setField(d,'trigger',condition);
  if(/\b(?:bad weather|weather would|weather could)\b/i.test(d.description)&&!/Risk condition:/i.test(d.description)){
    d.pending={key:'eventCondition',text:'What kind of weather would cause your loss?',choices:[{value:'Cold temperatures',label:'Too cold'},{value:'High temperatures',label:'Too hot'},{value:'Rainfall',label:'Rain'}]};
    return d;
  }
  const date=parseDeadline(d.description,deps.today);
  if(date)setField(d,'deadline',date.value,date.provenance==='inferred'?'inferred':'stated');
  const candidates=exposureListings(deps.index.listings,d.description,date?.value??null,!date,'ceiling',12,true).filter(r=>familyEnabled(r.kind));
  // Retrieval is recall-oriented. A lexical match is not evidence that a market
  // measures the exposure: check the bounded shortlist together in one call.
  const questions:Record<string,Question>={};
  candidates.forEach((r,i)=>{questions[`match_${i}`]={kind:'boolean',instructions:
    `Does this candidate measure the SAME underlying event or observable as the user's loss? Candidate: ${r.searchText??r.title}. Kind: ${r.kind}. Listed end: ${r.date}. Require the same asset, named entity, location, competition/season and event condition where specified. Winning is not relegation or a top-N finish. The Fed is not another central bank. A price touching a level at any time is not the terminal price. Do not accept merely correlated events or silently assume a proxy. Different possible settlement outcomes of the same categorical event are allowed; amounts are mapped later. Missing budget or loss amounts do not make an otherwise matching event incorrect.`};});
  const answers=candidates.length?(await deps.engine.ask(d.description,questions)).answers:{};
  const relevant=candidates.filter((_,i)=>{const a=answers[`match_${i}`];return a?.kind==='boolean'&&a.probability>=.8;});
  // Persisted catalogues may still contain the old event-wide rejection. Only
  // recheck that exact legacy reason, on the small semantically matched list.
  const refreshed=new Map<string,Promise<GammaEvent>>();
  await Promise.all(relevant.slice(0,5).map(async row=>{
    if(row.kind!=='binary'||row.eligible||row.reason!=='Changing or unverified outcome sets are not supported.')return;
    try{
      let event=refreshed.get(row.eventId);if(!event){event=deps.fetchEvent(row.eventId);refreshed.set(row.eventId,event);}
      const support=eventSupport(await event,row.selection);
      // Change this request's result only; the worker owns the catalogue.
      const replacement={...row,eligible:support.eligible,reason:support.reason};
      relevant[relevant.indexOf(row)]=replacement;
    }catch{ /* Keep the candidate unavailable when fresh verification fails. */ }
  }));
  const matches=relevant.filter(r=>r.eligible).slice(0,5);
  if(!matches.length&&relevant.length){d.unavailable=`${relevant[0]!.title}: ${relevant[0]!.reason??'Settlement rules are unsupported'}`;d.pending={key:'eventSubject',text:`I found “${relevant[0]!.title}”, but cannot build a hedge from it: ${relevant[0]!.reason?.replace(/[.!]+$/,'')??'its settlement rules are not supported'}. You can describe a different exposure.`};return d;}
  if(!date&&!matches.length){if(!deps.index.discoveryComplete)throw Error('catalogue_pending');d.pending={key:candidates.length?'eventSubject':'eventDate',text:candidates.length?'No supported event in the current shortlist clearly matches that exposure. Name the exact event or refine the date/location; we will not substitute a different risk.':'What date does the exposure matter? Include the day, month and year so we can check the available events.'};return d;}
  if(!matches.length&&!deps.index.discoveryComplete)throw new Error('catalogue_pending');
  if(!matches.length){d.pending={key:'eventSubject',text:'I could not match a supported event on or before that date. What specific asset, location or named event would cause your loss? You can also start over with a different date.'};return d;}
  d.matches=matches.map(r=>({id:r.eventId,title:r.title,selection:r.selection}));
  d.pending={key:'eventMatch',text:'These are possible matches, not confirmed hedges. Which event measures your exposure?',choices:[...d.matches.map((r,i)=>({value:String(i),label:r.title})),{value:'none',label:'None of these — describe a different event'}]};
  return d;
}
async function interpretOutcomeLosses(d:StudioDraft,deps:StudioIntakeDeps) {
  const support=d.event!.support;
  // One choice per amount: duplicate dollar mentions and two zero choices split confidence.
  const amounts=new Map<number,ReturnType<typeof findNumbers>[number]>();
  for(const n of findNumbers(d.description).filter(n=>n.value>0&&n.value<=1e9)){
    const previous=amounts.get(n.value);
    amounts.set(n.value,previous?{...previous,context:`${previous.context}; ${n.context}`} : n);
  }
  const numbers=[...amounts.values()].slice(0,24);
  const questions:Record<string,Question>={hedge:{kind:'boolean',instructions:'The user describes a loss on an existing position, expense or business activity, rather than a new speculative bet.'}};
  support.outcomes.forEach((o,i)=>{
    questions[`loss_${i}`]={kind:'choice',instructions:`For the event "${support.title}", the settlement outcome is "${o.label}". Which dollar LOSS does the user explicitly state for this outcome? Do not substitute holding value, protection budget, yearly rates or a threshold. Choose unknown when the amount or mapping is ambiguous. Zero requires an explicit statement that this outcome causes no loss.`,criteria:Object.fromEntries([...numbers.map((n,j)=>[`n${j}`,`Stated loss ${n.raw}; context: ${n.context}`]),['zero','The user explicitly states no loss in this outcome.'],['unknown','Loss for this outcome was not clearly stated.']])};
  });
  const {answers}=await deps.engine.ask(d.description,questions);
  if(answers.hedge?.kind!=='boolean'||answers.hedge.probability<.6){d.pending={key:'eventBasis',text:'What existing holding, expense or business activity would lose money if this event happens?'};return;}
  support.outcomes.forEach((o,i)=>{
    const a=answers[`loss_${i}`];
    const value=a?.kind==='choice'&&a.confidence>=.8?(a.choice==='zero'?0:numbers[Number(a.choice.slice(1))]?.value):undefined;
    setField(d,`outcome:${o.id}`,value===undefined?'':String(value),value===undefined?'missing':'stated',`${o.label} loss ($)`);
  });
  finishOutcomeMapping(d);
}
function finishOutcomeMapping(d:StudioDraft) {
  const support=d.event!.support;
  const missing=support.outcomes.find(o=>!field(d,`outcome:${o.id}`));
  if(missing){d.pending={key:`outcome:${missing.id}`,text:`For “${support.title}”, how much would you lose in the “${missing.label}” outcome? Enter a dollar amount such as 5000, or 0 for no loss.`};return;}
  const losses=support.outcomes.map(o=>({outcomeId:o.id,lossCents:Math.round(amount(field(d,`outcome:${o.id}`))!*100)}));
  const max=Math.max(...losses.map(l=>l.lossCents))/100;
  if(max<=0)throw new Error('bad_request: at least one outcome must cause a loss to hedge');
  setField(d,'lossUsd',String(max));
  setField(d,'trigger',support.outcomes.map((o,i)=>`${o.label}: $${losses[i]!.lossCents/100} loss`).join('; '));
  optionalAmounts(d);
  d.request={eventId:d.event!.id,selection:d.event!.selection,ruleHash:support.ruleHash,shape:{templateId:'outcome_losses',losses},execution:{quantityStep:.01},protectionGoal:{kind:'minimize_net_loss'}};
  delete d.pending;
}
export async function updateDraft(d:StudioDraft,key:string,value:string,deps:StudioIntakeDeps):Promise<StudioDraft> {
  const text=normalizeExposure(value);if(!text||text.length>2000)throw new Error('bad_request: enter a valid answer');
  if(key==='trigger'&&amount(text)!==null)throw Error('bad_request: A loss trigger is an event or condition, not a dollar amount. For example: Arsenal does not win the 2026–27 Premier League. Enter the amount in Potential loss.');
  if(key==='deadline'&&text!==field(d,'deadline')&&explicitHoldingRamp(d.description)){
    if(!parseDeadline(text,deps.today))throw Error('bad_request: enter a valid protection date');
    let revised=d.description.replace(/Protection date: [\s\S]*?(?=\.\s+Potential loss)/i,`Protection date: ${text}`);
    for(const [key,label] of [['lossUsd','Potential loss'],['coverageUsd','cover target'],['budgetUsd','spending budget']]){
      const value=field(d,key!);if(value&&value!=='no cap')revised=revised.replace(new RegExp(`${label} \\$[\\d,]+(?:\\.\\d+)?`,'i'),`${label} $${value}`);
    }
    const next=await describeExposure(revised,deps);
    if(field(d,'budgetUsd')==='no cap')setField(next,'budgetUsd','no cap');
    return next;
  }
  if(key==='numericDate'){
    if(!d.numericDate)throw Error('bad_request: no date confirmation is pending');
    if(text==='change'){d.pending={key:'description',text:'Enter the revised exposure and protection date.'};return d;}
    if(!/^(confirm|yes)$/i.test(text))throw Error('bad_request: confirm the earlier observation or change the exposure');
    d.assumptions.push(`User accepted observation ${d.numericDate.observed} before deadline ${d.numericDate.requested}; price changes afterwards are not covered.`);delete d.numericDate;delete d.pending;return d;
  }
  if(key==='holdingQuantity'){selectHolding(d,text);return d;}
  if(key==='holdingMeaning'){applyHoldingMeaning(d,text,true);return d;}
  if(key==='eventCondition')return updateDraft(d,'trigger',text,deps);
  if(key==='eventDate')return updateDraft(d,'deadline',text,deps);
  if(key==='eventSubject'){d.description+=` My specific exposure is ${text}.`;delete d.pending;return describeExposure(d.description,deps);}
  if(key==='eventMatch') {
    if(text==='none'){delete d.matches;d.pending={key:'eventSubject',text:'Which event, asset, location or season should we look for instead?'};return d;}
    const match=d.matches?.[Number(text)];if(!match||!/^\d+$/.test(text))throw new Error('bad_request: choose one listed event');
    const candidate=await deps.fetchEvent(match.id);
    const support=eventSupport(candidate,match.selection);
    const requested=field(d,'deadline');
    const cutoff=Date.parse(requested.includes('T')?requested:`${requested}T23:59:59.999Z`);
    if(!support.eligible||Date.parse(support.observationAt)<=deps.today.getTime()||(requested&&(!Number.isFinite(cutoff)||Date.parse(support.observationAt)>cutoff)))throw new Error('unavailable: This event is no longer available within your date ceiling.');
    d.event={id:match.id,selection:match.selection,support};
    if(!requested)setField(d,'deadline',support.observationAt,'inferred');
    d.assumptions=[`Business losses may differ from the market payout. The chosen event is ${support.title}.`,...new Set(support.rules.map(r=>r.description))];
    d.pending={key:'eventRules',text:`Does the published event measure the situation you mean? ${support.title.replace(/[.!?]+$/,'')}. Its listed end time is ${support.observationAt}.${requested&&Date.parse(support.observationAt)<cutoff?' This is earlier than your latest date; later changes are not covered.':''} Review the settlement rules below.`,choices:[{value:'confirm',label:'Yes, these conditions match my exposure'}]};
    return d;
  }
  if(key==='eventRules'||key==='eventBasis') {
    if(key==='eventRules'&&!/^(confirm|yes)$/i.test(text))throw new Error('bad_request: confirm the conditions, or start over to choose another event');
    if(key==='eventBasis')d.description+=` My existing exposure is ${text}.`;
    if(d.fields.find(f=>f.key==='deadline')?.status==='inferred')setField(d,'deadline',field(d,'deadline'));
    if(d.event?.selection.kind==='numeric'){
      const selected=await deps.fetchEvent(d.event.id),indexed=indexEvent(selected);
      if(!indexed)throw Error('unavailable: This event does not have supported numeric settlement rules.');
      const description=`${d.description} Protection date: ${field(d,'deadline')}.`;
      return describeExposure(description,{...deps,index:{...deps.index,events:[indexed],listings:eventListings(selected),byId:new Map([[selected.id,selected]])}});
    }
    delete d.pending;await interpretOutcomeLosses(d,deps);return d;
  }
  if(key.startsWith('outcome:')) {
    if(!d.event?.support.outcomes.some(o=>`outcome:${o.id}`===key))throw new Error('bad_request: unknown outcome');
    const n=amount(text);if(n===null)throw new Error('bad_request: enter a nonnegative dollar loss');
    setField(d,key,String(n));finishOutcomeMapping(d);return d;
  }
  if(d.numeric&&key===d.numeric.pending?.field)return describeExposure(text,deps,d);
  if(['lossUsd','coverageUsd','budgetUsd'].includes(key)) {
    if(key==='lossUsd'&&d.request?.shape.templateId==='outcome_losses')throw new Error('bad_request: edit each outcome loss instead');
    const n=key==='coverageUsd'&&/^(full|all|all of it)$/i.test(text)?amount(field(d,'lossUsd')):amount(text);
    if(key==='budgetUsd'&&/^(no cap|compare)$/i.test(text))setField(d,key,'no cap');
    else {if(n===null||n<=0)throw new Error('bad_request: enter a positive dollar amount');setField(d,key,String(n));}
    if(d.pending?.key===key)delete d.pending;
    return d;
  }
  // Accepting an inferred reading as shown confirms it; it is not an edit to reinterpret.
  if(d.fields.find(f=>f.key===key)?.status==='inferred'&&text===field(d,key)){setField(d,key,text);delete d.pending;return d;}
  if(!d.request&&!d.numeric&&['trigger','deadline','exposure'].includes(key)) {
    if(key==='deadline'&&!parseDeadline(text,deps.today))throw new Error('bad_request: enter a date such as September 30, 2026; include a timezone for an exact time');
    let description=key==='exposure'?text:key==='trigger'?`${d.description.replace(/Risk condition: [^.!?]+[.!?]?/gi,'')} Risk condition: ${text}.`:`${d.description} Protection date: ${text}.`;
    for(const [moneyKey,label] of [['lossUsd','Potential loss'],['coverageUsd','Cover target'],['budgetUsd','Spending budget']]){
      const value=field(d,moneyKey!);
      if(value&&value!=='no cap'&&!labeledAmounts(description)[moneyKey as 'lossUsd'|'coverageUsd'|'budgetUsd'])description+=` ${label} $${value}.`;
    }
    const next=await describeExposure(description,deps);
    for(const saved of d.fields.filter(f=>['lossUsd','coverageUsd','budgetUsd'].includes(f.key)&&f.status==='stated'))setField(next,saved.key,saved.value);
    return next;
  }
  if(['exposure','trigger','deadline','description'].includes(key)) {
    if(key==='description')return describeExposure(text,deps);
    setField(d,key,text);
    const rebuilt=`${field(d,'exposure')}. I lose $${field(d,'lossUsd')} if ${field(d,'trigger')} by ${field(d,'deadline')}.${field(d,'budgetUsd')&&field(d,'budgetUsd')!=='no cap'?` I can spend $${field(d,'budgetUsd')}.`:''}`;
    const next=await describeExposure(rebuilt,deps);
    if(field(d,'coverageUsd'))setField(next,'coverageUsd',field(d,'coverageUsd'));
    if(field(d,'budgetUsd')==='no cap')setField(next,'budgetUsd','no cap');
    return next;
  }
  throw new Error('bad_request: this field cannot be edited');
}

/** Apply an amount form atomically. No discovery, interpretation or venue calls. */
export function updateAmounts(original:StudioDraft,values:unknown):StudioDraft {
  if(original.unavailable||original.numeric||(!original.request&&!original.event)||original.pending&&!isAmountField(original.pending.key))throw Error('bad_request: confirm the matched event and its date first');
  if(!values||typeof values!=='object'||Array.isArray(values))throw Error('bad_request: enter the protection amounts');
  const d=structuredClone(original);delete d.exampleQualityRequired;
  for(const [key,value] of Object.entries(values)){
    if(!isAmountField(key)||!d.fields.some(f=>f.key===key)||typeof value!=='string')throw Error('bad_request: invalid amount field');
    if(key==='lossUsd'&&d.event?.selection.kind!=='numeric'&&d.event)throw Error('bad_request: edit each outcome loss instead');
    if(key==='budgetUsd'&&value==='no cap'){setField(d,key,value);continue;}
    const n=amount(value);
    if(n===null||(!key.startsWith('outcome:')&&n<=0))throw Error(`bad_request: enter a valid ${d.fields.find(f=>f.key===key)!.label.toLowerCase()}`);
    setField(d,key,String(n));
  }
  if(d.pending&&isAmountField(d.pending.key))delete d.pending;
  if(d.event&&d.event.selection.kind!=='numeric')finishOutcomeMapping(d);
  const loss=amount(field(d,'lossUsd')),cover=amount(field(d,'coverageUsd'));
  if(loss!==null&&cover!==null&&cover>loss)throw Error('bad_request: cover target cannot exceed the potential loss; adjust the cover target or outcome losses');
  return d;
}
