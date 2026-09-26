import { describe, expect, it } from 'vitest';
import type { ClobBook, GammaEvent } from '../../packages/venue/src/index.js';
import { quote } from '../../packages/engine/src/quote.js';
import { costLabel, payoutLabel } from '../../apps/web/lib/money.js';
import { toOptionView, type CoverOptionView } from '../../apps/web/lib/view-model.js';
import { basketMetrics, money } from '../../apps/web/lib/basket-metrics.js';

// These guard numbers a user acts on, where a rounding direction is the
// difference between a true statement and a flattering one.

describe('rounding always points away from flattering us', () => {
  it('rounds cost UP, so a price is never quoted cheaper than it will be', () => {
    expect(costLabel(59_999.4)).toBe('$600.00');
    expect(costLabel(1.2)).toBe('$0.02');
  });

  it('rounds a payout DOWN, so what arrives is never overstated', () => {
    expect(payoutLabel(3836.9)).toBe('$3,836');
    expect(payoutLabel(0.9)).toBe('$0');
  });

  it('formats card money in the stated direction without float noise', () => {
    expect(money(99.999, 'down')).toBe('$99.99');
    expect(money(50.001)).toBe('$50.01');
    expect(money(172.04000000000087)).toBe('$172.04');
    expect(money(0)).toBe('$0.00');
  });
});

describe('toOptionView', () => {
  const market = (id: string, title: string) => ({
    id, question: `Will BTC be ${title}?`, groupItemTitle: title, description: 'd', slug: null,
    yesTokenId: `${id}_yes`, noTokenId: `${id}_no`, yesPrice: 0.2, tickSize: 0.01, feeRate: 0,
    endDate: '2026-12-31T16:00:00Z',
  });
  const event: GammaEvent = {
    id: 'e1', slug: 'btc', title: 'BTC on Dec 31', negRisk: true, negRiskMarketId: '0x1',
    endDate: '2026-12-31T16:00:00Z', tags: [], seriesTickers: [],
    markets: [market('mA', '<68,000'), market('mB', '68,000-70,000'), market('mC', '>70,000')],
  };
  const book = (assetId: string): ClobBook => ({ market: 'x', assetId, timestamp: '1', hash: 'h', bids: [],
    asks: [{ priceMicros: assetId.endsWith('_yes') ? 300_000 : 800_000, size: 100_000 }] });

  it('shows one payout row per evaluation state, and only the legs actually bought', async () => {
    // The strike sits INSIDE the middle bracket, so that bracket is owed in
    // one half and not the other. A bracket-indexed row would hide exactly that.
    const record = await quote(
      { eventId: 'e1', shape: { templateId: 'threshold_digital', payoutUsd: 1000, direction: 'below', k: 69_000 } },
      { fetchEvent: async () => event, fetchBooks: async ids => ids.map(book), saveSnapshot: async () => 'snap' },
    );
    const view = toOptionView('primary', 'Your hedge', '', record, '$',
      id => event.markets.find(m => m.id === id)!.question, id => `https://example.test/${id}`);

    expect(view.ladder.payout.map(r => [r.label, r.owedUsd])).toEqual([
      ['<68000', 1000], ['68000-69000', 1000], ['69000-70000', 0], ['>70000', 0],
    ]);
    // Six legs were considered (YES and NO per bracket); only held ones show.
    expect(view.ladder.positions.length).toBe(view.ladder.heldCount);
    expect(view.ladder.positions.every(p => p.shares > 0)).toBe(true);
    expect(view.ladder.positions.length).toBeLessThan(record.basket.legs.length);
    expect(view.ladder.positions[0]).toMatchObject({
      question: expect.stringMatching(/^Will BTC be/), href: expect.stringMatching(/^https:\/\/example\.test\//),
    });
    expect(view.costUsd).toBe(record.basket.totalCostCents / 100);
  });
});

describe('basketMetrics', () => {
  const option = (costUsd: number, payout: { owedUsd: number; paidUsd: number }[]) =>
    ({ costUsd, ladder: { payout } }) as unknown as CoverOptionView;

  it('reports the worst exposed-state cover, not aggregate cover', () => {
    const metrics = basketMetrics(option(20, [
      { owedUsd: 100, paidUsd: 99.99 }, { owedUsd: 100, paidUsd: 50 }, { owedUsd: 0, paidUsd: 0 },
    ]));
    expect(metrics).toEqual({ netImprovement: 30, minimumCoverage: 0.5, maxPayout: 99.99, netLoss: 70, beyondOwed: 0 });
  });

  it('catches a hedge that pays beyond the loss, which full cover alone hides', () => {
    const over = basketMetrics(option(20, [{ owedUsd: 100, paidUsd: 130 }, { owedUsd: 0, paidUsd: 15 }]));
    expect(over).toMatchObject({ minimumCoverage: 1, beyondOwed: 30 });
  });
});
