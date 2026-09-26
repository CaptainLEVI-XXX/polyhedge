'use client';
import type { PricePoint } from '@/lib/basket-tracking';
export function MiniMovement({points,label,description}:{points:PricePoint[];label:string;description?:string}) {
  const first=points[0],last=points.at(-1);
  const values=points.flatMap(p=>p.cost===null?[]:[p.cost]);
  const min=Math.min(...values),max=Math.max(...values),pad=Math.max((max-min)*.15,(first?.cost??0)*.005,.00001);
  const elapsed=Math.max(1,(last?.at??0)-(first?.at??0));
  const x=(p:PricePoint)=>2+196*(p.at-(first?.at??0))/elapsed;
  const y=(p:PricePoint)=>34-30*(p.cost!-min+pad)/(max-min+2*pad);
  let start=true;
  const path=points.map(p=>{if(p.cost===null){start=true;return '';}const part=`${start?'M':'L'}${x(p)},${y(p)}`;start=false;return part;}).join(' ');
  const change=first?.cost&&last?.cost!=null?(last.cost-first.cost)/first.cost*100:null;
  const unchanged=change!==null&&Math.abs(change)<.005;
  return <div className="mini-movement" title={description??`${label}. Basket prices use validated quotes; market best asks use live book updates. Gaps mean unavailable prices.`}>
    <svg viewBox="0 0 200 38" preserveAspectRatio="none" aria-hidden><path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>{last?.cost!=null&&<circle cx={x(last)} cy={y(last)} r="2" fill="currentColor"/>}</svg>
    <span>{change===null?'—':`${unchanged?'—':change>0?'▲':'▼'} ${Math.abs(change).toFixed(2)}%`}<small>{label}</small></span>
  </div>;
}
