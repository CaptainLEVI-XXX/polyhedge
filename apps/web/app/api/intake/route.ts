import { createJevEngine } from '@polyhedge/questions';
import { fetchBooks, fetchEvent } from '@polyhedge/venue';
import { intake, type IntakeDeps, type IntakeSession } from '@polyhedge/intake';
import { marketIndex } from '@/lib/markets';
import { handleRouteError } from '@/lib/errors';
import { toOptionView, toQuotedView } from '@/lib/view-model';
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
      // Snapshots become durable in their own task; a quote that cannot produce
      // its books later cannot be bound, so this is a placeholder, not a design.
      saveSnapshot: async () => `unsaved-${Date.now().toString(36)}`,
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
    const view = toQuotedView(
      result.record,
      event,
      [
        toOptionView('recommended', 'Recommended', '', result.record, unit),
        ...result.alternatives.map((alt) =>
          // An alternative's coverage is re-measured against the PRIMARY's
          // target. Its own residual always flatters it, so it never crosses.
          toOptionView(alt.kind, alt.kind.replace(/_/g, ' '), alt.reason, alt.record, unit),
        ),
      ],
      result.assumptions,
    );

    // Alternatives change the shape, so their own coverage is not comparable.
    // Overwrite it with the honest re-measurement before anything is shown.
    result.alternatives.forEach((alt, i) => {
      const option = view.options[i + 1];
      if (option === undefined) return;
      option.coverageRatio = alt.residualVsPrimary.coverageRatio;
      option.coverageLabel = `${Math.floor(Math.max(0, Math.min(1, alt.residualVsPrimary.coverageRatio)) * 100)}%`;
    });

    return Response.json({ result: { kind: 'quoted', view }, indexedCount: index.events.length });
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
