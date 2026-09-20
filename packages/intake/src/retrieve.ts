// Series-aware market retrieval.
//
// Polymarket lists crypto bracket markets on a rolling ~6-day window, so
// "no market listed for that date" is the COMMON case, not an edge case —
// verified live: exactly 7 open BTC events, the furthest 6 days out (audit
// D-market-timing.md). Retrieval must say so plainly rather than silently
// substituting the nearest market.
//
// There are at least three crypto families sharing the `crypto` tag with
// different oracles (price-on-date brackets, Up/Down, hit-price). Only the
// price-on-date bracket family is what the engine models, so selection is
// by `series.ticker`, never by tag.
//
// Observation time exists only in the market `description` prose and must
// be converted DST-aware: noon ET is 16:00Z in September, 17:00Z in
// December. Date comparison is code, never the model — TypeSafe's own
// limitations page for jev-1.13 states dates are read as text, not ordered
// quantities.

import type { GammaEvent } from '@polyhedge/venue';

export const SUPPORTED_SERIES: Record<'BTC' | 'ETH', string> = {
  BTC: 'bitcoin-neg-risk-weekly',
  ETH: 'ethereum-neg-risk-weekly',
};

export interface IndexedEvent {
  eventId: string;
  slug: string;
  seriesTicker: string;
  underlying: 'BTC' | 'ETH';
  /** Parsed from the description prose, DST-aware. ISO instant. */
  observationAt: string;
  /** endDate — when trading stops; for this family it coincides with observation. */
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
 * Reads a time-of-day out of description prose ("...12:00 in the ET
 * timezone (noon)"). Requires an explicit ET/Eastern mention — a bare
 * number or "noon" without a timezone marker is not something we can read
 * with certainty, so it returns null rather than assume ET.
 *
 * Every time the prose states is collected, not just the first one. A
 * description mentioning two different times ("the 09:30 open ... resolves
 * 16:00 ET") is ambiguous about which one settles the market, and taking
 * whichever appeared first would hedge a plausible-looking wrong instant.
 * Disagreement returns null; the caller then excludes the event, which is
 * visible, where a wrong instant is not.
 *
 * 12-hour notation is read properly rather than taken at face value:
 * "4:00 PM" is 16:00, not 04:00. Restating the same instant in words
 * ("12:00 ... (noon)") agrees with itself and is not ambiguity.
 */
function extractEtTime(description: string): { hour: number; minute: number } | null {
  if (!ET_MENTION.test(description)) return null;

  const found = new Set<number>();

  for (const m of description.matchAll(EXPLICIT_TIME)) {
    const hourRaw = Number(m[1]);
    const minute = Number(m[2]);
    const meridiem = m[3]?.[0]?.toLowerCase();
    if (!Number.isInteger(hourRaw) || !Number.isInteger(minute) || minute > 59) return null;

    let hour: number;
    if (meridiem === undefined) {
      if (hourRaw > 23) return null;
      hour = hourRaw;
    } else {
      if (hourRaw < 1 || hourRaw > 12) return null;
      hour = meridiem === 'p' ? (hourRaw === 12 ? 12 : hourRaw + 12) : (hourRaw === 12 ? 0 : hourRaw);
    }
    found.add(hour * 60 + minute);
  }

  if (/\bnoon\b/i.test(description)) found.add(12 * 60);
  if (/\bmidnight\b/i.test(description)) found.add(0);

  if (found.size !== 1) return null;
  const minutes = [...found][0]!;
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
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

/**
 * Combines the description's stated ET time with the event's calendar date
 * (taken from `endDateIso`), converting DST-aware. Returns null when the
 * description does not state a time we can read with certainty — the
 * caller excludes that event rather than guessing.
 */
export function parseObservationAt(description: string, endDateIso: string): string | null {
  const time = extractEtTime(description);
  if (time === null) return null;

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
 * Indexes one Gamma event, or excludes it. Excluded when: its series is not
 * a supported bracket series (selected by `seriesTickers`, never `tags` —
 * the tag also carries Up/Down, hit-price, meme-coin and person-vs-person
 * markets), `negRisk` is false, or the observation time cannot be parsed.
 *
 * Every bracket in this family settles off one observation of one price, so
 * the event has a single observation instant. Rather than assume that and
 * read it off `markets[0]`, every bracket's description is parsed and they
 * must agree. A bracket whose prose we cannot read is passed over — one odd
 * description should not discard an event we can otherwise place — but two
 * brackets naming DIFFERENT instants means this is not the family we think
 * it is, and the event is excluded.
 */
export function indexEvent(event: GammaEvent, underlying: 'BTC' | 'ETH'): IndexedEvent | null {
  const seriesTicker = SUPPORTED_SERIES[underlying];
  if (!event.seriesTickers.includes(seriesTicker)) return null;
  if (!event.negRisk) return null;

  const observed = new Set<string>();
  for (const market of event.markets) {
    const at = parseObservationAt(market.description, event.endDate);
    if (at !== null) observed.add(at);
  }
  if (observed.size !== 1) return null;
  const observationAt = [...observed][0]!;

  return {
    eventId: event.id,
    slug: event.slug,
    seriesTicker,
    underlying,
    observationAt,
    endDate: event.endDate,
    negRisk: event.negRisk,
    bracketCount: event.markets.length,
  };
}

/**
 * Filters already-indexed events to a bounded, nearest-first shortlist at or
 * after `deadlineIso` — a bounded shortlist because the model scores what
 * it is handed and cannot surface what retrieval missed. An event observing
 * before the deadline is excluded outright. An event observing on a LATER
 * DATE than the deadline is kept but flagged with `observationNote`, since
 * that is time basis risk the user accepts explicitly rather than a mismatch
 * to hide. All date/time comparison happens here, in code — never handed to
 * the model.
 */
export function retrieve(
  events: IndexedEvent[],
  underlying: 'BTC' | 'ETH',
  deadlineIso: string,
  limit = 5,
): RetrievalResult {
  const relevant = events.filter((e) => e.underlying === underlying);
  const deadlineMs = Date.parse(deadlineIso);
  const deadlineDate = deadlineIso.slice(0, 10);

  const eligible = relevant.filter((e) => Date.parse(e.observationAt) >= deadlineMs);

  if (eligible.length === 0) {
    const furthestListed =
      relevant.length === 0
        ? null
        : relevant.reduce(
            (latest, e) => (Date.parse(e.observationAt) > Date.parse(latest) ? e.observationAt : latest),
            relevant[0]!.observationAt,
          );
    return {
      kind: 'no_market_listed',
      furthestListed,
      reason:
        furthestListed === null
          ? `no ${underlying} bracket markets are listed at all`
          : `no ${underlying} market observes at or after ${deadlineDate}; the furthest listed observation is ${furthestListed}`,
    };
  }

  const sorted = [...eligible].sort((a, b) => Date.parse(a.observationAt) - Date.parse(b.observationAt));
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
