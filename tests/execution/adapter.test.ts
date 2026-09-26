import { describe, expect, it, vi } from 'vitest';
import { PolymarketVenue, hashPolymarketOrder, type ExecutionEvidence } from '../../packages/execution/src/polymarket.js';
import { connectDepositWallet, sessionReady, setupApprovals } from '../../packages/execution/src/wallet.js';
import type { OrderIntent } from '../../packages/execution/src/types.js';

type SecureClient = Awaited<ReturnType<typeof connectDepositWallet>>;
type SignedOrder = Parameters<typeof hashPolymarketOrder>[0];
const AssetType = { COLLATERAL: 'COLLATERAL', CONDITIONAL: 'CONDITIONAL' };
const OrderSide = { BUY: 'BUY' } as const;
const OrderType = { GTC: 'GTC', FOK: 'FOK' } as const;
const SignatureType = { POLY_1271: 3 };
const SignerType = { SESSION_KEY: 'SESSION_KEY' };
const WalletType = { DEPOSIT_WALLET: 3 };

const wallet = '0x1111111111111111111111111111111111111111';
const signer = '0x2222222222222222222222222222222222222222';
const exchange = '0x3333333333333333333333333333333333333333';
const now = new Date('2026-09-20T12:00:00Z');
const intent: OrderIntent = { tokenId: '123', conditionId: 'condition', outcome: 'YES', side: 'BUY',
  sharesMicros: 10_000_000, limitPriceMicros: 400_000, maxCashMicros: 4_100_000 };
function fixture() {
  const signed = { builder: `0x${'0'.repeat(64)}`, metadata: `0x${'0'.repeat(64)}`, expiration: 0,
    maker: wallet, signer: wallet, makerAmount: '4000000', takerAmount: '10000000', salt: '8675309',
    timestamp: '1790000000000', tokenId: '123', side: OrderSide.BUY, orderType: OrderType.GTC,
    signatureType: SignatureType.POLY_1271, signature: `0x${'1'.repeat(130)}` } as unknown as SignedOrder;
  const client = {
    account: { wallet, signer, walletType: WalletType.DEPOSIT_WALLET, signerType: SignerType.SESSION_KEY },
    credentials: { key: 'fake-key', secret: 'fake-secret', passphrase: 'fake-passphrase' },
    fetchSessionKeys: vi.fn(async () => [{ address: signer, scopes: ['CLOB'], validUntil: now.getTime() / 1000 + 600 }]),
    fetchTradingApprovalsState: vi.fn(async () => ({ isFullyApproved: true, missing: {} })),
    setupTradingApprovals: vi.fn(async () => {}),
    fetchOrderBook: vi.fn(async () => ({ assetId: '123', conditionId: 'condition', timestamp: now.getTime(), negRisk: false,
      asks: [{ price: '0.40', size: '10' }], bids: [], minOrderSize: '5', tickSize: 0.01 })),
    createLimitOrder: vi.fn(async () => ({ ...signed })),
    postOrder: vi.fn(async (order: SignedOrder) => ({ ok: true, status: 'matched',
      orderId: hashPolymarketOrder(order, exchange, 137), makingAmount: '4', takingAmount: '10',
      tradeIds: ['trade'], transactionsHashes: [] })),
  };
  const evidence: ExecutionEvidence = {
    async availableCashMicros() { return 50_000_000; }, async mode() { return 'open'; }, async feeBoundBps() { return 100; },
    async reconcile() { return { kind: 'pending', reason: 'MATCHED is not confirmed' }; },
  };
  const venue = new PolymarketVenue(client as unknown as SecureClient,
    { chainId: 137, standardExchange: exchange, negRiskExchange: '0x4444444444444444444444444444444444444444' }, evidence, () => now);
  return { client, signed, evidence, venue };
}

describe('Polymarket exact-share adapter', () => {
  it('signs share-sized limit FOK, persists a deterministic hash, and does not promote matched responses to fills', async () => {
    const f = fixture();
    const envelope = await f.venue.prepare(wallet, intent);
    expect(f.client.createLimitOrder).toHaveBeenCalledWith({ assetId: '123', side: OrderSide.BUY, price: '0.400000', size: '10.000000' });
    const serialized = JSON.parse(JSON.stringify(envelope));
    expect(await f.venue.post(wallet, serialized)).toEqual({ kind: 'pending', reason: 'MATCHED is not confirmed' });
    expect(f.client.postOrder.mock.calls[0]?.[0].orderType).toBe(OrderType.FOK);
    expect(hashPolymarketOrder(f.signed, exchange, 137)).toBe(envelope.orderId);
    expect(hashPolymarketOrder({ ...f.signed, salt: '2' }, exchange, 137)).not.toBe(envelope.orderId);
    expect(hashPolymarketOrder(f.signed, exchange, 1)).not.toBe(envelope.orderId);
    f.evidence.reconcile = async (_wallet, orderId) => ({ kind: 'confirmed', fills: [{ ...intent,
      id: 'trade', orderId, cashMicros: 4_010_000, feeMicros: 10_000, transactionHash: 'receipt' }] });
    expect(await f.venue.reconcile(wallet, serialized)).toMatchObject({ kind: 'confirmed', fills: [{ cashMicros: 4_010_000 }] });
  });
  it('rejects expired sessions, changed wallet, and SDK quantity rounding before any submission', async () => {
    const f = fixture();
    f.client.createLimitOrder.mockResolvedValueOnce({ ...f.signed, takerAmount: '9990000' });
    await expect(f.venue.prepare(wallet, intent)).rejects.toThrow(/differs/);
    f.client.fetchSessionKeys.mockResolvedValueOnce([{ address: signer, scopes: ['CLOB'], validUntil: now.getTime() / 1000 - 1 }]);
    await expect(f.venue.prepare(wallet, intent)).rejects.toThrow(/session/);
    await expect(f.venue.prepare(signer, intent)).rejects.toThrow(/wallet/);
    expect(f.client.postOrder).not.toHaveBeenCalled();
    expect(await f.venue.book('123')).toMatchObject({ shareStepMicros: 10_000, feeBps: 100, asks: [{ sharesMicros: 10_000_000 }] });
  });
  it('reuses credentials, checks live scope, and refreshes collateral plus unique token caches after approval', async () => {
    const f = fixture();
    const sdk = f.client as unknown as SecureClient;
    const factory = vi.fn(async () => sdk);
    const credentials = { load: vi.fn(async () => sdk.credentials), save: vi.fn(async () => {}) };
    const fakeSigner = { getAddress: async () => signer } as unknown as Parameters<typeof connectDepositWallet>[0]['signer'];
    await connectDepositWallet({ wallet, signer: fakeSigner }, credentials, factory);
    expect(factory.mock.calls).toHaveLength(1);
    expect(credentials.save).toHaveBeenCalledWith(wallet, signer, sdk.credentials);
    f.client.fetchSessionKeys.mockResolvedValueOnce([{ address: signer, scopes: ['COMBOSRFQ'], validUntil: now.getTime() / 1000 + 1_000 }]);
    expect(await sessionReady(sdk, now)).toBe(false);
    f.client.fetchTradingApprovalsState.mockResolvedValueOnce({ isFullyApproved: false, missing: {} });
    const refresh = vi.fn(async () => {});
    await setupApprovals(sdk, ['123', '123', '456'], refresh);
    expect(f.client.setupTradingApprovals).toHaveBeenCalledOnce();
    expect(refresh.mock.calls).toEqual([[AssetType.COLLATERAL], [AssetType.CONDITIONAL, '123'], [AssetType.CONDITIONAL, '456']]);
  });
});
