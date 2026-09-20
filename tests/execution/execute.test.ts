import { describe, expect, it } from 'vitest';
import { execute } from '../../packages/execution/src/execute.js';
import type { Authorization, ExecutionJournal, ExecutionRecord, ExecutionVenue, MarketBook,
  OrderIntent, OrderResolution, SelectedQuote, SignedEnvelope } from '../../packages/execution/src/types.js';

const now = new Date('2026-09-20T12:00:00Z');
const quote: SelectedQuote = { hash: 'selected-record-digest', legs: [
  { id: 'thick', tokenId: 'a', conditionId: 'ca', outcome: 'YES', sharesMicros: 10_000_000, referencePriceMicros: 400_000 },
  { id: 'thin', tokenId: 'b', conditionId: 'cb', outcome: 'NO', sharesMicros: 10_000_000, referencePriceMicros: 400_000 },
] };
const authorization: Authorization = { id: 'confirmation', wallet: 'wallet', quoteHash: quote.hash,
  maxSpendMicros: 9_000_000, maxUnwindLossMicros: 500_000, slippageBps: 0,
  expiresAt: '2026-09-21T00:00:00Z', maxUnwindAttempts: 2 };

function fixture() {
  const records = new Map<string, ExecutionRecord>();
  let locked = false;
  const journal: ExecutionJournal = {
    async withWalletLock(_wallet, callback) {
      if (locked) throw new Error('concurrent wallet');
      locked = true;
      try { return await callback(); } finally { locked = false; }
    },
    async load(id) { return structuredClone(records.get(id) ?? null); },
    async create(record) { if (records.has(record.id)) throw new Error('duplicate'); records.set(record.id, structuredClone(record)); },
    async save(record, expectedRevision) {
      if (records.get(record.id)?.revision !== expectedRevision || record.revision !== expectedRevision + 1) throw new Error('CAS');
      records.set(record.id, structuredClone(record));
    },
  };
  const intents = new Map<string, OrderIntent>();
  const posts: string[] = [];
  let sequence = 0;
  const confirmed = (envelope: SignedEnvelope): OrderResolution => {
    const intent = intents.get(envelope.orderId)!;
    return { kind: 'confirmed', fills: [{ ...intent, id: `fill-${envelope.orderId}`, orderId: envelope.orderId,
      cashMicros: intent.side === 'BUY' ? 4_000_000 : 3_800_000, feeMicros: 0, transactionHash: `tx-${envelope.orderId}` }] };
  };
  const venue: ExecutionVenue = {
    async state() { return { mode: 'open', availableCashMicros: 20_000_000, sessionValid: true, approvalsReady: true }; },
    async book(tokenId): Promise<MarketBook> {
      return { tokenId, observedAt: now.toISOString(), tickMicros: 10_000, shareStepMicros: 10_000,
        minSharesMicros: 10_000, feeBps: 0,
        asks: [{ priceMicros: 400_000, sharesMicros: tokenId === 'a' ? 50_000_000 : 10_000_000 }],
        bids: [{ priceMicros: 380_000, sharesMicros: 50_000_000 }] };
    },
    async prepare(_wallet, intent) { const orderId = String(++sequence); intents.set(orderId, intent); return { orderId, payload: { signed: orderId } }; },
    async post(_wallet, envelope) {
      const persisted = records.get(authorization.id)!;
      expect(persisted.legs.flatMap(l => [...(l.buy ? [l.buy] : []), ...l.unwinds]).some(a => a.envelope.orderId === envelope.orderId && a.state === 'unknown')).toBe(true);
      posts.push(envelope.orderId);
      return confirmed(envelope);
    },
    async reconcile(_wallet, envelope) { return confirmed(envelope); },
  };
  return { records, journal, venue, intents, posts, confirmed, deps: { journal, venue, now: () => now } };
}

