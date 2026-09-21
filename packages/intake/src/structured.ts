import type { QuoteRequest } from '@polyhedge/engine';
import type { EventSelection } from '@polyhedge/venue';
import type { TargetShape } from '@polyhedge/core';

export function structuredRequest(input: unknown): QuoteRequest {
  const fail = (): never => { throw new Error('bad_request: select a market and supply valid losses and limits'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const b = input as Record<string,unknown>;
  const number = (v:unknown, min=0, max=1e9):number => typeof v==='number' && Number.isFinite(v) && v>=min && v<=max ? v : fail();
  if (typeof b.eventId!=='string' || !/^\d+$/.test(b.eventId) || typeof b.ruleHash!=='string' || !/^[a-f0-9]{64}$/.test(b.ruleHash)) return fail();
  const kind=b.kind;
  if (kind!=='numeric' && kind!=='binary' && kind!=='categorical') return fail();
  if (kind==='binary' && (typeof b.marketId!=='string' || !/^\d+$/.test(b.marketId))) return fail();
  const selection:EventSelection={kind,...(kind==='binary'?{marketId:b.marketId as string}:{})};
  let shape:TargetShape;
  if (kind!=='numeric') {
    if (!Array.isArray(b.losses) || b.losses.length<2 || b.losses.length>32) return fail();
    const losses=b.losses.map((raw:unknown) => {
      if (!raw || typeof raw!=='object') return fail();
      const r=raw as Record<string,unknown>;
      if (typeof r.outcomeId!=='string' || r.outcomeId.length>160) return fail();
      const lossCents=number(r.lossCents,0,1e11);
      if (!Number.isSafeInteger(lossCents)) return fail();
      return {outcomeId:r.outcomeId,lossCents};
    });
    if (new Set(losses.map(l=>l.outcomeId)).size!==losses.length || !losses.some(l=>l.lossCents>0)) return fail();
    shape={templateId:'outcome_losses',losses};
  } else {
    if (!b.shape || typeof b.shape!=='object') return fail();
    const s=b.shape as Record<string,unknown>;
    const payoutUsd=number(s.payoutUsd,0.01);
    if (s.templateId==='threshold_digital' || s.templateId==='linear_strip') {
      if (s.direction!=='below' && s.direction!=='above') return fail();
      if (s.templateId==='threshold_digital') shape={templateId:s.templateId,payoutUsd,direction:s.direction,k:number(s.k,-1e9)};
      else {
        const k1=number(s.k1,-1e9),k2=number(s.k2,-1e9); if(k1>=k2)return fail();
        shape={templateId:s.templateId,payoutUsd,direction:s.direction,k1,k2};
      }
    } else if(s.templateId==='range_protect') {
      const low=number(s.low,-1e9),high=number(s.high,-1e9);if(low>=high)return fail();
      shape={templateId:s.templateId,payoutUsd,low,high};
    } else return fail();
  }
  const maxLegs=b.maxLegs===undefined?undefined:number(b.maxLegs,1,30);
  if(maxLegs!==undefined&&!Number.isInteger(maxLegs))return fail();
  return {eventId:b.eventId,selection,ruleHash:b.ruleHash,shape,
    ...(b.budgetUsd===undefined?{}:{budgetUsd:number(b.budgetUsd)}),
    execution:{quantityStep:0.01,...(maxLegs===undefined?{}:{maxLegs})},
    protectionGoal:b.maxNetLossUsd===undefined?{kind:'minimize_net_loss'}:{kind:'limit_net_loss',maxNetLossUsd:number(b.maxNetLossUsd)}};
}
