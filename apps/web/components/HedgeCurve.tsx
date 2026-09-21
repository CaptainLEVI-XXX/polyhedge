import type { CoverOptionView } from '@/lib/view-model';

/**
 * What the hedge actually does to your money.
 *
 * Everything else on this page describes the BASKET — what it pays, what it
 * cost, which brackets it holds. None of that answers the question somebody
 * buying protection is actually asking, which is "what am I left with". So this
 * draws three lines over the settlement price:
 *
 *   • **Unhedged** — the loss as described, with no basket at all.
 *   • **Hedged** — that loss, plus what the basket pays, minus the premium.
 *   • **Zero** — break-even, so the two can be read against something.
 *
 * The premium is subtracted at every price, including the prices where the
 * hedge pays nothing. That is what makes the picture honest: a hedge is not
 * free, and a chart that showed only the payout would make it look like one.
 * The hedged line therefore sits BELOW zero on the right-hand side by exactly
 * the premium, and that dip is the true cost of the protection.
 *
 * Where the hedged line rises above zero, the basket pays more than the
 * exposure lost — real money, but money spent on cover that was not needed.
 * It is drawn in the same green as cover rather than flattered, because it is
 * the flip side of the same choice.
 */

const W = 1140;
const H = 300;
const PAD = { top: 28, right: 20, bottom: 46, left: 92 };

function money(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function level(value: number, unit: string): string {
  const abs = Math.abs(value);
  const short = abs >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value * 10) / 10);
  return unit === '' || unit === '$' ? short : `${short}${unit}`;
}

export function HedgeCurve({ option }: { option: CoverOptionView }) {
  const rows = option.ladder.payout;
  if (rows.length === 0) return null;
  if (option.ladder.kind && option.ladder.kind !== 'numeric') return <div style={{overflowX:'auto'}}><table>
    <thead><tr><th>Outcome</th><th>Your stated loss</th><th>Hedge pays</th><th>Loss after premium</th></tr></thead>
    <tbody>{rows.map((r,i)=><tr key={i}><td>{r.label}</td><td>${r.owedUsd.toFixed(2)}</td><td>${r.paidUsd.toFixed(2)}</td><td>${(r.owedUsd+option.costUsd-r.paidUsd).toFixed(2)}</td></tr>)}</tbody>
  </table></div>;

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
  const headroom = range * 0.12;

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

  const alt =
    `Without this basket the worst outcome loses ${money(worstUnhedged)}. ` +
    `With it, and after the ${money(-option.costUsd)} premium, the worst outcome is ${money(worstHedged)}.`;

  // A filled band between the two lines: the area is what the hedge changed.
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

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={alt}>
        {/* What the basket changed. */}
        <path d={band} fill="var(--covered)" opacity={0.55} />

        {/* Break-even, drawn under the lines so neither is obscured. */}
        <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="var(--rule-strong)" />
        <text
          x={PAD.left - 8}
          y={zeroY + 4}
          textAnchor="end"
          fontSize="11"
          fill="var(--muted)"
          fontFamily="var(--mono)"
        >
          break even
        </text>

        <path d={path((s) => s.unhedged)} fill="none" stroke="var(--short-ink)" strokeWidth="1.6" strokeDasharray="5 4" />
        <path d={path((s) => s.hedged)} fill="none" stroke="var(--ink)" strokeWidth="2.2" />

        {/* The worst case with the hedge on, which is the number being bought.
            Haloed in paper rather than boxed: it sits on top of the line it
            describes, and a solid label there would hide the shape. */}
        <text
          x={PAD.left + 8}
          y={Y(worstHedged) - 10}
          fontSize="12.5"
          fill="var(--ink)"
          fontFamily="var(--mono)"
          stroke="var(--paper)"
          strokeWidth="4"
          paintOrder="stroke"
          strokeLinejoin="round"
        >
          {money(worstHedged)} worst case
        </text>

        {rows.map((r, i) => {
          if (r.lo === null) return null;
          const x = X(r.lo, xMin);
          return (
            <g key={i}>
              <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + ih} stroke="var(--rule)" />
              <text x={x} y={H - 24} textAnchor="middle" fontSize="11" fill="var(--muted)" fontFamily="var(--mono)">
                {level(r.lo, option.ladder.unit)}
              </text>
            </g>
          );
        })}

        <text x={PAD.left} y={H - 6} fontSize="11" fill="var(--faint)">
          Settlement price
        </text>
      </svg>

      <div className="legend">
        <span><i className="swatch line dashed" aria-hidden /> without this basket</span>
        <span><i className="swatch line solid" aria-hidden /> with it, after the premium</span>
        <span><i className="swatch fill" aria-hidden /> what the basket changed</span>
      </div>
    </>
  );
}
