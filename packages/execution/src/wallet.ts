import {
  createSecureClient, SessionKeyKnownScope, SignerType, WalletType,
  type AssetType, type SecureClient, type SecureClientOptions, type SessionKey,
} from '@polymarket/client';
import { updateBalanceAllowance } from '@polymarket/client/actions';

export interface CredentialStore {
  load(wallet: string, signer: string): Promise<SecureClient['credentials'] | undefined>;
  save(wallet: string, signer: string, credentials: SecureClient['credentials']): Promise<void>;
}

/** Caller provides custody-backed SDK Signer and a secure credential store. */
export async function connectDepositWallet(
  options: Omit<SecureClientOptions, 'credentials' | 'nonce'> & { wallet: string },
  credentials: CredentialStore,
  connect: (options: SecureClientOptions) => Promise<SecureClient> = createSecureClient,
): Promise<SecureClient> {
  const signer = await options.signer.getAddress();
  const wallet = options.wallet.toLowerCase();
  const cached = await credentials.load(wallet, signer.toLowerCase());
  const client = await connect({ ...options, ...(cached === undefined ? {} : { credentials: cached }) });
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET || client.account.wallet.toLowerCase() !== wallet) {
    throw new Error('Expected the authorized Deposit Wallet');
  }
  await credentials.save(wallet, signer.toLowerCase(), client.credentials);
  return client;
}

export function validClobSession(keys: SessionKey[], signer: string, now: Date): boolean {
  return keys.some(key => key.address.toLowerCase() === signer.toLowerCase()
    && key.validUntil > Math.floor(now.getTime() / 1000)
    && key.scopes.some(scope => scope === SessionKeyKnownScope.CLOB || scope === SessionKeyKnownScope.ALL));
}

/** Read the live registry every time; a cached key cannot detect revocation. */
export async function sessionReady(
  client: Pick<SecureClient, 'account' | 'fetchSessionKeys'>,
  now: Date,
): Promise<boolean> {
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET || client.account.signerType !== SignerType.SESSION_KEY) return false;
  return validClobSession(await client.fetchSessionKeys(), client.account.signer, now);
}

/**
 * May this signer place an order right now?
 *
 * Two signers can: the wallet's OWNER, signing each order itself, and a valid
 * CLOB-scoped SESSION KEY signing on its behalf. Only the second was accepted
 * before, which meant an owner-signed order was refused by our own code — and
 * an owner signing every order is exactly what happens before session keys are
 * turned on.
 *
 * The owner needs no registry lookup: it is the wallet's own signer, so its
 * authority is the wallet, not a grant that can expire or be revoked. A session
 * key does need one on every call, because a cached key cannot notice it has
 * been revoked.
 */
export async function signerReady(
  client: Pick<SecureClient, 'account' | 'fetchSessionKeys'>,
  now: Date,
): Promise<boolean> {
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET) return false;
  if (client.account.signerType === SignerType.OWNER) return true;
  return sessionReady(client, now);
}

/**
 * Explicit setup action; never called implicitly while posting an order.
 * The SDK grants the current environment's trading approvals and waits for
 * confirmation. Then refresh both collateral and each traded token's CLOB cache.
 */
export async function setupApprovals(
  client: SecureClient,
  tokenIds: string[],
  refresh: (assetType: AssetType, tokenId?: string) => Promise<unknown> = (assetType, tokenId) =>
    updateBalanceAllowance(client, { assetType, ...(tokenId === undefined ? {} : { assetId: tokenId }) }),
): Promise<void> {
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET) throw new Error('Deposit Wallet required');
  if (!(await client.fetchTradingApprovalsState()).isFullyApproved) await client.setupTradingApprovals();
  await refresh('COLLATERAL' as AssetType);
  for (const token of new Set(tokenIds)) await refresh('CONDITIONAL' as AssetType, token);
  if (!(await client.fetchTradingApprovalsState()).isFullyApproved) throw new Error('Trading approvals remain incomplete');
}


/** Explicit owner setup: SDK derives/deploys the default wallet and waits for its receipt. */
export async function provisionDepositWallet(
  options: Omit<SecureClientOptions, 'wallet' | 'credentials' | 'nonce'>,
  credentials: CredentialStore,
  connect: (options: SecureClientOptions) => Promise<SecureClient> = createSecureClient,
): Promise<SecureClient> {
  const client = await connect(options);
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET || client.account.signerType !== SignerType.OWNER) {
    throw new Error('Deposit Wallet provisioning requires its owner');
  }
  await credentials.save(client.account.wallet.toLowerCase(), client.account.signer.toLowerCase(), client.credentials);
  return client;
}

/** Owner signs the SDK's native authorization; only CLOB scope is requested. */
export async function authorizeClobSession(owner: SecureClient, sessionAddress: string, idempotencyKey: string) {
  if (owner.account.walletType !== WalletType.DEPOSIT_WALLET || owner.account.signerType !== SignerType.OWNER) {
    throw new Error('Session authorization requires the Deposit Wallet owner');
  }
  if (!idempotencyKey) throw new Error('A stable session-authorization idempotency key is required');
  return owner.authorizeSessionKey({ address: sessionAddress, scopes: [SessionKeyKnownScope.CLOB], idempotencyKey });
}

/** SDK waits for registry removal; do not claim the revocation transaction is mined. */
export async function revokeClobSession(owner: SecureClient, sessionAddress: string): Promise<void> {
  if (owner.account.walletType !== WalletType.DEPOSIT_WALLET || owner.account.signerType !== SignerType.OWNER) {
    throw new Error('Session revocation requires the Deposit Wallet owner');
  }
  await owner.revokeSessionKey({ address: sessionAddress });
  if ((await owner.fetchSessionKeys()).some(key => key.address.toLowerCase() === sessionAddress.toLowerCase())) {
    throw new Error('Session key remains active after revocation');
  }
}
