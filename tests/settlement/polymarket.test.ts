import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, zeroHash, type Hex } from 'viem';
import { createPolymarketSettlementVenue, redemptionAdapter, redemptionCall, settlementContracts, type PolymarketSettlementOptions } from '../../packages/settlement/src/polymarket.js';
import type { ConditionRecord, RedemptionRecord } from '../../packages/settlement/src/types.js';

const wallet = '0x1111111111111111111111111111111111111111';
const underlying = '0x2222222222222222222222222222222222222222';
const conditionId = `0x${'33'.repeat(32)}` as Hex;
const hash = `0x${'44'.repeat(32)}` as Hex;
const abi = parseAbi([
  'function redeemPositions(address,bytes32,bytes32,uint256[])',
  'function setApprovalForAll(address,bool)',
  'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
function records(negRisk = false): { condition: ConditionRecord; redemption: RedemptionRecord } {
  const positions = [{ basketId: 'b', wallet, conditionId, tokenId: '1', outcome: 'YES' as const, sharesMicros: 10_000_000 }];
  const redemption: RedemptionRecord = { id: 'r', status: 'prepared', preparedAt: 'now', payout: { yes: 1, no: 0, denominator: 1 },
    positions, balances: [{ tokenId: '1', outcome: 'YES', sharesMicros: 10_000_000 }, { tokenId: '2', outcome: 'NO', sharesMicros: 0 }],
    allocations: [], externalPayoutMicros: 0, transportEnvelope: { kind: 'durable-test', data: { nonce: 17 } } };
  return { redemption, condition: { key: `${wallet}:${conditionId}`, revision: 0, wallet, conditionId, negRisk, yesTokenId: '1', noTokenId: '2', positions, phase: 'redeeming', payout: redemption.payout, history: [], redemptions: [redemption] } };
}
function logs(negRisk: boolean, payout = 10_000_000n) {
  const adapter = redemptionAdapter(negRisk);
  return [
    { address: settlementContracts.conditionalTokens, topics: encodeEventTopics({ abi, eventName: 'TransferBatch', args: { operator: adapter, from: wallet, to: adapter } }),
      data: encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[1n, 2n], [10_000_000n, 0n]]) },
    { address: settlementContracts.conditionalTokens, topics: encodeEventTopics({ abi, eventName: 'PayoutRedemption', args: { redeemer: negRisk ? settlementContracts.negRiskAdapter : adapter, collateralToken: underlying, parentCollectionId: zeroHash } }),
      data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256[]' }, { type: 'uint256' }], [conditionId, [1n, 2n], 10_000_000n]) },
    { address: settlementContracts.collateralToken, topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: zeroAddress, to: wallet } }), data: encodeAbiParameters([{ type: 'uint256' }], [payout]) },
  ];
}
function setup(negRisk = false) {
  let denominator = 1n;
  let head = 120n;
  let receiptLogs = logs(negRisk);
  const reads: string[] = [];
  const rpc = {
    getChainId: async () => 137,
    getBlockNumber: async () => head,
    readContract: async (request: { functionName: string; args?: unknown[]; blockNumber: bigint }) => {
      reads.push(request.functionName);
      switch (request.functionName) {
        case 'payoutDenominator':
          expect(request.blockNumber).toBe(head - 19n);
          return denominator;
        case 'payoutNumerators': return request.args?.[1] === 0n ? 1n : 0n;
        case 'USDCE': case 'WRAPPED_COLLATERAL': return underlying;
        case 'isApprovedForAll': return false;
        case 'getCollectionId': return request.args?.[2] === 1n ? zeroHash : conditionId;
        case 'getPositionId': return request.args?.[1] === zeroHash ? 1n : 2n;
        case 'balanceOf': return request.args?.[1] === 1n ? 10_000_000n : 0n;
        default: throw new Error(`unexpected read ${request.functionName}`);
      }
    },
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, transactionHash: hash, logs: receiptLogs }),
  } as unknown as PolymarketSettlementOptions['rpc'];
  const options: PolymarketSettlementOptions = { rpc, confirmations: 20, transport: {
    prepare: async (_id, _wallet, calls) => ({ kind: 'durable-test', data: { nonce: 17, calls } }),
    broadcast: async () => ({ status: 'confirmed', submissionId: 'r', transactionHash: hash }),
    lookup: async () => ({ status: 'confirmed', submissionId: 'r', transactionHash: hash }),
  } };
  return { options, venue: createPolymarketSettlementVenue(options), reads,
    setDenominator: (n: bigint) => { denominator = n; }, setHead: (n: bigint) => { head = n; },
    setLogs: (value: typeof receiptLogs) => { receiptLogs = value; } };
}
describe('Polymarket settlement contract boundary', () => {
  it.each([false, true])('encodes the current collateral adapter and verifies onchain resolution/tokens (negRisk=%s)', async negRisk => {
    const { condition, redemption } = records(negRisk); const h = setup(negRisk);
    const call = redemptionCall(condition);
    expect(call.to.toLowerCase()).toBe((negRisk ? settlementContracts.negRiskCollateralAdapter : settlementContracts.collateralAdapter).toLowerCase());
    expect(call.to.toLowerCase()).not.toBe(settlementContracts.negRiskAdapter.toLowerCase());
    expect(decodeFunctionData({ abi, data: call.data })).toEqual({ functionName: 'redeemPositions', args: [settlementContracts.collateralToken, zeroHash, conditionId, [1n, 2n]] });
    h.setDenominator(0n);
    expect((await h.venue.resolution(condition)).finalized).toBe(false);
    h.setDenominator(1n);
    expect((await h.venue.resolution(condition)).payout).toEqual({ yes: 1, no: 0, denominator: 1 });
    expect(await h.venue.balances(condition)).toEqual(redemption.balances);
    await expect(h.venue.balances({ ...condition, yesTokenId: '3' })).rejects.toThrow('onchain position');
    const envelope = await h.venue.prepare!(condition, redemption);
    const calls = envelope.data.calls as Array<{ data: Hex }>;
    expect(calls).toHaveLength(2);
    expect(decodeFunctionData({ abi, data: calls[0]!.data }).functionName).toBe('setApprovalForAll');
    expect(h.reads).toContain(negRisk ? 'WRAPPED_COLLATERAL' : 'USDCE');
  });

  it.each([false, true])('requires confirmed CTF logs, snapshot transfers and actual collateral receipt (negRisk=%s)', async negRisk => {
    const { condition, redemption } = records(negRisk); const h = setup(negRisk);
    h.setHead(118n);
    expect((await h.venue.reconcile(condition, redemption)).status).toBe('pending');
    h.setHead(119n);
    const result = await h.venue.reconcile(condition, redemption);
    expect(result).toMatchObject({ status: 'confirmed', receipt: { verified: true, payoutMicros: 10_000_000 } });
    h.setLogs(logs(negRisk, 9_000_000n));
    await expect(h.venue.reconcile(condition, redemption)).rejects.toThrow('actual pUSD');
    h.setLogs(logs(negRisk).slice(1));
    await expect(h.venue.reconcile(condition, redemption)).rejects.toThrow('token transfers');
  });

  it('requires a durable envelope and returns safe failure if a crash preceded preparation', async () => {
    const { condition, redemption } = records(); const h = setup();
    delete redemption.transportEnvelope;
    await expect(h.venue.submit(condition, redemption)).rejects.toThrow('envelope is missing');
    expect(await h.venue.reconcile(condition, redemption)).toMatchObject({ status: 'failed' });
  });
});
