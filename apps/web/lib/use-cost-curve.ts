'use client';
import { useEffect, useRef, useState } from 'react';
import type { CoverOptionView, CurvePoint } from './view-model.js';

type CurveSnapshot = {
  root: string;
  quote: string;
  points: CurvePoint[];
  options: CoverOptionView[];
  budgetUsd: number | undefined;
};

/** Keep curve and markers from one quote together while refreshing in the background. */
export function useCostCurve(rootId: string, quoteId: string, enabled: boolean,
  options: CoverOptionView[], budgetUsd: number | undefined) {
  const latest = useRef({ quoteId, options, budgetUsd });
  const [snapshot, setSnapshot] = useState<CurveSnapshot | null>(null);
  const [failedRoot, setFailedRoot] = useState<string | null>(null);
  useEffect(() => { latest.current = { quoteId, options, budgetUsd }; }, [quoteId, options, budgetUsd]);
  useEffect(() => {
    if (!enabled || !rootId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completedQuote = '';
    setFailedRoot(null);
    async function refresh() {
      const requested = latest.current;
      try {
        if (requested.quoteId && requested.quoteId !== completedQuote) {
          const response = await fetch(`/api/quote/${requested.quoteId}/curve`, { signal: controller.signal });
          if (!response.ok) throw Error('Curve unavailable');
          const body = await response.json();
          if (!Array.isArray(body?.points) || body.points.length < 2) throw Error('Curve unavailable');
          if (!controller.signal.aborted) {
            completedQuote = requested.quoteId;
            setSnapshot({ root: rootId, quote: requested.quoteId, points: body.points,
              options: requested.options, budgetUsd: requested.budgetUsd });
            setFailedRoot(null);
          }
        }
      } catch {
        if (!controller.signal.aborted) setFailedRoot(rootId);
      } finally {
        // One request at a time. Let fast quote updates coalesce instead of
        // repeatedly cancelling work or exceeding the curve endpoint's limit.
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [rootId, enabled]);
  const visible = snapshot?.root === rootId ? snapshot : null;
  return {
    points: visible?.points ?? [],
    options: visible?.options ?? [],
    budgetUsd: visible?.budgetUsd,
    loading: enabled && !visible && failedRoot !== rootId,
    refreshing: enabled && !!visible && visible.quote !== quoteId && failedRoot !== rootId,
    refreshFailed: failedRoot === rootId,
  };
}
