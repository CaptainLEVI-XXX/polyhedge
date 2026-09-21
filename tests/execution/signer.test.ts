import { describe, expect, it } from 'vitest';
import { SignerType, WalletType } from '@polymarket/client';
import { signerReady } from '../../packages/execution/src/wallet.js';

// Before this, an owner-signed order was refused by our own code — which is
// exactly what happens when a user signs each order themselves, i.e. every
// order placed before session keys are turned on.

const NOW = new Date('2026-09-21T12:00:00Z');
const FUTURE = Math.floor(NOW.getTime() / 1000) + 86_400;
const PAST = Math.floor(NOW.getTime() / 1000) - 86_400;

function client(
  signerType: SignerType,
  keys: { address: string; validUntil: number; scopes: string[] }[] = [],
  walletType: WalletType = WalletType.DEPOSIT_WALLET,
) {
  return {
    account: { walletType, signerType, signer: '0xSIGNER', wallet: '0xWALLET' },
    fetchSessionKeys: async () => keys,
  } as never;
}

describe('signerReady', () => {
  it('lets the wallet owner sign its own orders', async () => {
    // The owner's authority is the wallet itself, so there is no grant to look
    // up and nothing that can expire out from under it.
    expect(await signerReady(client(SignerType.OWNER), NOW)).toBe(true);
  });

  it('still refuses an expired or out-of-scope session key', async () => {
    const expired = client(SignerType.SESSION_KEY, [
      { address: '0xSIGNER', validUntil: PAST, scopes: ['CLOB'] },
    ]);
    expect(await signerReady(expired, NOW)).toBe(false);

    const wrongScope = client(SignerType.SESSION_KEY, [
      { address: '0xSIGNER', validUntil: FUTURE, scopes: ['PERPS'] },
    ]);
    expect(await signerReady(wrongScope, NOW)).toBe(false);
  });

  it('accepts a live CLOB session key, so turning session keys on still works', async () => {
    const live = client(SignerType.SESSION_KEY, [
      { address: '0xSIGNER', validUntil: FUTURE, scopes: ['CLOB'] },
    ]);
    expect(await signerReady(live, NOW)).toBe(true);
  });

  it('refuses anything that is not a Deposit Wallet, whoever signs', async () => {
    expect(await signerReady(client(SignerType.OWNER, [], WalletType.GNOSIS_SAFE), NOW)).toBe(false);
  });
});
