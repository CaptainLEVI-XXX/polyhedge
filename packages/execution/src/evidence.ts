import { fetchBalanceAllowance } from '@polymarket/client/actions';
import type { AssetType, SecureClient } from '@polymarket/client';
import { decodeEventLog, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { integer, mulDiv } from './order.js';
import type { ExchangeContracts, ExecutionEvidence } from './polymarket.js';
import type { ConfirmedFill, OrderIntent, OrderResolution, VenueState } from './types.js';

// Official ctf-exchange-v2/src/exchange/mixins/{Events,Trading,Fees}.sol.
export const FILL_ABI = parseAbi([
  'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
  'function getMaxFeeRate() view returns (uint256)',
]);
function units(raw: string): number {
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error('Unsupported venue decimal precision');
  const [whole, fraction = ''] = raw.split('.');
  return integer(Number(BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))), 'venue amount');
}
function safe(value: bigint): number { return integer(Number(value), 'chain amount'); }
function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
export interface EvidenceConfig {
  client: SecureClient;
  rpc: PublicClient;
  contracts: ExchangeContracts;
  /** Operational CLOB health, including restart post-only and cancel-only. Unknown must be closed. */
  health(): Promise<VenueState['mode']>;
}

/** CTF-v2 receipts supply actual collateral fees; trade statuses alone never confirm a fill. */
export function polymarketEvidence(config: EvidenceConfig): ExecutionEvidence {
  const { client, rpc, contracts } = config;
  const walletCheck = (wallet: string) => {
    if (!same(wallet, client.account.wallet)) throw new Error('Evidence account differs from execution wallet');
  };
  const chainCheck = async () => {
    if (await rpc.getChainId() !== contracts.chainId) throw new Error('RPC chain differs from configured exchange');
  };
  const exchangeFor = async (tokenId: string): Promise<Address> => {
    const book = await client.fetchOrderBook({ assetId: tokenId });
    if (book.assetId !== tokenId) throw new Error('Book asset mismatch');
    return book.negRisk ? contracts.negRiskExchange : contracts.standardExchange;
  };
  const feeBoundBps = async (tokenId: string): Promise<number> => {
    await chainCheck();
    const cap = safe(await rpc.readContract({ address: await exchangeFor(tokenId), abi: FILL_ABI, functionName: 'getMaxFeeRate' }));
    // A zero cap DISABLES the exchange's fee limit; it does not mean zero fees.
    if (cap === 0 || cap >= 10_000) throw new Error('Exchange has no supported enforceable fee cap');
    return cap;
  };
  return {
    feeBoundBps,
    async mode() {
      const mode = await config.health();
      return ['open', 'post_only', 'cancel_only', 'closed'].includes(mode) ? mode : 'closed';
    },
    async availableCashMicros(wallet) {
      walletCheck(wallet);
      const balance = await fetchBalanceAllowance(client, { assetType: 'COLLATERAL' as AssetType });
      let reserved = 0;
      const caps = new Map<string, number>();
      const reserve = async (token: string, size: string, price: string) => {
        let cap = caps.get(token);
        if (cap === undefined) { cap = await feeBoundBps(token); caps.set(token, cap); }
        const notional = mulDiv(units(size), units(price), 1_000_000, true);
        reserved = integer(reserved + notional + mulDiv(notional, cap, 10_000, true), 'reserved collateral');
      };
      // Reserve the FULL open-order quantity, including matched-but-unsettled parts.
      // Additional pending trades can overlap: intentional over-reservation is safer
      // than spending collateral already committed by an order absent from this page.
      const orders = new Set<string>();
      for await (const page of client.listOpenOrders()) for (const order of page.items) {
        if (!same(order.makerAddress, wallet)) throw new Error('Unexpected wallet in open orders');
        if (orders.has(order.id)) throw new Error('Order pagination changed; retry the snapshot');
        orders.add(order.id);
        if (order.side === 'BUY') await reserve(order.assetId, order.originalSize, order.price);
      }
      const seen = new Set<string>();
      for await (const page of client.listAccountTrades()) for (const trade of page.items) {
        if (seen.has(trade.id)) throw new Error('Trade pagination changed; retry the snapshot');
        seen.add(trade.id);
        if (trade.status === 'CONFIRMED' || trade.status === 'FAILED') continue;
        if (trade.traderSide === 'TAKER') {
          if (trade.side === 'BUY') await reserve(trade.assetId, trade.size, trade.price);
        } else {
          for (const maker of trade.makerOrders) if (same(maker.makerAddress, wallet) && maker.side === 'BUY') {
            await reserve(maker.assetId, maker.matchedAmount, maker.price);
          }
        }
      }
      // Re-read after pagination to avoid using a balance from before fills settled.
      const latest = await fetchBalanceAllowance(client, { assetType: 'COLLATERAL' as AssetType });
      return Math.max(0, Math.min(safe(BigInt(balance.balance)), safe(BigInt(latest.balance))) - reserved);
    },
    async reconcile(wallet, orderId, intent): Promise<OrderResolution> {
      walletCheck(wallet);
      await chainCheck();
      const trades = new Map<string, { status: string; transactionHash: string }>();
      for await (const page of client.listAccountTrades()) for (const trade of page.items) {
        if (trade.takerOrderId !== orderId && !trade.makerOrders.some(m => m.orderId === orderId)) continue;
        if (!same(trade.conditionId, intent.conditionId)) throw new Error('Trade condition differs from signed intent');
        if (trades.has(trade.id)) throw new Error('Trade pagination changed; retry reconciliation');
        trades.set(trade.id, trade);
      }
      if (trades.size === 0) return { kind: 'unknown', reason: 'Order has no indexed trades; absence does not establish failure' };
      const order = await client.fetchOrder({ orderId });
      if (order.id !== orderId || order.assetId !== intent.tokenId || !same(order.makerAddress, wallet)) throw new Error('Order identity mismatch');
      if (order.associateTrades.some(id => !trades.has(id))) return { kind: 'pending', reason: 'Not all order trades are indexed yet' };
      if ([...trades.values()].some(t => t.status !== 'CONFIRMED' && t.status !== 'FAILED')) {
        return { kind: 'pending', reason: 'Order trades have not all reached terminal settlement' };
      }
      const confirmed = [...trades.values()].filter(t => t.status === 'CONFIRMED');
      if (!confirmed.length) return { kind: 'unknown', reason: 'Failed indexed trades do not prove the signed order cannot fill later' };
      const exchange = await exchangeFor(intent.tokenId);
      const final = await rpc.getBlock({ blockTag: 'finalized' });
      const fills: ConfirmedFill[] = [];
      for (const hash of new Set(confirmed.map(t => t.transactionHash))) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Confirmed trade lacks transaction hash');
        const receipt = await rpc.getTransactionReceipt({ hash: hash as Hex });
        if (receipt.status !== 'success' || receipt.blockNumber > final.number) {
          return { kind: 'pending', reason: 'Trade receipt is not finalized and successful' };
        }
        const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
        if (block.hash !== receipt.blockHash) return { kind: 'pending', reason: 'Trade receipt is not on the canonical chain' };
        let found = false;
        for (const log of receipt.logs) {
          if (!same(log.address, exchange)) continue;
          let decoded;
          try { decoded = decodeEventLog({ abi: FILL_ABI, data: log.data, topics: log.topics }); }
          catch { continue; }
          const event = decoded.args;
          if (!same(event.orderHash, orderId)) continue;
          if (!same(event.maker, wallet) || event.tokenId !== BigInt(intent.tokenId) || event.side !== (intent.side === 'BUY' ? 0 : 1)) throw new Error('Receipt fill differs from signed intent');
          found = true;
          const buy = intent.side === 'BUY';
          const cash = buy ? event.makerAmountFilled + event.fee : event.takerAmountFilled - event.fee;
          fills.push({ id: `${hash}:${log.logIndex}`, orderId, tokenId: intent.tokenId, conditionId: intent.conditionId,
            outcome: intent.outcome, side: intent.side, sharesMicros: safe(buy ? event.takerAmountFilled : event.makerAmountFilled),
            cashMicros: safe(cash), feeMicros: safe(event.fee), transactionHash: hash });
        }
        if (!found) return { kind: 'unknown', reason: 'Receipt has no matching exchange fill event' };
      }
      const shares = fills.reduce((sum, fill) => integer(sum + fill.sharesMicros, 'settled shares'), 0);
      // Full quantity is required before allowing the sequencer to assume no more
      // fills can arrive. Partial or lagging evidence stays uncertain indefinitely.
      if (shares !== intent.sharesMicros || units(order.sizeMatched) !== shares) {
        return { kind: 'unknown', reason: 'Receipt quantity is not the exact complete FOK quantity' };
      }
      return { kind: 'confirmed', fills };
    },
  };
}
