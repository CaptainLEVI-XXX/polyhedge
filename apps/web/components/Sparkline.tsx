'use client';

import { useEffect, useState } from 'react';

/**
 * A week of price for one outcome, beside the position that holds it.
 *
 * Fetched per token and cached server-side. It renders nothing at all when the
 * history is missing rather than drawing an empty frame — an axis with no line
 * reads as "this is worth zero", which is a different and much worse claim than
 * "we do not have this".
 */
export function Sparkline({ tokenId }: { tokenId: string }) {
  const [points, setPoints] = useState<number[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/history/${tokenId}`)
      .then((r) => r.json() as Promise<{ points?: number[] }>)
      .then((b) => {
        if (live) setPoints(b.points ?? []);
      })
      .catch(() => {
        if (live) setPoints([]);
      });
    return () => {
      live = false;
    };
  }, [tokenId]);

  if (points === null || points.length < 2) return null;

  const w = 56;
  const h = 16;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((p - min) / span) * h).toFixed(1)}`)
    .join(' ');

  const rose = (points[points.length - 1] ?? 0) >= (points[0] ?? 0);

  return (
    <svg width={w} height={h} role="img" aria-label={`Traded between ${min.toFixed(2)} and ${max.toFixed(2)} over the past week.`}>
      <path d={d} fill="none" stroke={rose ? 'var(--covered-ink)' : 'var(--short-ink)'} strokeWidth="1.2" />
    </svg>
  );
}
