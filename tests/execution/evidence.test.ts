import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { FILL_ABI, polymarketEvidence, type EvidenceConfig } from '../../packages/execution/src/evidence.js';
import type { OrderIntent } from '../../packages/execution/src/types.js';

vi.mock('@polymarket/client/actions', () => ({
  fetchBalanceAllowance: async () => ({ balance: '10000000', allowances: {} }),
}));
const wallet = '0x1111111111111111111111111111111111111111';
const exchange = '0x2222222222222222222222222222222222222222';
const hash = `0x${'ab'.repeat(32)}` as const;
const orderId = `0x${'cd'.repeat(32)}` as const;
const blockHash = `0x${'ef'.repeat(32)}` as const;
const conditionId = `0x${'12'.repeat(32)}`;
const zero = `0x${'00'.repeat(32)}` as const;
const intent: OrderIntent = { tokenId: '7', conditionId, outcome: 'YES', side: 'BUY',
  sharesMicros: 1_000_000, limitPriceMicros: 500_000, maxCashMicros: 550_000 };
function fixture(side: 'BUY' | 'SELL' = 'BUY') {
  let cap = 500n;
  let final = 100n;
  const trades = [{ id: 'trade', takerOrderId: orderId, makerOrders: [], conditionId, status: 'CONFIRMED', transactionHash: hash }];
  const log = {
    address: exchange, logIndex: 3,
    topics: encodeEventTopics({ abi: FILL_ABI, eventName: 'OrderFilled', args: { orderHash: orderId, maker: wallet, taker: exchange } }),
    data: encodeAbiParameters([{ type: 'uint8' }, ...Array.from({ length: 4 }, () => ({ type: 'uint256' } as const)), { type: 'bytes32' }, { type: 'bytes32' }],
      [side === 'BUY' ? 0 : 1, 7n, side === 'BUY' ? 500_000n : 1_000_000n, side === 'BUY' ? 1_000_000n : 500_000n, 25_000n, zero, zero]),
  };
  const reads = { pages: 0 };
  const config = {
    client: {
      account: { wallet }, fetchOrderBook: async () => ({ assetId: '7', negRisk: false }),
      listAccountTrades: async function* () { reads.pages++; yield { items: [] }; reads.pages++; yield { items: trades }; },
      listOpenOrders: async function* () { yield { items: [] }; yield { items: [{ id: 'resting', makerAddress: wallet, side: 'BUY', assetId: '7', originalSize: '2', sizeMatched: '1', price: '0.5' }] }; },
      fetchOrder: async () => ({ id: orderId, assetId: '7', makerAddress: wallet, sizeMatched: '1', associateTrades: ['trade'] }),
    },
    rpc: {
      getChainId: async () => 137,
      readContract: async () => cap,
      getBlock: async (request: { blockTag?: string }) => request.blockTag ? { number: final } : { hash: blockHash },
      getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, blockHash, logs: [log] }),
    },
    contracts: { chainId: 137, standardExchange: exchange, negRiskExchange: exchange },
    health: async () => 'open',
  } as unknown as EvidenceConfig;
  return { config, trades, log, reads, setCap: (value: bigint) => { cap = value; }, setFinal: (value: bigint) => { final = value; } };
}

describe('CTF-v2 authoritative execution evidence', () => {
  it('paginates trades and uses keyed finalized fills with actual BUY and SELL collateral fees', async () => {
    for (const side of ['BUY', 'SELL'] as const) {
      const f = fixture(side);
      const result = await polymarketEvidence(f.config).reconcile(wallet, orderId, { ...intent, side });
      expect(result).toMatchObject({ kind: 'confirmed', fills: [{ orderId, side, sharesMicros: 1_000_000,
        cashMicros: side === 'BUY' ? 525_000 : 475_000, feeMicros: 25_000, transactionHash: hash }] });
      expect(f.reads.pages).toBe(2);
    }
  });
  it('keeps absent, unfinalized, and wrong-exchange evidence uncertain', async () => {
    const f = fixture(); const evidence = polymarketEvidence(f.config);
    f.setFinal(99n);
    expect((await evidence.reconcile(wallet, orderId, intent)).kind).toBe('pending');
    f.setFinal(100n); f.log.address = wallet;
    expect((await evidence.reconcile(wallet, orderId, intent)).kind).toBe('unknown');
    f.trades.length = 0;
    expect((await evidence.reconcile(wallet, orderId, intent)).kind).toBe('unknown');
  });
  it('reserves all open-order pages with conservative fees and rejects zero/unbounded exchange cap', async () => {
    const f = fixture();
    expect(await polymarketEvidence(f.config).availableCashMicros(wallet)).toBe(8_950_000);
    Object.assign(f.trades[0]!, { status: 'MATCHED', traderSide: 'TAKER', side: 'BUY', assetId: '7', size: '1', price: '0.5' });
    expect(await polymarketEvidence(f.config).availableCashMicros(wallet)).toBe(8_425_000);
    f.setCap(0n);
    await expect(polymarketEvidence(f.config).feeBoundBps('7')).rejects.toThrow(/enforceable/);
  });
});
