import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClobBook } from './schemas.js';

/**
 * Matches the ALREADY-PARSED `ClobBook` shape as stored on disk (numeric
 * `priceMicros`), not the raw Gamma/CLOB wire shape that `parseBook` expects.
 */
const parsedLevelSchema = z.object({ priceMicros: z.number(), size: z.number() });
const clobBookSchema = z.object({
  market: z.string(), assetId: z.string(), timestamp: z.string(), hash: z.string(),
  bids: z.array(parsedLevelSchema), asks: z.array(parsedLevelSchema),
});
const clobBooksSchema = z.array(clobBookSchema);

/** Sort by assetId so the same books always serialize identically. */
function canonical(books: ClobBook[]): string {
  return JSON.stringify([...books].sort((a, b) => a.assetId.localeCompare(b.assetId)));
}

export async function saveSnapshot(dir: string, books: ClobBook[]): Promise<string> {
  const text = canonical(books);
  const id = createHash('sha256').update(text, 'utf8').digest('hex');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), text, 'utf8');
  return id;
}

export async function loadSnapshot(dir: string, id: string): Promise<ClobBook[]> {
  let text: string;
  try {
    text = await readFile(join(dir, `${id}.json`), 'utf8');
  } catch {
    throw new Error(`snapshot ${id} not found in ${dir}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`snapshot ${id} in ${dir} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = clobBooksSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`snapshot ${id} in ${dir} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
