import { structuredQuote } from './structured-quote.js';
import type { StoredQuote } from './store.js';
import type { QuotedView } from './view-model.js';

/**
 * Re-pricing one quote at the current book.
 *
 * It rebuilds **every** basket, not just the one being looked at: the
 * comparison between baskets is the entire decision this product supports.
 *
 * None of this calls the model. The language work happened once and produced a
 * `QuoteRequest`; a re-price costs venue latency and some WASM, not a model
 * round trip.
 *
 * It never mutates what it re-prices. The previous row stays exactly as it was
 * read and the result is a NEW row pointing back at it — the question a quote
 * answers is "what did I agree to", and an edit destroys the answer.
 */

export interface Repriced {
  next: StoredQuote;
  view: QuotedView;
  snapshotId: string;
  /** False when the book has not moved: the id is a content hash. */
  snapshotChanged: boolean;
}

export async function reprice(previous: StoredQuote, owner: string): Promise<Repriced> {
  const { meta } = previous.record;
  const { stored: next, view } = await structuredQuote(previous.record.request, owner, previous.id, previous.revision + 1, undefined, {
    jevModelVersion: meta.jevModelVersion,
    calibrationMapVersion: meta.calibrationMapVersion,
    ruleFlags: meta.ruleFlags,
    correlationResidual: meta.correlationResidual,
  });
  const snapshotId = next.record.resolved.snapshotId;
  return { next, view, snapshotId, snapshotChanged: snapshotId !== previous.record.resolved.snapshotId };
}
