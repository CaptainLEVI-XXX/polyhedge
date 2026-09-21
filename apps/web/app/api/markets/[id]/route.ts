import { familyEnabled } from '@/lib/event-family';
import { fetchEvent, eventSupport, type EventSelection } from '@polyhedge/venue';
import { handleRouteError } from '@/lib/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request, context:{params:Promise<{id:string}>}) {
  try {
    const {id}=await context.params;
    if (!/^\d+$/.test(id)) return Response.json({error:'Invalid event'},{status:400});
    const p=new URL(request.url).searchParams;
    const kind=p.get('kind');
    if (kind!=='numeric' && kind!=='binary' && kind!=='categorical') return Response.json({error:'Select a market type'},{status:400});
    const selection:EventSelection={kind,...(kind==='binary'?{marketId:p.get('marketId')??''}:{})};
    const event=await fetchEvent(id);
    const support=eventSupport(event,selection);
    if(!familyEnabled(kind)){support.eligible=false;support.reason='This market type is temporarily disabled.';}
    return Response.json({...support,eventId:id,selection,rules:event.markets.filter(m=>support.marketIds.includes(m.id)).map(m=>({marketId:m.id,text:m.description})),
      note:'Date shown is the venue end date. Read the rules for the observation period and payment timing.'});
  } catch(error){return handleRouteError('api/markets/detail',error);}
}
