import { OrderSide, OrderType, SignatureType, type SecureClient, type SignedOrder } from '@polymarket/client';
import { hashTypedData, type Address } from 'viem';
import { integer, mulDiv } from './order.js';
import { sessionReady } from './wallet.js';
import type { ExecutionVenue, MarketBook, OrderIntent, OrderResolution, SignedEnvelope, VenueState } from './types.js';

export interface ExchangeContracts {
  chainId: number;
  standardExchange: Address;
  negRiskExchange: Address;
}
export interface ExecutionEvidence {
  /** Net collateral after ALL resting orders; must paginate the account's open orders. */
  availableCashMicros(wallet: string): Promise<number>;
  /** Includes restart post-only and cancel-only states. Unknown status must return closed. */
  mode(): Promise<VenueState['mode']>;
  /** Fresh, conservative ALL fee cap. Missing metadata must throw, never default to zero. */
  feeBoundBps(tokenId: string): Promise<number>;
  /**
   * Must join the order's trades to finalized successful chain receipts and
   * actual cash/share movements, including fees. A missing order is UNKNOWN,
   * not failed. Return confirmed only once all possible fills are terminal.
   * SDK acceptance / MATCHED / MINED / retrying are insufficient evidence.
   */
  reconcile(wallet: string, orderId: string, intent: OrderIntent): Promise<OrderResolution>;
}
type Client = Pick<SecureClient, 'account' | 'fetchSessionKeys' | 'fetchTradingApprovalsState' |
  'fetchOrderBook' | 'createLimitOrder' | 'postOrder'>;
interface Payload { schema: 1; order: SignedOrder; intent: OrderIntent; exchange: Address; chainId: number }

