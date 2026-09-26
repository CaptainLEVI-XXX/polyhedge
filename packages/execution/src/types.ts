/** All monetary, price and share quantities are safe integer millionths. */
export const SCALE = 1_000_000;
export type Outcome = 'YES' | 'NO';
export interface Authorization {
  id: string;
  wallet: string;
  quoteHash: string;
  maxSpendMicros: number;
  maxUnwindLossMicros: number;
  slippageBps: number;
  expiresAt: string;
  maxUnwindAttempts: number;
}
export interface ExecutionLeg {
  id: string;
  tokenId: string;
  conditionId: string;
  outcome: Outcome;
  sharesMicros: number;
  /** Deepest ask approved in the selected quote, not its average fill price. */
  referencePriceMicros: number;
  eventEvidence?: {eventId:string;kind:'numeric'|'binary'|'categorical';marketId?:string;ruleHash:string;negRisk:boolean};
}
export interface SelectedQuote {
  /** Digest of the entire selected record, including assumptions and rule flags. */
  hash: string;
  legs: ExecutionLeg[];
}
export interface BookLevel { priceMicros: number; sharesMicros: number }
export interface MarketBook {
  tokenId: string;
  asks: BookLevel[];
  bids: BookLevel[];
  observedAt: string;
  tickMicros: number;
  shareStepMicros: number;
  minSharesMicros: number;
  /** Conservative upper fee bound, in basis points of notional. */
  feeBps: number;
}
export interface OrderIntent {
  tokenId: string;
  conditionId: string;
  outcome: Outcome;
  side: 'BUY' | 'SELL';
  sharesMicros: number;
  limitPriceMicros: number;
  /** BUY maximum all-in debit; SELL minimum net credit. */
  maxCashMicros: number;
  eventEvidence?: ExecutionLeg['eventEvidence'];
}
export interface SignedEnvelope { orderId: string; payload: unknown }
export interface ConfirmedFill {
  id: string;
  orderId: string;
  tokenId: string;
  conditionId: string;
  outcome: Outcome;
  side: 'BUY' | 'SELL';
  sharesMicros: number;
  /** All-in debit for BUY; net credit for SELL. feeMicros is informational. */
  cashMicros: number;
  feeMicros: number;
  transactionHash: string;
}
export type OrderResolution =
  | { kind: 'confirmed'; fills: ConfirmedFill[] }
  | { kind: 'failed'; reason: string }
  | { kind: 'pending' | 'unknown'; reason: string };
export interface VenueState {
  mode: 'open' | 'post_only' | 'cancel_only' | 'closed';
  /** Spendable collateral net of existing resting-order reservations. */
  availableCashMicros: number;
  /** Whether THIS signer may trade — the owner itself, or a valid session key. */
  signerCanTrade: boolean;
  approvalsReady: boolean;
}
export interface ExecutionVenue {
  state(wallet: string): Promise<VenueState>;
  book(tokenId: string): Promise<MarketBook>;
  prepare(wallet: string, intent: OrderIntent): Promise<SignedEnvelope>;
  /** Exactly shares-sized limit FOK. Ambiguous exceptions must be reconciled. */
  post(wallet: string, envelope: SignedEnvelope): Promise<OrderResolution>;
  /** Must account for the signed envelope even if its initial submission was lost. */
  reconcile(wallet: string, envelope: SignedEnvelope): Promise<OrderResolution>;
}
export interface OrderAttempt {
  intent: OrderIntent;
  envelope: SignedEnvelope;
  state: 'unknown' | 'pending' | 'confirmed' | 'failed';
  fills: ConfirmedFill[];
  reason?: string;
}
export interface LegRecord { leg: ExecutionLeg; buy?: OrderAttempt; unwinds: OrderAttempt[] }
export type ExecutionStatus = 'buying' | 'unwinding' | 'complete' | 'unwound' | 'stuck' | 'rejected';
export interface ExecutionRecord {
  id: string;
  revision: number;
  authorization: Authorization;
  quote: SelectedQuote;
  status: ExecutionStatus;
  legs: LegRecord[];
  reason?: string;
  /** Confirmed execution breached an authorization bound; actual fills remain recorded. */
  authorizationViolation?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ExecutionJournal {
  withWalletLock<T>(wallet: string, callback: () => Promise<T>): Promise<T>;
  load(id: string): Promise<ExecutionRecord | null>;
  create(record: ExecutionRecord): Promise<void>;
  /** Saves record at expectedRevision + 1, or throws on a concurrent write. */
  save(record: ExecutionRecord, expectedRevision: number): Promise<void>;
}
export interface Position {
  tokenId: string;
  conditionId: string;
  outcome: Outcome;
  sharesMicros: number;
}
export interface ExecutionResult {
  kind: 'complete' | 'pending' | 'unwound' | 'partial' | 'rejected';
  record: ExecutionRecord;
  held: Position[];
  /** Actual confirmed buy debits less actual confirmed sell credits. */
  netSpendMicros: number;
  reason?: string;
  authorizationViolation?: string;
}
export interface ExecutionDeps {
  journal: ExecutionJournal;
  venue: ExecutionVenue;
  now(): Date;
  maxBookAgeMs?: number;
}
