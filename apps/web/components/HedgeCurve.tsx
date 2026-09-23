'use client';

import { useState } from 'react';
import type { CoverOptionView } from '@/lib/view-model';

/**
 * What the hedge actually does to your money.
 *
 * Everything else on this page describes the BASKET — what it pays, what it
 * cost, which markets it holds. None of that answers the question somebody
 * buying a hedge is actually asking, which is "what am I left with". So this
 * draws the loss against the settlement price, twice:
 *
 *   • **Unhedged** — the loss as described, with no positions at all.
 *   • **Hedged** — that loss, plus what the basket pays, minus what it cost.
 *
 * The cost is subtracted at every price, including the prices where the hedge
 * pays nothing. That is what makes the picture honest: a hedge is not free, and
 * a chart showing only the payout would make it look like one. The hedged line
 * therefore sits below break-even on the safe side by exactly what you paid,
 * and that dip is the true price of the cover.
 *
 * Where the hedged line rises ABOVE break-even, the basket pays more than the
 * exposure lost. Real money, but money spent on cover that was not needed, so
 * it is drawn plainly rather than flattered.
 *
 * Hovering reads one settlement range at a time. The ranges are the venue's own
 * brackets, so every readout names a state Polymarket can actually resolve to —
 * following the pointer along a continuous price would interpolate between
 * brackets and quote a loss for an outcome that cannot happen.
 */

const W = 860;
const H = 300;
const PAD = { top: 30, right: 16, bottom: 44, left: 56 };

const money = (value:number) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.round((value+Number.EPSILON)*100)/100 || 0);
const level = (value:number,unit:string) => `${unit==='$'?'$':''}${value.toLocaleString('en-US',{maximumFractionDigits:8})}${unit&&unit!=='$'?unit:''}`;

