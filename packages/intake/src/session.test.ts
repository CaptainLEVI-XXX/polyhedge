import { describe, expect, it } from 'vitest';
import { addAssumption, applyAnswer, ask, confirm, newSession } from './session.js';

describe('applyAnswer', () => {
  it('clears pending, increments followUpsAsked, and appends to answers with the right field name', () => {
    const s = ask(newSession('I hold 2 BTC', 'session-1'), 'deadline', 'When do you need this hedge by?');

    const next = applyAnswer(s, '2027');

    expect(next.pending).toBeUndefined();
    expect(next.followUpsAsked).toBe(1);
    expect(next.answers).toEqual([{ field: 'deadline', answer: '2027' }]);
  });

  it('throws rather than silently dropping the answer when there is no pending question', () => {
    const s = newSession('I hold 2 BTC', 'session-2');

    expect(() => applyAnswer(s, '2027')).toThrow();
  });
});

describe('confirm', () => {
  it('accumulates across calls and never mutates the input session', () => {
    const s0 = newSession('I hold 2 BTC', 'session-3');

    const s1 = confirm(s0, 'underlying', 'BTC');
    const s2 = confirm(s1, 'hedgeRatio', 0.5);

    expect(s2.confirmed).toEqual({ underlying: 'BTC', hedgeRatio: 0.5 });
    expect(s1.confirmed).toEqual({ underlying: 'BTC' });
    expect(s0.confirmed).toEqual({});
  });
});

describe('newSession jevModelVersion', () => {
  it('defaults to "unknown" when no version is supplied', () => {
    const s = newSession('I hold 2 BTC', 'session-5');

    expect(s.jevModelVersion).toBe('unknown');
  });

  it('records the version supplied by the caller', () => {
    const s = newSession('I hold 2 BTC', 'session-6', 'jev-1.13.0');

    expect(s.jevModelVersion).toBe('jev-1.13.0');
  });
});

describe('round trip', () => {
  it('preserves originalText and prior assumptions through ask -> applyAnswer -> confirm', () => {
    const withAssumption = addAssumption(newSession('I hold 2 BTC', 'session-4'), 'assumed no existing hedge');
    const asked = ask(withAssumption, 'deadline', 'When do you need this hedge by?');
    const answered = applyAnswer(asked, '2027');
    const confirmed = confirm(answered, 'deadline', {
      value: '2027-12-31',
      provenance: 'stated',
      raw: '2027',
    });

    expect(confirmed.originalText).toBe('I hold 2 BTC');
    expect(confirmed.assumptions).toEqual(['assumed no existing hedge']);
  });
});
