'use client';
import { useId } from 'react';
import type { PricePoint } from '@/lib/basket-tracking';
import { money } from '@/lib/basket-metrics';
import { LiveNumber } from './LiveNumber';

export function BasketMovement({points}:{points:PricePoint[]}){
  const id=useId();
  const first=points[0],last=points[points.length-1];
  const valid=points.filter((p):p is PricePoint&{cost:number}=>p.cost!==null);
  const baseline=first?.cost;
  const delta=baseline!=null&&baseline>0&&last?.cost!=null?(last.cost-baseline)/baseline*100:null;
  const values=valid.map(p=>p.cost);
  const low=Math.min(...values),high=Math.max(...values);
  // At least a 1% vertical range: sub-cent ticks must not look like a crash.
  const padding=Math.max((high-low)*.15,(baseline??0)*.005,.01);
  const bottom=low-padding,range=high-low+2*padding;
  const elapsed=Math.max(1,(last?.at??0)-(first?.at??0));
  const x=(p:PricePoint)=>((p.at-(first?.at??p.at))/elapsed)*1000;
  const y=(p:PricePoint)=>120-((p.cost!-bottom)/range)*100;
  const segments:PricePoint[][]=[];
  for(const point of points){if(point.cost===null){segments.push([]);continue;}if(!segments.length)segments.push([]);segments[segments.length-1]!.push(point);}
  const flat=delta!==null&&Math.abs(delta)<.005;
  return <>
    {valid.length>0&&<svg className="basket-background" viewBox="0 0 1000 140" preserveAspectRatio="none" aria-hidden>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#315bff" stopOpacity=".16"/><stop offset="100%" stopColor="#315bff" stopOpacity=".015"/></linearGradient></defs>
      {segments.filter(s=>s.length>0).map((segment,i)=>{const line=segment.map((p,j)=>`${j?'L':'M'}${x(p)},${y(p)}`).join(' ');return <g key={i}><path d={`${line} L${x(segment[segment.length-1]!)},140 L${x(segment[0]!)},140 Z`} fill={`url(#${id})`}/><path d={line} fill="none" stroke="#315bff" strokeOpacity=".3" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/></g>;})}
    </svg>}
    <div className="basket-movement">
      <span className="movement-percent">{delta===null?'—':<><span aria-hidden>{flat?'—':delta>0?'▲':'▼'} </span><LiveNumber text={`${Math.abs(delta).toFixed(2)}%`}/><span className="sr-only">{flat?' unchanged':delta>0?' increase':' decrease'}</span></>}</span>
      <span>Original basket price · since created</span>
      <span className="movement-price">{last?.cost==null?'Price unavailable · insufficient book data or depth':`Same original quantities would now cost ${money(last.cost)}`}</span>
    </div>
  </>;
}
