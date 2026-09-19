import { describe, expect, it } from 'vitest';
import { parseBracketTitle, validateLadder, type Bracket } from './bracket-parser.js';

describe('parseBracketTitle', () => {
  it('parses a lower-unbounded bracket', () => {
    expect(parseBracketTitle('<68,000'))
      .toEqual({ lo: null, hi: 68000, literalOp: '<' });
  });

  it('records <= distinctly from < while normalizing to the same interval', () => {
    expect(parseBracketTitle('≤68,000')).toEqual({ lo: null, hi: 68000, literalOp: '<=' });
    expect(parseBracketTitle('<=68,000')).toEqual({ lo: null, hi: 68000, literalOp: '<=' });
    expect(parseBracketTitle('<68,000')!.literalOp).toBe('<');
  });

  it('parses an upper-unbounded bracket', () => {
    expect(parseBracketTitle('>86,000'))
      .toEqual({ lo: 86000, hi: null, literalOp: '>' });
  });

  it('records >= distinctly from >', () => {
    expect(parseBracketTitle('≥86,000')!.literalOp).toBe('>=');
    expect(parseBracketTitle('>=86,000')!.literalOp).toBe('>=');
  });

  it('parses a closed range as half-open [lo, hi)', () => {
    expect(parseBracketTitle('68,000-70,000'))
      .toEqual({ lo: 68000, hi: 70000, literalOp: 'range' });
  });

  it('tolerates whitespace, dollar signs and unicode dashes', () => {
    expect(parseBracketTitle(' $68,000 – $70,000 '))
      .toEqual({ lo: 68000, hi: 70000, literalOp: 'range' });
  });

  it('parses decimals', () => {
    expect(parseBracketTitle('0.45-0.50')).toEqual({ lo: 0.45, hi: 0.5, literalOp: 'range' });
  });

  it('returns null for text it does not understand', () => {
    expect(parseBracketTitle('Yes')).toBeNull();
    expect(parseBracketTitle('Around 70k')).toBeNull();
    expect(parseBracketTitle('')).toBeNull();
    expect(parseBracketTitle('   ')).toBeNull();
  });

  it('returns null for an inverted range rather than silently swapping', () => {
    expect(parseBracketTitle('70,000-68,000')).toBeNull();
  });

  it('returns null for a degenerate range', () => {
    expect(parseBracketTitle('68,000-68,000')).toBeNull();
  });
});

describe('validateLadder', () => {
  const b = (lo: number | null, hi: number | null): Bracket =>
    ({ lo, hi, literalOp: lo === null ? '<' : hi === null ? '>' : 'range' });

  it('accepts a contiguous exhaustive partition', () => {
    expect(validateLadder([b(null, 68000), b(68000, 70000), b(70000, null)]))
      .toEqual({ ok: true });
  });

  it('accepts brackets supplied out of order', () => {
    expect(validateLadder([b(70000, null), b(null, 68000), b(68000, 70000)]))
      .toEqual({ ok: true });
  });

  it('rejects a gap', () => {
    expect(validateLadder([b(null, 68000), b(69000, null)]))
      .toEqual({ ok: false, reason: 'gap between 68000 and 69000' });
  });

  it('rejects an overlap', () => {
    expect(validateLadder([b(null, 70000), b(68000, null)]))
      .toEqual({ ok: false, reason: 'overlap between 70000 and 68000' });
  });

  it('rejects a ladder not unbounded at both ends', () => {
    expect(validateLadder([b(68000, 70000)]))
      .toEqual({ ok: false, reason: 'ladder is not unbounded at both ends' });
  });

  it('rejects an empty ladder', () => {
    expect(validateLadder([])).toEqual({ ok: false, reason: 'ladder is empty' });
  });

  it('rejects a second unbounded bracket in the middle', () => {
    expect(validateLadder([b(null, 68000), b(null, 70000), b(70000, null)]).ok).toBe(false);
  });
});
