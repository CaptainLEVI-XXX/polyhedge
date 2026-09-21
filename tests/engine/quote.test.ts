import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dollarsToCents } from '../../packages/core/src/index.js';
import { type ClobBook, type GammaEvent } from '../../packages/venue/src/index.js';
import { quote, replay } from '../../packages/engine/src/quote.js';
import { fileURLToPath } from 'node:url';

const mkt = (id: string, title: string, fee: number | null = 0.07) => ({
  id, question: `q ${id}`, groupItemTitle: title, description: 'd',
  slug: null, yesTokenId: `${id}_yes`, noTokenId: `${id}_no`, yesPrice: 0.2,
  tickSize: 0.01, feeRate: fee, endDate: '2026-12-31T16:00:00Z',
});

const event: GammaEvent = {
  id: 'e1', slug: 'btc', title: 'BTC on Dec 31', negRisk: true,
  negRiskMarketId: '0x1', endDate: '2026-12-31T16:00:00Z', tags: ['bitcoin'], seriesTickers: [],
  // deliberately NOT in ascending bracket order
  markets: [mkt('mC', '>70,000'), mkt('mA', '<68,000'), mkt('mB', '68,000-70,000')],
};

const book = (assetId: string, priceMicros: number): ClobBook => ({
  market: 'x', assetId, timestamp: '1', hash: 'h', bids: [],
  asks: [{ priceMicros, size: 100_000 }],
});

const prices: Record<string, number> = {
  mA_yes: 200_000, mA_no: 800_000,
  mB_yes: 500_000, mB_no: 500_000,
  mC_yes: 300_000, mC_no: 700_000,
};

const deps = (ev: GammaEvent = event) => ({
  fetchEvent: async () => ev,
  fetchBooks: async (ids: string[]) => ids.map((id) => book(id, prices[id] ?? 500_000)),
  saveSnapshot: async () => 'snap1',
});

describe('quote', () => {
  it('THE v1 BUG: maps markets to brackets by identity, not arrival order', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
    );
    // only the <68,000 bracket is owed; it is market mA, which arrived SECOND
    const bought = rec.basket.legs.filter((l) => l.shares > 0);
    expect(bought).toHaveLength(1);
    expect(bought[0]!.marketId).toBe('mA');
  });

  it('offers both YES and NO legs to the solver', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
    );
    expect(rec.resolved.legs.some((l) => l.side === 'NO')).toBe(true);
  });

  it('refuses to quote when any fee rate is unknown', async () => {
    const noFee = { ...event, markets: event.markets.map((m) => ({ ...m, feeRate: null })) };
    await expect(quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 68000 } },
      deps(noFee),
    )).rejects.toThrow(/fee/i);
  });

  it('refuses a non-neg-risk event', async () => {
    await expect(quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 68000 } },
      deps({ ...event, negRisk: false }),
    )).rejects.toThrow(/neg-risk/i);
  });

  it('refuses an event with an unparseable bracket title', async () => {
    const bad = { ...event, markets: [mkt('m1', 'Yes'), mkt('m2', 'No')] };
    await expect(quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1, direction: 'below', k: 68000 } },
      deps(bad),
    )).rejects.toThrow(/does not publish a numeric ladder/i);
  });

  describe('budgetUsd', () => {
    // A two-bracket ladder with zero fees: mLow at $0.20/share is the
    // strictly cheapest way to cover the "below 68,000" state, so a
    // budget-bound solve spends the whole budget on it and the resulting
    // cost in cents is exactly the dollar budget converted to cents.
    const ladderEvent: GammaEvent = {
      id: 'e2', slug: 'btc-ladder', title: 'BTC ladder', negRisk: true,
      negRiskMarketId: '0x2', endDate: '2026-12-31T16:00:00Z', tags: ['bitcoin'], seriesTickers: [],
      markets: [mkt('mLow', '<68000', 0), mkt('mHigh', '>=68000', 0)],
    };
    const ladderPrices: Record<string, number> = {
      mLow_yes: 200_000, mLow_no: 800_000,
      mHigh_yes: 500_000, mHigh_no: 500_000,
    };
    const ladderDeps = () => ({
      fetchEvent: async () => ladderEvent,
      fetchBooks: async (ids: string[]) => ids.map((id) => book(id, ladderPrices[id] ?? 500_000)),
      saveSnapshot: async () => 'snap-ladder',
    });

    it('spends no more than the requested budget', async () => {
      const rec = await quote(
        {
          eventId: 'e2',
          shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 },
          budgetUsd: 1,
        },
        ladderDeps(),
      );
      expect(rec.basket.totalCostCents).toBeLessThanOrEqual(dollarsToCents(1));
    });

    it('converts budgetUsd through dollarsToCents, not a raw float cast', async () => {
      // 1.015 is a float half-cent tie: `Math.round(1.015 * 100)` gives 101,
      // silently hiding the tie, while banker's rounding correctly gives 102.
      expect(Math.round(1.015 * 100)).toBe(101);
      expect(dollarsToCents(1.015)).toBe(102);

      const rec = await quote(
        {
          eventId: 'e2',
          shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 },
          budgetUsd: 1.015,
        },
        ladderDeps(),
      );
      expect(rec.basket.totalCostCents).toBe(dollarsToCents(1.015));
    });
  });
});

