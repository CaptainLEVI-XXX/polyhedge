import { describe, expect, it } from 'vitest';
import { toSafeError } from '../../apps/web/lib/errors.js';

// The route boundary is where an internal failure becomes something a stranger
// reads. Everything else about these routes is exercised by driving the app;
// this is the part that fails silently and expensively, because a leak looks
// exactly like a working response.

describe('toSafeError', () => {
  it('never echoes key material, even when the failure is about the key', () => {
    const leaked = toSafeError(new Error('AI_GATEWAY_API_KEY apik_live_9f2b7c1d is invalid'));
    expect(leaked.message).not.toMatch(/apik/i);
    expect(leaked.message).not.toMatch(/AI_GATEWAY/i);
    expect(leaked.code).toBe('model_unavailable');
  });

  it('never returns a stack trace or an upstream body', () => {
    const upstream = new Error(
      'jev: POST /v1/systemone -> 500 {"trace":"at Object.<anonymous> (/srv/app/x.js:12:9)"}',
    );
    const safe = toSafeError(upstream);
    expect(safe.message).not.toMatch(/at Object|\/srv\/|\{/);
    expect(safe.message).toMatch(/nothing was quoted/i);
  });

  it('tells the model and the venue apart, because the user can act on that', () => {
    expect(toSafeError(new Error('jev: request timeout')).code).toBe('model_unavailable');
    expect(toSafeError(new Error('gamma events -> 429')).code).toBe('venue_unavailable');
    expect(toSafeError(new Error('something else entirely')).code).toBe('unknown');
  });

  it('always says nothing was quoted, so a failure is never read as a position', () => {
    for (const error of [
      new Error('jev: timeout'),
      new Error('clob book unreachable'),
      new Error('nonsense'),
    ]) {
      expect(toSafeError(error).message).toMatch(/nothing was quoted/i);
    }
  });
});
