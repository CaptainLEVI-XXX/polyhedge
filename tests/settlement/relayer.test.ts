import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { fetchTransaction } from '@polymarket/client/actions';
vi.mock('@polymarket/client/actions', async importOriginal => ({
  ...await importOriginal<typeof import('@polymarket/client/actions')>(), fetchTransaction: vi.fn(),
}));
import { DepositWalletRedemptionTransport, sdkRelayerIO, type DepositWalletTransportOptions,
  type RelayerIO, type SignedBatchLookup } from '../../packages/settlement/src/relayer.js';
import type { RedemptionCall, TransactionEnvelope } from '../../packages/settlement/src/polymarket.js';

// Public deterministic fixture key; never used for a funded account.
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const wallet = '0x2222222222222222222222222222222222222222';
const factory = '0x3333333333333333333333333333333333333333';
const calls: RedemptionCall[] = [{ to: '0x4444444444444444444444444444444444444444', data: '0x1234', value: '0' }];
const now = new Date('2026-09-20T12:00:00Z');
function fixture() {
  const sign = vi.fn(async (payload: Parameters<typeof owner.signTypedData>[0]) => owner.signTypedData(payload));
  const signer = { getAddress: async () => owner.address, signTypedData: sign } as unknown as DepositWalletTransportOptions['signer'];
  const client = { account: { wallet, signer: owner.address, walletType: 3, signerType: 'OWNER' } } as unknown as DepositWalletTransportOptions['client'];
  const nonce = vi.fn(async () => '17');
  const submit = vi.fn<RelayerIO['submit']>(async () => ({ status: 'pending', submissionId: 'relay-1' }));
  const history = vi.fn<SignedBatchLookup>(async () => null);
  const lookup = vi.fn<RelayerIO['lookup']>(async submissionId => ({ status: 'pending', submissionId }));
  const options: DepositWalletTransportOptions = { client, signer, findSignedBatch: history,
    io: { nonce, submit, lookup }, deployment: { chainId: 137, walletFactory: factory }, now: () => now };
  return { sign, client, nonce, submit, lookup, history, options, transport: new DepositWalletRedemptionTransport(options) };
}

describe('durable owner Deposit Wallet relay', () => {
  it('signs without submitting, recovers a lost response using the identical persisted nonce/signature, and stops rebroadcasting once found', async () => {
    const f = fixture();
    const envelope = await f.transport.prepare('redemption-1', wallet, calls);
    expect(f.submit).not.toHaveBeenCalled();
    const persisted: TransactionEnvelope = JSON.parse(JSON.stringify(envelope));
    expect(JSON.stringify(persisted)).not.toMatch(/credentials|privateKey|apiKey/);
    f.submit.mockRejectedValueOnce(new Error('response lost after acceptance'));
    expect((await f.transport.broadcast(persisted)).status).toBe('unknown');
    const restarted = new DepositWalletRedemptionTransport(f.options);
    expect((await restarted.lookup(persisted)).status).toBe('pending');
    expect(f.submit.mock.calls[1]?.[0]).toEqual(f.submit.mock.calls[0]?.[0]);
    expect(f.nonce).toHaveBeenCalledOnce();
    expect(f.sign).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0]?.[0]).toMatchObject({ nonce: '17', type: 'WALLET',
      from: owner.address, to: factory, depositWalletParams: { depositWallet: wallet,
        calls: [{ target: calls[0]!.to, value: '0', data: '0x1234' }] } });
    f.history.mockResolvedValueOnce({ status: 'confirmed', submissionId: 'relay-1', transactionHash: `0x${'aa'.repeat(32)}` });
    expect((await restarted.lookup(persisted)).status).toBe('confirmed');
    expect(f.submit).toHaveBeenCalledTimes(2);
  });
  it('rejects changed signed payloads and trading session keys; expired missing evidence remains unknown without a fresh signature', async () => {
    const f = fixture();
    const envelope = await f.transport.prepare('redemption-2', wallet, calls);
    const tampered = JSON.parse(JSON.stringify(envelope)) as TransactionEnvelope;
    (tampered.data.request as { nonce: string }).nonce = '18';
    await expect(f.transport.lookup(tampered)).rejects.toThrow(/digest/);
    const expired = new DepositWalletRedemptionTransport({ ...f.options, now: () => new Date(now.getTime() + 700_000) });
    expect(await expired.lookup(envelope)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('expired') });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.sign).toHaveBeenCalledOnce();
    const sessionClient = { account: { ...f.client.account, signerType: 'SESSION_KEY' } } as unknown as DepositWalletTransportOptions['client'];
    expect(() => new DepositWalletRedemptionTransport({ ...f.options, client: sessionClient })).toThrow(/owner/);
  });
  it('uses the authenticated SDK submit endpoint and leaves relayer confirmation for chain verification', async () => {
    const f = fixture();
    const envelope = await f.transport.prepare('redemption-3', wallet, calls);
    const post = vi.fn(() => ({ async match(ok: (raw: unknown) => unknown) {
      return ok({ state: 'STATE_CONFIRMED', transactionID: 'relay-3', transactionHash: `0x${'bb'.repeat(32)}` });
    } }));
    const io = sdkRelayerIO({ ...f.client, relayer: { post } } as unknown as DepositWalletTransportOptions['client']);
    const request = envelope.data.request as Parameters<RelayerIO['submit']>[0];
    expect(await io.submit(request)).toMatchObject({ status: 'pending', submissionId: 'relay-3' });
    expect(post).toHaveBeenCalledWith('/submit', { json: request });
    vi.mocked(fetchTransaction).mockResolvedValueOnce({ transactionId: 'relay-3', state: 'STATE_MINED',
      transactionHash: `0x${'bb'.repeat(32)}`, errorMsg: null } as Awaited<ReturnType<typeof fetchTransaction>>);
    expect(await io.lookup('relay-3')).toMatchObject({ status: 'pending', submissionId: 'relay-3', transactionHash: `0x${'bb'.repeat(32)}` });
    const candidate = { status: 'pending' as const, submissionId: 'relay-3', transactionHash: `0x${'bb'.repeat(32)}` as const };
    f.lookup.mockResolvedValueOnce(candidate);
    expect(await f.transport.lookup(envelope, 'relay-3')).toEqual(candidate);
    expect(f.history).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
});