const ORDER_FIELDS = [
  { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' },
  { name: 'signer', type: 'address' }, { name: 'tokenId', type: 'uint256' },
  { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
  { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' },
  { name: 'timestamp', type: 'uint256' }, { name: 'metadata', type: 'bytes32' },
  { name: 'builder', type: 'bytes32' },
] as const;

/** Matches ctf-exchange-v2 Hashing.hashOrder: domain-separated digest, not struct hash. */
export function hashPolymarketOrder(order: SignedOrder, exchange: Address, chainId: number): string {
  return hashTypedData({ domain: { name: 'Polymarket CTF Exchange', version: '2', chainId, verifyingContract: exchange },
    types: { Order: ORDER_FIELDS }, primaryType: 'Order', message: {
      salt: BigInt(order.salt), maker: order.maker, signer: order.signer, tokenId: BigInt(order.tokenId),
      makerAmount: BigInt(order.makerAmount), takerAmount: BigInt(order.takerAmount),
      side: order.side === OrderSide.BUY ? 0 : 1, signatureType: order.signatureType,
      timestamp: BigInt(order.timestamp), metadata: order.metadata, builder: order.builder,
    } });
}
function decimal(micros: number): string {
  integer(micros, 'fixed-point amount');
  return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, '0')}`;
}
function micros(raw: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error(`Unsupported numeric precision: ${raw}`);
  const [whole, fraction = ''] = raw.split('.');
  return integer(Number(BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))), 'venue amount');
}

/**
 * CTF-v2-only adapter. Deployment supplies verified exchange addresses matching
 * the SDK environment and authoritative accounting readers. Without those
 * readers the adapter cannot be constructed and execution stays unavailable.
 */
export class PolymarketVenue implements ExecutionVenue {
  constructor(private readonly client: Client, private readonly contracts: ExchangeContracts,
    private readonly evidence: ExecutionEvidence, private readonly now: () => Date = () => new Date()) {}

  private wallet(wallet: string): void {
    if (this.client.account.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('SDK account differs from authorized wallet');
  }
  async state(wallet: string): Promise<VenueState> {
    this.wallet(wallet);
    const [mode, availableCashMicros, sessionValid, approvals] = await Promise.all([
      this.evidence.mode(), this.evidence.availableCashMicros(wallet), sessionReady(this.client, this.now()),
      this.client.fetchTradingApprovalsState(),
    ]);
    return { mode, availableCashMicros: integer(availableCashMicros, 'available collateral'),
      sessionValid, approvalsReady: approvals.isFullyApproved };
  }
  async book(tokenId: string): Promise<MarketBook> {
    if (!/^\d+$/.test(tokenId)) throw new Error('Only decimal CTF-v2 token IDs are supported');
    const [book, feeBps] = await Promise.all([this.client.fetchOrderBook({ assetId: tokenId }), this.evidence.feeBoundBps(tokenId)]);
    if (book.timestamp === undefined || book.timestamp === null) throw new Error('Book has no authoritative observation timestamp');
    return { tokenId: book.assetId, observedAt: new Date(book.timestamp).toISOString(),
      asks: book.asks.map(level => ({ priceMicros: micros(level.price), sharesMicros: micros(level.size) })),
      bids: book.bids.map(level => ({ priceMicros: micros(level.price), sharesMicros: micros(level.size) })),
      tickMicros: micros(String(book.tickSize)), shareStepMicros: 10_000,
      minSharesMicros: micros(book.minOrderSize), feeBps: integer(feeBps, 'fee bound') };
  }
  async prepare(wallet: string, intent: OrderIntent): Promise<SignedEnvelope> {
    this.wallet(wallet);
    if (!(await sessionReady(this.client, this.now()))) throw new Error('Native CLOB session is expired, revoked or out of scope');
    const book = await this.client.fetchOrderBook({ assetId: intent.tokenId });
    if (book.assetId !== intent.tokenId || book.conditionId !== intent.conditionId || !/^\d+$/.test(intent.tokenId)) {
      throw new Error('Order asset/condition does not match the CTF market');
    }
    const order = await this.client.createLimitOrder({ assetId: intent.tokenId,
      side: intent.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
      price: decimal(intent.limitPriceMicros), size: decimal(intent.sharesMicros) });
    // FOK is transport metadata, outside the signed EIP-712 Order structure.
    order.orderType = OrderType.FOK;
    order.postOnly = false;
    const exchange = book.negRisk ? this.contracts.negRiskExchange : this.contracts.standardExchange;
    this.assertOrder(wallet, order, intent);
    return { orderId: hashPolymarketOrder(order, exchange, this.contracts.chainId),
      payload: { schema: 1, order, intent, exchange, chainId: this.contracts.chainId } satisfies Payload };
  }
  private assertOrder(wallet: string, order: SignedOrder, intent: OrderIntent): void {
    const buy = intent.side === 'BUY';
    const shares = BigInt(buy ? order.takerAmount : order.makerAmount);
    const cash = BigInt(buy ? order.makerAmount : order.takerAmount);
    const expectedNotional = BigInt(mulDiv(intent.sharesMicros, intent.limitPriceMicros, 1_000_000, buy));
    if (order.maker.toLowerCase() !== wallet.toLowerCase() || order.signatureType !== SignatureType.POLY_1271 ||
      order.tokenId !== intent.tokenId || order.side !== (buy ? OrderSide.BUY : OrderSide.SELL) ||
      shares !== BigInt(intent.sharesMicros) || cash !== expectedNotional || order.orderType !== OrderType.FOK || order.postOnly === true ||
      (buy ? cash > BigInt(intent.maxCashMicros) : cash < BigInt(intent.maxCashMicros))) {
      throw new Error('SDK signed order differs from the exact-share authorized intent');
    }
  }
  private payload(wallet: string, envelope: SignedEnvelope): Payload {
    this.wallet(wallet);
    const payload = envelope.payload as Payload;
    if (payload?.schema !== 1 || payload.chainId !== this.contracts.chainId ||
      ![this.contracts.standardExchange.toLowerCase(), this.contracts.negRiskExchange.toLowerCase()].includes(payload.exchange?.toLowerCase())) {
      throw new Error('Unsupported persisted order envelope');
    }
    this.assertOrder(wallet, payload.order, payload.intent);
    if (hashPolymarketOrder(payload.order, payload.exchange, payload.chainId) !== envelope.orderId) throw new Error('Persisted order hash mismatch');
    return payload;
  }
  async post(wallet: string, envelope: SignedEnvelope): Promise<OrderResolution> {
    const payload = this.payload(wallet, envelope);
    const response = await this.client.postOrder(payload.order);
    if (!response.ok) {
      // A duplicate/timeout-like error can refer to an accepted earlier submission.
      // Prefer settlement evidence and only classify explicit no-fill rejections.
      const reconciled = await this.evidence.reconcile(wallet, envelope.orderId, payload.intent);
      if (reconciled.kind !== 'unknown') return reconciled;
      const definitive = ['fok_not_filled', 'unmatched', 'market_not_ready',
        'insufficient_balance_or_allowance', 'invalid_expiration', 'post_only_would_cross', 'post_only_mode'];
      return definitive.includes(response.code)
        ? { kind: 'failed', reason: `${response.code}: ${response.message}` }
        : { kind: 'unknown', reason: response.message };
    }
    if (response.orderId.toLowerCase() !== envelope.orderId.toLowerCase()) return { kind: 'unknown', reason: 'Venue order ID differs from persisted signed order' };
    return this.evidence.reconcile(wallet, envelope.orderId, payload.intent);
  }
  async reconcile(wallet: string, envelope: SignedEnvelope): Promise<OrderResolution> {
    const payload = this.payload(wallet, envelope);
    return this.evidence.reconcile(wallet, envelope.orderId, payload.intent);
  }
}
