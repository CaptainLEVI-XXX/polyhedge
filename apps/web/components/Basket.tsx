'use client';

import { useEffect, useState } from 'react';
import { Ladder } from './Ladder';
import { HedgeCurve } from './HedgeCurve';
import { Disclosure } from './Disclosure';
import { Allocation } from './Allocation';
import { RawData } from './RawData';
import { Sparkline } from './Sparkline';
import { useSession } from './Session';
import { useLiveQuote } from '@/lib/use-live-quote';
import { readiness } from '@/lib/wallet-readiness';
import type { QuotedView } from '@/lib/view-model';

/**
 * One basket, in full.
 *
 * Everything here was previously on the same screen as the choice between
 * baskets, which meant a user read eight panels before knowing whether they
 * cared about any of them. Now it is reached by opening a card, and Back goes
 * to the choice — so the depth is still there for anyone who wants it, without
 * standing in front of the decision.
 *
 * Order is deliberate: what you would be agreeing to, then what it pays and
 * where it falls short, then where the money goes, then the positions
 * themselves, then provenance. Claim first, evidence after.
 */
export function Basket({
  quoteId: initialId,
  view: initial,
  index,
  onBack,
}: {
  quoteId: string;
  view: QuotedView;
  index: number;
  onBack: () => void;
}) {
  const [frozen, setFrozen] = useState<{ at: string; snapshotId: string } | null>(null);
  const [reviewing, setReviewing] = useState<{ view: QuotedView; quoteId: string } | null>(null);

  // Watched only while unpinned. Pinning closes the stream, which is what makes
  // "this price no longer moves" a fact about the system rather than a caption.
  const live = useLiveQuote(initialId, frozen === null && reviewing === null);
  const view = reviewing?.view ?? live.view ?? initial;
  const quoteId = reviewing?.quoteId ?? live.quoteId;
  const selectedId = initial.options[index]?.id;
  const option = view.options.find(o => o.id === selectedId);

  if (option === undefined) return <section className="section"><p>This basket is no longer available at the current prices.</p><button onClick={onBack}>Back to baskets</button></section>;

  return (
    <>
      <button className="back" onClick={onBack}>
        <span aria-hidden>←</span> All baskets
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s5)' }}>
        <div>
          <div className="card-name">{option.name}</div>
          <h2 className="statement" style={{ marginTop: 'var(--s2)' }}>
            {option.costLabel} to cover {option.paysLabel}
          </h2>
          <p className="lede">{option.reason}</p>
        </div>
      </div>

      {frozen === null && <Feed live={live} />}

      <section className="section">
        <h3>
          What you are left with
          <span className="aside">at every settlement price, after the premium</span>
        </h3>
        <HedgeCurve option={option} />
      </section>

      <section className="section">
        <h3>The honest account</h3>
        <div className="figs">
          <Fig n={option.costLabel} l="Cost" />
          <Fig n={option.coverageLabel} l="Coverage" h="of the loss you described" />
          <Fig n={option.shortfallLabel} l="Worst shortfall" h={option.shortfallWhere ?? undefined} bad />
          {option.netLossLabel !== undefined && <Fig n={option.netLossLabel} l="Worst loss incl. premium" h="against the requested payout shape" bad />}
          <Fig n={option.beyondOwedLabel} l="Beyond owed" h="paid where you owe nothing" />
          {option.withinBracketLabel !== '$0.00' && (
            <Fig
              n={option.withinBracketLabel}
              l="Within a bracket"
              h="the venue does not split where your loss does"
            />
          )}
        </div>
      </section>

      <Review quoteId={quoteId} view={view} option={option} frozen={frozen}
        onReviewStart={() => setReviewing({ view, quoteId })}
        onReviewFailed={() => setReviewing(null)}
        onFreeze={f => { setFrozen(f); if (f === null) setReviewing(null); }} />

      <Disclosure
        title="The markets you would be buying"
        aside={`${option.ladder.heldCount} of ${option.ladder.consideredCount} considered · opens on Polymarket`}
      >
        <table>
          <thead>
            <tr>
              <th>The question you are buying</th>
              <th>Side</th>
              <th className="num">Shares</th>
              <th className="num">Price</th>
              <th className="num">Cost</th>
              <th className="num">Share of premium</th>
              <th className="num">7d</th>
            </tr>
          </thead>
          <tbody>
            {option.ladder.positions.map((p) => (
              <tr key={p.tokenId}>
                <td>
                  {/* Linked to the venue's own page: the one thing here that is
                      not our claim, so it is what makes the rest checkable. */}
                  {p.href === null ? (
                    p.question !== '' ? p.question : p.bracketLabel
                  ) : (
                    <a className="venue" href={p.href} target="_blank" rel="noreferrer noopener">
                      {p.question !== '' ? p.question : p.bracketLabel}
                      <span className="out" aria-label="opens on Polymarket">↗</span>
                    </a>
                  )}
                  {p.question !== '' && <span style={{ color: 'var(--faint)' }}> · {p.bracketLabel}</span>}
                </td>
                <td><span className={`side ${p.side}`}>{p.side}</span></td>
                <td className="num">{Math.round(p.shares).toLocaleString('en-US')}</td>
                <td className="num">{p.priceLabel}</td>
                <td className="num">{p.costLabel}</td>
                <td className="num">{(p.premiumShare * 100).toFixed(1)}%</td>
                <td className="num"><Sparkline tokenId={p.tokenId} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclosure>

      <section className="section">
        <h3>
          Where the money goes
          <span className="aside">across the markets above</span>
        </h3>
        <Allocation ladder={option.ladder} />
      </section>

      <Disclosure
        title="What it pays, range by range"
        aside={`${option.ladder.payout.length} price ranges over ${option.ladder.consideredCount / 2} brackets`}
      >
        <Ladder ladder={option.ladder} />
      </Disclosure>

      {view.assumptions.length > 0 && (
        <section className="section">
          <h3>Assumed on your behalf</h3>
          <ul className="plain">
            {view.assumptions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </section>
      )}

      <section className="section">
        <h3>Provenance</h3>
        <div className="chips">
          <span className="chip">model <b>{view.provenance.model}</b></span>
          <span className={`chip ${view.provenance.calibrationIsFitted ? '' : 'flag'}`}>
            calibration <b>{view.provenance.calibration}</b>
          </span>
          <span className="chip">
            settles <b>{view.event.settlesLabel.slice(0, 16).replace('T', ' ')}</b>
          </span>
          <span className="chip">snapshot <b>{option.detail.snapshotId.slice(0, 16)}…</b></span>
        </div>
        {view.event.observationSource === 'endDate' && (
          <p className="empty" style={{ margin: 'var(--s3) 0 0' }}>
            This market publishes no measurement time, so the settlement instant is taken from when
            trading ends. For some families those are not the same moment.
          </p>
        )}
        {!view.provenance.calibrationIsFitted && (
          <p className="empty" style={{ margin: 'var(--s3) 0 0' }}>
            “unfitted” is literal — no calibration curve has been fitted, so the model’s confidence
            figures are dispersion statistics, not probabilities of being right.
          </p>
        )}
      </section>

      <div className="section">
        <RawData option={option} view={view} />
      </div>
    </>
  );
}

/**
 * What the price on screen is currently worth as a claim.
 *
 * A live price and a price from a socket that died four minutes ago look
 * identical, so this says which one it is. Silence gets named rather than
 * rendered as calm.
 */
function Feed({ live }: { live: ReturnType<typeof useLiveQuote> }) {
  const stale = live.feed === 'stale';
  const label = stale
    ? 'Lost the feed — this is the last price we could confirm'
    : live.feed === 'connecting'
      ? 'Connecting to the book'
      : live.reason === null
        ? 'Live — re-prices when the book behind it moves'
        : live.moved
          ? `Re-priced — ${live.reason.replace(/_/g, ' ')}`
          : 'Re-checked — the book had not moved';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s2)',
        marginTop: 'var(--s5)',
        fontSize: 11,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: stale ? 'var(--short-ink)' : 'var(--muted)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          background: stale ? 'var(--short-ink)' : 'var(--covered-ink)',
        }}
      />
      {label}
    </div>
  );
}

