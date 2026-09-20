import type { QuoteRecord } from '@polyhedge/engine';

/** Monetary and quantity values are integer millionths, safe to JSON round-trip. */
export type Micros = number;
export type Outcome = 'YES' | 'NO';
export type ConditionPhase = 'observing' | 'proposed' | 'disputed' | 'redeemable' | 'lost' | 'redeeming' | 'redeemed';
export type BasketState = 'filled' | 'partial' | 'observing' | 'proposed' | 'disputed' | 'redeemable' | 'redeeming' | 'redeemed' | 'lost';
export interface AcquiredPosition {
  basketId: string; wallet: string; conditionId: string; tokenId: string;
  outcome: Outcome; sharesMicros: Micros;
}
export interface PayoutVector { yes: number; no: number; denominator: number }
export interface ReferenceObservation { price: number; observedAt: string; source: string }
export interface SettlementBasket {
  id: string; revision: number; wallet: string; quote: QuoteRecord;
  positions: AcquiredPosition[]; costMicros: Micros;
  /** Must come from the accepted event's reference observation requirements. */
  expectedObservationAt: string; expectedSource: string;
  observation?: ReferenceObservation;
  executionComplete: boolean;
}
export interface BalanceSnapshot { tokenId: string; outcome: Outcome; sharesMicros: Micros }
export interface RedemptionAllocation { basketId: string; payoutMicros: Micros }
export interface RedemptionRecord {
  id: string; status: 'prepared' | 'pending' | 'confirmed' | 'failed' | 'unknown';
  preparedAt: string; payout: PayoutVector; balances: BalanceSnapshot[];
  positions: AcquiredPosition[];
  /** Actual result is assigned only after a verified receipt matching this condition/wallet. */
  receipt?: RedemptionReceipt;
  submissionId?: string;
  /** Prepared signed envelope/nonce is stored before any broadcast. JSON-safe. */
  transportEnvelope?: { kind: string; data: Record<string, unknown> };
  allocations: RedemptionAllocation[];
  externalPayoutMicros: Micros;
  error?: string;
}
export interface HistoryEntry { at: string; from: ConditionPhase; to: ConditionPhase; reason: string }
export interface ConditionRecord {
  key: string; revision: number; wallet: string; conditionId: string; negRisk: boolean;
  yesTokenId: string; noTokenId: string;
  positions: AcquiredPosition[]; phase: ConditionPhase;
  payout?: PayoutVector;
  history: HistoryEntry[]; redemptions: RedemptionRecord[];
}
export interface AuthoritativeResolution {
  /** Finality must be established by the adapter, never inferred from a websocket or closed flag. */
  finalized: boolean; stage: 'observing' | 'proposed' | 'disputed';
  payout?: PayoutVector;
}
export interface RedemptionReceipt {
  transactionHash: string; wallet: string; conditionId: string;
  payoutMicros: Micros;
  /** Confirmed receipt + matching redemption log + actual collateral received. */
  verified: boolean;
}
export type SubmissionResult =
  | { status: 'pending'; submissionId: string }
  | { status: 'confirmed'; submissionId: string; receipt: RedemptionReceipt }
  | { status: 'failed'; reason: string }
  | { status: 'unknown'; reason: string };
export interface SettlementVenue {
  resolution(condition: ConditionRecord): Promise<AuthoritativeResolution>;
  balances(condition: ConditionRecord): Promise<BalanceSnapshot[]>;
  /** Optional signer step; MUST NOT broadcast. Result is persisted before submit. */
  prepare?(condition: ConditionRecord, redemption: RedemptionRecord): Promise<NonNullable<RedemptionRecord['transportEnvelope']>>;
  /** id is an idempotency key. Adapter must reconcile it before any retry submission. */
  submit(condition: ConditionRecord, redemption: RedemptionRecord): Promise<SubmissionResult>;
  reconcile(condition: ConditionRecord, redemption: RedemptionRecord): Promise<SubmissionResult>;
  /** Recover an externally submitted redemption only with a verified receipt for these snapshot balances. */
  findExternalReceipt?(condition: ConditionRecord, redemption: RedemptionRecord): Promise<RedemptionReceipt | null>;
}
export interface SettlementStore {
  getBasket(id: string): Promise<SettlementBasket | null>;
  saveBasket(record: SettlementBasket, expectedRevision: number | null): Promise<void>;
  listBaskets(): Promise<SettlementBasket[]>;
  getCondition(key: string): Promise<ConditionRecord | null>;
  saveCondition(record: ConditionRecord, expectedRevision: number | null): Promise<void>;
  listConditions(): Promise<ConditionRecord[]>;
  /** Must serialize across processes (e.g. PostgreSQL advisory lock), including callback writes. */
  withConditionLock<T>(key: string, action: () => Promise<T>): Promise<T>;
  /** Serializes preparation/broadcast across conditions sharing one wallet nonce. */
  withWalletLock<T>(wallet: string, action: () => Promise<T>): Promise<T>;
}
export interface SettlementDeps { store: SettlementStore; venue: SettlementVenue; now?: () => string; newId?: () => string }
