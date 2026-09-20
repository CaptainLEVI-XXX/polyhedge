import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClobBook, GammaEvent } from '@polyhedge/venue';
import { quote } from './quote.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesPath = resolve(__dirname, '..', 'fixtures', 'golden.json');
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

const mkt = (id: string, title: string, fee: number) => ({
  id, question: `q ${id}`, groupItemTitle: title, description: 'd',
  yesTokenId: `${id}_yes`, noTokenId: `${id}_no`, yesPrice: 0.2,
  tickSize: 0.01, feeRate: fee, endDate: '2026-12-31T16:00:00Z',
});

const book = (assetId: string, priceMicros: number, size: number): ClobBook => ({
  market: 'x', assetId, timestamp: '1', hash: 'h', bids: [],
  asks: [{ priceMicros, size }],
});

describe('golden fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, async () => {
      const markets = fixture.brackets.map((bracket, i) =>
        mkt(`m${i}`, bracket, fixture.feeRate),
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
            return book(id, price, size);
          }),
        saveSnapshot: async () => 'snap1',
      };

      const rec = await quote(
        { eventId: 'e1', shape: fixture.shape as any },
        deps,
      );

      expect(rec.basket.totalCostCents).toBe(fixture.expect.totalCostCents);
      const coverageRatio = Math.round(
        (rec.basket.legs.reduce((sum, l) => sum + l.shares, 0) / 1000) * 1_000_000,
      ) / 1_000_000;
      expect(coverageRatio).toBeCloseTo(fixture.expect.coverageRatio, 6);

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
