'use client';

import { useCallback, useRef, useState } from 'react';
import { Connect } from './Session';
import { Basket } from './Basket';
import { Cards } from './Cards';
import type { QuotedView } from '@/lib/view-model';

/**
 * The whole surface, in two states: choose a basket, or look inside one.
 *
 * It used to be one page with everything on it — eight panels of ladder,
 * allocation, payout table, positions, assumptions, provenance and raw receipt,
 * all at once, before the user had decided anything. That is not detail, it is
 * noise standing between someone and a decision.
 *
 * So: the sentence produces a few complete baskets, shown as cards carrying
 * only what distinguishes them. Opening one replaces the cards with everything
 * about that basket, and Back returns. One decision per screen.
 *
 * The one thing that does NOT move behind a click is the shortfall. What a
 * basket fails to cover is half of what it is, and a card that showed only cost
 * and coverage would be advertising rather than quoting.
 */

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
];

export function Studio() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [lossLimit, setLossLimit] = useState('');
  const [maxLegs, setMaxLegs] = useState('');
  const session = useRef<unknown>(undefined);

  const ask = useCallback(
    async (words: string) => {
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
          body: JSON.stringify({ text: words, session: session.current,
            ...(lossLimit.trim() === '' ? {} : { maxNetLossUsd: Number(lossLimit) }),
            ...(maxLegs.trim() === '' ? {} : { maxLegs: Number(maxLegs) }) }),
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
            setTurns((t) => [
              ...t,
              { who: 'ph', text: `Built ${r.view.options.length} ways to cover it.` },
            ]);
          } else if (r.kind === 'no_market_listed') {
            setTurns((t) => [...t, { who: 'ph', text: 'Nothing is listed that settles by then.' }]);
          } else {
            setTurns((t) => [...t, { who: 'ph', text: 'Not something this will quote.', why: r.reason }]);
          }
        }
        setOpened(null);
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
    },
    [busy, lossLimit, maxLegs],
  );

  const quoted = result?.kind === 'quoted' ? result : null;
  const open = quoted !== null && opened !== null ? quoted.view.options[opened] : undefined;

  // Inside a basket: nothing else on screen competes with it.
  if (quoted !== null && open !== undefined) {
    return (
      <div className="wrap">
        <Bar />
        <Basket
          quoteId={quoted.quoteId}
          view={quoted.view}
          index={opened as number}
          onBack={() => setOpened(null)}
        />
        <Foot />
      </div>
    );
  }

  return (
    <div className="wrap">
      <Bar />

      <div className="narrow-warning note warn" style={{ marginBottom: 'var(--s5)' }}>
        This is built for a screen at least 1024px wide. Below that the ladder is a different
        design that does not exist yet, and shrinking this one would misrepresent it.
      </div>

      {turns.length === 0 && (
        <div style={{ marginBottom: 'var(--s6)' }}>
          <h1 className="statement">Describe what you would lose.</h1>
          <p className="lede">
            Plain words are enough. What comes back is a small number of complete baskets, each
            priced against the live book, each saying what it does not cover.
          </p>
        </div>
      )}

      {turns.length > 0 && (
        <div style={{ marginBottom: 'var(--s5)', maxHeight: 220, overflowY: 'auto' }}>
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
        <label htmlFor="exposure" className="sr-only" style={SR_ONLY}>
          Describe what you would lose
        </label>
        <textarea
          id="exposure"
          rows={1}
          value={text}
          placeholder="What would you lose, how much, and by when?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(text.trim());
            }
          }}
        />
        <button className="primary" onClick={() => void ask(text.trim())} disabled={busy}>
          {busy ? 'Working' : 'Build'}
        </button>
      </div>

      <details style={{ marginTop: 'var(--s3)' }}>
        <summary>Protection limits (optional)</summary>
        <p className="note">Find the lowest-cost basket that keeps the remaining target loss, including premium and fees, below this amount in every modelled settlement state. Basis risk can leave more loss.</p>
        <label htmlFor="loss-limit">Maximum remaining target loss ($) </label>
        <input id="loss-limit" type="number" min="0" step="0.01" value={lossLimit}
          disabled={busy} onChange={e => setLossLimit(e.target.value)} placeholder="Leave blank to minimize loss" />
        <p><label htmlFor="max-positions">Maximum positions (optional) </label>
          <input id="max-positions" type="number" min="1" max="30" step="1" value={maxLegs}
            disabled={busy} onChange={e => setMaxLegs(e.target.value)} placeholder="No limit" /></p>
        <p className="note">Fewer positions can cost more or leave more loss. Each quoted quantity respects the reported minimum order size and 0.01-share increments; fills are not guaranteed.</p>
      </details>

      {turns.length === 0 && (
        <div className="chips" style={{ marginTop: 'var(--s4)' }}>
          {EXAMPLES.map((example, i) => (
            <button key={i} className="chip edit" onClick={() => setText(example)}>
              {example.slice(0, 46)}…
            </button>
          ))}
        </div>
      )}

      {busy && (
        <div className="section empty">
          <span className="spin" />
          Reading your words, pulling live books, solving.
        </div>
      )}

      {!busy && quoted !== null && (
        <Cards view={quoted.view} onOpen={setOpened} onRefine={(t) => setText(t)} />
      )}

      {!busy && result?.kind === 'no_market_listed' && (
        <div className="section">
          <h2 className="statement">Nothing is listed that settles by then.</h2>
          <p className="lede">
            {result.furthestListed === null
              ? 'This venue lists nothing on that subject at all.'
              : `The furthest this venue lists is ${result.furthestListed}. A basket cannot be built past the last market that exists.`}
          </p>
        </div>
      )}

      {!busy && result?.kind === 'declined' && (
        <div className="section">
          <h2 className="statement">Not something this will quote.</h2>
          <p className="lede">{result.reason}</p>
        </div>
      )}

      <Foot />
    </div>
  );
}

const SR_ONLY = {
  position: 'absolute' as const,
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
};

function Bar() {
  return (
    <div className="bar">
      <span className="brand">PolyHedge</span>
      <span className="tag">beta</span>
      <span className="spacer" />
      <Connect />
    </div>
  );
}

function Foot() {
  return (
    <p className="foot">
      <span>
        <strong style={{ color: 'var(--muted)' }}>Not investment advice.</strong> This describes
        instruments and prices; it does not recommend them.
      </span>
      <span className="spacer" />
      <span>Every position can expire worthless. Prices move within seconds.</span>
    </p>
  );
}