describe('replay', () => {
  it('replays executable quantities from stored minimum sizes and refuses missing metadata', async () => {
    const request = { eventId: 'e1', shape: { templateId: 'threshold_digital' as const,
      payoutUsd: 1000, direction: 'below' as const, k: 68000 }, budgetUsd: 10,
      protectionGoal: { kind: 'minimize_net_loss' as const }, execution: { quantityStep: 0.01, maxLegs: 2 } };
    const books = Object.keys(prices).map(id => ({ ...book(id, prices[id]!), minOrderSize: 5 }));
    const rec = await quote(request, { ...deps(), fetchBooks: async () => books });
    expect(await replay(JSON.parse(JSON.stringify(rec)), books)).toEqual(rec.basket);
    await expect(quote(request, deps())).rejects.toThrow(/minimum order size/);
  });
  it('preserves the premium-aware objective and explicit loss limit across JSON replay', async () => {
    for (const protectionGoal of [{ kind: 'minimize_net_loss' } as const,
      { kind: 'limit_net_loss', maxNetLossUsd: 600 } as const]) {
      const rec = await quote({ eventId: 'e1',
        shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 },
        protectionGoal }, deps());
      const books = Object.keys(prices).map(id => book(id, prices[id]!));
      expect(await replay(JSON.parse(JSON.stringify(rec)), books)).toEqual(rec.basket);
    }
  });
  it('reproduces the basket exactly from the record and its books', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'range_protect', payoutUsd: 2500, low: 68000, high: 70000 } },
      deps(),
    );
    const books = Object.keys(prices).map((id) => book(id, prices[id]!));
    const again = await replay(rec, books);
    expect(again.legs).toEqual(rec.basket.legs);
    expect(again.totalCostCents).toBe(rec.basket.totalCostCents);
    expect(again.phase2Hash).toBe(rec.basket.phase2Hash);
  });

  it('a record survives JSON serialization intact', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'tail_only', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
    );
    const roundTripped = JSON.parse(JSON.stringify(rec)) as typeof rec;
    const books = Object.keys(prices).map((id) => book(id, prices[id]!));
    expect((await replay(roundTripped, books)).legs).toEqual(rec.basket.legs);
  });

  it('re-solves under the mu recorded on the basket, not the current default', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'range_protect', payoutUsd: 2500, low: 68000, high: 70000 } },
      deps(),
    );
    const books = Object.keys(prices).map((id) => book(id, prices[id]!));

    const mutated = { ...rec, basket: { ...rec.basket, mu: 0.5 } };
    const again = await replay(mutated, books);

    // mu genuinely flowed from the record: the replayed basket carries it...
    expect(again.mu).toBe(0.5);
    // ...rather than falling back to buildBasket's own default.
    expect(rec.basket.mu).not.toBe(0.5);
    expect(again).not.toEqual(rec.basket);
  });
});

describe('mu on the request', () => {
  it('a requested mu flows through to the basket', async () => {
    const rec = await quote(
      {
        eventId: 'e1',
        shape: { templateId: 'range_protect', payoutUsd: 2500, low: 68000, high: 70000 },
        mu: 0.5,
      },
      deps(),
    );
    expect(rec.basket.mu).toBe(0.5);
  });
});

