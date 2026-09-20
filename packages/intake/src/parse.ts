// Deterministic parsing layer: this file extracts number/date/asset CANDIDATES
// with their surrounding context. It never assigns meaning (e.g. "this $40k is
// the holding") — a later, model-driven task does that. Kept dependency-free
// on purpose: no imports, not even from ./types.ts, so it can be tested and
// reused in total isolation from the rest of the package graph.

/** Matches shapes ../types.ts calls Provenance, without importing it. */
type LocalProvenance = 'stated' | 'inferred';

/** Structurally identical to Parsed<string> in ../types.ts. */
interface ParsedDate {
  value: string;
  provenance: LocalProvenance;
  raw: string;
}

export interface NumberCandidate {
  value: number;
  /** Exactly as written, e.g. "$40k". */
  raw: string;
  /** Surrounding words, enough for a model to assign a role later. */
  context: string;
  /** Character offset in the source text. */
  index: number;
}

const NUMBER_PATTERN = /\$?\d[\d,]*(?:\.\d+)?[kKmM]?/g;
const CONTEXT_WORD_WINDOW = 4;

/** Parses "$40k" / "$40,000" / "40k" / "$8,000" / "300" / "$60k" into a number. */
function parseAmount(raw: string): number | null {
  const withoutDollar = raw.replace(/\$/g, '');
  const suffixMatch = /^([\d,]+(?:\.\d+)?)([kKmM])$/.exec(withoutDollar);
  if (suffixMatch) {
    const numPart = suffixMatch[1];
    const suffix = suffixMatch[2];
    if (numPart === undefined || suffix === undefined) return null;
    const base = Number(numPart.replace(/,/g, ''));
    if (Number.isNaN(base)) return null;
    const multiplier = suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000;
    return base * multiplier;
  }
  const plain = Number(withoutDollar.replace(/,/g, ''));
  return Number.isNaN(plain) ? null : plain;
}

/** A few words on each side of the match, enough for a model to read "hold" / "lose" / "below" / "spend". */
function extractContext(text: string, index: number, matchLength: number): string {
  const before = text.slice(0, index).trim();
  const after = text.slice(index + matchLength).trim();
  const matched = text.slice(index, index + matchLength);

  const beforeWords = before.length > 0 ? before.split(/\s+/).slice(-CONTEXT_WORD_WINDOW) : [];
  const afterWords = after.length > 0 ? after.split(/\s+/).slice(0, CONTEXT_WORD_WINDOW) : [];

  return [...beforeWords, matched, ...afterWords].join(' ');
}

export function findNumbers(text: string): NumberCandidate[] {
  const candidates: NumberCandidate[] = [];

  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const raw = match[0];
    if (raw === undefined || raw.length === 0) continue;
    const index = match.index;

    const value = parseAmount(raw);
    if (value === null) continue;

    candidates.push({
      value,
      raw,
      context: extractContext(text, index, raw.length),
      index,
    });
  }

  return candidates;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const DEADLINE_PATTERN = /\bby\s+([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i;

/**
 * Parses a phrase like "by Dec 31" or "by December 31 2027" into an ISO date.
 * When the year is not in the text, it is inferred from `today` (rolling
 * forward a year if the month/day has already passed) and marked `inferred`
 * — `raw` stays the user's own words so a later confirmation question is
 * built from what they actually said, not from our guessed year.
 */
export function parseDeadline(text: string, today: Date): ParsedDate | null {
  const match = DEADLINE_PATTERN.exec(text);
  if (!match) return null;

  const monthText = match[1];
  const dayText = match[2];
  const yearText = match[3];
  if (monthText === undefined || dayText === undefined) return null;

  const month = MONTHS[monthText.toLowerCase()];
  if (month === undefined) return null;

  const day = Number(dayText);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const raw = `${monthText} ${dayText}`;

  let year: number;
  let provenance: LocalProvenance;
  if (yearText !== undefined) {
    year = Number(yearText);
    provenance = 'stated';
  } else {
    provenance = 'inferred';
    const todayYear = today.getUTCFullYear();
    const candidateMs = Date.UTC(todayYear, month - 1, day);
    const todayMs = Date.UTC(todayYear, today.getUTCMonth(), today.getUTCDate());
    year = candidateMs < todayMs ? todayYear + 1 : todayYear;
  }

  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { value: iso, provenance, raw };
}

const BTC_PATTERN = /\b(btc|bitcoin)\b/i;
const ETH_PATTERN = /\b(eth|ether|ethereum)\b/i;
// Other assets we recognise but do not support hedging for. These must
// decline early (return 'OTHER') rather than be silently mis-routed as
// BTC or ETH.
const OTHER_PATTERN =
  /\b(sol|solana|doge|dogecoin|xrp|ripple|ada|cardano|ltc|litecoin|bnb|matic|polygon|link|chainlink|avax|avalanche|dot|polkadot|shib|shiba|arb|arbitrum|uni|uniswap|trx|tron|atom|cosmos)\b/i;

export function parseUnderlying(text: string): 'BTC' | 'ETH' | 'OTHER' | null {
  if (BTC_PATTERN.test(text)) return 'BTC';
  if (ETH_PATTERN.test(text)) return 'ETH';
  if (OTHER_PATTERN.test(text)) return 'OTHER';
  return null;
}
