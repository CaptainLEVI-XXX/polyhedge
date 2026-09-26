import { describe, expect, it } from 'vitest';
import { buildOrder } from '../../packages/execution/src/order.js';
import { assertReservation } from '../../packages/execution/src/reserve.js';
import type { ExecutionLeg, MarketBook } from '../../packages/execution/src/types.js';

const now = new Date('2026-09-20T12:00:00Z');
const leg: ExecutionLeg = { id: 'one', tokenId: 'yes', conditionId: 'condition', outcome: 'YES',
  sharesMicros: 100_000_000, referencePriceMicros: 400_000 };
const book: MarketBook = { tokenId: 'yes', observedAt: now.toISOString(), tickMicros: 10_000,
  shareStepMicros: 10_000, minSharesMicros: 10_000, feeBps: 100,
  asks: [{ priceMicros: 200_000, sharesMicros: 50_000_000 }, { priceMicros: 400_000, sharesMicros: 50_000_000 }],
  bids: [{ priceMicros: 395_000, sharesMicros: 100_000_000 }] };

describe('executable orders and whole-basket reservations', () => {
  it('uses the deepest ask, reserves worst-case fees, and rounds sells toward fillability', () => {
    expect(buildOrder(leg, 'BUY', book, 0, now)).toMatchObject({ limitPriceMicros: 400_000, maxCashMicros: 40_400_000 });
    expect(buildOrder(leg, 'SELL', book, 500, now)).toMatchObject({ limitPriceMicros: 390_000, maxCashMicros: 38_610_000 });
    expect(() => assertReservation([40_400_000, 40_400_000], 80_800_000, 80_800_000)).not.toThrow();
    expect(() => assertReservation([40_400_000, 40_400_000], 80_799_999, 90_000_000)).toThrow(/collateral/);
    expect(() => assertReservation([40_400_000], 80_000_000, 40_399_999)).toThrow(/maximum spend/);
  });
  it('refuses insufficient depth, stale snapshots, unrepresentable shares and slippage instead of silently changing protection', () => {
    expect(() => buildOrder({ ...leg, sharesMicros: 100_000_001 }, 'BUY', book, 0, now)).toThrow(/precision/);
    expect(() => buildOrder({ ...leg, sharesMicros: 101_000_000 }, 'BUY', book, 0, now)).toThrow(/depth/);
    expect(() => buildOrder(leg, 'BUY', book, 0, new Date(now.getTime() + 20_000))).toThrow(/stale/);
    expect(() => buildOrder({ ...leg, referencePriceMicros: 300_000 }, 'BUY', book, 0, now)).toThrow(/slippage/);
    expect(buildOrder(leg, 'BUY', { ...book, tickMicros: 2_500 }, 0, now).limitPriceMicros).toBe(400_000);
  });
});
