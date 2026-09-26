// Ladder-based market retrieval.
//
// THE TRAP this file used to be built around, and no longer is: a hardcoded
// allow-list. Retrieval selected events by `series.ticker` from a two-entry
// map (`bitcoin-neg-risk-weekly`, `ethereum-neg-risk-weekly`), which confined
// the whole product to two assets and the ~6-day window those weeklies are
// listed on. Nothing in `core` has that limit — it prices any partition of a
// numeric axis — so the allow-list was the product's ceiling, not the engine's.
//
// What replaces it is a PROPERTY, not a list: an event is indexable when it is
// `negRisk`, has 3+ markets, and its `groupItemTitle`s parse as a `Ladder`.
// `parseLadder` is the safety, and it is strict for a reason — a real ladder
// tiles its axis exactly once, so candidate lists, sports scorelines and
// ladders carrying a categorical escape hatch ("No IPO by December 31, 2027")
// are rejected without anyone having to enumerate them. Verified live: 140 of
// 221 open neg-risk multi-outcome families parse; the other 81 are correctly
// refused. Selection is still never by `tags` — the `crypto` tag alone carries
// Up/Down, hit-price and meme-coin markets settling off other oracles, and
// none of those tile an axis either, which is now the reason they are out.
//
// Opening this up reaches families dated from 1 day to 467 days out, so
// "no market listed for that date" is still the common answer for a far
// deadline, and retrieval must say so plainly rather than silently
// substituting the nearest market.
//
// Observation time is read from the market `description` prose when the prose
// states one, DST-aware: noon ET is 16:00Z in September, 17:00Z in December.
// Most families outside crypto state no time at all, so the event's own
// `endDate` is the fallback — but ONLY when nothing was stated. Which of the
// two was used is recorded on `observationSource`, because a fallback the
// caller cannot see is a guess dressed as a reading.
//
// Date comparison is code, never the model — TypeSafe's own limitations page
// for jev-1.13 states dates are read as text, not ordered quantities. The same
// applies to the subject: `candidatesForText` is a cheap lexical PREFILTER
// that narrows hundreds of ladders to a shortlist, and nothing more. It never
// decides whether a market fits; `fit.ts` does that, with the model, on what
// this hands it.

import { parseLadder, type GammaEvent, type GammaMarket, type Ladder } from '@polyhedge/venue';

export interface IndexedEvent {
  eventId: string;
  slug: string;
  /** First `series[].ticker`, or `''` when the venue published none. Display/provenance only. */
  seriesTicker: string;
  /** The venue's own event title — what this market is about, in its words. */
  title: string;
  /** Parsed ladder: brackets, unit, span. */
  ladder: Ladder;
  /** ISO instant. From the description prose when stated, else `endDate`. */
  observationAt: string;
  /** Which of the two `observationAt` came from. A fallback must be visible. */
  observationSource: 'description' | 'endDate';
  /** endDate — when trading stops. */
  endDate: string;
  negRisk: boolean;
  bracketCount: number;
  /** Set when this event observes on a different DATE than the user asked for. */
  observationNote?: string;
}

export type RetrievalResult =
  | { kind: 'candidates'; events: IndexedEvent[] }
  | { kind: 'no_market_listed'; furthestListed: string | null; reason: string };

const ET_MENTION = /\b(?:ET|EST|EDT|Eastern)\b/i;
const EXPLICIT_TIME = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/gi;

/**
 * What the prose said about the time of day, as three distinguishable cases.
 *
 * The distinction between `none` and `ambiguous` is the whole point. `none`
 * means the description never stated a time, which is the normal state of
 * most families on the venue and is safe to fall back from. `ambiguous` means
 * a time WAS stated and we cannot read it with certainty — two different
 * instants, or a malformed clock — and falling back there would quietly
 * overrule the venue's own words with a date. Collapsing the two into `null`,
 * as this used to, made the fallback impossible to add safely.
 */
