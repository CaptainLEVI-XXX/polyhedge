/** Demonstration policy, not a probability forecast or a promise of future performance.
 * All amounts must use the same unit. Evaluate every compiler scenario, not max payout.
 */
export function hedgeQuality(target:readonly number[],payout:readonly number[],cost:number){
  const valid=target.length>0&&target.length===payout.length&&[...target,...payout,cost].every(n=>Number.isFinite(n)&&n>=0);
  const loss=valid?Math.max(...target):0;
  const worst=valid?Math.max(0,...target.map((t,i)=>t+cost-payout[i]!)):Infinity;
  const reduction=loss>0?(loss-worst)/loss:0;
  const minimumCover=loss>0?Math.min(...target.flatMap((t,i)=>t>0?[Math.min(1,payout[i]!/t)]:[])):0;
  const excess=loss>0?Math.max(0,...target.map((t,i)=>payout[i]!-t))/loss:Infinity;
  const gain=loss-worst;
  // Curated examples must materially help after premium, cover loss scenarios,
  // and avoid showcasing large unrelated payouts. User quotes remain available.
  return {reduction,minimumCover,excess,worstLoss:worst,
    eligible:valid&&loss>0&&reduction>=.2&&minimumCover>=.3&&excess<=.2&&gain>=cost*.5};
}
