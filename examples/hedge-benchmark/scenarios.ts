import { holdingProtectionShape, priceMicros, type Leg, type TargetShape } from '../../packages/core/src/index.js';
import type { Scenario } from './evaluate.js';

const items = [
  { key: 'low', bracket: { lo: null, hi: 80 } },
  { key: 'middle', bracket: { lo: 80, hi: 100 } },
  { key: 'high', bracket: { lo: 100, hi: null } },
];
const legs: Leg[] = items.flatMap(item => (['YES', 'NO'] as const).map(side => ({
  id: `${item.key}-${side}`, marketId: item.key, tokenId: `${item.key}-${side}`,
  label: item.key, tradableKey: item.key, side,
})));
const shapes: [string, TargetShape][] = [
  ['aligned-downside', { templateId: 'threshold_digital', direction: 'below', k: 80, payoutUsd: 100 }],
  ['inside-bracket', { templateId: 'threshold_digital', direction: 'below', k: 90, payoutUsd: 100 }],
  ['upside', { templateId: 'threshold_digital', direction: 'above', k: 100, payoutUsd: 100 }],
  ['both-tails', { templateId: 'range_protect', low: 80, high: 100, payoutUsd: 100 }],
  ['linear-downside', { templateId: 'linear_strip', direction: 'below', k1: 80, k2: 100, payoutUsd: 100 }],
  ['holding-loss-layer', holdingProtectionShape({ quantity: 10, referencePriceUsd: 100,
    position: 'long', deductibleUsd: 100, payoutCapUsd: 100, protectionFraction: 1 })],
];

/** Deliberately synthetic, not calibrated probabilities or historical observations. */
export function scenarios(): Scenario[] {
  const base=shapes.flatMap(([name, shape]) => [10, 30, 80].flatMap(budgetUsd =>
    (['deep', 'thin', 'expensive'] as const).map(liquidity => ({
      id: `${name}/${liquidity}/budget-${budgetUsd}`, items, shape, budgetUsd, legs,
      stateProbabilities:{low:.2/1.1,middle:.65/1.1,high:.25/1.1},
      // Middle NO can cover both tails: exercise complements, not only YES ladders.
      books: [0.2, 0.85, 0.65, 0.38, 0.25, 0.8].map(p => [
        { priceMicros: priceMicros(Math.round((p + (liquidity === 'expensive' ? 0.05 : 0)) * 1e6)),
          size: liquidity === 'thin' ? 5 : 60 },
        { priceMicros: priceMicros(Math.round((p + (liquidity === 'expensive' ? 0.08 : 0.02)) * 1e6)),
          size: liquidity === 'thin' ? 15 : 140 },
      ]),
      feeRates: legs.map(() => 0.02),
    })),
  ));
  const competing:Scenario={id:'competing-complements',items,shape:shapes[0]![1],budgetUsd:35,legs,
    books:legs.map(l=>[{priceMicros:priceMicros(l.side==='NO'&&l.tradableKey!=='low'?350_000:990_000),size:1000}]),feeRates:legs.map(()=>0),
    stateProbabilities:{low:.1,middle:.6,high:.3}};
  return [...base,competing,{...competing,id:'competing-complements/wrong-odds',evaluationProbabilities:{low:.1,middle:.1,high:.8}}];
}
