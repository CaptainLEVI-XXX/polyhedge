import { eventSupport, type EventKind, type EventSelection, type GammaEvent } from '@polyhedge/venue';
import { subjectWords } from '@polyhedge/intake/retrieve';

export interface EventListing {
  id: string; eventId: string; selection: EventSelection; title: string; slug: string;
  categories: string[]; kind: EventKind; date: string; eligible: boolean; reason: string | null;
}
export function eventListings(event: GammaEvent): EventListing[] {
  const selections: EventSelection[] = [{kind:'numeric'}, ...(event.negRisk ? [{kind:'categorical' as const}] : []),
    ...event.markets.map(m => ({kind:'binary' as const,marketId:m.id}))];
  return selections.flatMap(selection => {
    const support = eventSupport(event,selection);
    if (selection.kind === 'numeric' && !support.eligible) return [];
    return [{id:`${event.id}:${selection.kind}:${selection.marketId ?? ''}`,eventId:event.id,selection,
      title:support.title,slug:event.slug,categories:event.tags,kind:selection.kind,date:support.observationAt,
      eligible:support.eligible,reason:support.reason}];
  });
}
const aliases: Record<string,string> = {btc:'bitcoin',eth:'ethereum',ether:'ethereum',temp:'temperature',weather:'temperature',fed:'fomc'};
const tokens = (text:string) => subjectWords(text).map(t => aliases[t] ?? t);
interface SearchIndex {
  search:(query:string)=>EventListing[];
  titles:Map<string,Set<number>>;
  dates:{time:number;id:number}[];
}
const searchHost=globalThis as typeof globalThis & { polyhedgeSearchIndexesV2?:WeakMap<EventListing[],SearchIndex> };
const indexes=searchHost.polyhedgeSearchIndexesV2??=new WeakMap<EventListing[],SearchIndex>();
function buildSearchIndex(rows:EventListing[]):SearchIndex {
  const cached=indexes.get(rows);if(cached)return cached;
  const postings=new Map<string,Set<number>>(),titles=new Map<string,Set<number>>();
  const dates:{time:number;id:number}[]=[];
  const add=(map:Map<string,Set<number>>,word:string,id:number)=>{
    let hits=map.get(word);if(!hits){hits=new Set();map.set(word,hits);}hits.add(id);
  };
  rows.forEach((row,id)=>{
    const words=new Set(tokens(row.title));
    for(const word of words){add(titles,word,id);add(postings,word,id);}
    for(const word of new Set(tokens(row.categories.join(' '))))add(postings,word,id);
    const time=Date.parse(row.date);
    if(row.eligible&&Number.isFinite(time))dates.push({time,id});
  });
  dates.sort((a,b)=>a.time-b.time||a.id-b.id);
  const index:SearchIndex={titles,dates,search:query=>{
    const terms=[...new Set(tokens(query))];if(!terms.length)return rows;
    const lists=terms.map(term=>postings.get(term)??new Set<number>()).sort((a,b)=>a.size-b.size);
    // Iterate the smallest posting list, checking membership in the others.
    return [...lists[0]!].filter(id=>lists.every(hits=>hits.has(id))).map(id=>rows[id]!);
  }};
  indexes.set(rows,index);return index;
}
export function listingIndex(rows:EventListing[]) { return buildSearchIndex(rows).search; }
function lowerBound(dates:SearchIndex['dates'],time:number):number {
  let lo=0,hi=dates.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(dates[mid]!.time<time)lo=mid+1;else hi=mid;}
  return lo;
}
/** Restrict the date window before ranking lexical matches. Never proves exposure fit. */
export function exposureListings(rows:EventListing[],text:string,date:string,includeNumeric:boolean|'only'=false):EventListing[] {
  const index=buildSearchIndex(rows),start=Date.parse(`${date.slice(0,10)}T00:00:00Z`);
  if(!Number.isFinite(start))return [];
  const now=Date.now(),eligible=new Set<number>();
  const end=lowerBound(index.dates,start+86_400_000);
  for(let i=lowerBound(index.dates,Math.max(start,now));i<end;i++){
    const row=index.dates[i]!;if(row.time>now&&(includeNumeric==='only'?rows[row.id]!.kind==='numeric':includeNumeric||rows[row.id]!.kind!=='numeric'))eligible.add(row.id);
  }
  const scores=new Map<number,number>();
  for(const token of new Set(tokens(text))){
    if(['loss','los','lose','protection','money','want','need','would','could','cost','hold','holding','budget','spending','potential','cover','coverage','target','listed','rule','source','accept','proxy','busines','position','otherwise','existing'].includes(token))continue;
    const hits=index.titles.get(token);if(!hits)continue;
    const weight=Math.log(1+rows.length/hits.size);
    const smaller=hits.size<eligible.size?hits:eligible;
    for(const id of smaller)if(hits.has(id)&&eligible.has(id))scores.set(id,(scores.get(id)??0)+weight);
  }
  const ranked=[...scores].sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
  const categoricalParents=new Set(ranked.filter(([i])=>rows[i]!.kind==='categorical').map(([i])=>rows[i]!.eventId));
  return ranked.map(([i])=>rows[i]!).filter(row=>row.kind==='categorical'||!categoricalParents.has(row.eventId)).slice(0,5);
}