export function HedgeCurve({ option }: { option: CoverOptionView }) {
  const [over, setOver] = useState<number | null>(null);
  const rows = option.ladder.payout;

  if (rows.length === 0) return null;

  // A categorical or binary event has named outcomes rather than a price line,
  // so there is no axis to draw one against. The same three numbers, as a table.
  if (option.ladder.kind && option.ladder.kind !== 'numeric') {
    return (
      <div className="scroll-x">
        <table>
          <thead>
            <tr><th>Outcome</th><th className="num">Your loss</th><th className="num">Hedge pays</th><th className="num">Left with</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.label}</td>
                <td className="num">{money(-r.owedUsd)}</td>
                <td className="num">{money(r.paidUsd)}</td>
                <td className="num">{money(r.paidUsd - r.owedUsd - option.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const finite = rows.flatMap((r) => [r.lo, r.hi]).filter((v): v is number => v !== null);
  if (finite.length === 0) return null;

  // The outermost ranges are unbounded in the data, not on the page, so they
  // are clamped to the plot edge rather than running off it.
  const span = Math.max(...finite) - Math.min(...finite) || 1;
  const pad = span * 0.06;
  const xMin = Math.min(...finite) - pad;
  const xMax = Math.max(...finite) + pad;

  const steps = rows.map((r) => ({
    lo: r.lo,
    hi: r.hi,
    unhedged: -r.owedUsd,
    hedged: r.paidUsd - r.owedUsd - option.costUsd,
  }));

  const values = steps.flatMap((s) => [s.unhedged, s.hedged]).concat(0);
  const yMax = Math.max(...values);
  const yMin = Math.min(...values);
  const range = yMax - yMin || 1;
  const headroom = range * 0.14;

  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const X = (v: number | null, fallback: number) =>
    PAD.left + (((v ?? fallback) - xMin) / (xMax - xMin)) * iw;
  const Y = (usd: number) =>
    PAD.top + ih - ((usd - (yMin - headroom)) / (range + headroom * 2)) * ih;

  /** A step path: flat across each range, jumping between them. */
  const path = (pick: (s: (typeof steps)[number]) => number): string =>
    steps
      .map((s, i) => {
        const x0 = X(s.lo, xMin);
        const x1 = X(s.hi, xMax);
        const y = Y(pick(s));
        return `${i === 0 ? `M${x0},${y}` : `L${x0},${y}`} L${x1},${y}`;
      })
      .join(' ');

  const zeroY = Y(0);
  const worstHedged = Math.min(...steps.map((s) => s.hedged));
  const worstUnhedged = Math.min(...steps.map((s) => s.unhedged));
  const worstIndex = steps.findIndex((s) => s.hedged === worstHedged);

  const alt =
    `Without this hedge the worst outcome loses ${money(worstUnhedged)}. ` +
    `With it, and after the ${money(-option.costUsd)} it cost, the worst outcome is ${money(worstHedged)}.`;

  const band =
    steps.map((s, i) => {
      const x0 = X(s.lo, xMin);
      const x1 = X(s.hi, xMax);
      return `${i === 0 ? `M${x0},${Y(s.hedged)}` : `L${x0},${Y(s.hedged)}`} L${x1},${Y(s.hedged)}`;
    }).join(' ') +
    ' ' +
    [...steps].reverse().map((s) => {
      const x0 = X(s.lo, xMin);
      const x1 = X(s.hi, xMax);
      return `L${x1},${Y(s.unhedged)} L${x0},${Y(s.unhedged)}`;
    }).join(' ') +
    ' Z';

  const read = over === null ? undefined : rows[over];
  const readStep = over === null ? undefined : steps[over];

  return (
    <>
      {option.conservativeWithinRange&&<p className="note">Each range shows its maximum target loss, not an exact loss at every price inside it.</p>}
      <div className="plot" onPointerLeave={() => setOver(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={alt}>
          <path d={band} fill="var(--covered)" opacity={0.55} />

          <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="var(--rule-strong)" />
          {/* Above the line, at the right edge: the left gutter is the y-axis's
              and a label parked there collided with the worst-case callout. */}
          <text x={W - PAD.right} y={zeroY - 7} textAnchor="end" fontSize="12" fill="var(--muted)">
            break even
          </text>

          <path d={path((s) => s.unhedged)} fill="none" stroke="var(--short-ink)" strokeWidth="1.6" strokeDasharray="5 4" />
          <path d={path((s) => s.hedged)} fill="none" stroke="var(--ink)" strokeWidth="2.2" />

          {/* The worst case with the hedge on: the number being bought. Placed
              over its own range rather than at a fixed x, so it points at the
              outcome it describes. */}
          {steps[worstIndex] !== undefined && (
            <text
              x={Math.min(W - PAD.right - 4, X(steps[worstIndex].lo, xMin) + 8)}
              y={Y(worstHedged) - 12}
              fontSize="13"
              fill="var(--ink)"
              stroke="var(--paper)"
              strokeWidth="4"
              paintOrder="stroke"
              strokeLinejoin="round"
              style={{ fontFamily: 'var(--mono)' }}
            >
              {money(worstHedged)} worst case
            </text>
          )}

          {rows.map((r, i) => {
            if (r.lo === null) return null;
            const x = X(r.lo, xMin);
            return (
              <g key={i}>
                <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + ih} stroke="var(--rule)" />
                <text x={x} y={H - 22} textAnchor="middle" fontSize="12" fill="var(--muted)" style={{ fontFamily: 'var(--mono)' }}>
                  {level(r.lo, option.ladder.unit)}
                </text>
              </g>
            );
          })}

          <text x={PAD.left} y={H - 4} fontSize="11.5" fill="var(--faint)">
            Settlement value
          </text>

          {/* One target per venue bracket. */}
          {steps.map((s, i) => {
            const x0 = X(s.lo, xMin);
            const x1 = X(s.hi, xMax);
            return (
              <rect
                key={`hit-${i}`}
                x={x0}
                y={PAD.top}
                width={Math.max(1, x1 - x0)}
                height={ih}
                fill={over === i ? 'var(--ink)' : 'transparent'}
                opacity={over === i ? 0.05 : 1}
                onPointerEnter={() => setOver(i)}
                onFocus={() => setOver(i)}
                onBlur={() => setOver(null)}
                tabIndex={0}
                aria-label={`${rows[i]!.label}: loss ${money(-rows[i]!.owedUsd)}, payout ${money(rows[i]!.paidUsd)}, net ${money(steps[i]!.hedged)}`}
                style={{ cursor: 'crosshair' }}
              />
            );
          })}
        </svg>

        {read !== undefined && readStep !== undefined && (
          <div
            className="plot-read"
            style={{
              left: `${((X(readStep.lo, xMin) + X(readStep.hi, xMax)) / 2 / W) * 100}%`,
              top: `${(Y(Math.max(readStep.hedged, readStep.unhedged)) / H) * 100}%`,
            }}
          >
            <span className="t">{read.label}</span>
            <span className="r"><span>{option.conservativeWithinRange?'Max loss in range':'Target loss'}</span><b>{money(-read.owedUsd)}</b></span>
            <span className="r"><span>Hedge pays</span><b>{money(read.paidUsd)}</b></span>
            <span className="r keep"><span>Left with</span><b>{money(readStep.hedged)}</b></span>
          </div>
        )}
      </div>

      <div className="legend">
        <span><i className="swatch line dashed" aria-hidden /> without the hedge</span>
        <span><i className="swatch line solid" aria-hidden /> with it, after what it cost</span>
        <span><i className="swatch fill" aria-hidden /> what the hedge changed</span>
        <span className="legend-hint">Hover a range</span>
      </div>
    </>
  );
}
