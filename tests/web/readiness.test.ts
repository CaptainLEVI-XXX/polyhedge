import { describe, expect, it } from 'vitest';
import { readiness, type WalletFacts } from '../../apps/web/lib/wallet-readiness.js';

// Every one of these fails at submit time if unchecked, which is the worst
// place for any of them to fail. This asserts the order they are caught in.

const funded: WalletFacts = {
  address: '0xW',
  provisioned: true,
  approvalsReady: true,
  availableMicros: 900_000_000,
  pendingDepositMicros: 0,
};

describe('readiness', () => {
  it('asks for the earliest missing thing, not the last', () => {
    // A wallet with no approvals AND no money reports approvals, because that
    // is what the user hits first; reporting the balance would send them to
    // deposit and then fail again.
    const blocked = readiness(
      { ...funded, approvalsReady: false, availableMicros: 0 },
      60_000,
    );
    expect(blocked.step).toBe('approvals');
    expect(blocked.canPlace).toBe(false);
  });

  it('names approvals as a one-time step, because the venue error never does', () => {
    const noApprovals = readiness({ ...funded, approvalsReady: false }, 60_000);
    expect(noApprovals.message).toMatch(/one-time/);
  });

  it('only allows placing when every step is done and the money is there', () => {
    expect(readiness(funded, 60_000).step).toBe('ready');
    expect(readiness(funded, 60_000).canPlace).toBe(true);

    // $900 available, $1,000 basket.
    expect(readiness(funded, 100_000).canPlace).toBe(false);
    expect(readiness(funded, 100_000).step).toBe('funding');
  });

  it('never claims readiness for a wallet it cannot see', () => {
    const none = readiness({ ...funded, address: null, availableMicros: null }, 60_000);
    expect(none.step).toBe('connect');
    expect(none.canPlace).toBe(false);
  });
});
