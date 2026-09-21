'use client';

import { useCallback, useRef, useState } from 'react';
import { Ladder } from './Ladder';
import type { CoverOptionView, QuotedView } from '@/lib/view-model';

type Result =
  | { kind: 'quoted'; view: QuotedView }
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
        <span className="tag">nothing here places an order</span>
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
        <Quoted view={result.view} chosen={chosen} onChoose={setChosen} />
      )}

      {!busy && result?.kind === 'no_market_listed' && (
        <div className="box">
          <div className="body">
            <h2 className="statement">
              {result.furthestListed === null
                ? 'Nothing is listed for this at all.'
                : `Nothing settles that late. The furthest is ${result.furthestListed.slice(0, 10)}.`}
            </h2>
          </div>
          <div className="note info">
            Quoting the nearest listed date instead would cover a different date than the one you
            asked about. That substitution is the thing this refuses to make quietly.
          </div>
        </div>
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
        <span>Not investment advice.</span>
        <span>Every position can expire worthless.</span>
        <span className="spacer" />
        <span>Prices move within seconds.</span>
      </p>
    </div>
  );
}

function Quoted({
  view,
  chosen,
  onChoose,
}: {
  view: QuotedView;
  chosen: number;
  onChoose: (i: number) => void;
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

      {view.options.length > 1 && (
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
                <th>Range</th>
                <th>Side</th>
                <th className="num">Shares</th>
                <th className="num">Price</th>
                <th className="num">Cost</th>
                <th className="num">Share of premium</th>
              </tr>
            </thead>
            <tbody>
              {option.ladder.positions.map((p) => (
                <tr key={p.tokenId}>
                  <td>{p.bracketLabel}</td>
                  <td><span className={`side ${p.side}`}>{p.side}</span></td>
                  <td className="num">{Math.round(p.shares).toLocaleString('en-US')}</td>
                  <td className="num">{p.priceLabel}</td>
                  <td className="num">{p.costLabel}</td>
                  <td className="num">{(p.premiumShare * 100).toFixed(1)}%</td>
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
    </>
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
