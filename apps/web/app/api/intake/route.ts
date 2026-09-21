import { createJevEngine } from '@polyhedge/questions';
import { fetchBooks, fetchEvent } from '@polyhedge/venue';
import { intake, type IntakeDeps, type IntakeSession } from '@polyhedge/intake';
import { marketIndex } from '@/lib/markets';
import { handleRouteError } from '@/lib/errors';

/** Node, never Edge: this route solves, and the solver is WASM. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TEXT = 2_000;

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
    const body = (await request.json()) as Body;
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
    return Response.json({ result, indexedCount: index.events.length });
  } catch (error) {
    return handleRouteError('api/intake', error);
  }
}
