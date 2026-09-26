import { getQuote,NotYours } from '@/lib/store';
import { requireCaller,rateLimit,TooManyRequests } from '@/lib/identity';
import { marketHistories } from '@/lib/market-history';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const caller=requireCaller(request);rateLimit(caller,'market-history',60,60_000);
    const {id}=await context.params;
    const quote=await getQuote(id,caller.id);
    const tokens=[...new Set(quote.view.options.flatMap(o=>o.ladder.positions.map(p=>p.tokenId)))];
    return Response.json({histories:await marketHistories(tokens)},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    if(error instanceof NotYours)return Response.json({error:'No such quote.'},{status:404});
    if(error instanceof TooManyRequests)return Response.json({error:'Please retry shortly.'},{status:429,headers:{'Retry-After':String(error.retryAfterSeconds)}});
    return Response.json({error:'History unavailable.'},{status:503});
  }
}
