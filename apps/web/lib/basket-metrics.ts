import type { CoverOptionView } from './view-model.js';

/** Display every claim from the SAME state payouts used by the chart. */
export function basketMetrics(option: CoverOptionView) {
  const rows = option.ladder.payout;
  const exposed = rows.filter(row => row.owedUsd > 0);
  const unhedgedLoss = Math.max(0, ...rows.map(row => row.owedUsd));
  const netLoss = Math.max(0, ...rows.map(row => row.owedUsd - row.paidUsd + option.costUsd));
  return {
    netImprovement: unhedgedLoss - netLoss,
    minimumCoverage: exposed.length ? Math.min(...exposed.map(row => Math.min(1, row.paidUsd / row.owedUsd))) : 1,
    maxPayout: Math.max(0, ...rows.map(row => row.paidUsd)),
    netLoss,
    /**
     * The most this basket pays ABOVE the loss, in the outcome where it
     * overshoots furthest.
     *
     * The only signal that a hedge is too big: a basket can read 100% cover
     * while quietly paying out more than you would ever lose, which is money
     * spent on protection you do not need.
     */
    beyondOwed: Math.max(0, ...rows.map(row => row.paidUsd - row.owedUsd)),
  };
}
export const money = (n: number, direction: 'up' | 'down' = 'up') => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format((direction==='up'?Math.ceil(n*100-1e-7):Math.floor(n*100+1e-7))/100 || 0);
