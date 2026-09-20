import { describe, expect, it } from 'vitest';
import { payoffMatrix, type Leg } from './payoff-matrix.js';
import { buildStateSpace } from './state-space.js';

const br = (lo: number | null, hi: number | null) => ({ lo, hi });
const ladder = [
  { key: 'mA', bracket: br(null, 68000) },
  { key: 'mB', bracket: br(68000, 70000) },
  { key: 'mC', bracket: br(70000, null) },
];
const leg = (id: string, key: string, side: 'YES' | 'NO'): Leg =>
  ({ id, marketId: key, label: `bracket ${key}`, tokenId: `tok_${id}`, side, tradableKey: key });

describe('payoffMatrix', () => {
  it('gives a YES leg a one in its own state only', () => {
    expect(payoffMatrix([leg('a', 'mB', 'YES')], buildStateSpace(ladder, []))).toEqual([[0, 1, 0]]);
  });

  it('gives a NO leg a one in every state but its own', () => {
    expect(payoffMatrix([leg('a', 'mB', 'NO')], buildStateSpace(ladder, []))).toEqual([[1, 0, 1]]);
  });

  it('pays across EVERY evaluation state of a split bracket', () => {
    const ss = buildStateSpace(ladder, [69000]); // mB splits in two
    expect(payoffMatrix([leg('a', 'mB', 'YES')], ss)).toEqual([[0, 1, 1, 0]]);
  });

  it('gives a NO leg zeros across every evaluation state of its own bracket', () => {
    const ss = buildStateSpace(ladder, [69000]);
    expect(payoffMatrix([leg('a', 'mB', 'NO')], ss)).toEqual([[1, 0, 0, 1]]);
  });

  it('makes YES and NO exact complements across split states', () => {
    const ss = buildStateSpace(ladder, [69000]);
    const [yes, no] = payoffMatrix([leg('a', 'mB', 'YES'), leg('b', 'mB', 'NO')], ss);
    yes!.forEach((v, i) => expect(v + no![i]!).toBe(1));
  });

  it('keeps row order aligned with leg order', () => {
    const ss = buildStateSpace(ladder, []);
    expect(payoffMatrix([leg('a', 'mA', 'YES'), leg('b', 'mC', 'YES')], ss))
      .toEqual([[1, 0, 0], [0, 0, 1]]);
  });

  it('is unaffected by the order markets arrived in', () => {
    const a = payoffMatrix([leg('x', 'mB', 'YES')], buildStateSpace(ladder, []));
    const b = payoffMatrix([leg('x', 'mB', 'YES')], buildStateSpace([ladder[2]!, ladder[0]!, ladder[1]!], []));
    expect(a).toEqual(b);
  });

  it('throws when a leg names a tradable key that does not exist', () => {
    expect(() => payoffMatrix([leg('a', 'mZ', 'YES')], buildStateSpace(ladder, []))).toThrow(/mZ/);
  });

  it('returns an empty matrix for no legs', () => {
    expect(payoffMatrix([], buildStateSpace(ladder, []))).toEqual([]);
  });
});
