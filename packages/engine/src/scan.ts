import { parseBracketTitle, validateLadder, type ClobBook, type GammaEvent } from '@polyhedge/venue';

/** Payout we ask each bracket to supply when testing capacity. */
export const TARGET_PAYOUT_USD = 10_000;

/** Price above which buying payout stops being a hedge and becomes a
 *  near-par transfer: at 99c you pay $0.99 to receive $1. */
const USEFUL_PRICE_CAP = 0.5;

export interface BracketDepth {
  marketId: string;
  label: string;
  /** Total ask size across every level. Raw depth, NOT usable capacity:
   *  most of it typically sits near $1, where buying $1 of payout costs
   *  $1 and hedges nothing. Kept for reference only. */
  rawAskSizeUsd: number;
  /** Payout purchasable at or below the useful price cap — the depth that
   *  is actually worth buying as protection. */
  payoutAtOrBelowCapUsd: number;
  /** Cost to buy TARGET_PAYOUT_USD of payout by walking the real book with
   *  fees. null when depth is short or the fee rate is unknown. */
  costToBuyTargetUsd: number | null;
  avgPriceToBuyTarget: number | null;
}

export interface EventScan {
  eventId: string; slug: string; title: string; endDate: string; negRisk: boolean;
  parsed: boolean; validLadder: boolean; reason: string | null;
  brackets: BracketDepth[];
  /** Binding cheap depth: the smallest payout-at-or-below-cap across
   *  brackets. A threshold hedge needs the same payout in every losing
   *  bracket, so the smallest one caps the hedge. */
  minPayoutAtOrBelowCapUsd: number;
  /** How many brackets cannot supply TARGET_PAYOUT_USD at any price. */
  bracketsShortOfTarget: number;
  feeKnown: boolean;
}

/** Walk the asks to buy `shares`, including the taker fee. Returns null
 *  when the book cannot supply that size, or when the fee is unknown —
 *  an unknown fee is not a zero fee. */
function costToBuy(
  book: ClobBook | undefined,
  shares: number,
  feeRate: number | null,
): { costUsd: number; avgPrice: number } | null {
  if (!book || feeRate === null) return null;
  let remaining = shares;
  let costUsd = 0;
  for (const l of book.asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, l.size);
    const p = l.priceMicros / 1_000_000;
    costUsd += take * (p + feeRate * p * (1 - p));
    remaining -= take;
  }
  if (remaining > 0) return null; // not enough depth at any price
  return { costUsd, avgPrice: costUsd / shares };
}

/**
 * Judge one event's usability as a hedging state space. Pure, so it tests
 * without a network. A negative verdict is a successful result.
 */
export function scanEvent(
  event: GammaEvent,
  books: Map<string, ClobBook>,
  targetPayoutUsd: number = TARGET_PAYOUT_USD,
): EventScan {
  const parsedBrackets = event.markets.map((m) => parseBracketTitle(m.groupItemTitle));
  const unparseable = parsedBrackets.filter((b) => b === null).length;
  const feeKnown = event.markets.every((m) => m.feeRate !== null);

  const brackets: BracketDepth[] = event.markets.map((m) => {
    const book = books.get(m.yesTokenId);
    const rawAskSizeUsd = book ? book.asks.reduce((s, l) => s + l.size, 0) : 0;
    const payoutAtOrBelowCapUsd = book
      ? book.asks.reduce((s, l) => {
          const p = l.priceMicros / 1_000_000;
          return p <= USEFUL_PRICE_CAP ? s + l.size : s;
        }, 0)
      : 0;
    const targetCost = costToBuy(book, targetPayoutUsd, m.feeRate);
    return {
      marketId: m.id,
      label: m.groupItemTitle,
      rawAskSizeUsd,
      payoutAtOrBelowCapUsd,
      costToBuyTargetUsd: targetCost?.costUsd ?? null,
      avgPriceToBuyTarget: targetCost?.avgPrice ?? null,
    };
  });

  const minPayoutAtOrBelowCapUsd =
    brackets.length === 0 ? 0 : Math.min(...brackets.map((b) => b.payoutAtOrBelowCapUsd));

  const bracketsShortOfTarget = brackets.filter((b) => b.costToBuyTargetUsd === null).length;

  const common = {
    eventId: event.id,
    slug: event.slug,
    title: event.title,
    endDate: event.endDate,
    negRisk: event.negRisk,
    brackets,
    minPayoutAtOrBelowCapUsd,
    bracketsShortOfTarget,
    feeKnown,
  };

  if (unparseable > 0) {
    return {
      ...common,
      parsed: false,
      validLadder: false,
      reason: `${unparseable} of ${event.markets.length} bracket titles unparseable`,
    };
  }

  const verdict = validateLadder(parsedBrackets.filter((b) => b !== null));
  return {
    ...common,
    parsed: true,
    validLadder: verdict.ok,
    reason: verdict.ok ? null : verdict.reason,
  };
}
