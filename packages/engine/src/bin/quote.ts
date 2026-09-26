#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fetchBooks, fetchEvent, saveSnapshot } from '@polyhedge/venue';
import { quote, type QuoteRequest } from '../quote.js';

const file = process.argv[2];
if (!file) throw new Error('usage: quote <request.json> [snapshotDir]');
const dir = process.argv[3] ?? './snapshots';

const request = JSON.parse(await readFile(file, 'utf8')) as QuoteRequest;
const record = await quote(request, {
  fetchEvent,
  fetchBooks,
  saveSnapshot: (books) => saveSnapshot(dir, books),
});
console.log(JSON.stringify(record, null, 2));
