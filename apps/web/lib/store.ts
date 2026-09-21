import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSnapshot, saveSnapshot, type ClobBook } from '@polyhedge/venue';
import type { QuoteRecord } from '@polyhedge/engine';
import type { QuotedView } from './view-model.js';

/**
 * Durable quotes and the books they were priced against.
 *
 * This is a prerequisite for review and execution, not a cleanup task.
 * `bindQuote` re-hashes the stored books and refuses if they do not match the
 * accepted record, so a quote that cannot produce its books later cannot be
 * bound — and a quote nobody can bind cannot be executed.
 *
 * On the snapshot id: it is a CONTENT hash. Re-pricing against unchanged books
 * legitimately returns the same id, so sameness of snapshot means "the market
 * did not move", never "nothing happened". What must be new on a re-price is
 * the QUOTE, and that is the thing this file gives its own identity.
 *
 * Filesystem-backed, which is the right size for one instance. The execution
 * journal already uses Postgres; moving these there is a change of driver, not
 * of design, and the interface below is what stays.
 */

const ROOT = process.env.POLYHEDGE_STORE ?? join(process.cwd(), '.polyhedge-store');
const SNAPSHOTS = join(ROOT, 'snapshots');
const QUOTES = join(ROOT, 'quotes');

export interface StoredQuote {
  id: string;
  /** Increments on each re-price. A new revision is a NEW row, never an edit. */
  revision: number;
  /** The revision this one re-priced from, if any. */
  previousId: string | null;
  owner: string;
  record: QuoteRecord;
  view: QuotedView;
  /** Set once, at review. From then on this row never changes again. */
  acceptedAt: string | null;
  createdAt: string;
  optionRecords?: Record<string, QuoteRecord>;
  acceptedOptionId?: string;
}

export class QuoteImmutable extends Error {
  constructor(id: string) {
    super(`quote ${id} was accepted and cannot be changed`);
    this.name = 'QuoteImmutable';
  }
}

export class NotYours extends Error {
  constructor() {
    super('not yours');
    this.name = 'NotYours';
  }
}

/** Stores the books and returns their content hash, for `saveSnapshot` in deps. */
export async function putSnapshot(books: ClobBook[]): Promise<string> {
  return saveSnapshot(SNAPSHOTS, books);
}

export async function getSnapshot(id: string): Promise<ClobBook[]> {
  return loadSnapshot(SNAPSHOTS, id);
}

async function quotePath(id: string): Promise<string> {
  await mkdir(QUOTES, { recursive: true });
  return join(QUOTES, `${id}.json`);
}

export async function putQuote(
  owner: string,
  record: QuoteRecord,
  view: QuotedView,
  previousId: string | null = null,
  revision = 0,
  optionRecords?: Record<string, QuoteRecord>,
): Promise<StoredQuote> {
  const stored: StoredQuote = {
    id: randomUUID(),
    revision,
    previousId,
    owner,
    record,
    view,
    acceptedAt: null,
    createdAt: new Date().toISOString(),
    ...(optionRecords ? { optionRecords } : {}),
  };
  await writeFile(await quotePath(stored.id), JSON.stringify(stored), 'utf8');
  return stored;
}

export async function getQuote(id: string, owner: string): Promise<StoredQuote> {
  let text: string;
  try {
    text = await readFile(await quotePath(id), 'utf8');
  } catch {
    // Deliberately the same error as a wrong owner: a stranger must not be able
    // to tell an id that exists from one that does not.
    throw new NotYours();
  }
  const stored = JSON.parse(text) as StoredQuote;
  if (stored.owner !== owner) throw new NotYours();
  return stored;
}

/**
 * Freezes a quote. Idempotent, because a double-click is not a second decision.
 *
 * After this the row is never written again. Re-pricing produces a new row via
 * `putQuote` with `previousId` set, so what the user agreed to remains readable
 * exactly as it was.
 */
async function acceptSelected(id: string, owner: string, optionId?: string): Promise<StoredQuote> {
  const stored = await getQuote(id, owner);
  if (stored.acceptedAt !== null) {
    if (optionId !== undefined && optionId !== stored.acceptedOptionId) throw new QuoteImmutable(id);
    return stored;
  }
  if (stored.optionRecords && optionId === undefined) throw new Error('bad_request: select a basket');
  const selected = optionId === undefined ? stored.record
    : Object.hasOwn(stored.optionRecords ?? {}, optionId) ? stored.optionRecords![optionId] : undefined;
  if (!selected) throw new Error('bad_request: basket unavailable; rebuild this quote');
  const accepted: StoredQuote = { ...stored, record: selected, acceptedAt: new Date().toISOString(),
    ...(optionId === undefined ? {} : { acceptedOptionId: optionId }) };
  await writeFile(await quotePath(id), JSON.stringify(accepted), 'utf8');
  return accepted;
}

// Serialize accept operations in this single-instance filesystem store so two
// simultaneous selections cannot both replace the accepted record.
const accepting = new Map<string, Promise<StoredQuote>>();
export async function acceptQuote(id: string, owner: string, optionId?: string): Promise<StoredQuote> {
  const previous = accepting.get(id);
  const pending = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => acceptSelected(id, owner, optionId));
  accepting.set(id, pending);
  try { return await pending; }
  finally { if (accepting.get(id) === pending) accepting.delete(id); }
}

/** Guards any write that is not the one-time accept. */
export async function assertMutable(id: string, owner: string): Promise<StoredQuote> {
  const stored = await getQuote(id, owner);
  if (stored.acceptedAt !== null) throw new QuoteImmutable(id);
  return stored;
}

/** Only used by the runtime check; not a product surface. */
export async function countSnapshots(): Promise<number> {
  try {
    return (await readdir(SNAPSHOTS)).length;
  } catch {
    return 0;
  }
}
