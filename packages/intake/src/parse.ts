// Deterministic parsing layer: this file extracts number/date/asset CANDIDATES
// with their surrounding context. It never assigns meaning (e.g. "this $40k is
// the holding") — a later, model-driven task does that. Kept dependency-free
// on purpose: no external/runtime dependencies, only a type-only import of
// the shared Parsed<T> shape (erased at compile time), so it can be tested
// and reused without pulling in anything beyond the package itself.

import type { Parsed, Provenance } from './types.js';

export interface NumberCandidate {
  value: number;
  unit?: string;
  /** Exactly as written, e.g. "$40k". */
  raw: string;
  /** Surrounding words, enough for a model to assign a role later. */
  context: string;
  /** Character offset in the source text. */
  index: number;
}

const NUMBER_PATTERN = /(?<![\d.])[-−]?\$?\d[\d,]*(?:\.\d+)?[kKmM]?/g;
const CONTEXT_WORD_WINDOW = 4;

/** Parses "$40k" / "$40,000" / "40k" / "$8,000" / "300" / "$60k" into a number. */
function parseAmount(raw: string): number | null {
  const withoutDollar = raw.replace(/\$/g, '').replace('−', '-');
  const suffixMatch = /^(-?[\d,]+(?:\.\d+)?)([kKmM])$/.exec(withoutDollar);
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

  const dates=[...text.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?/gi)];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    if(dates.some(date=>match.index>=date.index && match.index<date.index+date[0].length))continue;
    const raw = match[0];
    if (raw === undefined || raw.length === 0) continue;
    const index = match.index;

    const value = parseAmount(raw);
    if (value === null) continue;

    const suffix = text.slice(index + raw.length).match(/^\s*(°\s*[CF]\b|degrees?\s+(?:Fahrenheit|Celsius)\b|Fahrenheit\b|Celsius\b|[CF]\b|%|bps\b)/i)?.[1];
    const unit = suffix ? /fahrenheit|f$/i.test(suffix) ? "°F" : /celsius|c$/i.test(suffix) ? "°C" : suffix.toLowerCase() : raw.startsWith("$") ? "$" : undefined;
    candidates.push({
      ...(unit ? { unit } : {}),
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

/**
 * `\s*` between the month and the day, not `\s+`: people type "Sept26" as often
 * as "Sept 26", and an answer that reads perfectly to a human returned null —
 * so the same question was asked again, verbatim, as though nothing had been
 * said. That is the worst possible failure for a parser, because it looks like
 * the product is broken rather than like the input was.
 *
 * `(?!\d)` guards what the looser space then allows: without it "by Sep2026"
 * would take "20" as the day and silently quote a date three weeks off. A
 * refusal to parse is recoverable by asking; a confident wrong date is not.
 */
const DEADLINE_PATTERN = /\b(?:by|on)\s+(?:the\s+)?([A-Za-z]+)\.?\s*(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gi;

/**
 * Parses a phrase like "by Dec 31" or "by December 31 2027" into an ISO date.
 * When the year is not in the text, it is inferred from `today` (rolling
 * forward a year if the month/day has already passed) and marked `inferred`
 * — `raw` always stays exactly the user's own words (including the year
 * when they stated one) so a later confirmation question is built from
 * what they actually said, never from our own guess or an edited version
 * of their text in either direction.
 *
 * Returns `null` for an impossible calendar date (e.g. "Feb 29" in a
 * non-leap year) rather than emitting a malformed ISO string.
 */
function parseCalendarDeadline(text: string, today: Date): Parsed<string> | null {
  // Normalize unambiguous day-first and ISO dates; numeric slash dates remain
  // ambiguous across locales and must be clarified rather than guessed.
  text = text.replace(/\b(by|on)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:,?\s+(\d{4}))?/gi,
    (_, prefix: string, day: string, month: string, year: string | undefined) => `${prefix} ${month} ${day}${year ? ` ${year}` : ''}`)
    .replace(/\b(by|on)\s+(\d{4})-(\d{2})-(\d{2})\b/gi,
      (raw: string, prefix: string, year: string, month: string, day: string) => {
        const name = Object.keys(MONTHS).find(k => MONTHS[k] === Number(month));
        return `${prefix} ${name ?? 'invalidmonth'} ${day} ${year}`;
      });
  // Later explicit answers can correct an earlier deadline.
  const match = [...text.matchAll(DEADLINE_PATTERN)].at(-1);
  if (!match) return null;

  const monthText = match[1];
  const dayText = match[2];
  const yearText = match[3];
  if (monthText === undefined || dayText === undefined) return null;

  const month = MONTHS[monthText.toLowerCase()];
  if (month === undefined) return null;

  const day = Number(dayText);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  let year: number;
  let provenance: Provenance;
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

  // Date.UTC silently normalises an impossible day (29 Feb -> 1 Mar in a
  // non-leap year) instead of failing. Round-trip the constructed date and
  // reject it unless it lands on exactly the year/month/day we asked for.
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day;
  if (!isRealDate) return null;

  const raw = yearText !== undefined ? `${monthText} ${dayText} ${yearText}` : `${monthText} ${dayText}`;
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

/** Preserve explicit instants, including offsets; never turn a time into midnight. */
export function parseDeadline(text:string,today:Date):Parsed<string>|null {
  const markers=[...text.matchAll(/\b(?:by|on)\s+|\b(?:protection date|deadline)(?:\s+is)?\s*:\s*/gi)];
  const tails=markers.reverse().map(m=>text.slice(m.index+m[0].length).trim());
  if(!markers.length)tails.push(text.trim());
  for(const tail of tails){
    if(/^\d{4}-/.test(tail)){
      const m=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?(?=$|[\s.;,!?])/i.exec(tail);
      if(!m)return null;
      if(m[4]===undefined&&/^\s+(?:at\s+)?\d{1,2}(?::|\s*(?:am|pm)\b)/i.test(tail.slice(m[0].length)))return null;
      const [year,month,day]=[Number(m[1]),Number(m[2]),Number(m[3])];
      const calendar=new Date(Date.UTC(year!,month!-1,day));
      if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month!-1||calendar.getUTCDate()!==day)return null;
      if(m[4]!==undefined&&(Number(m[4])>23||Number(m[5])>59||Number(m[6]??0)>59))return null;
      if(m[8]&&m[8].toUpperCase()!=='Z'&&(Number(m[8].slice(1,3))>23||Number(m[8].slice(4))>59))return null;
      const ms=Date.parse(m[0]);if(!Number.isFinite(ms))return null;
      return {value:m[4]===undefined?m[0]:new Date(ms).toISOString().replace('.000Z','Z'),raw:m[0],provenance:'stated'};
    }
    if(/^\d+[\/]/.test(tail))return null;
    const date=parseCalendarDeadline(`by ${tail}`,today);
    if(date){
      const clock=/\bat\s+(\d{1,2}):(\d{2})\s*(UTC|GMT)\b/i.exec(tail);
      if(clock){
        if(Number(clock[1])>23||Number(clock[2])>59)return null;
        return {...date,value:`${date.value}T${clock[1]!.padStart(2,'0')}:${clock[2]}:00Z`,raw:`${date.raw} ${clock[0]}`};
      }
      // An explicit clock without a supported timezone needs clarification.
      if(/\bat\s+\d{1,2}(?::|\s*(?:am|pm)\b)/i.test(tail))return null;
      return date;
    }
    if(/^(?:the\s+)?(?:[A-Za-z]+\.?\s*\d|\d{1,2}\s+[A-Za-z])/.test(tail))return null;
  }
  return null;
}
