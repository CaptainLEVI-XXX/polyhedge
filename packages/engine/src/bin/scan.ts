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
console.log(JSON.stringify({
  scanned: scans.length,
  usable: usable.length,
  gate: {
    question: 'at least 2 underlyings with a valid ladder and >= $10,000 minimum bracket payout',
    passing: usable.filter((s) => s.minPayoutUsd >= 10_000).map((s) => s.slug),
  },
  scans: scans.sort((a, b) => b.minPayoutUsd - a.minPayoutUsd),
}, null, 2));
