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
  for(const [key,value] of Object.entries(values))setField(draft,key,String(value));
  return draft;
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
