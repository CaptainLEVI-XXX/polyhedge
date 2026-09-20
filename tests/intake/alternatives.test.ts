import { describe, expect, it } from 'vitest';
import { quote, replay, type QuoteDeps } from '../../packages/engine/src/index.js';
import { type ClobBook, type GammaEvent } from '../../packages/venue/src/index.js';
import { buildAlternatives } from '../../packages/intake/src/alternatives.js';

const mkt = (id: string, title: string) => ({
  id, question: `q ${id}`, groupItemTitle: title, description: 'd',
  yesTokenId: `${id}_yes`, noTokenId: `${id}_no`, yesPrice: 0.2,
  tickSize: 0.01, feeRate: 0, endDate: '2026-12-31T16:00:00Z',
});

const book = (assetId: string, priceMicros: number): ClobBook => ({
  market: 'x', assetId, timestamp: '1', hash: 'h', bids: [],
  asks: [{ priceMicros, size: 100_000 }],
});

/**
 * A five-bracket ladder, priced so the cheapest way to cover "below 68,000"
 * is the blunt pair mA_yes + mA_no: $0.70 a share for a position that pays
 * in every state, against $1.10 for the exact strip mA+mB+mC. The blunt pair
 * buys $2,000 of payout above 68,000 on a $1,000 exposure, which is what the
 * `shaped` trigger is looking for.
 */
const event: GammaEvent = {
  id: 'e1', slug: 'btc', title: 'BTC on Dec 31', negRisk: true,
  negRiskMarketId: '0x1', endDate: '2026-12-31T16:00:00Z', tags: ['bitcoin'], seriesTickers: [],
  markets: [
    mkt('mA', '<60,000'),
    mkt('mB', '60,000-64,000'),
    mkt('mC', '64,000-68,000'),
    mkt('mD', '68,000-72,000'),
    mkt('mE', '>72,000'),
  ],
};

const prices: Record<string, number> = {
  mA_yes: 200_000, mA_no: 500_000,
  mB_yes: 450_000, mB_no: 900_000,
  mC_yes: 450_000, mC_no: 900_000,
  mD_yes: 900_000, mD_no: 900_000,
  mE_yes: 900_000, mE_no: 900_000,
};

/** A fresh snapshot id per call, so "its own snapshot" is observable. */
const deps = (ev: GammaEvent, px: Record<string, number>): QuoteDeps => {
  let n = 0;
  return {
    fetchEvent: async () => ev,
    fetchBooks: async (ids: string[]) => ids.map((id) => book(id, px[id] ?? 900_000)),
    saveSnapshot: async () => { n += 1; return `snap${n}`; },
  };
};

const primaryShape = {
  templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 68000,
} as const;

async function primaryAndAlternatives() {
  const d = deps(event, prices);
  const primary = await quote({ eventId: 'e1', shape: primaryShape }, d);
  return { primary, alternatives: await buildAlternatives(primary, d) };
}

describe('buildAlternatives', () => {
  it('a shaped alternative costs more and buys less payout where nothing is owed', async () => {
    const { primary, alternatives } = await primaryAndAlternatives();
    const shaped = alternatives.find((a) => a.kind === 'shaped');

    expect(shaped).toBeDefined();
    expect(shaped!.record.basket.totalCostCents)
      .toBeGreaterThan(primary.basket.totalCostCents);
    expect(shaped!.residualVsPrimary.crossStateOverhedgeCents)
      .toBeLessThan(primary.basket.residual.crossStateOverhedgeCents);
  });

  // THE REGRESSION GUARD. A cheaper tail re-solved at a further strike solves
  // its own, weaker target perfectly, so its own residual flatters it. If
  // anyone ever wires a UI to `record.basket.residual` for an alternative,
  // the second expectation below is what fails.
  it('a cheaper tail covers strictly less of the PRIMARY target than the primary does', async () => {
    const { primary, alternatives } = await primaryAndAlternatives();
    const tail = alternatives.find((a) => a.kind === 'cheaper_tail');

    expect(tail).toBeDefined();
    expect(tail!.residualVsPrimary.coverageRatio)
      .toBeLessThan(primary.basket.residual.coverageRatio);

    // ...and its own residual reads HIGHER than the honest number, which is
    // exactly the trap `residualVsPrimary` exists to close.
    expect(tail!.record.basket.residual.coverageRatio)
      .toBeGreaterThan(tail!.residualVsPrimary.coverageRatio);
  });

  it('every alternative carries a complete record with its own snapshot', async () => {
    const { primary, alternatives } = await primaryAndAlternatives();
    expect(alternatives.length).toBeGreaterThan(1);

    const snapshots = new Set<string>([primary.resolved.snapshotId]);
    for (const alt of alternatives) {
      expect(alt.record.version).toBe(1);
      expect(alt.record.resolved.legs.length).toBe(primary.resolved.legs.length);
      expect(alt.record.resolved.feeRates.length).toBe(primary.resolved.feeRates.length);
      expect(alt.record.basket.legs.length).toBeGreaterThan(0);
      expect(alt.record.meta.quotedAt).toEqual(expect.any(String));
      expect(alt.reason.length).toBeGreaterThan(0);

      expect(snapshots.has(alt.record.resolved.snapshotId)).toBe(false);
      snapshots.add(alt.record.resolved.snapshotId);
      const restored = JSON.parse(JSON.stringify(alt.record));
      const books = alt.record.resolved.legs.map((leg) => book(leg.tokenId, prices[leg.tokenId]!));
      expect(await replay(restored, books)).toEqual(alt.record.basket);
    }
  });

  it('emits nothing when no condition fires', async () => {
    // A two-bracket ladder where the exact cover is $0.10 a share: no
    // over-hedge at all, and a premium of a tenth of the payout.
    const cheapEvent: GammaEvent = {
      ...event, id: 'e2', slug: 'btc-cheap',
      markets: [mkt('mLow', '<68,000'), mkt('mHigh', '>68,000')],
    };
    const cheapPrices: Record<string, number> = {
      mLow_yes: 100_000, mLow_no: 900_000,
      mHigh_yes: 900_000, mHigh_no: 900_000,
    };

    const d = deps(cheapEvent, cheapPrices);
    const primary = await quote({ eventId: 'e2', shape: primaryShape }, d);

    expect(primary.basket.residual.crossStateOverhedgeCents).toBe(0);
    expect(await buildAlternatives(primary, d)).toEqual([]);
  });
});
