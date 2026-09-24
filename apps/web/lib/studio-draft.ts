import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { QuoteOptions, QuoteRequest } from '@polyhedge/engine';
import type { IntakeSession, TypedExposure } from '@polyhedge/intake';
import type { EventSelection, EventSupport } from '@polyhedge/venue';
import { isAmountField, type BriefField, type StudioReply, type StudioChoice } from './studio-types.js';

export interface StudioDraft {
  version: 1; expires: number; description: string; fields: BriefField[];
  request?: QuoteRequest; options?: QuoteOptions; assumptions: string[];
  holdingInterpretation?: { candidates: { quantity:number; coin:string }[]; selected?: { quantity:number; coin:string } };
  unavailable?: string;
  exampleQualityRequired?: boolean;
  numericDate?: {requested:string;observed:string};
  numeric?: IntakeSession; known?: Partial<TypedExposure>;
  event?: { id: string; selection: EventSelection; support: EventSupport };
  matches?: { id: string; title: string; selection: EventSelection }[];
  pending?: { key: string; text: string; choices?: StudioChoice[] };
}
const host = globalThis as typeof globalThis & { studioSigningKey?: Buffer };
const key = host.studioSigningKey ??= randomBytes(32);
export function sealDraft(draft: StudioDraft) {
  const encoded = Buffer.from(JSON.stringify(draft)).toString('base64url');
  return encoded + '.' + createHmac('sha256', key).update(encoded).digest('base64url');
}
export function readDraft(token: unknown): StudioDraft {
  if (typeof token !== 'string' || token.length > 120_000) throw new Error('bad_request: invalid brief');
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) throw new Error('bad_request: invalid brief');
  const expected = createHmac('sha256', key).update(body).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('bad_request: expired brief; start over');
  const draft = JSON.parse(Buffer.from(body, 'base64url').toString()) as StudioDraft;
  if (draft.version !== 1 || draft.expires < Date.now()) throw new Error('bad_request: expired brief; start over');
  return draft;
}
const labels: Record<string,string> = { exposure:'Exposure', trigger:'Loss trigger', deadline:'Protection date', lossUsd:'Potential loss ($)', coverageUsd:'Cover target ($)', budgetUsd:'Spending budget ($)' };
export function newDraft(description: string): StudioDraft {
  return { version:1, expires:Date.now()+2*60*60*1000, description, assumptions:[], fields:Object.entries(labels).map(([key,label])=>({key,label,value:'',status:'missing'})) };
}
export function setField(draft:StudioDraft,key:string,value:string,status:BriefField['status']='stated',label?:string) {
  const existing=draft.fields.find(f=>f.key===key);
  if (existing) Object.assign(existing,{value,status});
  else draft.fields.push({key,label:label??key,value,status});
}
export const field = (d:StudioDraft,key:string) => d.fields.find(f=>f.key===key)?.value ?? '';
export function amount(text:string):number|null {
  const cleaned=text.trim().replace(/^(?:about|around|up to)\s+/i,'').replace(/[.!?]$/,'').trim();
  const match=/^\$?(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*([km])?\s*(?:dollars?|USD)?$/i.exec(cleaned);
  if(!match)return null;
  const value=Number(match[1]!.replace(/,/g,''))*(match[2]?.toLowerCase()==='k'?1000:match[2]?.toLowerCase()==='m'?1e6:1);
  return Number.isFinite(value)&&value<=1e9?value:null;
}
function pendingAmount(d:StudioDraft) {
  const cover=d.fields.find(f=>f.key==='coverageUsd');
  const budget=d.fields.find(f=>f.key==='budgetUsd');
  if(cover?.status==='missing')return {key:'coverageUsd',text:'How much of your potential loss do you want to protect?',choices:[{value:'full',label:'The full loss'}]};
  if(budget?.status==='missing')return {key:'budgetUsd',text:'What is the most you want to spend on protection?',choices:[{value:'no cap',label:'Compare costs without a spending cap'}]};
  const loss=amount(field(d,'lossUsd')),target=amount(field(d,'coverageUsd'));
  if(loss!==null&&target!==null&&target>loss)return {key:'coverageUsd',text:`Your $${target.toLocaleString('en-US')} cover target exceeds your $${loss.toLocaleString('en-US')} potential loss. Reduce the cover target, or edit the potential loss if that amount is incorrect.`,choices:[{value:'full',label:'The full loss'}]};
  const inferred=d.fields.find(f=>f.status==='inferred');
  if(inferred)return {key:inferred.key,text:`Please confirm ${inferred.label.toLowerCase()}: ${inferred.value}.`,choices:[{value:inferred.value,label:`Use ${inferred.value}`} ]};
  return undefined;
}
export function reply(d:StudioDraft,message='Here is what I understood. Edit any detail before pricing.'):StudioReply {
  if(!d.pending&&d.numericDate)d.pending={key:'numericDate',text:`The closest matched market observes on ${d.numericDate.observed}, before your requested ceiling ${d.numericDate.requested}. It does not cover price changes after its observation. Do you accept this earlier observation?`,choices:[{value:'confirm',label:'Use this earlier observation'},{value:'change',label:'Change my date or exposure'}]};
  if(!d.pending && d.request){const pending=pendingAmount(d);if(pending)d.pending=pending;}
  const ready=!!d.request&&!d.pending&&d.fields.every(f=>f.status==='stated');
  return {kind:'brief',session:sealDraft(d),description:d.description,brief:d.fields.map(f=>({...f,readOnly:(d.event?.selection.kind!=='numeric'&&!!d.event&&['trigger','lossUsd'].includes(f.key))})),message,ready,collectAmounts:!d.unavailable&&!d.numeric&&(!d.pending||isAmountField(d.pending.key))&&!!(d.request||d.event),...(d.unavailable?{unavailable:d.unavailable}:{}),...(d.pending?.key==='eventRules'?{rules:[...new Set(d.event?.support.rules.map(r=>r.description)??[])]}:{}),...(d.pending?{question:d.pending}:{})};
}
/** The original loss stays in the brief; partial cover changes only its explicit target. */
export function quoteFromDraft(d:StudioDraft):QuoteRequest {
  if(!d.request||d.fields.some(f=>f.status!=='stated')||d.pending||d.numericDate)throw new Error('bad_request: complete and confirm the brief first');
  const loss=amount(field(d,'lossUsd')),cover=amount(field(d,'coverageUsd'));
  const budget=field(d,'budgetUsd')==='no cap'?undefined:amount(field(d,'budgetUsd'));
  if(loss===null||cover===null||loss<=0||cover<=0||cover>loss||budget===null||budget===0)throw new Error('bad_request: check the loss, cover target and spending budget');
  const request=structuredClone(d.request);
  // Use 90% of each displayed ask level, retaining a 10% liquidity buffer.
  request.planningDepth=0.9;
  request.selectionPolicy='premium';
  if('payoutUsd' in request.shape)request.shape.payoutUsd=cover;
  else request.shape.losses=request.shape.losses.map(l=>({...l,lossCents:Math.min(l.lossCents,Math.round(cover*100))}));
  if(budget===undefined)delete request.budgetUsd;else request.budgetUsd=budget;
  request.observationNote=[d.request.observationNote,`Exposure: ${field(d,'exposure')}. Potential maximum loss: $${loss}. Requested maximum target: $${cover}. The coverage and remaining-loss figures measure this target; up to $${loss-cover} of the stated loss is outside the target.`,...d.assumptions].filter(Boolean).join('\n');
  return request;
}
