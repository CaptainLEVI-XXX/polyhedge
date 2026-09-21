import { describe, expect, it } from 'vitest';
import {
  costLabel,
  coverageLabel,
  payoutLabel,
  shortfallLabel,
} from '../../apps/web/lib/money.js';

// The view-model group. These guard numbers a user acts on, where a rounding
// direction is the difference between a true statement and a flattering one.
// Rendering is judged by opening the page; this is not.

describe('rounding always points away from flattering us', () => {
  it('rounds coverage DOWN, so protection is never overstated', () => {
    // 0.4795 is 47.95%. Shown as 48% it claims cover that was not bought.
    expect(coverageLabel(0.4795)).toBe('47%');
    expect(coverageLabel(0.2249)).toBe('22%');
    expect(coverageLabel(0.9999)).toBe('99%');
    // Exact values are not dragged down by floating point.
    expect(coverageLabel(1)).toBe('100%');
    expect(coverageLabel(0.5)).toBe('50%');
  });

  it('rounds a shortfall UP, so a gap is never shown smaller than it is', () => {
    expect(shortfallLabel(416_401)).toBe('$4,165');
    expect(shortfallLabel(1)).toBe('$1');
    expect(shortfallLabel(0)).toBe('$0');
  });

  it('rounds cost UP, so a price is never quoted cheaper than it will be', () => {
    expect(costLabel(59_999.4)).toBe('$600.00');
    expect(costLabel(1.2)).toBe('$0.02');
  });

  it('rounds a payout DOWN, so what arrives is never overstated', () => {
    expect(payoutLabel(3836.9)).toBe('$3,836');
    expect(payoutLabel(0.9)).toBe('$0');
  });

  it('clamps coverage rather than reporting an impossible percentage', () => {
    // A ratio slightly over one is a rounding artefact upstream, not 104% cover.
    expect(coverageLabel(1.04)).toBe('100%');
    expect(coverageLabel(-0.2)).toBe('0%');
  });
});
