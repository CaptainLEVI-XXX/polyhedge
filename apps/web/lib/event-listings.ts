import { eventSupport, type EventKind, type EventSelection, type GammaEvent } from '@polyhedge/venue';
import { subjectWords } from '@polyhedge/intake';

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
export function listingIndex(rows: EventListing[]) {
  const postings = new Map<string,Set<number>>();
  rows.forEach((row,i) => {
    for (const token of new Set(tokens(`${row.title} ${row.categories.join(' ')}`))) {
      const set = postings.get(token) ?? new Set<number>(); set.add(i); postings.set(token,set);
    }
  });
  return (query:string) => {
    const terms = tokens(query);
    if (!terms.length) return rows;
    let matches: Set<number> | undefined;
    for (const term of terms) {
      const hits = postings.get(term) ?? new Set<number>();
      matches = matches === undefined ? new Set(hits) : new Set([...matches].filter(i => hits.has(i)));
    }
    return [...(matches ?? [])].map(i => rows[i]!);
  };
}
