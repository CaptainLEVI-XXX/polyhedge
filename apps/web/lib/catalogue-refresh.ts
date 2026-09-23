import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { parseEvent, openEventBatches, type GammaEvent } from '@polyhedge/venue';
import { indexEvent } from '@polyhedge/intake/retrieve';
import { eventListings } from './event-listings.js';
import type { MarketIndex, MarketCategory } from './markets.js';
import { atomicJson, readJson, encodeIndex, decodeIndex, emptyIndex, publishSnapshot } from './catalogue-store.js';

type Checkpoint = { version:1; generation:string; pages:number; cursor:string|null; startedAt:number };
type Chunk = { ids:string[]; snapshot:ReturnType<typeof encodeIndex> };
function indexPage(page:unknown[]):{ index:MarketIndex; ids:string[] } {
  const index=emptyIndex(), categories=new Map<string,MarketCategory>(), ids:string[]=[];
  for(const raw of page) {
    if(!raw||typeof raw!=='object'||!('id' in raw)||typeof raw.id!=='string')throw new Error('Invalid discovery event');
    if(ids.includes(raw.id))continue;
    ids.push(raw.id);
    const tags=new Set<string>();
    const entry=raw as {tags?:{slug?:unknown;label?:unknown}[]};
    if(Array.isArray(entry.tags))for(const tag of entry.tags){
      if(!tag||typeof tag.slug!=='string'||typeof tag.label!=='string'||tags.has(tag.slug))continue;
      tags.add(tag.slug);
      const category=categories.get(tag.slug)??{slug:tag.slug,label:tag.label,discoveredEvents:0,supportedEvents:0};
      category.discoveredEvents++;categories.set(tag.slug,category);
    }
    let event:GammaEvent;
    try{event=parseEvent(raw);}catch{continue;}
    const listings=eventListings(event);index.listings.push(...listings);
    if(listings.some(row=>row.eligible))for(const tag of tags)categories.get(tag)!.supportedEvents++;
    const numeric=indexEvent(event);
    if(numeric){
      index.events.push(numeric);
      index.resolutionText.set(event.id,event.markets[0]?.description??'');
      index.bracketLabels.set(event.id,event.markets.map(m=>m.groupItemTitle));
    }
  }
  index.categories=[...categories.values()];index.discoveredEvents=ids.length;
  return {index,ids};
}
function append(target:MarketIndex,part:MarketIndex) {
  target.listings.push(...part.listings);target.events.push(...part.events);
  for(const [key,value] of part.resolutionText)target.resolutionText.set(key,value);
  for(const [key,value] of part.bracketLabels)target.bracketLabels.set(key,value);
  const categories=new Map(target.categories.map(c=>[c.slug,c]));
  for(const c of part.categories){
    const old=categories.get(c.slug);
    categories.set(c.slug,old?{...c,discoveredEvents:old.discoveredEvents+c.discoveredEvents,supportedEvents:old.supportedEvents+c.supportedEvents}:c);
  }
  target.categories=[...categories.values()];target.discoveredEvents+=part.discoveredEvents;
}
/** Checkpoint page data before advancing its cursor. Never replace a good snapshot with a partial walk. */
export async function refreshCatalogue(store:string,fetchImpl:typeof fetch=fetch,
  progress:(count:number)=>Promise<void>=async()=>{}):Promise<MarketIndex> {
  const checkpointPath=join(store,'catalogue-checkpoint.json');
  let checkpoint:Checkpoint|null=null, index=emptyIndex();
  const seen=new Set<string>();
  try{
    const saved=await readJson<Checkpoint>(checkpointPath);
    if(saved.version===1&&/^[a-f0-9-]+$/.test(saved.generation)
      &&Number.isInteger(saved.pages)&&saved.pages>=0&&(saved.cursor===null||typeof saved.cursor==='string')
      &&Number.isFinite(saved.startedAt)&&Date.now()-saved.startedAt<24*60*60*1000){
      checkpoint=saved;
      for(let n=0;n<saved.pages;n++){
        const chunk=await readJson<Chunk>(join(store,'catalogue-pages',saved.generation,`${n}.json.gz`),true);
        append(index,decodeIndex(chunk.snapshot));chunk.ids.forEach(id=>seen.add(id));
      }
    }
  }catch{checkpoint=null;index=emptyIndex();seen.clear();}
  checkpoint??={version:1,generation:randomUUID(),pages:0,cursor:null,startedAt:Date.now()};
  if(checkpoint.pages===0||checkpoint.cursor!==null){
    for await(const batch of openEventBatches(fetchImpl,checkpoint.cursor??undefined)){
      const page=batch.events.filter(raw=>!(raw&&typeof raw==='object'&&'id' in raw&&seen.has(String(raw.id))));
      const part=indexPage(page);
      await atomicJson(join(store,'catalogue-pages',checkpoint.generation,`${checkpoint.pages}.json.gz`),
        {ids:part.ids,snapshot:encodeIndex(part.index)},true);
      checkpoint={...checkpoint,pages:checkpoint.pages+1,cursor:batch.nextCursor};
      await atomicJson(checkpointPath,checkpoint);
      append(index,part.index);part.ids.forEach(id=>seen.add(id));
      await progress(index.discoveredEvents);
    }
  }
  index.categories.sort((a,b)=>a.label.localeCompare(b.label));
  index.builtAt=Date.now();index.discoveryComplete=true;
  await publishSnapshot(index,store);
  await rm(checkpointPath,{force:true});
  await rm(join(store,'catalogue-pages',checkpoint.generation),{recursive:true,force:true});
  return index;
}
