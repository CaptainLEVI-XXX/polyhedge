import type { TargetShape } from './shapes.js';

/** Explicit units: never infer quantity from a dollar holding or vice versa. */
export interface HoldingProtection {
  quantity: number;
  referencePriceUsd: number;
  position: 'long' | 'short';
  deductibleUsd: number;
  /** Maximum hedge payout, AFTER applying protectionFraction. */
  payoutCapUsd: number;
  protectionFraction: number;
}

/** min(cap, fraction * max(holding loss - deductible, 0)).
 * This is a protected layer of a holding, not the holding's entire loss.
 * Market source and observation time must still match the exposure.
 */
export function holdingProtectionShape(input: HoldingProtection): TargetShape {
  const { quantity, referencePriceUsd, deductibleUsd, payoutCapUsd, protectionFraction } = input;
  for (const value of [quantity, referencePriceUsd, payoutCapUsd, protectionFraction]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('quantity, reference price, payout cap and fraction must be positive');
  }
  if (!Number.isFinite(deductibleUsd) || deductibleUsd < 0 || protectionFraction > 1) {
    throw new Error('deductible must be nonnegative and protection fraction at most one');
  }
  if (input.position !== 'long' && input.position !== 'short') throw new Error('invalid holding direction');
  const deductibleMove = deductibleUsd / quantity;
  const span = payoutCapUsd / (quantity * protectionFraction);
  const start = input.position === 'long' ? referencePriceUsd - deductibleMove : referencePriceUsd + deductibleMove;
  const k1 = input.position === 'long' ? start - span : start;
  const k2 = input.position === 'long' ? start : start + span;
  if (!Number.isFinite(k1) || !Number.isFinite(k2) || k1 < 0 || k2 <= k1) {
    throw new Error('protection layer exceeds the nonnegative price domain or numeric precision');
  }
  return { templateId: 'linear_strip', direction: input.position === 'long' ? 'below' : 'above',
    k1, k2, payoutUsd: payoutCapUsd };
}
