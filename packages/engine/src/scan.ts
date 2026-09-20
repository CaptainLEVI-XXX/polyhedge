import { parseBracketTitle, validateLadder, type ClobBook, type GammaEvent } from '@polyhedge/venue';

export interface BracketDepth {
  marketId: string;
  label: string;
  /** Dollars of payout purchasable: each share pays $1, so this is total ask size. */
  maxPayoutUsd: number;
  /** null when the venue did not report a fee rate. */
  costToFillUsd: number | null;
}

export interface EventScan {
  eventId: string; slug: string; title: string; endDate: string; negRisk: boolean;
  parsed: boolean; validLadder: boolean; reason: string | null;
  brackets: BracketDepth[];
  /** The binding capacity: a threshold hedge needs the same N in every
   *  losing bracket, so the smallest bracket caps the whole hedge. */
  minPayoutUsd: number;
  feeKnown: boolean;
}

function fillCost(book: ClobBook | undefined, feeRate: number | null): number | null {
  if (!book || feeRate === null) return null;
  return book.asks.reduce((sum, l) => {
    const p = l.priceMicros / 1_000_000;
    return sum + l.size * p;
  }, 0);
}

/**
 * Judge one event's usability as a hedging state space. Pure, so it tests
 * without a network. A negative verdict is a successful result.
 */
export function scanEvent(event: GammaEvent, books: Map<string, ClobBook>): EventScan {
  const parsedBrackets = event.markets.map((m) => parseBracketTitle(m.groupItemTitle));
  const unparseable = parsedBrackets.filter((b) => b === null).length;
  const feeKnown = event.markets.every((m) => m.feeRate !== null);

  const brackets: BracketDepth[] = event.markets.map((m) => {
    const book = books.get(m.yesTokenId);
    return {
      marketId: m.id,
      label: m.groupItemTitle,
      maxPayoutUsd: book ? book.asks.reduce((s, l) => s + l.size, 0) : 0,
      costToFillUsd: fillCost(book, m.feeRate),
    };
  });

  const minPayoutUsd = brackets.length === 0
    ? 0
    : Math.min(...brackets.map((b) => b.maxPayoutUsd));

  const common = {
    eventId: event.id, slug: event.slug, title: event.title,
    endDate: event.endDate, negRisk: event.negRisk,
    brackets, minPayoutUsd, feeKnown,
  };

  if (unparseable > 0) {
    return { ...common, parsed: false, validLadder: false,
      reason: `${unparseable} of ${event.markets.length} bracket titles unparseable` };
  }

  const verdict = validateLadder(parsedBrackets.filter((b) => b !== null));
  return { ...common, parsed: true, validLadder: verdict.ok,
    reason: verdict.ok ? null : verdict.reason };
}
