import { holdingProtectionShape, type TargetShape } from '@polyhedge/core';
import { amount, field, setField, type StudioDraft } from './studio-draft.js';

// A complete number, not a run of digits and punctuation that swallows a sentence stop.
const MONEY=String.raw`\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*[km]?)(?![\d,]|\.\d)(?:\s*(?:USD|dollars?))?`;
const labels={lossUsd:'potential loss',coverageUsd:'cover(?:age)?(?: target)?',budgetUsd:'(?:spending )?budget'} as const;
export function labeledAmounts(text:string):Partial<Record<keyof typeof labels,number>> {
  const result:Partial<Record<keyof typeof labels,number>>={};
  for(const [key,label] of Object.entries(labels)){
    const matches=[...text.matchAll(new RegExp(`\\b${label}(?: is| of)?\\s*:?\\s*${MONEY}`,'gi'))];
    const values=matches.map(m=>amount(m[1]!));
    if(values.length&&values.every(v=>v!==null&&v===values[0]))result[key as keyof typeof labels]=values[0]!;
  }
  return result;
}
/** Retain a verified event only when the edit changes labelled amounts alone. */
export function editExample(original:StudioDraft,text:string):StudioDraft|null {
  const mask=(value:string)=>value.replace(new RegExp(`\\b(potential loss|cover(?:age)?(?: target)?|(?:spending )?budget)(?: is| of)?\\s*:?\\s*${MONEY}`,'gi'),
    (_,label:string)=>`${label.toLowerCase()} <amount>`).trim().replace(/\s+/g,' ');
  if(mask(original.description)!==mask(text))return null;
  const values=labeledAmounts(text);
  if(Object.keys(values).length!==3)return null;
  // A categorical loss is specified per outcome, and a holding's loss by its quantity;
  // an aggregate edit cannot rewrite either, so the text is interpreted afresh.
  if(['outcome_losses','linear_strip'].includes(original.request?.shape.templateId??'')&&values.lossUsd!==Number(field(original,'lossUsd')))return null;
  const draft=structuredClone(original);draft.description=text;
  if(text!==original.description)delete draft.exampleQualityRequired;
  for(const [key,value] of Object.entries(values))setField(draft,key,String(value));
  return draft;
}

/** Strip copied blockquote markers, retaining numeric comparisons such as > $3,000. */
export function normalizeExposure(text:string):string {
  if(!/^\s*>\s*/m.test(text))return text.trim();
  return text.replace(/^\s*>\s*/gm,'').replace(/\s+>\s+(?=[A-Za-z])/g,' ').trim();
}
/** Preserve the user's condition verbatim; this is display evidence, not a priced shape. */
export function statedTrigger(text:string):string|null {
  const clauses=text.split(/(?<=[.!?])\s+/);
  const conditions=clauses.filter(c=>/\b(?:below|above|if|when|increase|decrease|no change)\b/i.test(c)
    &&!/^(?:ask me|please|cover target|spending budget)/i.test(c));
  return conditions.length?conditions.join(' '):null;
}

/** Display the position separately; retain the full original description for interpretation. */
export function exposureSummary(text:string):string {
  const clean=text.replace(/^\s*>\s*/gm,'').trim();
  const first=clean.split(/[.!?]\s+(?=[A-Z])/)[0]!;
  return first.split(/\b(?:if|when|by)\b/i)[0]!.replace(/\s+(?:and\s+)?(?:I\s+)?(?:would\s+)?lose\b.*$/i,'').trim() || clean;
}

/**
 * A coin holding loses gradually: $quantity for every $1 the price moves, reaching
 * `lossUsd` at `k`. The caller must first confirm that `k` is the end of the ramp;
 * ambiguous language is not sufficient evidence for this interpretation.
 */
export function holdingLoss(held:{quantity:number;coin:string},direction:'below'|'above',k:number,lossUsd:number):{shape:TargetShape;trigger:string} {
  const span=lossUsd/held.quantity;
  const start=direction==='below'?k+span:k-span;
  const shape=holdingProtectionShape({quantity:held.quantity,position:direction==='below'?'long':'short',referencePriceUsd:start,
    deductibleUsd:0,payoutCapUsd:lossUsd,protectionFraction:1});
  const usd=(n:number)=>`$${n.toLocaleString('en-US',{maximumFractionDigits:2})}`;
  return {shape,trigger:`${held.coin} ${direction} ${usd(start)}: loss grows ${usd(held.quantity)} per $1 ${direction==='below'?'fall':'rise'}, reaching ${usd(lossUsd)} at ${usd(k)}`};
}