/**
 * Pinning, then placing.
 *
 * Pinning is not cosmetic: it stops the stream and freezes the record, so what
 * the user reviews is exactly what they would be agreeing to. The record is
 * never edited afterwards — re-pricing writes a new row — because the question
 * a pinned quote answers is "what did I agree to", and an edit destroys the
 * answer.
 */
function Review({
  quoteId,
  view,
  option,
  frozen,
  onFreeze,
  onReviewStart,
  onReviewFailed,
}: {
  quoteId: string;
  view: QuotedView;
  option: QuotedView['options'][number];
  frozen: { at: string; snapshotId: string } | null;
  onFreeze: (f: { at: string; snapshotId: string } | null) => void;
  onReviewStart: () => void;
  onReviewFailed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [age, setAge] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const session = useSession();
  const ready = readiness(session.facts, 0);

  useEffect(() => {
    if (frozen === null) return;
    const started = Date.parse(frozen.at);
    const tick = setInterval(() => setAge(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [frozen]);

  const freeze = async () => {
    setBusy(true);
    setError(null);
    onReviewStart();
    try {
      const res = await fetch(`/api/quote/${quoteId}/accept`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ optionId: option.id }) });
      const body = (await res.json()) as { acceptedAt?: string; snapshotId?: string; error?: string };
      if (!res.ok || !body.acceptedAt || !body.snapshotId) throw new Error(body.error ?? 'Could not pin this basket.');
      if (body.acceptedAt !== undefined && body.snapshotId !== undefined) {
        onFreeze({ at: body.acceptedAt, snapshotId: body.snapshotId });
        setAge(0);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not pin this basket.');
      onReviewFailed();
    } finally {
      setBusy(false);
    }
  };

  if (frozen === null) {
    return (
      <div className="section">
        {error && <p role="alert">{error}</p>}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s5)',
            borderTop: '1px solid var(--rule)',
            borderBottom: '1px solid var(--rule)',
            padding: 'var(--s4) 0',
          }}
        >
          <span style={{ color: 'var(--muted)', maxWidth: '48ch' }}>
            This price moves with the book. Pin it to stop it and see exactly what you would be
            agreeing to.
          </span>
          <span className="spacer" />
          <button className="primary" onClick={() => void freeze()} disabled={busy}>
            {busy ? 'Pinning' : 'Pin this price'}
          </button>
        </div>
        <p className="empty" style={{ margin: 'var(--s3) 0 0', fontSize: 13 }}>{ready.message}</p>
      </div>
    );
  }

  const stale = age > 60;
  return (
    <div className="section">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s5)',
          border: `1px solid ${stale ? 'var(--short)' : 'var(--ink)'}`,
          padding: 'var(--s4) var(--s5)',
        }}
      >
        <div>
          <div className="card-name">Pinned — this price no longer moves</div>
          <div className="card-cost" style={{ fontSize: 24 }}>
            {option.costLabel} for {option.paysLabel} of cover
          </div>
        </div>
        <span className="spacer" />
        <div style={{ textAlign: 'right' }}>
          <div className="card-name">Pinned for</div>
          <div
            className="num"
            style={{ fontSize: 22, color: stale ? 'var(--short-ink)' : 'var(--ink)' }}
          >
            {Math.floor(age / 60)}:{String(age % 60).padStart(2, '0')}
          </div>
        </div>
        <button onClick={() => onFreeze(null)}>Unpin</button>
        <button className="primary" disabled={!ready.canPlace} title={ready.message}>
          Place {option.ladder.heldCount} orders
        </button>
      </div>
      <div className="note warn" style={{ marginTop: 'var(--s3)' }}>
        {ready.message} Orders settle in pUSD, which is not the USDC you may already hold — it has
        to be deposited and wrapped first.
      </div>
    </div>
  );
}

function Fig({ n, l, h, bad }: { n: string; l: string; h?: string | undefined; bad?: boolean }) {
  return (
    <div className={`fig${bad === true ? ' bad' : ''}`}>
      <div className="n">{n}</div>
      <div className="l">{l}</div>
      {h !== undefined && <div className="h">{h}</div>}
    </div>
  );
}