describe('ruleFlags option', () => {
  it('reaches record.basket.residual.ruleFlags', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
      { ruleFlags: ['resolution source differs'] },
    );
    expect(rec.basket.residual.ruleFlags).toEqual(['resolution source differs']);
  });
});

describe('provenance', () => {
  it('a record round-trips through JSON with meta intact, and replay still reproduces legs', async () => {
    const rec = await quote(
      { eventId: 'e1', shape: { templateId: 'tail_only', payoutUsd: 1000, direction: 'below', k: 68000 } },
      deps(),
      { calibrationMapVersion: 'cal-2026-09-01', jevModelVersion: 'jev-1.13.0' },
    );

    const roundTripped = JSON.parse(JSON.stringify(rec)) as typeof rec;
    expect(roundTripped.meta).toEqual(rec.meta);

    const books = Object.keys(prices).map((id) => book(id, prices[id]!));
    const again = await replay(roundTripped, books);
    expect(again.legs).toEqual(rec.basket.legs);
  });
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesPath = resolve(__dirname, '../../packages/engine/fixtures/golden.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Array<{
  name: string;
  brackets: string[];
  yesPriceMicros: number[];
  noPriceMicros?: number[];
  sizes: number[];
  feeRate: number;
  shape: Record<string, unknown>;
  expect: {
    totalCostCents: number;
    coverageRatio: number;
    boughtLabels?: string[];
    crossStateOverhedgeCents?: number;
  };
}>;

const goldenMkt = (id: string, title: string, fee: number) => ({
  id, question: `q ${id}`, groupItemTitle: title, description: 'd',
  slug: null, yesTokenId: `${id}_yes`, noTokenId: `${id}_no`, yesPrice: 0.2,
  tickSize: 0.01, feeRate: fee, endDate: '2026-12-31T16:00:00Z',
});

const goldenBook = (assetId: string, priceMicros: number, size: number): ClobBook => ({
  market: 'x', assetId, timestamp: '1', hash: 'h', bids: [],
  asks: [{ priceMicros, size }],
});

describe('golden fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, async () => {
      const markets = fixture.brackets.map((bracket, i) =>
        goldenMkt(`m${i}`, bracket, fixture.feeRate),
      );

      const event: GammaEvent = {
        id: 'e1', slug: 'test', title: 'Test Event', negRisk: true,
        negRiskMarketId: '0x1', endDate: '2026-12-31T16:00:00Z', tags: [], seriesTickers: [],
        markets,
      };

      const prices = new Map<string, number>();
      for (let i = 0; i < fixture.brackets.length; i += 1) {
        prices.set(`m${i}_yes`, fixture.yesPriceMicros[i]!);
        if (fixture.noPriceMicros) {
          prices.set(`m${i}_no`, fixture.noPriceMicros[i]!);
        } else {
          prices.set(`m${i}_no`, 1_000_000 - fixture.yesPriceMicros[i]!);
        }
      }

      const deps = {
        fetchEvent: async () => event,
        fetchBooks: async (ids: string[]) =>
          ids.map((id) => {
            const price = prices.get(id) ?? 500_000;
            const size = fixture.sizes[Number(id.match(/m(\d+)/)?.[1])] ?? 100_000;
            return goldenBook(id, price, size);
          }),
        saveSnapshot: async () => 'snap1',
      };

      const rec = await quote(
        { eventId: 'e1', shape: fixture.shape as any },
        deps,
      );

      expect(rec.basket.totalCostCents).toBe(fixture.expect.totalCostCents);
      expect(rec.basket.residual.coverageRatio).toBeCloseTo(fixture.expect.coverageRatio, 6);

      if (fixture.expect.boughtLabels) {
        const boughtLabels = rec.basket.legs
          .filter((l) => l.shares > 0)
          .map((l) => l.label)
          .sort();
        expect(boughtLabels).toEqual(fixture.expect.boughtLabels.sort());
      }

      if (fixture.expect.crossStateOverhedgeCents !== undefined) {
        expect(rec.basket.residual.crossStateOverhedgeCents).toBe(fixture.expect.crossStateOverhedgeCents);
      }
    });
  }
});
