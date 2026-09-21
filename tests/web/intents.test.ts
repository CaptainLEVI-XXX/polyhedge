import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The browser-signing group. Every case here happens in practice, and each one
// ends with either a placed order or a user who can say what happened — never
// with a leg in an unknown state.

let dir: string;
let intents: typeof import('../../apps/web/lib/intents.js');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyhedge-intents-'));
  process.env.POLYHEDGE_STORE = dir;
  intents = await import('../../apps/web/lib/intents.js');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = { executionId: 'x1', owner: 'me', wallet: '0xWALLET', legIndex: 0, payload: { leg: 1 } };

describe('signing an order that is waiting', () => {
  it('is idempotent for the same signature, because a retry is one decision', async () => {
    const intent = await intents.prepareIntent(base);
    const first = await intents.signIntent(intent.id, 'me', '0xWALLET', 'sig-a');
    const again = await intents.signIntent(intent.id, 'me', '0xWALLET', 'sig-a');
    expect(first.status).toBe('signed');
    expect(again.signature).toBe('sig-a');
  });

  it('refuses a different signature rather than overwriting the first', async () => {
    const intent = await intents.prepareIntent(base);
    await intents.signIntent(intent.id, 'me', '0xWALLET', 'sig-a');
    // One of the two was not what the user saw. Picking either is a guess.
    await expect(intents.signIntent(intent.id, 'me', '0xWALLET', 'sig-b')).rejects.toMatchObject({
      code: 'already_signed',
    });
  });

  it('will not let a different wallet sign a basket priced against another', async () => {
    const intent = await intents.prepareIntent(base);
    await expect(intents.signIntent(intent.id, 'me', '0xOTHER', 'sig')).rejects.toMatchObject({
      code: 'wrong_wallet',
    });
  });

  it('expires rather than accepting a signature against a stale book', async () => {
    const intent = await intents.prepareIntent(base);
    const late = new Date(Date.parse(intent.expiresAt) + 1_000);
    await expect(intents.signIntent(intent.id, 'me', '0xWALLET', 'sig', late)).rejects.toMatchObject({
      code: 'expired',
    });
    // And it stays expired, so nothing can sign it afterwards either.
    const after = await intents.getIntent(intent.id, 'me');
    expect(after.status).toBe('expired');
  });

  it('never submits anything whose signature was not stored first', async () => {
    const unsigned = await intents.prepareIntent(base);
    await expect(intents.markSubmitted(unsigned.id, 'me')).rejects.toMatchObject({
      code: 'not_signable',
    });

    await intents.signIntent(unsigned.id, 'me', '0xWALLET', 'sig');
    expect((await intents.markSubmitted(unsigned.id, 'me')).status).toBe('submitted');
  });

  it('stops the basket when the user declines, and will not sign it later', async () => {
    const intent = await intents.prepareIntent(base);
    await intents.declineIntent(intent.id, 'me');
    await expect(intents.signIntent(intent.id, 'me', '0xWALLET', 'sig')).rejects.toMatchObject({
      code: 'declined',
    });
  });

  it('hides another owner\'s intent behind the same answer as a missing one', async () => {
    const intent = await intents.prepareIntent(base);
    await expect(intents.getIntent(intent.id, 'someone-else')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(intents.getIntent('no-such-id', 'me')).rejects.toMatchObject({ code: 'not_found' });
  });
});
