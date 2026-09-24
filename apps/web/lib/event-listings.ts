import { eventSupport, type EventKind, type EventSelection, type GammaEvent } from '@polyhedge/venue';
import { subjectWords } from '@polyhedge/intake/retrieve';

export interface EventListing {
  id: string; eventId: string; selection: EventSelection; title: string; slug: string;
  searchText?: string; categories: string[]; kind: EventKind; date: string; eligible: boolean; reason: string | null;
}
export function eventListings(event: GammaEvent): EventListing[] {
  const selections: EventSelection[] = [{kind:'numeric'}, ...(event.negRisk ? [{kind:'categorical' as const}] : []),
    ...event.markets.map(m => ({kind:'binary' as const,marketId:m.id}))];
  return selections.flatMap(selection => {
    const support = eventSupport(event,selection);
    if (selection.kind === 'numeric' && !support.eligible) return [];
    return [{id:`${event.id}:${selection.kind}:${selection.marketId ?? ''}`,eventId:event.id,selection,
      title:support.title,searchText:`${event.title} ${support.title}`,slug:event.slug,categories:event.tags,kind:selection.kind,date:support.observationAt,
      eligible:support.eligible,reason:support.reason}];
  });
}
const aliases: Record<string,string> = {btc:'bitcoin',eth:'ethereum',ether:'ethereum',temp:'temperature',weather:'temperature',fed:'fomc',winner:'win',winning:'win',wins:'win'};
const tokens = (text:string) => subjectWords(text).map(t => aliases[t] ?? t);
interface SearchIndex {
  search:(query:string)=>EventListing[];
  titles:Map<string,Set<number>>;
  dates:{time:number;id:number}[];
}
const searchHost=globalThis as typeof globalThis & { polyhedgeSearchIndexesV3?:WeakMap<EventListing[],SearchIndex> };
const indexes=searchHost.polyhedgeSearchIndexesV3??=new WeakMap<EventListing[],SearchIndex>();
function buildSearchIndex(rows:EventListing[]):SearchIndex {
  const cached=indexes.get(rows);if(cached)return cached;
  const postings=new Map<string,Set<number>>(),titles=new Map<string,Set<number>>();
  const dates:{time:number;id:number}[]=[];
  const add=(map:Map<string,Set<number>>,word:string,id:number)=>{
    let hits=map.get(word);if(!hits){hits=new Set();map.set(word,hits);}hits.add(id);
  };
  rows.forEach((row,id)=>{
    const words=new Set(tokens(row.searchText??`${row.slug.replace(/-/g,' ')} ${row.title}`));
    for(const word of words){add(titles,word,id);add(postings,word,id);}
    for(const word of new Set(tokens(row.categories.join(' '))))add(postings,word,id);
    const time=Date.parse(row.date);
    if(Number.isFinite(time))dates.push({time,id});
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
/** Restrict to the requested day or latest-date ceiling before lexical ranking. Never proves exposure fit. */
export function exposureListings(rows:EventListing[],text:string,date:string|null,includeNumeric:boolean|'only'=false,dateMode:'exact'|'ceiling'='exact',limit=5,includeUnavailable=false):EventListing[] {
  const index=buildSearchIndex(rows),start=date?Date.parse(`${date.slice(0,10)}T00:00:00Z`):Date.now();
  if(!Number.isFinite(start))return [];
  const now=Date.now(),eligible=new Set<number>();
  const cutoff=!date?Infinity:dateMode==='ceiling'&&date.includes('T')?Date.parse(date)+1:start+86_400_000;
  const end=lowerBound(index.dates,cutoff);
  for(let i=lowerBound(index.dates,!date||dateMode==='ceiling'?now:Math.max(start,now));i<end;i++){
    const row=index.dates[i]!;if((includeUnavailable||rows[row.id]!.eligible)&&matchesPeriod(rows[row.id]!,text)&&row.time>now&&(includeNumeric==='only'?rows[row.id]!.kind==='numeric':includeNumeric||rows[row.id]!.kind!=='numeric'))eligible.add(row.id);
  }
  const scores=new Map<number,number>();
  for(const token of new Set(tokens(text))){
    if(['loss','los','lose','protection','money','want','need','would','could','cost','hold','holding','budget','spending','potential','cover','coverage','target','listed','rule','source','accept','proxy','busines','position','otherwise','existing','increase','decrease','basi','point','bps','rate','interest','change','dollar','per','reaching'].includes(token))continue;
    const hits=index.titles.get(token);if(!hits)continue;
    const weight=Math.log(1+rows.length/hits.size);
    const smaller=hits.size<eligible.size?hits:eligible;
    for(const id of smaller)if(hits.has(id)&&eligible.has(id))scores.set(id,(scores.get(id)??0)+weight);
  }
  const ranked=[...scores].sort((a,b)=>b[1]-a[1]||(dateMode==='ceiling'?Date.parse(rows[b[0]]!.date)-Date.parse(rows[a[0]]!.date):0)||a[0]-b[0]);
  const categoricalParents=new Set(ranked.filter(([i])=>rows[i]!.kind==='categorical'&&rows[i]!.eligible).map(([i])=>rows[i]!.eventId));
  return ranked.map(([i])=>rows[i]!).filter(row=>row.kind==='numeric'||row.kind==='categorical'||!categoricalParents.has(row.eventId)).slice(0,limit);
}

/** A named month/season narrows discovery without inventing an exact protection date. */
function matchesPeriod(row:EventListing,text:string):boolean {
  const season=/\b(20\d{2})\s*[-–/]\s*(20\d{2}|\d{2})\b(?!-\d)/.exec(text);
  if(season){
    const end=season[2]!.length===2?season[1]!.slice(0,2)+season[2]:season[2]!;
    const label=row.searchText??row.title;
    const candidate=/\b(20\d{2})\s*[-–/]\s*(20\d{2}|\d{2})\b(?!-\d)/.exec(label);
    if(!candidate||candidate[1]!==season[1]||(candidate[2]!.length===2?candidate[1]!.slice(0,2)+candidate[2]:candidate[2])!==end)return false;
  }
  const month=/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i.exec(text);
  if(month){
    const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
    const date=new Date(row.date);
    if(date.getUTCFullYear()!==Number(month[2])||date.getUTCMonth()!==months.indexOf(month[1]!.toLowerCase()))return false;
  }
  return true;
}
