import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { MarketIndex } from './markets.js';
import type { EventListing } from './event-listings.js';

export const catalogueStore = () => process.env.POLYHEDGE_STORE ?? join(process.cwd(), '.polyhedge-store');
const compress = promisify(gzip), decompress = promisify(gunzip);
// Parent metadata is repeated for every binary selection in the old snapshot.
// Group it once per event; rule blobs are fetched only for shortlisted events.
type Row = [EventListing['selection'], string, string, boolean, string | null, string?];
type Group = [string, string, string[], Row[]];
interface Snapshot {
  version: 5; builtAt: number; discoveryComplete: boolean; discoveredEvents: number;
  groups: Group[]; categories: MarketIndex['categories']; events: MarketIndex['events'];
  resolutionText: [string,string][]; bracketLabels: [string,string[]][];
}
export function emptyIndex(): MarketIndex {
  return { listings: [], categories: [], events: [], resolutionText: new Map(), bracketLabels: new Map(),
    byId: new Map(), builtAt: 0, discoveredEvents: 0, discoveryComplete: false };
}
export function encodeIndex(index: MarketIndex): Snapshot {
  const groups = new Map<string,Group>();
  for (const row of index.listings) {
    let group = groups.get(row.eventId);
    if (!group) { group = [row.eventId,row.slug,row.categories,[]]; groups.set(row.eventId,group); }
    const packed:Row=[row.selection,row.title,row.date,row.eligible,row.reason];
    if(row.searchText)packed[5]=row.searchText;
    group[3].push(packed);
  }
  return { version: 5, builtAt: index.builtAt, discoveryComplete: index.discoveryComplete,
    discoveredEvents: index.discoveredEvents, groups: [...groups.values()], categories: index.categories,
    events: index.events, resolutionText: [...index.resolutionText], bracketLabels: [...index.bracketLabels] };
}
export function decodeIndex(raw: Snapshot): MarketIndex {
  if (raw.version !== 5 || !Array.isArray(raw.groups) || !Array.isArray(raw.events)
    || !Number.isFinite(raw.builtAt) || typeof raw.discoveryComplete !== 'boolean') throw new Error('Invalid catalogue snapshot');
  return { ...emptyIndex(), builtAt:raw.builtAt, discoveryComplete:raw.discoveryComplete, discoveredEvents:raw.discoveredEvents,
    categories:raw.categories, events:raw.events, listings: raw.groups.flatMap(([eventId,slug,categories,rows]) =>
    rows.map(([selection,title,date,eligible,reason,searchText]) => ({ id:`${eventId}:${selection.kind}:${selection.marketId ?? ''}`,
      eventId,slug,categories,selection,title,date,eligible,reason,...(searchText?{searchText}:{}),kind:selection.kind }))),
    resolutionText: new Map(raw.resolutionText), bracketLabels: new Map(raw.bracketLabels) };
}
export async function atomicJson(path:string, value:unknown, zipped=false):Promise<void> {
  await mkdir(dirname(path),{recursive:true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  const json = JSON.stringify(value);
  await writeFile(temporary, zipped ? await compress(json) : json);
  await rename(temporary,path);
}
export async function readJson<T>(path:string,zipped=false):Promise<T> {
  const bytes=await readFile(path);
  return JSON.parse(zipped ? (await decompress(bytes)).toString() : bytes.toString()) as T;
}
export async function loadSnapshot(store=catalogueStore()):Promise<MarketIndex> {
  return decodeIndex(await readJson<Snapshot>(join(store,'catalogue.json.gz'),true));
}
export async function publishSnapshot(index:MarketIndex,store=catalogueStore()):Promise<void> {
  await atomicJson(join(store,'catalogue.json.gz'),encodeIndex(index),true);
}
/** Migration is worker-only: requests never parse the old 95 MB cache. */
export async function migrateSnapshot(store=catalogueStore()):Promise<MarketIndex|null> {
  try { return await loadSnapshot(store); } catch { /* Try the previous format once. */ }
  try {
    const raw=await readJson<Record<string,unknown>>(join(store,'market-index.json'));
    if(raw.version!==4 || !Array.isArray(raw.events)||!Array.isArray(raw.listings))return null;
    const index={...emptyIndex(),...raw,resolutionText:new Map(raw.resolutionText as [string,string][]),
      bracketLabels:new Map(raw.bracketLabels as [string,string[]][]),byId:new Map()} as MarketIndex;
    await publishSnapshot(index,store);
    return index;
  } catch { return null; }
}
export async function snapshotStamp(store=catalogueStore()):Promise<number> {
  try { return (await stat(join(store,'catalogue.json.gz'))).mtimeMs; } catch { return 0; }
}
