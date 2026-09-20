import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClobBook } from './schemas.js';

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
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as ClobBook[];
  } catch {
    throw new Error(`snapshot ${id} not found in ${dir}`);
  }
}