type TimeReading =
  | { kind: 'time'; hour: number; minute: number }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * Reads a time-of-day out of description prose ("...12:00 in the ET
 * timezone (noon)"). Requires an explicit ET/Eastern mention — a bare
 * number or "noon" without a timezone marker is not something we can read
 * with certainty.
 *
 * Every time the prose states is collected, not just the first one. A
 * description mentioning two different times ("the 09:30 open ... resolves
 * 16:00 ET") is ambiguous about which one settles the market, and taking
 * whichever appeared first would hedge a plausible-looking wrong instant.
 *
 * 12-hour notation is read properly rather than taken at face value:
 * "4:00 PM" is 16:00, not 04:00. Restating the same instant in words
 * ("12:00 ... (noon)") agrees with itself and is not ambiguity.
 */
function readEtTime(description: string): TimeReading {
  if (!ET_MENTION.test(description)) return { kind: 'none' };

  const found = new Set<number>();

  for (const m of description.matchAll(EXPLICIT_TIME)) {
    const hourRaw = Number(m[1]);
    const minute = Number(m[2]);
    const meridiem = m[3]?.[0]?.toLowerCase();
    if (!Number.isInteger(hourRaw) || !Number.isInteger(minute) || minute > 59) {
      return { kind: 'ambiguous' };
    }

    let hour: number;
    if (meridiem === undefined) {
      if (hourRaw > 23) return { kind: 'ambiguous' };
      hour = hourRaw;
    } else {
      if (hourRaw < 1 || hourRaw > 12) return { kind: 'ambiguous' };
      hour = meridiem === 'p' ? (hourRaw === 12 ? 12 : hourRaw + 12) : (hourRaw === 12 ? 0 : hourRaw);
    }
    found.add(hour * 60 + minute);
  }

  if (/\bnoon\b/i.test(description)) found.add(12 * 60);
  if (/\bmidnight\b/i.test(description)) found.add(0);

  // An ET mention with no clock in it ("settles at the ET close") states no
  // time: nothing to disagree with, so this is `none` and may fall back.
  if (found.size === 0) return { kind: 'none' };
  if (found.size > 1) return { kind: 'ambiguous' };

  const minutes = [...found][0]!;
  return { kind: 'time', hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

/**
 * The UTC offset (minutes, negative west of UTC) America/New_York observes
 * on the given Y/M/D. Resolved from `Intl` at noon UTC on that date — safely
 * clear of the 2am-local DST transition either direction — so the result is
 * correct on both sides of the flip. Never a hardcoded -4 or -5.
 */
function etOffsetMinutes(year: number, month: number, day: number): number {
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(anchor);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const match = /GMT([+-]\d+)/.exec(tzName);
  if (!match || match[1] === undefined) {
    throw new Error(`could not resolve America/New_York offset for ${year}-${month}-${day}`);
  }
  return Number(match[1]) * 60;
}

/** The stated ET time placed on `endDateIso`'s calendar date, DST-aware. */
function instantFrom(time: { hour: number; minute: number }, endDateIso: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(endDateIso);
  if (!dateMatch || dateMatch[1] === undefined || dateMatch[2] === undefined || dateMatch[3] === undefined) {
    return null;
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);

  const offsetMinutes = etOffsetMinutes(year, month, day);
  const etMinutesSinceMidnight = time.hour * 60 + time.minute;
  const utcMs = Date.UTC(year, month - 1, day) + (etMinutesSinceMidnight - offsetMinutes) * 60_000;

  return new Date(utcMs).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * Combines the description's stated ET time with the event's calendar date
 * (taken from `endDateIso`), converting DST-aware. Returns null when the
 * description does not state a time we can read with certainty.
 *
 * Kept as the narrow, prose-only reading. `indexEvent` is what decides
 * whether a null here means "fall back to endDate" or "exclude this event",
 * because only it can see whether the OTHER brackets said something.
 */
export function parseObservationAt(description: string, endDateIso: string): string | null {
  const reading = readEtTime(description);
  if (reading.kind !== 'time') return null;
  return instantFrom(reading, endDateIso);
}

/**
 * The one observation instant this event settles on, and where it came from.
 *
 * Every bracket in a ladder settles off one observation, so the event has a
 * single instant. Rather than assume that and read it off `markets[0]`, every
 * bracket's prose is parsed and they must agree. A bracket that states nothing
 * is passed over — one terse description should not discard an event we can
 * otherwise place — but two brackets naming DIFFERENT instants means this is
 * not one observation, and the event is excluded.
 *
 * The fallback to `endDate` applies only when NO bracket stated a time. A
 * bracket that stated one we could not read (`ambiguous`) excludes the event
 * instead: the venue said something about when this settles, and answering it
 * with a date we picked ourselves would be a guess the caller cannot see.
 */
function resolveObservation(
  markets: GammaMarket[],
  endDate: string,
): { at: string; source: IndexedEvent['observationSource'] } | null {
  const instants = new Set<string>();
  let ambiguous = false;

  for (const market of markets) {
    const reading = readEtTime(market.description);
    if (reading.kind === 'none') continue;
    if (reading.kind === 'ambiguous') {
      ambiguous = true;
      continue;
    }
    const at = instantFrom(reading, endDate);
    if (at === null) {
      ambiguous = true;
      continue;
    }
    instants.add(at);
  }

  if (instants.size > 1) return null;
  if (instants.size === 1) return { at: [...instants][0]!, source: 'description' };
  if (ambiguous) return null;

  // Nothing was stated anywhere: the event's own end instant is what the
  // venue publishes about when this settles.
  if (!Number.isFinite(Date.parse(endDate))) return null;
  return { at: endDate, source: 'endDate' };
}

/**
 * Indexes one Gamma event, or excludes it. Excluded when `negRisk` is false,
 * when it has fewer than 3 markets, when its bracket titles do not parse as a
 * ladder, or when its brackets disagree about the observation instant.
 *
 * There is deliberately no ticker or tag test. A family is indexable because
 * of what its labels ARE — a partition of a numeric axis the engine can price
 * — not because someone wrote its ticker down here.
 */
export function indexEvent(event: GammaEvent): IndexedEvent | null {
  if (!event.negRisk) return null;
  if (event.markets.length < 3) return null;

  const ladder = parseLadder(event.markets.map((m) => m.groupItemTitle));
  if (ladder === null) return null;

  const observation = resolveObservation(event.markets, event.endDate);
  if (observation === null) return null;

  return {
    eventId: event.id,
    slug: event.slug,
    seriesTicker: event.seriesTickers[0] ?? '',
    title: event.title,
    ladder,
    observationAt: observation.at,
    observationSource: observation.source,
    endDate: event.endDate,
    negRisk: event.negRisk,
    bracketCount: event.markets.length,
  };
}

/**
 * Words that carry no subject. Three groups, and each is here for its own
 * reason:
 *
 *   - ordinary function words, which match everything and so distinguish
 *     nothing;
 *   - the vocabulary every hedging request is written in ("hold", "lose",
 *     "protection", "price"), which would otherwise make every request look
 *     like every market;
 *   - MONTHS AND DATE WORDS. A title names a date ("Bitcoin price on December
 *     31?") and so does the request ("by Dec 31"), so leaving them in would
 *     match a December request to every December market whatever it is about.
 *     Dates are decided in code, in `retrieve`, and must not leak into a
 *     lexical match that looks like subject agreement.
 */
const STOPWORDS = new Set<string>([
  'a', 'about', 'above', 'after', 'against', 'all', 'am', 'an', 'and', 'any', 'anything', 'are',
  'around', 'as', 'at', 'back', 'be', 'because', 'been', 'before', 'being', 'below', 'between',
  'both', 'but', 'buy', 'by', 'can', 'cover', 'could', 'do', 'does', 'down', 'drop', 'during',
  'each', 'end', 'ends', 'ending', 'enough', 'even', 'ever', 'every', 'fall', 'falls', 'far',
  'few', 'for', 'from', 'get', 'go', 'goes', 'going', 'had', 'has', 'have', 'hedge', 'hedging',
  'her', 'here', 'high', 'higher', 'him', 'his', 'hold', 'holding', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'just', 'less', 'level', 'levels', 'like', 'lose', 'loses',
  'losing', 'loss', 'low', 'lower', 'make', 'many', 'market', 'markets', 'may', 'me', 'money',
  'more', 'most', 'move', 'moves', 'much', 'my', 'need', 'needs', 'no', 'not', 'now', 'of',
  'off', 'on', 'once', 'one', 'only', 'or', 'other', 'our', 'out', 'outside', 'over', 'own',
  'pay', 'pays', 'payout', 'position', 'price', 'prices', 'protect', 'protection', 'rather',
  'really', 'resolve', 'resolves', 'resolution', 'risk', 'run', 'same', 'say', 'sell', 'she',
  'should', 'so', 'some', 'spend', 'still', 'such', 'sure', 'take', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'think', 'this', 'those',
  'through', 'to', 'too', 'under', 'up', 'us', 'use', 'value', 'very', 'want', 'wants', 'was',
  'we', 'week', 'weekly', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why',
  'will', 'with', 'within', 'worth', 'would', 'you', 'your',
  // Contractions, which survive punctuation stripping as bare stems.
  'im', 'ive', 'id', 'ill', 'dont', 'doesnt', 'didnt', 'cant', 'wont', 'isnt', 'thats',
  'theres', 'youre', 'ones',
  // Dates, in every shape either side writes them.
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'today', 'tomorrow', 'tonight', 'date', 'dates', 'day', 'days', 'month', 'monthly',
  'year', 'yearly', 'annual', 'daily', 'hourly', 'eod', 'close', 'closing', 'open', 'opening',
]);

/**
 * Names the venue and the user write differently for the same subject. A
 * prefilter that cannot see that "BTC" and "Bitcoin" are the same thing
 * throws away the market the user actually wants, invisibly — the user is
 * never shown what retrieval did not hand the model. Recall-only, symmetric,
 * and cheap to extend: adding a pair here can widen a shortlist, never
 * narrow one, and never decides a fit.
 */
const ALIASES: Record<string, string[]> = {
  btc: ['bitcoin'], bitcoin: ['btc'],
  eth: ['ethereum', 'ether'], ethereum: ['eth'], ether: ['eth'],
  sol: ['solana'], solana: ['sol'],
  doge: ['dogecoin'], dogecoin: ['doge'],
  xrp: ['ripple'], ripple: ['xrp'],
  ada: ['cardano'], cardano: ['ada'],
  ltc: ['litecoin'], litecoin: ['ltc'],
  link: ['chainlink'], chainlink: ['link'],
  avax: ['avalanche'], avalanche: ['avax'],
  fed: ['fomc', 'federal', 'reserve', 'rates', 'rate'],
  fomc: ['fed', 'rates', 'rate'],
  rates: ['fed', 'fomc'], rate: ['fed', 'fomc'],
  sp: ['spx', 'sandp'], spx: ['sp'],
  nasdaq: ['ndx'], ndx: ['nasdaq'],
  temperature: ['temp', 'degrees', 'weather'], temp: ['temperature'],
  weather: ['temperature'], degrees: ['temperature'],
  nyc: ['york'], york: ['nyc'],
  gdp: ['growth'], cpi: ['inflation'], inflation: ['cpi'],
  unemployment: ['jobs'], jobs: ['unemployment'],
};

/**
 * Lowercase content words, with punctuation stripped INSIDE the token so
 * "S&P" reads as "sp" and matches the venue's `sp-500-monthly-close`. Pure
 * numbers are dropped: they are quantities, and every comparison involving
 * one happens in code.
 */
export function subjectWords(text: string): string[] {
  const out: string[] = [];
  for (const rawToken of text.toLowerCase().split(/[^a-z0-9&$'°]+/)) {
    const token = rawToken.replace(/[^a-z0-9]/g, '');
    if (token === '') continue;
    if (/^\d+$/.test(token)) continue;
    // Plural and possessive forms of the same subject are the same subject.
    const stem = token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
    if (STOPWORDS.has(token) || STOPWORDS.has(stem)) continue;
    if (stem.length < 2) continue;
    if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

/** A word plus every name that means the same subject. */
function withAliases(words: string[]): Set<string> {
  const out = new Set<string>();
  for (const word of words) {
    out.add(word);
    for (const alias of ALIASES[word] ?? []) {
      out.add(alias.length > 3 && alias.endsWith('s') ? alias.slice(0, -1) : alias);
    }
  }
  return out;
}

/**
 * Cheap lexical prefilter: which indexed events could plausibly be about this
 * text. One shared content word between the user's words and the event's own
 * title or series ticker is enough.
 *
 * DELIBERATELY GENEROUS. This is a prefilter, not a decision — the model
 * scores what comes out of it, and a market it never sees is a market the
 * user never learns existed. A false positive costs one line in a payload
 * that already carries several; a false negative is invisible. So the bar is
 * one word, with aliases, and the judgement is left to `fit.ts`.
 *
 * Input order is preserved: `retrieve` orders the survivors by date, in code,
 * and this must not introduce a ranking of its own for that to be the
 * ordering the pipeline acts on.
 */
const subjectIndexes = new WeakMap<IndexedEvent[],Map<string,Set<number>>>();
export function candidatesForText(text: string, events: IndexedEvent[]): IndexedEvent[] {
  const wanted = withAliases(subjectWords(text));
  if (wanted.size === 0) return [];
  let postings=subjectIndexes.get(events);
  if(!postings){
    postings=new Map();
    events.forEach((event,id)=>{
      for(const word of withAliases(subjectWords(`${event.title} ${event.seriesTicker.replace(/-/g,' ')}`))){
        let hits=postings!.get(word);if(!hits){hits=new Set();postings!.set(word,hits);}hits.add(id);
      }
    });
    subjectIndexes.set(events,postings);
  }
  const matches=new Set<number>();
  for(const word of wanted)for(const id of postings.get(word)??[])matches.add(id);
  return [...matches].sort((a,b)=>a-b).map(id=>events[id]!);
}

/**
 * Filters already-indexed events to a bounded, nearest-first shortlist at or
 * after `deadlineIso` by default — a bounded shortlist because the model scores what
 * it is handed and cannot surface what retrieval missed. An event observing
 * before the deadline is excluded outright. An event observing on a LATER
 * DATE than the deadline is kept but flagged with `observationNote`, since
 * that is time basis risk the user accepts explicitly rather than a mismatch
 * to hide. All date/time comparison happens here, in code — never handed to
 * the model. Studio may instead request a ceiling: observations after the
 * deadline are then excluded and the latest earlier observations come first.
 * The caller is responsible for expiry filtering and explicit date-risk consent.
 *
 * `events` is the SHORTLIST the subject prefilter already produced, not the
 * whole corpus. The two narrowings are kept separate on purpose: subject
 * matching is lexical and fuzzy, date eligibility is exact arithmetic, and
 * `furthestListed` has to report the furthest market about the user's own
 * subject rather than the furthest market on the venue.
 */
export function retrieve(
  events: IndexedEvent[],
  deadlineIso: string,
  limit = 5,
  dateMode: 'at_or_after' | 'ceiling' = 'at_or_after',
): RetrievalResult {
  const deadlineMs = Date.parse(dateMode==='ceiling'&&!deadlineIso.includes('T')?`${deadlineIso}T23:59:59.999Z`:deadlineIso);
  const deadlineDate = deadlineIso.slice(0, 10);

  const eligible = events.filter((e) => dateMode==='ceiling'?Date.parse(e.observationAt)<=deadlineMs:Date.parse(e.observationAt)>=deadlineMs);

  if (eligible.length === 0) {
    const furthestListed =
      events.length === 0
        ? null
        : events.reduce(
            (latest, e) => (Date.parse(e.observationAt) > Date.parse(latest) ? e.observationAt : latest),
            events[0]!.observationAt,
          );
    return {
      kind: 'no_market_listed',
      furthestListed,
      reason:
        furthestListed === null
          ? 'no listed market matches what you described'
          : `no listed market observes ${dateMode==='ceiling'?'on or before':'at or after'} ${deadlineDate}; the furthest listed observation is ${furthestListed}`,
    };
  }

  const sorted = [...eligible].sort((a, b) => (dateMode==='ceiling'?-1:1)*(Date.parse(a.observationAt) - Date.parse(b.observationAt)));
  const limited = sorted.slice(0, limit);

  const withNotes: IndexedEvent[] = limited.map((e) => {
    if (e.observationAt.slice(0, 10) === deadlineDate) return e;
    return {
      ...e,
      observationNote: `observes on ${e.observationAt.slice(0, 10)}, not the requested ${deadlineDate}`,
    };
  });

  return { kind: 'candidates', events: withNotes };
}
