import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The store is what makes "what did I agree to" answerable. These guard the two
// properties execution depends on: an accepted quote never changes, and nobody
// else can read it.

let dir: string;
let store: typeof import('../../apps/web/lib/store.js');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyhedge-store-'));
  process.env.POLYHEDGE_STORE = dir;
  store = await import('../../apps/web/lib/store.js');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Only the fields the store itself touches; the engine's own types are
// exercised where they are produced.
const record = { resolved: { snapshotId: 'snap-a' }, meta: { quotedAt: 'then' } } as never;
const view = { parsed: { subject: 'first reading' }, options: [] } as never;

describe('an accepted quote is immutable', () => {
  it('pins the selected basket and rejects a competing selection', async () => {
    const cheaper = { resolved: { snapshotId: 'snap-cheaper' }, meta: { quotedAt: 'then' } } as never;
    const first = await store.putQuote('owner-1', record, view, null, 0, { primary: record, cheaper });
    const outcomes = await Promise.allSettled([
      store.acceptQuote(first.id, 'owner-1', 'cheaper'),
      store.acceptQuote(first.id, 'owner-1', 'primary'),
    ]);
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'rejected']);
    const saved = await store.getQuote(first.id, 'owner-1');
    expect(saved.record).toEqual(cheaper);
    expect(saved.acceptedOptionId).toBe('cheaper');
    expect((await store.acceptQuote(first.id, 'owner-1', 'cheaper')).acceptedAt).toBe(saved.acceptedAt);
  });
  it('keeps what was read, and re-pricing creates a new row rather than editing it', async () => {
    const first = await store.putQuote('owner-1', record, view);
    const accepted = await store.acceptQuote(first.id, 'owner-1');
    expect(accepted.acceptedAt).not.toBeNull();

    // A second accept is a double-click, not a second decision.
    const again = await store.acceptQuote(first.id, 'owner-1');
    expect(again.acceptedAt).toBe(accepted.acceptedAt);

    // A re-price is a new row that points back, so the original stays readable
    // exactly as it was when it was agreed to.
    const second = await store.putQuote('owner-1', record, view, first.id, 1);
    expect(second.id).not.toBe(first.id);
    expect(second.previousId).toBe(first.id);

    const original = await store.getQuote(first.id, 'owner-1');
    expect(original.view).toEqual(view);
    expect(original.acceptedAt).toBe(accepted.acceptedAt);
  });

  it('will not hand a quote to anyone else, or admit that it exists', async () => {
    const mine = await store.putQuote('owner-1', record, view);

    await expect(store.getQuote(mine.id, 'owner-2')).rejects.toThrow(/not yours/);
    // A missing id fails identically, so an id cannot be probed for existence.
    await expect(store.getQuote('does-not-exist', 'owner-2')).rejects.toThrow(/not yours/);
  });
});
