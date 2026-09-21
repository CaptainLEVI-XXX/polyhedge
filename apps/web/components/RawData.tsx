'use client';

import { useState } from 'react';
import type { CoverOptionView, QuotedView } from '@/lib/view-model';

/**
 * Everything the engine decided, in its own terms.
 *
 * Nobody needs this to use the product; everybody needs it to trust the
 * product. It is the only place token ids appear, and it is collapsed by
 * default because the plain register is what the product speaks — this is the
 * receipt, not the sentence.
 */
export function RawData({ option, view }: { option: CoverOptionView; view: QuotedView }) {
  const [open, setOpen] = useState(false);
  const L = option.ladder;

  return (
    <div className="box">
      <header>
        <span>Raw data</span>
        <span className="spacer" />
        <button style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </header>

      {open && (
        <div className="body">
          <p className="empty" style={{ marginTop: 0 }}>
            Nothing here is needed to use this. It is here so the numbers above can be checked
            rather than believed.
          </p>

          <table>
            <thead>
              <tr>
                <th>Range</th>
                <th className="num">Owed</th>
                <th className="num">Paid</th>
                <th className="num">Short</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {L.payout.map((r, i) => (
                <tr key={i}>
                  <td>{r.label}</td>
                  <td className="num">{r.owedUsd.toFixed(2)}</td>
                  <td className="num">{r.paidUsd.toFixed(2)}</td>
                  <td className="num" style={{ color: r.owedUsd > r.paidUsd ? 'var(--short-ink)' : undefined }}>
                    {Math.max(0, r.owedUsd - r.paidUsd).toFixed(2)}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>
                    {r.beyondOwed ? 'paid, not owed' : r.owedUsd > r.paidUsd ? 'short' : 'covered'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <table style={{ marginTop: 18 }}>
            <thead>
              <tr>
                <th>Token</th>
                <th>Side</th>
                <th className="num">Shares</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {L.positions.map((p) => (
                <tr key={p.tokenId}>
                  <td style={{ fontSize: 11, color: 'var(--muted)' }}>{p.tokenId}</td>
                  <td>{p.side}</td>
                  <td className="num">{p.shares.toFixed(2)}</td>
                  <td className="num">{p.costLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="chips" style={{ marginTop: 18 }}>
            <span className="chip">event <b>{option.detail.eventId}</b></span>
            <span className="chip">snapshot <b>{option.detail.snapshotId.slice(0, 16)}…</b></span>
            <span className="chip">quoted <b>{option.detail.quotedAt}</b></span>
            <span className="chip">mu <b>{option.detail.mu}</b></span>
            <span className="chip">phase1 <b>{option.detail.phase1Hash.slice(0, 12)}…</b></span>
            <span className="chip">phase2 <b>{option.detail.phase2Hash.slice(0, 12)}…</b></span>
            <span className="chip">model <b>{view.provenance.model}</b></span>
            <span className="chip">held <b>{L.heldCount}/{L.consideredCount}</b></span>
          </div>
        </div>
      )}
    </div>
  );
}
