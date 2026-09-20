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
const EXPLICIT_TIME = /(\d{1,2}):(\d{2})/;

/**
 * Reads a time-of-day out of description prose ("...12:00 in the ET
 * timezone (noon)"). Requires an explicit ET/Eastern mention nearby — a
 * bare number or "noon" without a timezone marker is not something we can
 * read with certainty, so it returns null rather than assume ET.
 */
function extractEtTime(description: string): { hour: number; minute: number } | null {
  if (!ET_MENTION.test(description)) return null;

  const explicit = EXPLICIT_TIME.exec(description);
  if (explicit) {
    const hour = Number(explicit[1]);
    const minute = Number(explicit[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  if (/\bnoon\b/i.test(description)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/i.test(description)) return { hour: 0, minute: 0 };
  return null;
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
 */
export function indexEvent(event: GammaEvent, underlying: 'BTC' | 'ETH'): IndexedEvent | null {
  const seriesTicker = SUPPORTED_SERIES[underlying];
  if (!event.seriesTickers.includes(seriesTicker)) return null;
  if (!event.negRisk) return null;

  const description = event.markets[0]?.description ?? '';
  const observationAt = parseObservationAt(description, event.endDate);
  if (observationAt === null) return null;

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
