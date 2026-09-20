import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSnapshot, saveSnapshot } from './snapshots.js';

const books = [{ market: 'm', assetId: 'a', timestamp: '1', hash: 'h',
  bids: [], asks: [{ priceMicros: 450_000, size: 10 }] }];
const dir = () => mkdtempSync(join(tmpdir(), 'ph-'));

describe('snapshots', () => {
  it('round-trips', async () => {
    const d = dir();
    expect(await loadSnapshot(d, await saveSnapshot(d, books))).toEqual(books);
  });
  it('gives identical content the same id', async () => {
    const d = dir();
    expect(await saveSnapshot(d, books)).toBe(await saveSnapshot(d, books));
  });
  it('gives different content a different id', async () => {
    const d = dir();
    const other = [{ ...books[0]!, asks: [{ priceMicros: 460_000, size: 10 }] }];
    expect(await saveSnapshot(d, books)).not.toBe(await saveSnapshot(d, other));
  });
  it('is insensitive to book ordering', async () => {
    const d = dir();
    const b = { ...books[0]!, assetId: 'b' };
    expect(await saveSnapshot(d, [books[0]!, b])).toBe(await saveSnapshot(d, [b, books[0]!]));
  });
  it('names the missing id in its error', async () => {
    await expect(loadSnapshot(dir(), 'deadbeef')).rejects.toThrow(/deadbeef/);
  });
});
