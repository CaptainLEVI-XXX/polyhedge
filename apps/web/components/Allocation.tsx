import type { LadderView } from '@/lib/view-model';

/**
 * Where the premium goes, against what each position pays.
 *
 * Two proportional strips, stacked, **both in price order**. Reading them
 * against each other is the whole point: the premium is wildly lopsided — a
 * large share buys the bracket nearest the strike — while the payout is flat.
 * You are not more exposed near the threshold; you pay more there because the
 * market prices it likelier.
 *
 * Deliberately NOT a treemap. A treemap destroys the price ordering, which is
 * the most important structure this data has — Paradigm's works because their
 * categories are unordered, whereas brackets sit on a number line. And
 * cost-weighted area alone implies concentrated exposure where the exposure is
 * uniform, which is a false reading of a true number. With this many ordered
 * categories a treemap is a bar chart with extra steps.
 */

export function Allocation({ ladder }: { ladder: LadderView }) {
  const positions = ladder.positions;
  if (positions.length === 0) return null;

  const shares = positions.map((p) => p.shares);
  const flatPayout = shares.every((s) => Math.abs(s - (shares[0] ?? 0)) < 1);
  const biggest = positions.reduce((a, b) => (b.premiumShare > a.premiumShare ? b : a));

  return (
    <>
      <div style={{ display: 'flex', width: '100%', border: '1px solid var(--ink)' }}>
        {positions.map((p) => (
          <div
            key={`prem-${p.tokenId}`}
            title={`${p.bracketLabel} — ${p.costLabel}`}
            style={{
              width: `${p.premiumShare * 100}%`,
              minWidth: 2,
              borderRight: '1px solid var(--ink)',
              background: p.side === 'YES' ? 'var(--covered)' : 'var(--action-soft)',
              padding: '10px 4px',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textAlign: 'center',
              fontSize: 11,
            }}
          >
            {p.premiumShare > 0.09 ? `${(p.premiumShare * 100).toFixed(0)}%` : ''}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5, letterSpacing: '0.07em' }}>
        SHARE OF PREMIUM — width is what each position cost
      </div>

      <div style={{ display: 'flex', width: '100%', border: '1px solid var(--ink)', marginTop: 16 }}>
        {positions.map((p) => (
          <div
            key={`pay-${p.tokenId}`}
            style={{
              flex: 1,
              borderRight: '1px solid var(--ink)',
              background: 'var(--covered)',
              padding: '8px 4px',
              textAlign: 'center',
              fontSize: 11,
            }}
          >
            {Math.round(p.shares).toLocaleString('en-US')}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5, letterSpacing: '0.07em' }}>
        SHARES HELD — what each one pays if it comes true
      </div>

      <p style={{ marginTop: 16, marginBottom: 0, fontSize: 12.5, lineHeight: 1.65, color: 'var(--ink-2)' }}>
        {flatPayout ? (
          <>
            <strong style={{ color: 'var(--ink)' }}>Read those two against each other.</strong>{' '}
            The premium is lopsided — {(biggest.premiumShare * 100).toFixed(0)}% of it buys{' '}
            {biggest.bracketLabel} alone — while the payout is flat. You are not more exposed there
            than anywhere else below your threshold. You pay more because the market prices it
            likelier, and likelihood is the only thing that differs.
          </>
        ) : (
          <>
            The premium and the shares held both vary across positions, so the cost of each is not a
            reading of how exposed you are there.
          </>
        )}
      </p>

      <p style={{ marginTop: 12, marginBottom: 0, fontSize: 12.5, lineHeight: 1.65 }}>
        {ladder.exclusivity === 'exactly_one' ? (
          <>
            <strong>Exactly one of these can pay.</strong> They are mutually exclusive outcomes of
            one question, so the price settles in exactly one range and that position pays a dollar
            a share while the rest expire at zero. That is why the premium is far smaller than the
            payout.
          </>
        ) : (
          <>
            <strong>More than one of these can pay at once.</strong> This basket holds NO positions,
            and a NO pays whenever its range is <em>not</em> where the price settles — so several
            of them come true together.
          </>
        )}
      </p>
    </>
  );
}
