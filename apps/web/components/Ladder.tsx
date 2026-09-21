import type { LadderView } from '@/lib/view-model';

/**
 * One object replacing three panels.
 *
 * It draws what the basket pays at every settlement price, over what is owed,
 * with the gap between them filled. The residual stops being a percentage to
 * interpret and becomes visible area.
 *
 * It draws PAYOUT ROWS, not brackets. When the threshold falls inside a traded
 * bracket the compiler subdivides it, so evaluation states outnumber brackets —
 * and that is the common case, since people say "below 77,000" far more often
 * than they name a number the venue happens to split on. Drawing per bracket
 * would be wrong exactly where it matters most.
 */

const W = 1140;
const H = 230;
const PAD = { top: 26, right: 16, bottom: 46, left: 18 };

function niceLevel(value: number, unit: string): string {
  const abs = Math.abs(value);
  const short = abs >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value * 10) / 10);
  return unit === '' || unit === '$' ? short : `${short}${unit}`;
}

export function Ladder({ ladder }: { ladder: LadderView }) {
  const rows = ladder.payout;
  if (rows.length === 0) return null;

  const finite = rows.flatMap((r) => [r.lo, r.hi]).filter((v): v is number => v !== null);
  if (finite.length === 0) return null;

  // Open-ended outer states are clamped to the plot edge rather than running
  // off it — they are unbounded in the data, not on the page.
  const span = Math.max(...finite) - Math.min(...finite) || 1;
  const pad = span * 0.09;
  const xMin = Math.min(...finite) - pad;
  const xMax = Math.max(...finite) + pad;

  const maxUsd = Math.max(...rows.map((r) => Math.max(r.owedUsd, r.paidUsd)), 1);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const X = (v: number | null, fallback: number) =>
    PAD.left + ((( v ?? fallback) - xMin) / (xMax - xMin)) * iw;
  const Y = (usd: number) => PAD.top + ih - (usd / maxUsd) * ih;

  const totalOwed = rows.reduce((sum, r) => sum + r.owedUsd, 0);
  const totalPaid = rows.reduce((sum, r) => sum + Math.min(r.paidUsd, r.owedUsd), 0);
  const worst = rows.reduce((w, r) => Math.max(w, r.owedUsd - r.paidUsd), 0);

  const alt =
    `Pays across ${rows.length} price ranges. ` +
    `${Math.floor((totalOwed === 0 ? 1 : totalPaid / totalOwed) * 100)}% of what is owed is covered, ` +
    `and the worst uncovered amount in any single range is $${Math.ceil(worst).toLocaleString('en-US')}.`;

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={alt}>
        <defs>
          {/* Hatching, not just red: colour is never the only signal, and a
              hatch reads as absence, which is what a shortfall is. */}
          <pattern id="shortfall" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="7" height="7" fill="var(--short-bg)" />
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--short)" strokeWidth="2" />
          </pattern>
        </defs>

        {rows.map((r, i) => {
          const a = X(r.lo, xMin);
          const b = X(r.hi, xMax);
          const width = Math.max(0, b - a);
          const owedTop = Y(r.owedUsd);
          const paidTop = Y(r.paidUsd);
          const base = PAD.top + ih;
          return (
            <g key={i}>
              {/* what is owed but not paid */}
              {r.owedUsd > r.paidUsd && (
                <rect x={a} y={owedTop} width={width} height={paidTop - owedTop} fill="url(#shortfall)" />
              )}
              {/* what is paid */}
              {r.paidUsd > 0 && (
                <rect
                  x={a}
                  y={paidTop}
                  width={width}
                  height={base - paidTop}
                  fill="var(--covered)"
                  stroke="var(--ink)"
                  strokeWidth="1"
                />
              )}
              {/* paid where nothing is owed */}
              {r.beyondOwed && r.owedUsd === 0 && (
                <rect x={a} y={paidTop} width={width} height={base - paidTop} fill="var(--action-soft)" stroke="var(--action)" strokeWidth="1" />
              )}
              {/* what is owed, as an outline, so the target is always legible */}
              {r.owedUsd > 0 && (
                <line x1={a} y1={owedTop} x2={b} y2={owedTop} stroke="var(--muted)" strokeWidth="1.4" strokeDasharray="5 4" />
              )}
            </g>
          );
        })}

        <line x1={PAD.left} y1={PAD.top + ih} x2={W - PAD.right} y2={PAD.top + ih} stroke="var(--ink)" />

        {ladder.thresholds.map((t) => (
          <g key={t}>
            <line x1={X(t, xMin)} y1={PAD.top - 12} x2={X(t, xMin)} y2={PAD.top + ih + 6} stroke="var(--ink)" strokeWidth="2" />
            <text x={X(t, xMin) + 6} y={PAD.top - 15} style={{ font: '600 11px var(--mono)', fill: 'var(--ink)' }}>
              {niceLevel(t, ladder.unit)} — your loss starts here
            </text>
          </g>
        ))}

        {[xMin + pad, (xMin + xMax) / 2, xMax - pad].map((v, i) => (
          <text key={i} x={X(v, v)} y={H - 26} textAnchor="middle" style={{ font: '400 10px var(--mono)', fill: 'var(--muted)' }}>
            {niceLevel(v, ladder.unit)}
          </text>
        ))}
      </svg>

      <div style={{ display: 'flex', gap: 20, marginTop: 8, fontSize: 11.5, color: 'var(--ink-2)', flexWrap: 'wrap' }}>
        <Key swatch={<rect width="14" height="10" fill="var(--covered)" stroke="var(--ink)" />}>what this pays</Key>
        <Key swatch={<rect width="14" height="10" fill="url(#shortfall)" />}>not covered</Key>
        <Key swatch={<line x1="0" y1="5" x2="16" y2="5" stroke="var(--muted)" strokeWidth="1.4" strokeDasharray="5 4" />}>
          what you asked for
        </Key>
        <Key swatch={<rect width="14" height="10" fill="var(--action-soft)" stroke="var(--action)" />}>paid, nothing owed</Key>
      </div>
    </>
  );
}

function Key({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <svg width="16" height="10" aria-hidden="true">
        <defs>
          <pattern id="shortfall-key" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="7" height="7" fill="var(--short-bg)" />
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--short)" strokeWidth="2" />
          </pattern>
        </defs>
        {swatch}
      </svg>
      {children}
    </span>
  );
}
