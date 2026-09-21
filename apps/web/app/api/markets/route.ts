import { marketIndex, discoveryStatus } from '@/lib/markets';
import { handleRouteError } from '@/lib/errors';
import { candidatesForText } from '@polyhedge/intake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tags come from the venue, including tags with no compiler-compatible events. */
export async function GET(request: Request) {
  try {
    const index = await marketIndex();
    const params = new URL(request.url).searchParams;
    const category = params.get('category');
    const query = (params.get('q') ?? '').trim().toLowerCase();
    const matching = query ? candidatesForText(query, index.events) : index.events;
    const events = matching.filter(event => {
      const source = index.byId.get(event.eventId);
      return !category || source?.tags.includes(category);
    });
    return Response.json({
      categories: index.categories,
      discoveryComplete: index.discoveryComplete,
      discovery: discoveryStatus(),
      builtAt: index.builtAt,
      discoveredEvents: index.discoveredEvents,
      supportedEvents: index.events.length,
      scope: 'Numeric bracket markets only. Category presence does not mean every event can be hedged.',
      events: events.map(event => ({ id: event.eventId, title: event.title, slug: event.slug,
        observationAt: event.observationAt, unit: event.ladder.unit,
        categories: index.byId.get(event.eventId)?.tags ?? [] })),
    });
  } catch (error) {
    return handleRouteError('api/markets', error);
  }
}