describe('durable sequential execution', () => {
  it('trades thinnest first, persists before posting, and executes one confirmation only once', async () => {
    const f = fixture();
    const result = await execute(quote, authorization, f.deps);
    expect(result.kind).toBe('complete');
    expect([...f.intents.values()].map(i => i.tokenId)).toEqual(['b', 'a']);
    expect(result.held.map(p => p.sharesMicros)).toEqual([10_000_000, 10_000_000]);
    expect((await execute(quote, authorization, f.deps)).kind).toBe('complete');
    expect(f.posts).toHaveLength(2);
    await expect(execute(quote, { ...authorization, maxSpendMicros: 99_000_000 }, f.deps)).rejects.toThrow(/different/);
  });
  it('reconciles a timed-out submission without resubmitting or treating a match as settled', async () => {
    const f = fixture();
    const originalPost = f.venue.post;
    let timeout = true;
    f.venue.post = async (wallet, envelope) => {
      if (timeout) { timeout = false; f.posts.push(envelope.orderId); throw new Error('timeout after acceptance'); }
      return originalPost(wallet, envelope);
    };
    f.venue.reconcile = async () => ({ kind: 'pending', reason: 'MATCHED, not confirmed' });
    expect((await execute(quote, authorization, f.deps)).kind).toBe('pending');
    expect((await execute(quote, authorization, f.deps)).held).toEqual([]);
    expect(f.posts).toHaveLength(1);
    f.venue.reconcile = async (_wallet, envelope) => f.confirmed(envelope);
    expect((await execute(quote, authorization, f.deps)).kind).toBe('complete');
    expect(f.posts).toHaveLength(2);
  });
  it('unwinds after a confirmed first leg and failed second leg, accounting for actual cash', async () => {
    const f = fixture();
    const original = f.venue.post;
    f.venue.post = async (wallet, envelope) => f.intents.get(envelope.orderId)?.tokenId === 'a'
      ? { kind: 'failed', reason: 'FOK rejected' } : original(wallet, envelope);
    const result = await execute(quote, authorization, f.deps);
    expect(result.kind).toBe('unwound');
    expect(result.held).toEqual([]);
    expect(result.netSpendMicros).toBe(200_000);
  });
  it('reports held inventory when authorized unwind loss is too small', async () => {
    const f = fixture();
    const original = f.venue.post;
    f.venue.post = async (wallet, envelope) => f.intents.get(envelope.orderId)?.tokenId === 'a'
      ? { kind: 'failed', reason: 'FOK rejected' } : original(wallet, envelope);
    const result = await execute(quote, { ...authorization, maxUnwindLossMicros: 100_000 }, f.deps);
    expect(result.kind).toBe('partial');
    expect(result.held).toMatchObject([{ tokenId: 'b', sharesMicros: 10_000_000 }]);
    expect([...f.intents.values()].filter(i => i.side === 'SELL')).toHaveLength(0);
  });
  it('does not submit when signing crosses the authorization expiry', async () => {
    const f = fixture();
    let clock = now;
    f.deps.now = () => clock;
    const prepare = f.venue.prepare;
    f.venue.prepare = async (wallet, intent) => {
      const envelope = await prepare(wallet, intent);
      clock = new Date(authorization.expiresAt);
      return envelope;
    };
    const result = await execute(quote, authorization, f.deps);
    expect(result.kind).toBe('rejected');
    expect(result.reason).toMatch(/expired before submission/);
    expect(f.posts).toEqual([]);
    expect(result.record.legs.find(leg => leg.buy)?.buy).toMatchObject({ state: 'failed', fills: [] });
    expect((await execute(quote, authorization, f.deps)).kind).toBe('rejected');
    expect(f.posts).toEqual([]);
  });
  it('retains actual bad unwind proceeds and flags both breached bounds across restart', async () => {
    const f = fixture();
    const original = f.venue.post;
    f.venue.post = async (wallet, envelope) => {
      const intent = f.intents.get(envelope.orderId)!;
      if (intent.tokenId === 'a') return { kind: 'failed', reason: 'Second buy rejected' };
      if (intent.side === 'SELL') {
        f.posts.push(envelope.orderId);
        const settled = f.confirmed(envelope);
        if (settled.kind !== 'confirmed') throw new Error('fixture');
        return { kind: 'confirmed', fills: settled.fills.map(fill => ({ ...fill, cashMicros: 1_000_000 })) };
      }
      return original(wallet, envelope);
    };
    const result = await execute(quote, authorization, f.deps);
    expect(result.kind).toBe('unwound');
    expect(result.held).toEqual([]);
    expect(result.netSpendMicros).toBe(3_000_000);
    expect(result.authorizationViolation).toMatch(/proceeds 1000000.*minimum 3800000/);
    expect(result.authorizationViolation).toMatch(/loss 3000000.*maximum 500000/);
    const submissions = f.posts.length;
    expect(await execute(quote, authorization, f.deps)).toEqual(result);
    expect(f.posts).toHaveLength(submissions);
  });
  it('halts on anomalous partial unwind proceeds even with retry attempts remaining', async () => {
    const f = fixture();
    const original = f.venue.post;
    f.venue.post = async (wallet, envelope) => {
      const intent = f.intents.get(envelope.orderId)!;
      if (intent.tokenId === 'a') return { kind: 'failed', reason: 'Second buy rejected' };
      if (intent.side === 'SELL') {
        const settled = f.confirmed(envelope);
        if (settled.kind !== 'confirmed') throw new Error('fixture');
        // Defensive handling of a venue reporting less than the requested FOK.
        return { kind: 'confirmed', fills: settled.fills.map(fill => ({ ...fill,
          sharesMicros: 5_000_000, cashMicros: 1_900_000 })) };
      }
      return original(wallet, envelope);
    };
    const result = await execute(quote, authorization, f.deps);
    expect(result.kind).toBe('partial');
    expect(result.held).toMatchObject([{ tokenId: 'b', sharesMicros: 5_000_000 }]);
    expect(result.netSpendMicros).toBe(2_100_000);
    expect(result.authorizationViolation).toMatch(/below authorized minimum/);
    expect([...f.intents.values()].filter(i => i.side === 'SELL')).toHaveLength(1);
  });

  it('pauses cancel-only without submitting a sell and rejects whole-basket underfunding upfront', async () => {
    const f = fixture();
    f.venue.state = async () => ({ mode: 'cancel_only', availableCashMicros: 20_000_000, sessionValid: true, approvalsReady: true });
    expect((await execute(quote, authorization, f.deps)).kind).toBe('pending');
    expect(f.intents.size).toBe(0);
    f.venue.state = async () => ({ mode: 'open', availableCashMicros: 7_000_000, sessionValid: true, approvalsReady: true });
    expect((await execute(quote, authorization, f.deps)).kind).toBe('rejected');
    expect(f.intents.size).toBe(0);
  });
});
