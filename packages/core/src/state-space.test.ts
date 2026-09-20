import { describe, expect, it } from 'vitest';
import { buildCategoricalStateSpace, buildStateSpace } from './state-space.js';
import type { TradableItem } from './types.js';

const br = (lo: number | null, hi: number | null) => ({ lo, hi });
const ladder: TradableItem[] = [
  { key: 'mA', bracket: br(null, 68000) },
  { key: 'mB', bracket: br(68000, 70000) },
  { key: 'mC', bracket: br(70000, 72000) },
  { key: 'mD', bracket: br(72000, null) },
];

describe('buildStateSpace', () => {
  it('sorts tradable states ascending while preserving caller keys', () => {
    const shuffled = [ladder[2]!, ladder[0]!, ladder[3]!, ladder[1]!];
    expect(buildStateSpace(shuffled, []).tradable.map((t) => t.key))
      .toEqual(['mA', 'mB', 'mC', 'mD']);
  });

  it('produces one evaluation state per bracket when no levels are given', () => {
    const ss = buildStateSpace(ladder, []);
    expect(ss.evals).toHaveLength(4);
    expect(ss.evals.map((e) => e.tradableKey)).toEqual(['mA', 'mB', 'mC', 'mD']);
  });

  it('splits a bracket at a level falling strictly inside it', () => {
    const ss = buildStateSpace(ladder, [69000]);
    expect(ss.evals).toHaveLength(5);
    const inB = ss.evals.filter((e) => e.tradableKey === 'mB');
    expect(inB.map((e) => [e.lo, e.hi])).toEqual([[68000, 69000], [69000, 70000]]);
  });

  it('does not split at a level sitting exactly on a bracket boundary', () => {
    expect(buildStateSpace(ladder, [70000]).evals).toHaveLength(4);
  });

  it('splits at several levels inside one bracket, in ascending order', () => {
    const ss = buildStateSpace(ladder, [69500, 68500]);
    expect(ss.evals.filter((e) => e.tradableKey === 'mB').map((e) => e.lo))
      .toEqual([68000, 68500, 69500]);
  });

  it('ignores duplicate levels', () => {
    expect(buildStateSpace(ladder, [69000, 69000]).evals).toHaveLength(5);
  });

  it('splits both unbounded tails when levels fall inside them', () => {
    // the ladder tiles the whole real line, so every finite level lands in
    // some bracket — there is no such thing as a level outside it
    const ss = buildStateSpace(ladder, [1, 999999]);
    expect(ss.evals.map((e) => [e.lo, e.hi])).toEqual([
      [null, 1], [1, 68000],
      [68000, 70000],
      [70000, 72000],
      [72000, 999999], [999999, null],
    ]);
  });

  it('splits an unbounded lower tail', () => {
    const ss = buildStateSpace(ladder, [60000]);
    expect(ss.evals.filter((e) => e.tradableKey === 'mA').map((e) => [e.lo, e.hi]))
      .toEqual([[null, 60000], [60000, 68000]]);
  });

  it('splits an unbounded upper tail', () => {
    const ss = buildStateSpace(ladder, [80000]);
    expect(ss.evals.filter((e) => e.tradableKey === 'mD').map((e) => [e.lo, e.hi]))
      .toEqual([[72000, 80000], [80000, null]]);
  });

  it('gives evaluation states stable ascending ids', () => {
    expect(buildStateSpace(ladder, [69000]).evals.map((e) => e.id))
      .toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('labels states readably', () => {
    const ss = buildStateSpace(ladder, []);
    expect(ss.evals.map((e) => e.label))
      .toEqual(['<68000', '68000-70000', '70000-72000', '>72000']);
  });

  it('throws on a ladder with a gap', () => {
    expect(() => buildStateSpace(
      [{ key: 'a', bracket: br(null, 1) }, { key: 'b', bracket: br(2, null) }], [],
    )).toThrow(/gap/);
  });

  it('throws on a ladder with an overlap', () => {
    expect(() => buildStateSpace(
      [{ key: 'a', bracket: br(null, 3) }, { key: 'b', bracket: br(2, null) }], [],
    )).toThrow(/overlap/);
  });

  it('throws on duplicate keys, which would make the join ambiguous', () => {
    expect(() => buildStateSpace(
      [{ key: 'x', bracket: br(null, 1) }, { key: 'x', bracket: br(1, null) }], [],
    )).toThrow(/duplicate key/);
  });

  it('throws deterministically when two brackets are both unbounded below', () => {
    // exercises the sort comparator's symmetry: whichever order these land in,
    // the result must be the same thrown error, never a silent pass
    const items = [
      { key: 'a', bracket: br(null, 68000) },
      { key: 'b', bracket: br(null, 70000) },
      { key: 'c', bracket: br(70000, null) },
    ];
    expect(() => buildStateSpace(items, [])).toThrow();
    expect(() => buildStateSpace([items[1]!, items[0]!, items[2]!], [])).toThrow();
  });

  it('throws on an empty ladder', () => {
    expect(() => buildStateSpace([], [])).toThrow(/empty/);
  });
});

describe('buildCategoricalStateSpace', () => {
  it('maps each outcome to one tradable and one evaluation state', () => {
    const ss = buildCategoricalStateSpace([
      { key: 'mYes', label: 'yes' }, { key: 'mNo', label: 'no' },
    ]);
    expect(ss.tradable.map((t) => t.key)).toEqual(['mYes', 'mNo']);
    expect(ss.evals.map((e) => e.tradableKey)).toEqual(['mYes', 'mNo']);
    expect(ss.evals.map((e) => e.id)).toEqual(['e0', 'e1']);
  });
});
