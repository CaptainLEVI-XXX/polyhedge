import { createJevEngine } from '@polyhedge/questions';
import { fetchBooks, fetchEvent } from '@polyhedge/venue';
import { buildBasketOptions, intake, type IntakeDeps, type IntakeSession } from '@polyhedge/intake';
import { marketIndex } from '@/lib/markets';
import { handleRouteError } from '@/lib/errors';
import { toOptionView, toQuotedView } from '@/lib/view-model';
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
}

function requireKey(): string {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (key === undefined || key.trim() === '') {
    throw new Error('AI_GATEWAY_API_KEY is not set');
  }
  return key;
}

export async function POST(request: Request) {
  try {
    const caller = requireCaller(request);
    rateLimit(caller, 'intake', LIMIT_PER_MINUTE, 60_000);

    const body = (await readJsonBody(request, MAX_BODY_BYTES)) as Body;
    const text = typeof body.text === 'string' ? body.text.trim() : '';

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

    const index = await marketIndex();
    const deps: IntakeDeps = {
      engine: createJevEngine({ apiKey: requireKey() }),
      events: index.events,
      resolutionTextFor: (id) => index.resolutionText.get(id) ?? '',
      bracketLabelsFor: (id) => index.bracketLabels.get(id) ?? [],
      today: new Date(),
      newSessionId: () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      fetchEvent: async (id) => index.byId.get(id) ?? (await fetchEvent(id)),
      fetchBooks,
      // Durable, because `bindQuote` re-hashes these books against the accepted
      // record before execution: a quote that cannot produce its books later
      // cannot be bound, and one nobody can bind cannot be executed.
      saveSnapshot: putSnapshot,
    };

    const result = await intake(text, deps, session);

    // Everything but a quote is already in the plain register and crosses as
    // it is. A quote does not: the raw record carries token ids, hashes and
    // engine vocabulary, and its numbers are unrounded.
    if (result.kind !== 'quoted') {
      return Response.json({ result, indexedCount: index.events.length });
    }

    const event = index.events.find((e) => e.eventId === result.record.request.eventId);
    if (event === undefined) {
      throw new Error('quoted an event that is no longer indexed');
    }

    const unit = event.ladder.unit;
    // The venue's own wording for each outcome, so a position is shown as the
    // question it actually is rather than as a bracket label we invented.
    const gamma = index.byId.get(event.eventId);
    const questionFor = (marketId: string): string =>
      gamma?.markets.find((m) => m.id === marketId)?.question ?? '';

    // The stops. Solved together against one pinned snapshot so the three
    // prices are the same moment and can honestly be read side by side.
    const stops = await buildBasketOptions(result.record.request, deps);

    const view = toQuotedView(
      result.record,
      event,
      [
        ...stops.map((stop, i) =>
          // Same shape at different budgets, so each record's own coverage is
          // already measured against the real loss.
          toOptionView(`stop-${i}`, stop.name, stop.reason, stop.record, unit, questionFor),
        ),
        ...result.alternatives.map((alt) =>
          toOptionView(alt.kind, alt.kind.replace(/_/g, ' '), alt.reason, alt.record, unit, questionFor),
        ),
      ],
      result.assumptions,
    );

    // An alternative CHANGES the shape, so it solves a different target and its
    // own residual flatters it — a further strike reports perfect coverage for
    // strictly less protection. Overwrite with the re-measurement against the
    // original target before anything crosses the wire, because the safest
    // place to close that trap is the boundary, not every renderer downstream.
    result.alternatives.forEach((alt, i) => {
      const option = view.options[stops.length + i];
      if (option === undefined) return;
      const ratio = Math.max(0, Math.min(1, alt.residualVsPrimary.coverageRatio));
      option.coverageRatio = ratio;
      option.coverageLabel = `${Math.floor(ratio * 100)}%`;
    });

    // Stored before it is shown. What the user is about to read has to be
    // retrievable later, exactly as it was, or "what did I agree to" has no
    // answer once prices move.
    const stored = await putQuote(caller.id, result.record, view);

    return Response.json({
      result: { kind: 'quoted', quoteId: stored.id, view },
      indexedCount: index.events.length,
    });
  } catch (error) {
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
