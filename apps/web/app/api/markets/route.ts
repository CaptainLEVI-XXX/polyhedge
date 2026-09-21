import { createHash } from 'node:crypto';
import { familyEnabled } from '@/lib/event-family';
import { marketIndex, discoveryStatus, searchListings } from '@/lib/markets';
import { eventListings, listingIndex } from '@/lib/event-listings';
import { searchEvents, fetchEvent } from '@polyhedge/venue';
import { handleRouteError } from '@/lib/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const index = await marketIndex(true);
    const p = new URL(request.url).searchParams;
    const q = (p.get('q') ?? '').trim().slice(0,160);
    let rows = searchListings(index,q);
    if (!index.discoveryComplete && q.length >= 2) {
      const candidates=await searchEvents(q);
      // Search responses may omit acceptance/fee fields. Verify a bounded set of full details.
      const details=await Promise.allSettled(candidates.slice(0,3).map(e=>fetchEvent(e.id)));
      const live=details.flatMap(r=>r.status==='fulfilled'?eventListings(r.value):[]);
      rows=listingIndex([...new Map([...rows,...live].map(r=>[r.id,r])).values()])(q);
    }
    const category=p.get('category'), kind=p.get('kind'), date=p.get('date');
    rows = rows.map(r=>familyEnabled(r.kind)?r:{...r,eligible:false,reason:'This market type is temporarily disabled.'});
    rows = rows.filter(r => (!category || r.categories.includes(category)) && (!kind || r.kind===kind)
      && (!date || r.date.startsWith(date)) && (p.get('unsupported')==='1' || r.eligible));
    rows.sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const limit=Math.min(100,Math.max(1,Number(p.get('limit') ?? 25) || 25));
    const offset=Math.max(0,Number(p.get('offset') ?? 0) || 0);
    const currentVersion=createHash('sha256').update(JSON.stringify([index.builtAt,q,category,kind,date,p.get('unsupported'),limit])).digest('hex').slice(0,24);
    const version=p.get('version');
    if (version && version!==currentVersion) return Response.json({error:'Catalogue changed; search again.'},{status:409});
    return Response.json({...(p.get('categoryVersion')===String(index.builtAt)?{}:{categories:index.categories}),catalogueVersion:String(index.builtAt),discoveryComplete:index.discoveryComplete,discovery:discoveryStatus(),
      version:currentVersion,total:rows.length,events:rows.slice(offset,offset+limit),
      nextOffset:offset+limit<rows.length ? offset+limit : null});
  } catch(error) { return handleRouteError('api/markets',error); }
}
