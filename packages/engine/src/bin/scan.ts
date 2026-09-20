#!/usr/bin/env node
import { fetchBooks, searchEvents } from '@polyhedge/venue';
import { scanEvent, type EventScan } from '../scan.js';

const queries = process.argv.slice(2);
const terms = queries.length > 0 ? queries : ['bitcoin price', 'ethereum price', 'solana price'];

const scans: EventScan[] = [];
for (const q of terms) {
  for (const event of await searchEvents(q)) {
    const tokenIds = event.markets.map((m) => m.yesTokenId).filter(Boolean);
    const books = tokenIds.length > 0 ? await fetchBooks(tokenIds) : [];
    scans.push(scanEvent(event, new Map(books.map((b) => [b.assetId, b]))));
  }
}

const usable = scans.filter((s) => s.validLadder && s.feeKnown);

// Add best hedges to each scan for reporting
const scansWithBestHedges = scans.map((s) => {
  const bestBelowHedge = s.belowHedges.reduce<typeof s.belowHedges[0] | null>((best, h) => {
    return !best || h.capacityUsd > best.capacityUsd ? h : best;
  }, null);
  const bestAboveHedge = s.aboveHedges.reduce<typeof s.aboveHedges[0] | null>((best, h) => {
    return !best || h.capacityUsd > best.capacityUsd ? h : best;
  }, null);
  return { ...s, bestBelowHedge, bestAboveHedge };
});

console.log(JSON.stringify({
  scanned: scans.length,
  usable: usable.length,
  gate: {
    question: 'at least 2 underlyings where some one-sided threshold hedge spanning 2+ brackets has >= $10,000 of capacity at or below 50c',
    passing: usable.filter((s) => s.bestMultiBracketCapacityUsd >= 10_000).map((s) => s.slug),
  },
  scans: scansWithBestHedges.sort((a, b) => b.bestMultiBracketCapacityUsd - a.bestMultiBracketCapacityUsd),
}, null, 2));
