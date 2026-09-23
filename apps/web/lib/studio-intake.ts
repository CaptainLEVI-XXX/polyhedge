import { exposureSummary, heldCoins, holdingLoss, labeledAmounts } from './studio-input.js';
import { createJevEngine, type Question, type QuestionEngine } from '@polyhedge/questions';
import { candidatesForText, findNumbers, intake, parseDeadline, type IntakeDeps, type TypedExposure } from '@polyhedge/intake';
import { eventSupport, type GammaEvent } from '@polyhedge/venue';
import type { MarketIndex } from './markets.js';
import { exposureListings } from './event-listings.js';
import { familyEnabled } from './event-family.js';
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
  if(e.levels?.length&&e.direction)setField(d,'trigger',`${/daily high/i.test(d.description)?'daily high ':/daily low/i.test(d.description)?'daily low ':''}${e.direction} ${e.levels.map(l=>`${l.value}${l.unit??''}`).join(' to ')}`);
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
  const d=previous??newDraft(text);
  if(!previous)optionalAmounts(d);
  const events=numericUniverse(deps.index);
  const deadline=parseDeadline(d.description,deps.today);
  const ranked=deadline?exposureListings(deps.index.listings,d.description,deadline.value,true).filter(r=>familyEnabled(r.kind)):[];
  const terminalNumeric=deadline&&/\b(?:ends?|closes?|settles?|daily (?:high|low))\b/i.test(d.description)
    ?exposureListings(deps.index.listings,d.description,deadline.value,'only').filter(r=>familyEnabled(r.kind)):[];
  const preferred=terminalNumeric[0]??ranked[0];
  const numericMatch=preferred?events.some(e=>e.eventId===preferred.eventId):false;
  if((d.numeric||numericMatch)&&candidatesForText(d.description,events).length>0) {
    const never=async():Promise<never>=>{throw new Error('Preparation must not read books or solve');};
    const intakeDeps:IntakeDeps={engine:deps.engine,events,today:deps.today,newSessionId:()=>crypto.randomUUID(),
      resolutionTextFor:id=>deps.index.resolutionText.get(id)??'',bracketLabelsFor:id=>deps.index.bracketLabels.get(id)??[],
      fetchEvent:deps.fetchEvent,fetchBooks:never,saveSnapshot:never,combinedShape:true,prepareOnly:true,
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
      asHolding(d,support.title);
      d.options=result.options;
      d.assumptions=result.assumptions.filter(a=>!a.startsWith('Assumed you want to cover the full'));
      delete d.numeric;delete d.pending;
      return d;
    }
    if(result.kind==='declined')throw new Error(`unavailable: ${result.reason}`);
    if(!deps.index.discoveryComplete)throw new Error('catalogue_pending');
    throw new Error('unavailable: No suitable market is listed for that exposure and date.');
  }
  delete d.numeric;
  return prepareEvent(d,deps);
}
/**
 * "I hold 2 BTC and lose $8,000 below $77,000" is a loss that grows as the price
 * falls, not one that appears in full at $77,000. When the text names a coin
 * holding of the event's own asset, the one-level target becomes that gradual
 * loss, and the reading is shown for confirmation because it is an inference.
 */
function asHolding(d:StudioDraft,eventTitle:string) {
  const held=heldCoins(d.description),shape=d.request?.shape;
  if(!held||!shape||(shape.templateId!=='threshold_digital'&&shape.templateId!=='tail_only'))return;
  const aliases:Record<string,string>={btc:'bitcoin',eth:'ethereum',ether:'ethereum',sol:'solana',doge:'dogecoin'};
  const coin=held.coin.toLowerCase();
  if(!new RegExp(`\\b(${coin}|${aliases[coin]??coin})\\b`,'i').test(eventTitle))return;
  try {
    const holding=holdingLoss(held,shape.direction,shape.k,shape.payoutUsd);
    d.request!.shape=holding.shape;
    setField(d,'trigger',holding.trigger,'inferred');
  } catch { /* A layer outside the price domain stays a one-level target. */ }
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
  if(!date){d.pending={key:'eventDate',text:'When does the exposure matter? Include the day, month and year.'};return d;}
  setField(d,'deadline',date.value,date.provenance==='inferred'?'inferred':'stated');
  const matches=exposureListings(deps.index.listings,d.description,date.value.slice(0,10)).filter(r=>familyEnabled(r.kind));
  if(!matches.length&&!deps.index.discoveryComplete)throw new Error('catalogue_pending');
  if(!matches.length){d.pending={key:'eventSubject',text:'I could not match a supported event on that date. What specific asset, location or named event would cause your loss? You can also start over with a different date.'};return d;}
  d.matches=matches.map(r=>({id:r.eventId,title:r.title,selection:r.selection}));
  d.pending={key:'eventMatch',text:'Which of these events matches what would cause your loss?',choices:d.matches.map((r,i)=>({value:String(i),label:r.title}))};
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
  const text=value.trim();if(!text||text.length>2000)throw new Error('bad_request: enter a valid answer');
  if(key==='eventCondition')return updateDraft(d,'trigger',text,deps);
  if(key==='eventDate')return updateDraft(d,'deadline',text,deps);
  if(key==='eventSubject'){d.description+=` My specific exposure is ${text}.`;delete d.pending;return describeExposure(d.description,deps);}
  if(key==='eventMatch') {
    const match=d.matches?.[Number(text)];if(!match||!/^\d+$/.test(text))throw new Error('bad_request: choose one listed event');
    const support=eventSupport(await deps.fetchEvent(match.id),match.selection);
    if(!support.eligible)throw new Error('unavailable: This event is no longer available.');
    d.event={id:match.id,selection:match.selection,support};
    d.assumptions=[`Business losses may differ from the market payout. The chosen event is ${support.title}.`,...new Set(support.rules.map(r=>r.description))];
    d.pending={key:'eventRules',text:`Does the published event measure the situation you mean? ${support.title}. Its listed end time is ${support.observationAt}. Review the settlement rules below.`,choices:[{value:'confirm',label:'Yes, these conditions match my exposure'}]};
    return d;
  }
  if(key==='eventRules'||key==='eventBasis') {
    if(key==='eventRules'&&!/^(confirm|yes)$/i.test(text))throw new Error('bad_request: confirm the conditions, or start over to choose another event');
    if(key==='eventBasis')d.description+=` My existing exposure is ${text}.`;
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
