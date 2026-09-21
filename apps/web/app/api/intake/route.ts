import { createJevEngine } from '@polyhedge/questions';
import { quoteSession } from '@polyhedge/engine';
import { LpNotOptimalError } from '@polyhedge/core';
import { fetchBooks, fetchEvent } from '@polyhedge/venue';
import { buildBasketOptions, intake, type IntakeDeps, type IntakeSession } from '@polyhedge/intake';
import { marketIndex } from '@/lib/markets';
import { handleRouteError } from '@/lib/errors';
import { composeView } from '@/lib/compose';
import { linkForMarket } from '@/lib/venue-links';
import { putQuote, putSnapshot } from '@/lib/store';
import { rateLimit, readJsonBody, requireCaller, TooManyRequests } from '@/lib/identity';

/** Node, never Edge: this route solves, and the solver is WASM. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TEXT = 2_000;
const MAX_BODY_BYTES = 64 * 1024;
// Each call is a model round trip plus venue fetches, so this is the endpoint
// where an unbounded caller costs money rather than just cycles.
const LIMIT_PER_MINUTE = 12;

interface Body {
  text?: unknown;
  session?: unknown;
  maxNetLossUsd?: unknown;
  maxLegs?: unknown;
}

function requireKey(): string {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (key === undefined || key.trim() === '') {
    throw new Error('AI_GATEWAY_API_KEY is not set');
  }
  return key;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const timed = async <T,>(name: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await run(); }
    finally { timings[name] = (timings[name] ?? 0) + performance.now() - start; }
  };
  const respond = (payload: object) => Response.json({ ...payload, timings }, {
    headers: { 'Server-Timing': Object.entries(timings).map(([k, v]) => `${k};dur=${v.toFixed(1)}`).join(', ') },
  });
  try {
    const caller = requireCaller(request);
    rateLimit(caller, 'intake', LIMIT_PER_MINUTE, 60_000);

    const body = (await readJsonBody(request, MAX_BODY_BYTES)) as Body;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (body.maxLegs !== undefined && (typeof body.maxLegs !== 'number'
      || !Number.isInteger(body.maxLegs) || body.maxLegs < 1 || body.maxLegs > 30)) {
      throw new Error('bad_request: maximum positions must be between 1 and 30');
    }
    if (body.maxNetLossUsd !== undefined && (typeof body.maxNetLossUsd !== 'number'
      || !Number.isFinite(body.maxNetLossUsd) || body.maxNetLossUsd < 0 || body.maxNetLossUsd > 1e12)) {
      throw new Error('bad_request: invalid remaining loss limit');
    }

    if (text === '') {
      return Response.json(
        { error: 'Describe the position you want to cover.', code: 'bad_request' },
        { status: 400 },
      );
    }
    if (text.length > MAX_TEXT) {
      return Response.json(
        { error: 'That is longer than this can read. Shorten it to the exposure itself.', code: 'bad_request' },
        { status: 400 },
      );
    }

    // A session continues a conversation; a follow-up answer is more of the
    // user's words about the same exposure, not a new request. The client
    // returns the session it was given rather than a transcript, so the server
    // is never reconstructing state from prose.
    const session = body.session as IntakeSession | undefined;

    const index = await timed('discovery', () => marketIndex());
    const engine = createJevEngine({ apiKey: requireKey() });
    let modelCall = 0;
    const venue = quoteSession({
      fetchEvent: async (id) => index.byId.get(id) ?? (await fetchEvent(id)),
      fetchBooks: (ids) => timed('books', () => fetchBooks(ids)),
      saveSnapshot: (books) => timed('snapshot', () => putSnapshot(books)),
    });
    const deps: IntakeDeps = {
      ...venue,
      onTiming: (name, milliseconds) => { timings[name] = milliseconds; },
      combinedShape: process.env.POLYHEDGE_COMBINED_INTAKE !== '0',
      execution: { quantityStep: 0.01, ...(body.maxLegs === undefined ? {} : { maxLegs: body.maxLegs as number }) },
      protectionGoal: body.maxNetLossUsd === undefined ? { kind: 'minimize_net_loss' }
        : { kind: 'limit_net_loss', maxNetLossUsd: body.maxNetLossUsd as number },
      engine: { ask: (state, questions) => timed(`model${++modelCall}`, () => engine.ask(state, questions)) },
      events: index.events,
      resolutionTextFor: (id) => index.resolutionText.get(id) ?? '',
      bracketLabelsFor: (id) => index.bracketLabels.get(id) ?? [],
      today: new Date(),
      newSessionId: () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      // Durable, because `bindQuote` re-hashes these books against the accepted
      // record before execution: a quote that cannot produce its books later
      // cannot be bound, and one nobody can bind cannot be executed.
    };

    const result = await timed('intake', () => intake(text, deps, session));

    // Everything but a quote is already in the plain register and crosses as
    // it is. A quote does not: the raw record carries token ids, hashes and
    // engine vocabulary, and its numbers are unrounded.
    if (result.kind !== 'quoted') {
      return respond({ result, indexedCount: index.events.length, tookMs: Date.now() - startedAt });
    }

    const event = index.events.find((e) => e.eventId === result.record.request.eventId);
    if (event === undefined) {
      throw new Error('quoted an event that is no longer indexed');
    }

    // The venue's own wording for each outcome, so a position is shown as the
    // question it actually is rather than as a bracket label we invented.
    const gamma = index.byId.get(event.eventId);
    const questionFor = (marketId: string): string =>
      gamma?.markets.find((m) => m.id === marketId)?.question ?? '';

    // The stops. Solved together against one pinned snapshot so the prices are
    // the same moment and can honestly be read side by side.
    const stops = await timed('options', () => buildBasketOptions(result.record.request, venue, {
      ruleFlags: result.record.meta.ruleFlags,
      correlationResidual: result.record.meta.correlationResidual,
      jevModelVersion: result.record.meta.jevModelVersion,
      calibrationMapVersion: result.record.meta.calibrationMapVersion,
    }, result.record));

    // Composed through the one shared path, which also re-measures every
    // alternative against the primary's target before it crosses the wire.
    const { view, optionRecords } = composeView({
      primary: result.record,
      event,
      stops,
      alternatives: result.alternatives,
      assumptions: result.assumptions,
      questionFor,
      linkFor: (marketId) => linkForMarket(gamma, marketId),
    });

    // Stored before it is shown. What the user is about to read has to be
    // retrievable later, exactly as it was, or "what did I agree to" has no
    // answer once prices move.
    const stored = await timed('store', () => putQuote(caller.id, result.record, view, null, 0, optionRecords));

    return respond({
      result: { kind: 'quoted', quoteId: stored.id, view },
      indexedCount: index.events.length,
      tookMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof LpNotOptimalError && error.phase === 'loss limit' && error.status === 'Infeasible') {
      return respond({ result: { kind: 'declined', reason: 'The available books and your budget cannot meet that remaining-loss limit. Increase the limit or budget and rebuild.' }, tookMs: Date.now() - startedAt });
    }
    if (error instanceof TooManyRequests) {
      return Response.json(
        { error: 'Too many requests. Give it a moment.', code: 'rate_limited' },
        { status: 429, headers: { 'retry-after': String(error.retryAfterSeconds) } },
      );
    }
    if (error instanceof Error && error.message.startsWith('bad_request')) {
      return Response.json(
        { error: 'That request was malformed or too large.', code: 'bad_request' },
        { status: 400 },
      );
    }
    return handleRouteError('api/intake', error);
  }
}
