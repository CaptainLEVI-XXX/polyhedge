import {
  SignerType, WalletType, production, type SecureClient, type Signer,
} from '@polymarket/client';
import { RelayerDepositWalletExecuteRequestSchema, RelayerExecuteResponseSchema, RelayerTransactionType,
  type RelayerDepositWalletExecuteRequest } from '@polymarket/bindings/relayer';
import { fetchExecuteParams, fetchTransaction } from '@polymarket/client/actions';
import { getAddress, hashTypedData, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { DurableRedemptionTransport, RedemptionCall, TransactionEnvelope, TransportStatus } from './polymarket.js';

const KIND = 'polymarket-deposit-wallet-v1';
const TYPES = {
  Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
  Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
} as const;
export interface SignedRedemptionBatch {
  id: string;
  digest: Hex;
  chainId: number;
  request: RelayerDepositWalletExecuteRequest;
}
/**
 * Must identify this exact signed Batch, not just the wallet or nonce. Use a
 * durable relayer-request index or verified onchain Batch evidence. null means
 * no evidence yet, never proof that a prior broadcast did not execute.
 */
export type SignedBatchLookup = (batch: SignedRedemptionBatch) => Promise<TransportStatus | null>;
export interface RelayerIO {
  nonce(owner: string): Promise<string>;
  submit(request: RelayerDepositWalletExecuteRequest): Promise<TransportStatus>;
  lookup(submissionId: string): Promise<TransportStatus>;
}
export interface DepositWalletTransportOptions {
  client: SecureClient;
  /** Owner custody adapter. CLOB session keys cannot authorize redemptions. */
  signer: Signer;
  findSignedBatch: SignedBatchLookup;
  now?: () => Date;
  ttlSeconds?: number;
  /** Config must match the SDK environment used for this client. */
  deployment?: { chainId: number; walletFactory: Address };
  io?: RelayerIO;
}
function deployment() {
  const runtime = production as unknown as { chainId: number; walletDerivation?: { depositWalletFactory?: string } };
  if (!runtime.walletDerivation?.depositWalletFactory) throw new Error('Pinned SDK lacks Deposit Wallet factory metadata');
  return { chainId: runtime.chainId, walletFactory: getAddress(runtime.walletDerivation.depositWalletFactory) };
}
function typedData(batch: Pick<SignedRedemptionBatch, 'chainId' | 'request'>) {
  const { request, chainId } = batch;
  return { domain: { name: 'DepositWallet', version: '1', chainId,
    verifyingContract: getAddress(request.depositWalletParams.depositWallet) },
    primaryType: 'Batch' as const, types: TYPES,
    message: { wallet: getAddress(request.depositWalletParams.depositWallet), nonce: BigInt(request.nonce),
      deadline: BigInt(request.depositWalletParams.deadline),
      calls: request.depositWalletParams.calls.map(call => ({ target: getAddress(call.target), value: BigInt(call.value), data: call.data as Hex })) } };
}

/** Uses the authenticated SDK transport; credentials never enter the envelope. */
export function sdkRelayerIO(client: SecureClient): RelayerIO {
  // SDK 0.10 hides this low-level member in its public declarations. Its pinned
  // gasless.ts uses precisely post('/submit', {json}). Keep this boundary narrow.
  const runtime = client as unknown as { relayer: { post(path: string, options: { json: unknown }): {
    match<T>(ok: (value: unknown) => T, error: (error: unknown) => T): Promise<T>;
  } } };
  return {
    async nonce(owner) {
      const response = await fetchExecuteParams(client, { address: owner, type: RelayerTransactionType.WALLET });
      return response.nonce;
    },
    async lookup(submissionId) {
      const response = await fetchTransaction(client, { transactionId: submissionId });
      // The SDK schema carries only transaction ID/state/hash, not wallet or nonce.
      // This ID must come from the durable response to this envelope's submit.
      if (response.transactionId !== submissionId) return { status: 'unknown', reason: 'Relayer returned a different submission ID' };
      if (response.transactionHash) return { status: 'pending', submissionId, transactionHash: response.transactionHash };
      if (response.state === 'STATE_INVALID' || response.state === 'STATE_FAILED') {
        return { status: 'unknown', reason: `Relayer ${response.state}; exact-batch chain evidence is still required` };
      }
      return { status: 'pending', submissionId };
    },
    async submit(request) {
      const raw = await runtime.relayer.post('/submit', { json: request }).match(value => value, error => { throw error; });
      const response = RelayerExecuteResponseSchema.parse(raw);
      // Even STATE_CONFIRMED is only a receipt candidate. The settlement venue
      // independently verifies chain confirmations, token burns and pUSD payout.
      if (response.transactionHash) return { status: 'pending', submissionId: response.transactionId, transactionHash: response.transactionHash };
      if (response.state === 'STATE_INVALID' || response.state === 'STATE_FAILED') {
        return { status: 'unknown', reason: `Relayer ${response.state}; lookup of the exact signed batch is required` };
      }
      return { status: 'pending', submissionId: response.transactionId };
    },
  };
}

/** Owner-only, durable, exact-nonce relay. prepare signs but never broadcasts. */
export class DepositWalletRedemptionTransport implements DurableRedemptionTransport {
  private readonly config;
  private readonly io: RelayerIO;
  private readonly now: () => Date;
  private readonly ttl: number;
  constructor(private readonly options: DepositWalletTransportOptions) {
    this.config = options.deployment ?? deployment();
    this.io = options.io ?? sdkRelayerIO(options.client);
    this.now = options.now ?? (() => new Date());
    this.ttl = options.ttlSeconds ?? 600;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 3600) throw new Error('Redemption signature lifetime must be 1–3600 seconds');
    this.owner();
  }
  private owner(): void {
    const { account } = this.options.client;
    if (account.walletType !== WalletType.DEPOSIT_WALLET || account.signerType !== SignerType.OWNER) {
      throw new Error('Redemption requires the Deposit Wallet owner; trading session keys cannot redeem');
    }
  }
  async prepare(id: string, wallet: Address, calls: RedemptionCall[]): Promise<TransactionEnvelope> {
    this.owner();
    const { account } = this.options.client;
    if (!id || getAddress(wallet) !== getAddress(account.wallet) || calls.length === 0) throw new Error('Invalid redemption wallet or empty call batch');
    if (getAddress(await this.options.signer.getAddress()) !== getAddress(account.signer)) throw new Error('Custody signer differs from authenticated owner');
    const nonce = await this.io.nonce(account.signer);
    if (!/^\d+$/.test(nonce)) throw new Error('Relayer nonce is invalid');
    const request = RelayerDepositWalletExecuteRequestSchema.parse({
      type: 'WALLET', from: account.signer, to: this.config.walletFactory, nonce,
      metadata: `PolyHedge redemption ${id}`, signature: '0x',
      depositWalletParams: { depositWallet: wallet, deadline: String(Math.floor(this.now().getTime() / 1000) + this.ttl),
        calls: calls.map(call => ({ target: getAddress(call.to), data: call.data, value: call.value })) },
    });
    const batch = { id, chainId: this.config.chainId, request };
    const signingPayload = typedData(batch);
    request.signature = await this.options.signer.signTypedData({ ...signingPayload,
      domain: { ...signingPayload.domain, verifyingContract: account.wallet } });
    const signed: SignedRedemptionBatch = { ...batch, digest: hashTypedData(typedData(batch)) };
    await this.validateSignature(signed);
    return { kind: KIND, data: { id: signed.id, digest: signed.digest, chainId: signed.chainId, request: signed.request } };
  }
  private async validateSignature(batch: SignedRedemptionBatch): Promise<void> {
    const recovered = await recoverTypedDataAddress({ ...typedData(batch), signature: batch.request.signature as Hex });
    if (getAddress(recovered) !== getAddress(batch.request.from)) throw new Error('Persisted batch does not carry the owner signature');
  }
  private async read(envelope: TransactionEnvelope): Promise<SignedRedemptionBatch> {
    this.owner();
    if (envelope.kind !== KIND || envelope.data.chainId !== this.config.chainId || typeof envelope.data.id !== 'string' || typeof envelope.data.digest !== 'string') {
      throw new Error('Unsupported persisted redemption envelope');
    }
    const request = RelayerDepositWalletExecuteRequestSchema.parse(envelope.data.request);
    if (getAddress(request.from) !== getAddress(this.options.client.account.signer) ||
      getAddress(request.depositWalletParams.depositWallet) !== getAddress(this.options.client.account.wallet) ||
      getAddress(request.to) !== getAddress(this.config.walletFactory)) throw new Error('Persisted batch belongs to another wallet or factory');
    const batch: SignedRedemptionBatch = { id: envelope.data.id, digest: envelope.data.digest as Hex, chainId: this.config.chainId, request };
    if (hashTypedData(typedData(batch)) !== batch.digest) throw new Error('Persisted redemption digest mismatch');
    await this.validateSignature(batch);
    return batch;
  }
  private async send(batch: SignedRedemptionBatch): Promise<TransportStatus> {
    if (BigInt(batch.request.depositWalletParams.deadline) <= BigInt(Math.floor(this.now().getTime() / 1000))) {
      return { status: 'unknown', reason: 'Signed batch expired; a prior broadcast may still have executed. Exact-batch evidence is required.' };
    }
    try { return await this.io.submit(batch.request); }
    catch { return { status: 'unknown', reason: 'Relayer response unavailable or request rejected; reconcile this same signed batch before proceeding' }; }
  }
  async broadcast(envelope: TransactionEnvelope): Promise<TransportStatus> {
    return this.send(await this.read(envelope));
  }
  async lookup(envelope: TransactionEnvelope, submissionId?: string): Promise<TransportStatus> {
    const batch = await this.read(envelope);
    let knownStatus: TransportStatus | undefined;
    if (submissionId !== undefined) {
      try { knownStatus = await this.io.lookup(submissionId); }
      catch { return { status: 'unknown', reason: 'Relayer submission lookup unavailable' }; }
      if (knownStatus.status === 'pending' || knownStatus.status === 'confirmed') return knownStatus;
    }
    let found: TransportStatus | null;
    try { found = await this.options.findSignedBatch(batch); }
    catch { return { status: 'unknown', reason: 'Exact-batch transaction lookup unavailable' }; }
    if (found !== null) return found;
    if (knownStatus !== undefined) return { status: 'unknown', reason: 'Known relayer submission has no conclusive chain evidence' };
    // Covers a crash after prepare/persist but before submission. A replay uses
    // identical nonce, deadline and signature; the wallet can execute it once.
    // Never copy SDK gasless.ts's nonce-correction-and-resign retry here.
    return this.send(batch);
  }
}
