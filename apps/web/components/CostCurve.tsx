'use client';
import { useState } from 'react';
import { basketMetrics, money } from '@/lib/basket-metrics';
import type { CoverOptionView, CurvePoint } from '@/lib/view-model';

/**
 * What each extra dollar of premium buys: the cheapest hedge at every level of
 * protection, from no hedge (top left) to the most the books allow. Steep means
 * a little premium removes a lot of risk; flat means more premium barely helps.
 */
const W = 860;
const H = 240;
const PAD = { top: 16, right: 20, bottom: 30, left: 60 };

const short = (usd: number) => usd >= 1000 ? `$${(usd / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : `$${Math.round(usd)}`;

export function CostCurve({ points, options, budgetUsd, loading, refreshing, refreshFailed }: { points: CurvePoint[]; options: CoverOptionView[]; budgetUsd: number | undefined; loading: boolean; refreshing: boolean; refreshFailed: boolean }) {
  const [over, setOver] = useState<number | null>(null);
  if (points.length < 2) {
    return <section className="cost-curve"><h3>What more spending buys</h3>
      <p className="comparison-caption">{loading ? 'Working out the trade-off…' : points.length===0?'The cost/protection curve is unavailable. Your basket quotes remain available.':'No further reduction was found in the sampled quotes.'}</p></section>;
  }

  const marked = options.map(o => ({ name: o.name === 'Lowest loss without a budget cap' ? 'Lowest loss' : o.name, costUsd: o.costUsd, worstLossUsd: basketMetrics(o).netLoss }));
  const xMax = Math.max(...points.map(p => p.costUsd), ...marked.map(m => m.costUsd)) * 1.04 || 1;
  const yMax = Math.max(...points.map(p => p.worstLossUsd), ...marked.map(m => m.worstLossUsd)) * 1.05 || 1;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  // Square-root price axis: the cheap end is where the decision is, and a linear
  // axis crushes it against the left edge.
  const X = (usd: number) => PAD.left + Math.sqrt(Math.max(0, usd) / xMax) * iw;
  const Y = (usd: number) => PAD.top + ih - (usd / yMax) * ih;
  const read = over === null ? undefined : points[over];
  const first = points[0]!;
  const last = points.at(-1)!;
  const axis = { fontSize: 11.5, fill: 'var(--faint)', style: { fontFamily: 'var(--mono)' } };
  // Each label takes the first free spot near its dot, alternating above and
  // below, clear of every dot, other labels, the axis title and the budget label.
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [{ x0: PAD.left, x1: PAD.left + 110, y0: PAD.top - 10, y1: PAD.top + 8 }];
  if (budgetUsd !== undefined) boxes.push({ x0: X(budgetUsd), x1: X(budgetUsd) + 60, y0: PAD.top - 2, y1: PAD.top + 14 });
  for (const m of marked) boxes.push({ x0: X(m.costUsd) - 8, x1: X(m.costUsd) + 8, y0: Y(m.worstLossUsd) - 8, y1: Y(m.worstLossUsd) + 8 });
  const free = (b: (typeof boxes)[number]) => b.y0 >= PAD.top - 12 && b.y1 <= Y(0) - 4
    && !boxes.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  const labels = [...marked].sort((a, b) => a.costUsd - b.costUsd).map(m => {
    const x = X(m.costUsd), y = Y(m.worstLossUsd), width = m.name.length * 7;
    const right = x + 10 + width < W - PAD.right;
    const x0 = right ? x + 10 : x - 10 - width;
    const offsets = [-10, 22, -26, 38, -42, 54, -58, 70];
    const ly = offsets.map(o => y + o).find(ly => free({ x0, x1: x0 + width, y0: ly - 12, y1: ly + 4 })) ?? y - 10;
    boxes.push({ x0, x1: x0 + width, y0: ly - 12, y1: ly + 4 });
    return { ...m, x, y, lx: right ? x + 10 : x - 10, ly, anchor: right ? 'start' as const : 'end' as const };
  });

  return <section className="cost-curve">
    <h3>What more spending buys</h3>
    <p className="comparison-caption" style={{ minHeight: '1.5em' }}>{refreshFailed ? 'Refresh unavailable · showing the last complete comparison.' : refreshing ? 'Updating · showing the last complete comparison.' : 'Curve and basket markers use the same market snapshot.'}</p>
    <div className="plot" onPointerLeave={() => setOver(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={`With no hedge the worst case is ${money(first.worstLossUsd)}. Paying ${money(last.costUsd)} brings it down to ${money(last.worstLossUsd)}.`}>
        <line x1={PAD.left} x2={W - PAD.right} y1={Y(0)} y2={Y(0)} stroke="var(--rule-strong)" />
        <text x={PAD.left - 8} y={Y(first.worstLossUsd) + 4} textAnchor="end" {...axis}>{short(first.worstLossUsd)}</text>
        <text x={PAD.left - 8} y={Y(0) + 4} textAnchor="end" {...axis}>$0</text>
        <text x={PAD.left} y={H - 8} {...axis}>$0</text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" {...axis}>{short(xMax)}</text>
        <text x={(PAD.left + W - PAD.right) / 2} y={H - 8} textAnchor="middle" fontSize="12" fill="var(--muted)">you pay →</text>
        <text x={PAD.left + 8} y={PAD.top + 4} fontSize="12" fill="var(--muted)">↓ worst case</text>

        {budgetUsd !== undefined && budgetUsd < xMax && <g>
          <line x1={X(budgetUsd)} x2={X(budgetUsd)} y1={PAD.top} y2={Y(0)} stroke="var(--warn-ink)" strokeDasharray="3 4" />
          <text x={X(budgetUsd) + 5} y={PAD.top + 10} fontSize="11.5" fill="var(--warn-ink)">budget</text>
        </g>}

        <path d={points.map((p, i) => `${i ? 'L' : 'M'}${X(p.costUsd)},${Y(p.worstLossUsd)}`).join(' ')} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />

        {labels.map(m => <g key={m.name} pointerEvents="none">
          <circle cx={m.x} cy={m.y} r="6" fill="var(--action)" stroke="var(--paper)" strokeWidth="2" />
          <text x={m.lx} y={m.ly} textAnchor={m.anchor} fontSize="12.5" fill="var(--action)"
            stroke="var(--paper)" strokeWidth="4" paintOrder="stroke">{m.name}</text>
        </g>)}

        {points.map((p, i) => <circle key={i} cx={X(p.costUsd)} cy={Y(p.worstLossUsd)} r={over === i ? 5 : 12}
          fill={over === i ? 'var(--ink)' : 'transparent'} tabIndex={0}
          aria-label={`Pay ${money(p.costUsd)}: worst case ${money(p.worstLossUsd)}`}
          onPointerEnter={() => setOver(i)} onFocus={() => setOver(i)} onBlur={() => setOver(null)} />)}
      </svg>
      {read && <div className="plot-read" style={{ left: `${(X(read.costUsd) / W) * 100}%`, top: `${(Y(read.worstLossUsd) / H) * 100}%` }}>
        <span className="r"><span>You pay</span><b>{money(read.costUsd)}</b></span>
        <span className="r"><span>Worst case</span><b>{money(read.worstLossUsd)}</b></span>
        {read.trueCostUsd !== null && <span className="r keep"><span>Market-implied net cost</span><b>{money(read.trueCostUsd)}</b></span>}
      </div>}
    </div>
    <p className="comparison-caption">Points are minimum-cost solves at sampled loss limits; the connecting line is illustrative. Market-implied net cost uses estimated probabilities, not guaranteed payouts.</p>
  </section>;
}