/** The exact ramp notation emitted by our examples. Never guesses a prose meaning. */
export function explicitHoldingRamp(text:string):{trigger:string;shape:TargetShape;coin:string;error?:string;corrections?:{value:string;label:string}[]}|null {
  const number=String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)`;
  const coin=String.raw`(BTC|ETH|SOL|XRP|DOGE)`;
  const position=new RegExp(`^\\s*${number}\\s*${coin}\\s+holdings\\.\\s*`,'i').exec(text);
  if(!position)return null;
  const pattern=new RegExp(`^${coin} (below|above) \\$${number}: loss grows \\$${number} per \\$1 (fall|rise), reaching \\$${number} at \\$${number}(?=,|\\.|\\s|$)`,'i');
  const match=pattern.exec(text.slice(position[0].length));
  if(!match||position[2]!.toUpperCase()!==match[1]!.toUpperCase())return null;
  const tail=text.slice(position[0].length+match[0].length);
  // Restrict the fast path to our complete scaffold. Extra prose or overrides
  // must go through interpretation rather than being silently ignored.
  const suffix=new RegExp(`^, under the listed price-source rules\\.\\s+Protection date: [^\\n]+?\\.\\s+Potential loss \\$${number};\\s*cover target \\$${number};\\s*spending budget \\$${number}\\.\\s*$`,'i');
  if(!suffix.test(tail))return null;
  const n=(s:string)=>Number(s.replace(/,/g,''));
  const quantity=n(position[1]!),direction=match[2]!.toLowerCase() as 'below'|'above',start=n(match[3]!),slope=n(match[4]!),loss=n(match[6]!),end=n(match[7]!);
  if(![quantity,start,slope,loss,end].every(Number.isFinite)||quantity<=0||loss<=0)return null;
  const shape:TargetShape={templateId:'linear_strip',direction,k1:Math.min(start,end),k2:Math.max(start,end),payoutUsd:loss};
  const trigger=match[0],result={trigger,shape,coin:match[1]!.toUpperCase()};
  const expected=quantity*Math.abs(start-end);
  const usd=(v:number)=>`$${v.toLocaleString('en-US',{maximumFractionDigits:8})}`;
  if(slope!==quantity)return {...result,error:`You wrote ${quantity} ${result.coin}, but ${usd(slope)} loss per $1 move describes ${slope} ${result.coin}. Are you protecting only ${slope} ${result.coin}, or should the holding quantity and loss amounts change? Please update the exposure description.`};
  if(match[5]!.toLowerCase()!==(direction==='below'?'fall':'rise')||(direction==='below'?start<=end:start>=end))return {...result,error:'The holding quantity, loss per $1 move and price direction disagree. Please correct the exposure description.'};
  const stated=labeledAmounts(text).lossUsd;
  if(stated!==undefined&&Math.abs(stated-loss)>.005)return {...result,error:`The ramp reaches ${usd(loss)}, but potential loss is ${usd(stated)}. Please make those amounts consistent.`};
  if(Math.abs(expected-loss)>.005){
    const sign=direction==='below'?-1:1;
    const correctedEnd=start+sign*loss/quantity,correctedStart=end-sign*loss/quantity;
    const correction=(a:number,b:number)=>text.replace(trigger,`${result.coin} ${direction} ${usd(a)}: loss grows ${usd(quantity)} per $1 ${match[5]}, reaching ${usd(loss)} at ${usd(b)}`);
    return {...result,error:`At ${usd(quantity)} loss per $1 move, ${usd(start)} to ${usd(end)} implies ${usd(expected)} of loss, not ${usd(loss)}. Which price should stay?`,corrections:[
      ...(correctedEnd>=0?[{value:correction(start,correctedEnd),label:`Keep ${usd(start)} start; reach ${usd(loss)} at ${usd(correctedEnd)}`}]:[]),
      ...(correctedStart>=0?[{value:correction(correctedStart,end),label:`Keep ${usd(end)} endpoint; start at ${usd(correctedStart)}`}]:[]),
    ]};
  }
  return result;
}
