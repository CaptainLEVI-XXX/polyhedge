'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Ladder } from './Ladder';
import { Allocation } from './Allocation';
import { readiness } from '@/lib/wallet-readiness';
import { useSession } from './Session';
import { Sparkline } from './Sparkline';
import { RawData } from './RawData';
import type { CoverOptionView, QuotedView } from '@/lib/view-model';

type Result =
  | { kind: 'quoted'; quoteId: string; view: QuotedView }
  | { kind: 'follow_up'; session: unknown; question: string }
  | { kind: 'no_market_listed'; furthestListed: string | null }
  | { kind: 'declined'; reason: string };

interface Turn {
  who: 'you' | 'ph';
  text: string;
  why?: string;
}

const EXAMPLES = [
  "I hold 2 BTC and I'd be down about $8,000 if it ends below 77,000 by September 23. I can spend $600.",
  'I run outdoor events in Chicago and I would lose about $12,000 if it is cold on the 26th.',
  'I have $2M of floating-rate debt and every 25bp hike costs me about $5,000 a year.',
  "I don't own any bitcoin but I reckon it is going to 100k and I want to put $500 on it.",
];

export function Studio() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [chosen, setChosen] = useState(0);
  const [frozen, setFrozen] = useState<{ at: string; snapshotId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const session = useRef<unknown>(undefined);

  const submit = useCallback(async () => {
    const words = text.trim();
    if (words === '' || busy) return;

    setTurns((t) => [...t, { who: 'you', text: words }]);
    setText('');
    setBusy(true);

    try {
      const res = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The session goes back as it was given. The server never rebuilds
        // state by re-reading a transcript.
        body: JSON.stringify({ text: words, session: session.current }),
      });
      const payload = (await res.json()) as { result?: Result; error?: string };
      if (!res.ok || payload.result === undefined) {
        throw new Error(payload.error ?? 'that did not work');
      }

      const r = payload.result;
      if (r.kind === 'follow_up') {
        session.current = r.session;
        setTurns((t) => [...t, { who: 'ph', text: r.question }]);
      } else {
        session.current = undefined;
        if (r.kind === 'quoted') {
          const first = r.view.options[0];
          setTurns((t) => [
            ...t,
            { who: 'ph', text: 'Built it.', why: `${first?.costLabel ?? ''} · ${first?.coverageLabel ?? ''} covered` },
          ]);
        } else if (r.kind === 'no_market_listed') {
          setTurns((t) => [...t, { who: 'ph', text: 'Nothing is listed that settles by then.' }]);
        } else {
          setTurns((t) => [...t, { who: 'ph', text: 'Not something this will quote.', why: r.reason }]);
        }
      }
      setChosen(0);
      setFrozen(null);
      setResult(r);
    } catch (error) {
      setResult(null);
      setTurns((t) => [
        ...t,
        { who: 'ph', text: error instanceof Error ? error.message : 'that did not work' },
      ]);
    } finally {
      setBusy(false);
    }
  }, [text, busy]);

  return (
    <div className="wrap">
      <div className="bar">
        <span className="brand">PolyHedge</span>
        <span className="tag">[beta]</span>
        <span className="spacer" />
        <Connect />
      </div>

      <div className="narrow-warning note warn" style={{ marginBottom: 16 }}>
        This is built for a screen at least 1024px wide. Below that the ladder is a different
        design that does not exist yet, and shrinking this one would misrepresent it.
      </div>

      <div className="box">
        {turns.length > 0 && (
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {turns.map((turn, i) => (
              <div className="turn" key={i}>
                <span className="who">{turn.who === 'you' ? 'you' : 'ph'}</span>
                <span className="msg">
                  {turn.text}
                  {turn.why !== undefined && <span className="why">{turn.why}</span>}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="composer">
          <label htmlFor="exposure" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Describe what you would lose
          </label>
          <textarea
            id="exposure"
            rows={1}
            value={text}
            placeholder="Describe what you would lose, and when…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Working' : 'Build'}
          </button>
        </div>
      </div>

      {turns.length === 0 && (
        <div className="chips" style={{ marginTop: 14 }}>
          {EXAMPLES.map((example, i) => (
            <button key={i} className="chip" style={{ cursor: 'pointer' }} onClick={() => setText(example)}>
              {example.slice(0, 44)}…
            </button>
          ))}
        </div>
      )}

      {busy && (
        <div className="box">
          <div className="body empty">
            <span className="spin" />
            Reading your words, pulling live books, solving…
          </div>
        </div>
      )}

      {!busy && result?.kind === 'quoted' && (
        <Quoted
          view={result.view}
          quoteId={result.quoteId}
          chosen={chosen}
          onChoose={setChosen}
          frozen={frozen}
          onFreeze={setFrozen}
        />
      )}

      {!busy && result?.kind === 'no_market_listed' && (
        <NoMarket furthestListed={result.furthestListed} />
      )}

      {!busy && result?.kind === 'declined' && (
        <div className="box">
          <div className="body">
            <h2 className="statement">Not something this will quote.</h2>
            <p style={{ color: 'var(--ink-2)', marginBottom: 0 }}>{result.reason}</p>
          </div>
        </div>
      )}

      <p className="foot">
        <span>
          <strong>Not investment advice.</strong> This describes instruments and prices; it does
          not recommend them.
        </span>
        <span className="spacer" />
        <span>Every position can expire worthless. Prices move within seconds.</span>
      </p>
    </div>
  );
}

function Quoted({
  view,
  quoteId,
  chosen,
  onChoose,
  frozen,
  onFreeze,
}: {
  view: QuotedView;
  quoteId: string;
  chosen: number;
  onChoose: (i: number) => void;
  frozen: { at: string; snapshotId: string } | null;
  onFreeze: (f: { at: string; snapshotId: string } | null) => void;
}) {
  const option = view.options[chosen] ?? view.options[0];
  if (option === undefined) return null;

  return (
    <>
      <div className="box">
        <div className="body">
          <h2 className="statement">{view.statement}</h2>
        </div>
      </div>

      <Review
        quoteId={quoteId}
        option={option}
        frozen={frozen}
        onFreeze={onFreeze}
      />

      {view.options.length > 1 && !frozen && (
        <div className="box">
          <header>How much cover</header>
          <div className="stops">
            {view.options.map((o, i) => (
              <button
                key={o.id}
                className="stop"
                aria-pressed={i === chosen}
                onClick={() => onChoose(i)}
              >
                <div className="stop-name">{o.name}</div>
                <div className="stop-cost">{o.costLabel}</div>
                <div className="stop-sub">{o.coverageLabel} of your loss covered</div>
                <div className="meter">
                  <span style={{ width: `${Math.min(100, o.coverageRatio * 100)}%` }} />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="box">
        <header>
          <span>What it pays, and where it falls short</span>
          <span className="spacer" />
          <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--muted)' }}>
            {option.ladder.payout.length} price ranges over {option.ladder.consideredCount / 2} brackets
          </span>
        </header>
        <div className="body">
          <Ladder ladder={option.ladder} />
        </div>
      </div>

      <div className="box">
        <header>Where the money goes</header>
        <div className="body">
          <Allocation ladder={option.ladder} />
        </div>
      </div>

      <div className="box">
        <header>The honest account</header>
        <div className="body figs">
          <Fig n={option.costLabel} l="Cost" />
          <Fig n={option.coverageLabel} l="Coverage" h="of the loss you described" />
          <Fig n={option.shortfallLabel} l="Worst shortfall" h={option.shortfallWhere ?? undefined} bad />
          <Fig n={option.beyondOwedLabel} l="Beyond owed" h="paid where you owe nothing" />
          {option.withinBracketLabel !== '$0.00' && (
            <Fig n={option.withinBracketLabel} l="Within a bracket" h="the venue does not split where your loss does" />
          )}
        </div>
      </div>

      <div className="box">
        <header>
          <span>Positions</span>
          <span className="spacer" />
          <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--muted)' }}>
            {option.ladder.heldCount} held of {option.ladder.consideredCount} considered
          </span>
        </header>
        <div className="body">
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
                    {p.question !== '' ? p.question : p.bracketLabel}
                    {p.question !== '' && (
                      <span style={{ color: 'var(--muted)' }}> · {p.bracketLabel}</span>
                    )}
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
        </div>
      </div>

      {view.assumptions.length > 0 && (
        <div className="box">
          <header>Assumed on your behalf</header>
          <div className="body">
            <ul className="plain">
              {view.assumptions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="box">
        <header>Provenance</header>
        <div className="body">
          <div className="chips">
            <span className="chip">model <b>{view.provenance.model}</b></span>
            <span className={`chip ${view.provenance.calibrationIsFitted ? '' : 'flag'}`}>
              calibration <b>{view.provenance.calibration}</b>
            </span>
            <span className="chip">settles <b>{view.event.settlesLabel.slice(0, 16).replace('T', ' ')}</b></span>
            <span className="chip">snapshot <b>{option.detail.snapshotId}</b></span>
          </div>
          {view.event.observationSource === 'endDate' && (
            <p className="empty" style={{ marginBottom: 0, marginTop: 10 }}>
              This market publishes no measurement time, so the settlement instant is taken from
              when trading ends. For some families those are not the same moment.
            </p>
          )}
          {!view.provenance.calibrationIsFitted && (
            <p className="empty" style={{ marginBottom: 0, marginTop: 10 }}>
              “unfitted” is literal — no calibration curve has been fitted, so the model’s
              confidence figures are dispersion statistics, not probabilities of being right.
            </p>
          )}
        </div>
      </div>

      <RawData option={option} view={view} />
    </>
  );
}

/**
 * The boundary between exploring and consenting.
 *
 * A price that moves while you read it means "what did I agree to" has no
 * answer, so pinning stops everything and fixes the record with its snapshot.
 * The clock is shown because a frozen quote is only honest for as long as the
 * book behind it holds, and re-pricing is an explicit act that produces a NEW
 * record rather than quietly editing this one.
 */
function Review({
  quoteId,
  option,
  frozen,
  onFreeze,
}: {
  quoteId: string;
  option: CoverOptionView;
  frozen: { at: string; snapshotId: string } | null;
  onFreeze: (f: { at: string; snapshotId: string } | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [age, setAge] = useState(0);

  useEffect(() => {
    if (frozen === null) return;
    const started = Date.parse(frozen.at);
    const tick = setInterval(() => setAge(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [frozen]);

  const freeze = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/quote/${quoteId}/accept`, { method: 'POST' });
      const body = (await res.json()) as { acceptedAt?: string; snapshotId?: string };
      if (body.acceptedAt !== undefined && body.snapshotId !== undefined) {
        onFreeze({ at: body.acceptedAt, snapshotId: body.snapshotId });
        setAge(0);
      }
    } finally {
      setBusy(false);
    }
  };

  // Signing in proves identity and nothing else. Provisioning, approvals and a
  // pUSD balance are each their own step, so they stay false and null here
  // until the thing itself has happened — claiming them would make the UI offer
  // an order the venue then refuses.
  const session = useSession();
  const ready = readiness(session.facts, 0);

  if (frozen === null) {
    return (
      <div className="box">
        <div className="body" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ color: 'var(--ink-2)' }}>
            This price moves with the book. Pin it to stop it and see exactly what you would be
            agreeing to.
          </span>
          <span className="spacer" />
          <button className="primary" onClick={() => void freeze()} disabled={busy}>
            {busy ? 'Pinning' : 'Review this'}
          </button>
        </div>
        <div className="note info">{ready.message}</div>
      </div>
    );
  }

  const stale = age > 60;
  return (
    <div className="box" style={{ borderColor: stale ? 'var(--short)' : 'var(--ink)' }}>
      <div className="body" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div>
          <div style={{ fontSize: 10.5, letterSpacing: '0.08em', color: 'var(--muted)' }}>
            PINNED — THIS PRICE NO LONGER MOVES
          </div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 24, marginTop: 4 }}>
            {option.costLabel} for {option.paysLabel} of cover
          </div>
        </div>
        <span className="spacer" />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 10.5, letterSpacing: '0.08em', color: 'var(--muted)' }}>PINNED FOR</div>
          <div style={{ fontSize: 22, color: stale ? 'var(--short-ink)' : 'var(--ink)' }}>
            {Math.floor(age / 60)}:{String(age % 60).padStart(2, '0')}
          </div>
        </div>
        <button onClick={() => onFreeze(null)}>Unpin</button>
        <button className="primary" disabled={!ready.canPlace} title={ready.message}>
          Place {option.ladder.heldCount} orders
        </button>
      </div>
      <div className="note warn">
        {ready.message} Orders settle in pUSD, which is not the USDC you may already hold — it has
        to be deposited and wrapped first.
      </div>
      <div className="note info">
        These {option.ladder.heldCount} orders go one at a time, thinnest book first, and you will
        be asked to sign <strong>{option.ladder.heldCount} times</strong>. There is no way to place
        them as one transaction. If a later one fails you will hold part of a hedge, and selling
        that back is more signatures — so if you leave before doing it, you keep the part you
        already bought until you come back.
      </div>
      {stale && (
        <div className="note stop">
          This was priced over a minute ago and the book has almost certainly moved. Re-price
          before acting on it — that produces a new quote rather than changing this one.
        </div>
      )}
    </div>
  );
}

/**
 * A refusal is the product working, not an error — so it gets a screen rather
 * than a red toast. For a distant date there is genuinely no instrument, and
 * this is the most common answer the product gives, so it explains the shape
 * of the problem rather than describing it.
 */
function NoMarket({ furthestListed }: { furthestListed: string | null }) {
  if (furthestListed === null) {
    return (
      <div className="box">
        <div className="body">
          <h2 className="statement">Nothing is listed for this at all.</h2>
          <p style={{ color: 'var(--ink-2)', marginBottom: 0 }}>
            No market we can read settles on this subject right now.
          </p>
        </div>
      </div>
    );
  }

  const furthest = new Date(furthestListed);
  const today = new Date();
  const days = Math.max(0, Math.round((furthest.getTime() - today.getTime()) / 86_400_000));
  const listedWidth = 14;

  return (
    <div className="box">
      <div className="body">
        <h2 className="statement">
          Nothing settles that late. The furthest is {furthestListed.slice(0, 10)}.
        </h2>
        <p style={{ color: 'var(--ink-2)', maxWidth: 760 }}>
          These markets list on a rolling window, so a later date is a matter of waiting rather
          than of looking harder.
        </p>

        <svg viewBox="0 0 1140 86" width="100%" role="img"
          aria-label={`Markets are listed up to ${furthestListed.slice(0, 10)}. The date you asked for is about ${days} days beyond that.`}>
          <line x1="10" y1="48" x2="1130" y2="48" stroke="var(--ink)" />
          <rect x="10" y="32" width={listedWidth * 10} height="32" fill="var(--covered)" stroke="var(--ink)" />
          <text x={10 + listedWidth * 5} y="24" textAnchor="middle" style={{ font: '500 11px var(--mono)', fill: 'var(--ink)' }}>listed</text>
          <text x={10 + listedWidth * 5} y="53" textAnchor="middle" style={{ font: '400 10px var(--mono)', fill: 'var(--ink)' }}>
            to {furthestListed.slice(5, 10)}
          </text>
          <line x1="1060" y1="26" x2="1060" y2="70" stroke="var(--short)" strokeWidth="2" />
          <text x="1060" y="18" textAnchor="middle" style={{ font: '500 11px var(--mono)', fill: 'var(--short-ink)' }}>you asked for</text>
          <text x="580" y="44" textAnchor="middle" style={{ font: '400 10.5px var(--mono)', fill: 'var(--faint)' }}>
            nothing trades in here
          </text>
        </svg>
      </div>

      <div className="note info">
        Quoting the nearest listed date instead would cover a different date than the one you asked
        about. That substitution is the thing this refuses to make quietly.
      </div>
    </div>
  );
}

function Connect() {
  const session = useSession();

  if (session.status === 'connecting') return <span className="tag">connecting…</span>;

  if (session.address === null) {
    return (
      <button onClick={session.login} style={{ padding: '6px 14px' }}>
        Sign in
      </button>
    );
  }

  const short = `${session.address.slice(0, 6)}…${session.address.slice(-4)}`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span className="tag">{short}</span>
      <button onClick={session.logout} style={{ padding: '6px 12px' }}>
        Sign out
      </button>
    </span>
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
