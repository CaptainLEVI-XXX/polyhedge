import { production } from '@polymarket/client';
import { createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, parseAbi, zeroHash, type Address, type Hex, type PublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { integer, validatePayout } from './accounting.js';
import type { ConditionRecord, RedemptionRecord, SettlementVenue, SubmissionResult, RedemptionReceipt } from './types.js';

const ctfAbi = parseAbi([
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function payoutNumerators(bytes32,uint256) view returns (uint256)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
  'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
  'function getPositionId(address,bytes32) pure returns (uint256)',
  'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
]);
const adapterAbi = parseAbi([
  'function redeemPositions(address,bytes32,bytes32,uint256[])',
  'function USDCE() view returns (address)',
  'function WRAPPED_COLLATERAL() view returns (address)',
]);
const collateralAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
// SDK 0.10.0 ships deployment metadata but its EnvironmentConfig public type is opaque.
// Validate the pinned runtime metadata instead of copying potentially stale addresses.
function deploymentContracts() {
  const raw = (production as unknown as { contracts?: Record<string, unknown> }).contracts;
  function address(name: string): Address {
    const value = raw?.[name];
    if (typeof value !== 'string') throw new Error(`Pinned SDK deployment lacks ${name}`);
    return getAddress(value);
  }
  return { collateralToken: address('collateralToken'), conditionalTokens: address('conditionalTokens'),
    negRiskAdapter: address('negRiskAdapter'), collateralAdapter: address('collateralAdapter'),
    negRiskCollateralAdapter: address('negRiskCollateralAdapter') };
}
export const settlementContracts = deploymentContracts();
export interface RedemptionCall { to: Address; data: Hex; value: '0' }
export type TransactionEnvelope = NonNullable<RedemptionRecord['transportEnvelope']>;
export type TransportStatus =
  | { status: 'pending'; submissionId: string; transactionHash?: Hex }
  | { status: 'confirmed'; submissionId: string; transactionHash: Hex }
  | { status: 'failed'; reason: string }
  | { status: 'unknown'; reason: string };
/**
 * Required wallet-specific integration. prepare signs/reserves the exact nonce WITHOUT sending.
 * broadcast and lookup operate on that same persisted envelope across process restarts.
 * lookup must also recover the persisted-before-broadcast gap by safely resending the
 * identical signed request/nonce when its protocol permits that; never sign a new request.
 * A relayer implementation must serialize its signed request/nonce here; calling SDK
 * redeemPositions afresh during recovery is not a conforming implementation.
 */
export interface DurableRedemptionTransport {
  prepare(id: string, wallet: Address, calls: RedemptionCall[]): Promise<TransactionEnvelope>;
  broadcast(envelope: TransactionEnvelope): Promise<TransportStatus>;
  lookup(envelope: TransactionEnvelope, submissionId?: string): Promise<TransportStatus>;
}
export interface PolymarketSettlementOptions {
  rpc: Pick<PublicClient, 'getChainId' | 'getBlockNumber' | 'readContract' | 'getTransactionReceipt'>;
  transport: DurableRedemptionTransport;
  confirmations?: number;
  proposalStage?: (condition: ConditionRecord) => Promise<'observing' | 'proposed' | 'disputed'>;
  /** Optional indexer returns a candidate hash; logs and payout are still verified here. */
  externalTransaction?: (condition: ConditionRecord, redemption: RedemptionRecord) => Promise<Hex | null>;
}
export function polygonSettlementRpc(url: string): PolymarketSettlementOptions['rpc'] {
  return createPublicClient({ chain: polygon, transport: http(url) });
}
export function redemptionAdapter(negRisk: boolean): Address {
  return getAddress(negRisk ? settlementContracts.negRiskCollateralAdapter : settlementContracts.collateralAdapter);
}
export function redemptionCall(condition: ConditionRecord): RedemptionCall {
  return { to: redemptionAdapter(condition.negRisk), value: '0', data: encodeFunctionData({
    abi: adapterAbi, functionName: 'redeemPositions', args: [getAddress(settlementContracts.collateralToken), zeroHash, condition.conditionId as Hex, [1n, 2n]],
  }) };
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const safe = (n: bigint, field: string) => integer(Number(n), field);
class RedemptionRevertedError extends Error {}

export function createPolymarketSettlementVenue(options: PolymarketSettlementOptions): SettlementVenue {
  const { rpc, transport } = options;
  const confirmations = options.confirmations ?? 20;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('Confirmations must be a positive integer');
  const ctf = getAddress(settlementContracts.conditionalTokens);
  async function block() {
    if (await rpc.getChainId() !== production.chainId) throw new Error('Settlement RPC must use Polygon chain 137');
    return rpc.getBlockNumber();
  }
  async function underlyingCollateral(condition: ConditionRecord, blockNumber: bigint) {
    return rpc.readContract({ address: redemptionAdapter(condition.negRisk), abi: adapterAbi,
      functionName: condition.negRisk ? 'WRAPPED_COLLATERAL' : 'USDCE', blockNumber });
  }
  async function verifyReceipt(condition: ConditionRecord, redemption: RedemptionRecord, hash: Hex): Promise<RedemptionReceipt | null> {
    const head = await block();
    const receipt = await rpc.getTransactionReceipt({ hash });
    if (receipt.status === 'reverted') throw new RedemptionRevertedError('Redemption transaction reverted');
    if (head < receipt.blockNumber + BigInt(confirmations - 1)) return null;
    const underlying = await underlyingCollateral(condition, receipt.blockNumber);
    const adapter = redemptionAdapter(condition.negRisk);
    const expectedRedeemer = condition.negRisk ? settlementContracts.negRiskAdapter : adapter;
    let ctfPayout = 0n;
    let foundRedemption = false;
    let collateralReceived = 0n;
    const transferred = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (same(log.address, ctf)) {
        let decoded;
        try { decoded = decodeEventLog({ abi: ctfAbi, data: log.data, topics: log.topics }); } catch { continue; }
        if (decoded.eventName === 'PayoutRedemption') {
          const a = decoded.args;
          if (same(a.conditionId, condition.conditionId) && same(a.redeemer, expectedRedeemer) && same(a.collateralToken, underlying) && a.parentCollectionId === zeroHash &&
              a.indexSets.length === 2 && a.indexSets[0] === 1n && a.indexSets[1] === 2n) {
            ctfPayout += a.payout; foundRedemption = true;
          }
        } else if (decoded.eventName === 'TransferBatch' || decoded.eventName === 'TransferSingle') {
          const a = decoded.args;
          if (!same(a.from, condition.wallet) || !same(a.to, adapter)) continue;
          const ids = decoded.eventName === 'TransferBatch' ? decoded.args.ids : [decoded.args.id];
          const values = decoded.eventName === 'TransferBatch' ? decoded.args.values : [decoded.args.value];
          ids.forEach((id, i) => transferred.set(id.toString(), (transferred.get(id.toString()) ?? 0n) + values[i]!));
        }
      } else if (same(log.address, settlementContracts.collateralToken)) {
        let decoded;
        try { decoded = decodeEventLog({ abi: collateralAbi, data: log.data, topics: log.topics }); } catch { continue; }
        if (same(decoded.args.to, condition.wallet)) collateralReceived += decoded.args.value;
        if (same(decoded.args.from, condition.wallet)) collateralReceived -= decoded.args.value;
      }
    }
    if (!foundRedemption || collateralReceived !== ctfPayout || collateralReceived < 0n) throw new Error('Receipt lacks matching CTF redemption and actual pUSD transfer');
    for (const balance of redemption.balances) {
      if ((transferred.get(balance.tokenId) ?? 0n) !== BigInt(balance.sharesMicros)) throw new Error('Receipt token transfers differ from durable balance snapshot');
    }
    return { transactionHash: hash, wallet: condition.wallet, conditionId: condition.conditionId, payoutMicros: safe(collateralReceived, 'actual payout'), verified: true };
  }
  async function result(condition: ConditionRecord, redemption: RedemptionRecord, status: TransportStatus): Promise<SubmissionResult> {
    if (status.status === 'failed' || status.status === 'unknown') return status;
    if (status.transactionHash) {
      try {
        const receipt = await verifyReceipt(condition, redemption, status.transactionHash);
        if (receipt) return { status: 'confirmed', submissionId: status.submissionId, receipt };
      } catch (error) {
        if (error instanceof RedemptionRevertedError) return { status: 'failed', reason: error.message };
        throw error;
      }
    }
    return { status: 'pending', submissionId: status.submissionId };
  }
  return {
    async resolution(condition) {
      const head = await block();
      if (head < BigInt(confirmations - 1)) return { finalized: false, stage: 'observing' };
      const blockNumber = head - BigInt(confirmations - 1);
      const denominator = await rpc.readContract({ address: ctf, abi: ctfAbi, functionName: 'payoutDenominator', args: [condition.conditionId as Hex], blockNumber });
      if (denominator === 0n) return { finalized: false, stage: await options.proposalStage?.(condition) ?? 'observing' };
      const [yes, no] = await Promise.all([0n, 1n].map(i => rpc.readContract({ address: ctf, abi: ctfAbi, functionName: 'payoutNumerators', args: [condition.conditionId as Hex, i], blockNumber })));
      const payout = { yes: safe(yes!, 'YES numerator'), no: safe(no!, 'NO numerator'), denominator: safe(denominator, 'denominator') };
      validatePayout(payout);
      return { finalized: true, stage: 'proposed', payout };
    },
    async balances(condition) {
      const blockNumber = await block();
      const collateral = await underlyingCollateral(condition, blockNumber);
      const output = [];
      for (const [index, tokenId] of [condition.yesTokenId, condition.noTokenId].entries()) {
        const collection = await rpc.readContract({ address: ctf, abi: ctfAbi, functionName: 'getCollectionId', args: [zeroHash, condition.conditionId as Hex, BigInt(index + 1)], blockNumber });
        const expected = await rpc.readContract({ address: ctf, abi: ctfAbi, functionName: 'getPositionId', args: [collateral, collection], blockNumber });
        if (BigInt(tokenId) !== expected) throw new Error('Condition token ID does not match its onchain position');
        const amount = await rpc.readContract({ address: ctf, abi: ctfAbi, functionName: 'balanceOf', args: [getAddress(condition.wallet), expected], blockNumber });
        output.push({ tokenId, outcome: index === 0 ? 'YES' as const : 'NO' as const, sharesMicros: safe(amount, 'wallet balance') });
      }
      return output;
    },
    async prepare(condition, redemption) {
      const blockNumber = await block();
      const adapter = redemptionAdapter(condition.negRisk);
      const approved = await rpc.readContract({ address: ctf, abi: ctfAbi, functionName: 'isApprovedForAll', args: [getAddress(condition.wallet), adapter], blockNumber });
      const calls: RedemptionCall[] = [];
      if (!approved) calls.push({ to: ctf, value: '0', data: encodeFunctionData({ abi: ctfAbi, functionName: 'setApprovalForAll', args: [adapter, true] }) });
      calls.push(redemptionCall(condition));
      return transport.prepare(redemption.id, getAddress(condition.wallet), calls);
    },
    async submit(condition, redemption) {
      if (!redemption.transportEnvelope) throw new Error('Durable signed transaction envelope is missing');
      return result(condition, redemption, await transport.broadcast(redemption.transportEnvelope));
    },
    async reconcile(condition, redemption) {
      if (!redemption.transportEnvelope) return { status: 'failed', reason: 'No prepared envelope was persisted; transaction was never broadcast' };
      return result(condition, redemption, await transport.lookup(redemption.transportEnvelope, redemption.submissionId));
    },
    async findExternalReceipt(condition, redemption) {
      const hash = await options.externalTransaction?.(condition, redemption);
      return hash ? verifyReceipt(condition, redemption, hash) : null;
    },
  };
}
