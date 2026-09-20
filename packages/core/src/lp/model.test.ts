import { describe, expect, it } from 'vitest';
import { cents, priceMicros } from '../money.js';
import { buildLpModel, type LpInput } from './model.js';

const base: LpInput = {
  target: [cents(10_000), cents(0)],
  matrix: [[1, 0], [0, 1]],
  books: [
    [{ priceMicros: priceMicros(400_000), size: 100 }],
    [{ priceMicros: priceMicros(600_000), size: 100 }],
  ],
  feeRates: [0, 0],
  mu: 0.001,
  budgetCents: null,
};

describe('buildLpModel', () => {
  it('emits LP sections in order', () => {
    const { text } = buildLpModel(base, { kind: 'minimax' });
    expect(text.indexOf('Minimize')).toBeLessThan(text.indexOf('Subject To'));
    expect(text.indexOf('Subject To')).toBeLessThan(text.indexOf('Bounds'));
    expect(text.indexOf('Bounds')).toBeLessThan(text.indexOf('End'));
  });

  it('names level variables canonically', () => {
    expect(buildLpModel(base, { kind: 'minimax' }).legLevelVars.map((v) => v.name))
      .toEqual(['x_0_0', 'x_1_0']);
  });

  it('bounds each level variable by that level size', () => {
    expect(buildLpModel(base, { kind: 'minimax' }).text)
      .toContain('x_0_0 <= 100.000000000000');
  });

  it('phase minimax minimizes M and caps every shortfall by it', () => {
    const { text } = buildLpModel(base, { kind: 'minimax' });
    expect(text).toMatch(/obj: 1\.000000000000 M/);
    expect(text).toContain('m_0:');
    expect(text).toContain('m_1:');
  });

  it('phase minimax does NOT weight shortfall by probability', () => {
    const { text } = buildLpModel(base, { kind: 'minimax' });
    // the objective is M alone plus perturbations; no s_t terms carry weights
    expect(text).not.toMatch(/obj:.*\bs_0\b.*\bs_1\b/);
  });

  it('phase cost pins shortfall and minimizes true cost', () => {
    const { text } = buildLpModel(base, { kind: 'cost', maxShortfallDollars: 25 });
    expect(text).toMatch(/cap_0: 1\.000000000000 s_0 <= 25\.0000/);
    expect(text).toContain('0.400000000000 x_0_0');
    expect(text).not.toContain(' M ');
  });

  it('writes one equality constraint per evaluation state', () => {
    const { text } = buildLpModel(base, { kind: 'minimax' });
    expect(text).toContain('c_0:');
    expect(text).toContain('c_1:');
    expect(text).not.toContain('c_2:');
  });

  it('puts the target on the right-hand side in dollars', () => {
    expect(buildLpModel(base, { kind: 'minimax' }).text)
      .toMatch(/c_0:.*= 100\.000000000000/);
  });

  it('adds the canonicalizing perturbation by variable index', () => {
    const { text } = buildLpModel(base, { kind: 'cost', maxShortfallDollars: 0 });
    expect(text).toContain('0.400000000000 x_0_0');
    expect(text).toContain('0.600000001000 x_1_0');
  });

  it('is byte-identical across repeated builds', () => {
    const a = buildLpModel(base, { kind: 'minimax' });
    const b = buildLpModel(base, { kind: 'minimax' });
    expect(b.text).toBe(a.text);
    expect(b.hash).toBe(a.hash);
  });

  it('hashes differently for different phases and different inputs', () => {
    const p1 = buildLpModel(base, { kind: 'minimax' }).hash;
    const p2 = buildLpModel(base, { kind: 'cost', maxShortfallDollars: 0 }).hash;
    const p3 = buildLpModel({ ...base, target: [cents(10_001), cents(0)] }, { kind: 'minimax' }).hash;
    expect(new Set([p1, p2, p3]).size).toBe(3);
  });

  it('includes a budget row only when a budget is given', () => {
    expect(buildLpModel(base, { kind: 'minimax' }).text).not.toContain('budget:');
    expect(buildLpModel({ ...base, budgetCents: cents(5000) }, { kind: 'minimax' }).text)
      .toMatch(/budget:.*<= 50\.000000000000/);
  });
});
