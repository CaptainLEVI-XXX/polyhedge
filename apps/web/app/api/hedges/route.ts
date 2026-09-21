import { EventQuoteError } from '@polyhedge/engine';
import { structuredRequest } from '@polyhedge/intake';
import { LpNotOptimalError } from '@polyhedge/core';
import { structuredQuote } from '@/lib/structured-quote';
import { requireCaller, readJsonBody, rateLimit, TooManyRequests } from '@/lib/identity';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request) {
  try {
    const caller=requireCaller(request);rateLimit(caller,'structured',12,60_000);
    const req=structuredRequest(await readJsonBody(request,32*1024));
    const {stored,view,timings}=await structuredQuote(req,caller.id,null,0,request.signal);
    return Response.json({result:{kind:'quoted',quoteId:stored.id,view},timings});
  } catch(error) {
    if(error instanceof EventQuoteError)return Response.json({error:error.message,code:error.code},{status:error.code==='changed'?409:422});
    if(error instanceof TooManyRequests) return Response.json({error:'Please wait before building another hedge.'},{status:429,headers:{'Retry-After':String(error.retryAfterSeconds)}});
    if(error instanceof LpNotOptimalError && /infeasible/i.test(error.status))return Response.json({error:'No basket can meet these loss and spending limits with the available orders. Relax a limit or choose another market.',code:'infeasible'},{status:422});
    if(error instanceof LpNotOptimalError) return Response.json({error:'The solver could not establish a valid optimal basket within its limits. Try fewer positions or a different budget.'},{status:422});
    const message=error instanceof Error?error.message:'';
    if(message==='quote_deadline' || (error instanceof Error && error.name==='TimeoutError'))return Response.json({error:'The quote took too long. Please try again.',code:'timeout'},{status:504});
    if(message==='quote_busy')return Response.json({error:'The hedge builder is busy. Please try again shortly.'},{status:503,headers:{'Retry-After':'2'}});
    if(error instanceof SyntaxError || message.startsWith('bad_request'))return Response.json({error:'Select a market and supply every loss and limit as a valid amount.'},{status:400});
    // Errors here contain only public venue metadata or validation details; no model credentials.
    return Response.json({error:'Could not build this hedge. Refresh the market details and check its availability and loss limits.'},{status:422});
  }
}
