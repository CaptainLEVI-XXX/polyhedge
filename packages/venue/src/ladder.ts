// A general parser for Polymarket's numeric bracket ladders.
//
// `bracket-parser.ts` reads one family's grammar (`<66,000`, `66,000-68,000`,
// `>84,000`). Across the venue there are ~45 distinct label shapes over ~160
// neg-risk families, and the engine can price any of them: a ladder is just a
// partition of a numeric axis, and nothing in `core` cares whether the axis is
// dollars, degrees, percent or basis points.
//
// What makes this safe is NOT the per-label regex — it is the contiguity check
// in `parseLadder`. A real ladder tiles its axis exactly once: one open bottom,
// one open top, and every interior bracket starting where the previous ended.
// Label shapes that merely LOOK numeric do not tile, which is how soccer
// scorelines ("CA Lanús 0 - 0 Estudiantes de La Plata") and candidate lists are
// rejected without needing to know what a soccer scoreline is. Guessing a
// partition wrong would silently misprice every state, so a ladder that does
// not tile is not a ladder we will quote.

export interface LadderBracket {
  /** null means open below. */
  lo: number | null;
  /** null means open above. */
  hi: number | null;
  /** The venue's own label, verbatim, for display. */
  label: string;
}

export interface Ladder {
  brackets: LadderBracket[];
  /** e.g. "$", "°F", "%", "bps", "" — display only, never used in arithmetic. */
  unit: string;
  /** Lowest and highest interior boundary: the span the ladder can express. */
  span: { lo: number; hi: number };
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, m: 1e6, b: 1e9, t: 1e12,
};

// Every dash Polymarket uses as a range separator, including en/em dashes.
const DASHES = /[-‒–—―]/;

/**
 * Reads one number with its optional multiplier and unit decoration.
 * `$2.25` → 2.25, `419K` → 419000, `940m` → 940000000, `3.1%` → 3.1, `20°C` → 20.
 *
 * Case matters for the multiplier only in that `m`/`M` both mean million here:
 * the venue writes `940m` for box office and `50M` for view counts, and no
 * family uses lowercase `m` for anything else on a ladder.
 */
function readNumber(raw: string): { value: number; unit: string } | null {
  const text = raw.trim();
  const match = /^([$€£]?)\s*(-?\d[\d,]*(?:\.\d+)?)\s*([kKmMbBtT])?\s*(%|°[CF]|"|bps)?\s*$/.exec(text);
  if (!match) return null;

  const [, currency, digits, multiplier, suffix] = match;
  const base = Number((digits ?? '').replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;

  const scale = multiplier === undefined ? 1 : (MULTIPLIERS[multiplier.toLowerCase()] ?? 1);
  const unit = suffix ?? (currency !== '' ? currency : '') ?? '';
  return { value: base * scale, unit: unit ?? '' };
}

/**
 * Central-bank decision ladders are ordinal, not written as numbers on an axis:
 * `50+ bps decrease | 25 bps decrease | No change | 25 bps increase | 50+ bps
 * increase`. They ARE a numeric axis once read as signed basis points, which is
 * how a borrower actually experiences them — a cut is a negative move.
 */
function readRateStep(raw: string): { lo: number | null; hi: number | null } | null {
  const text = raw.trim().toLowerCase();
  if (/^no\s+change$/.test(text)) return { lo: -12.5, hi: 12.5 };

  const match = /^(\d+)(\+)?\s*bps?\s+(decrease|increase|cut|hike)$/.exec(text);
  if (!match) return null;

  const size = Number(match[1]);
  const open = match[2] === '+';
  const down = match[3] === 'decrease' || match[3] === 'cut';
  if (!Number.isFinite(size)) return null;

  // Half-open around the step, so consecutive steps tile: a 25bp cut covers
  // (-37.5, -12.5], and "50+" runs open to the end of the axis.
  if (down) return open ? { lo: null, hi: -(size - 12.5) } : { lo: -(size + 12.5), hi: -(size - 12.5) };
  return open ? { lo: size - 12.5, hi: null } : { lo: size - 12.5, hi: size + 12.5 };
}

/**
 * One bracket label → its interval, or null when the label is not a numeric
 * bracket at all.
 *
 * A label must START with its number or comparator. That single rule is what
 * keeps `CA Lanús 0 - 0 Estudiantes de La Plata` from reading as the range
 * 0 to 0: the digits are there, but they are not where a bracket puts them.
 */
export function parseLadderLabel(label: string): LadderBracket | null {
  const text = label.trim();
  if (text === '') return null;

  const rate = readRateStep(text);
  if (rate !== null) return { lo: rate.lo, hi: rate.hi, label };

  // "20°C or below", "78°F or higher", "$1.25 or more"
  const phrase = /^(.+?)\s+or\s+(below|less|lower|higher|more|above)$/i.exec(text);
  if (phrase) {
    const n = readNumber(phrase[1] ?? '');
    if (n === null) return null;
    const isLow = /below|less|lower/i.test(phrase[2] ?? '');
    return isLow ? { lo: null, hi: n.value, label } : { lo: n.value, hi: null, label };
  }

  // "<40", "≤3.0%", "<$2.25", "Less than 5"
  const below = /^(?:<=|≤|<|less\s+than|under|below)\s*(.+)$/i.exec(text);
  if (below) {
    const n = readNumber(below[1] ?? '');
    return n === null ? null : { lo: null, hi: n.value, label };
  }

  // ">88,000", "≥5", "More than 3"
  const above = /^(?:>=|≥|>|more\s+than|over|above)\s*(.+)$/i.exec(text);
  if (above) {
    const n = readNumber(above[1] ?? '');
    return n === null ? null : { lo: n.value, hi: null, label };
  }

  // "4+", "970m+", "1.1%+"
  const openTop = /^(.+?)\+$/.exec(text);
  if (openTop) {
    const n = readNumber(openTop[1] ?? '');
    if (n !== null) return { lo: n.value, hi: null, label };
  }

  // "0.5% to 0.6%"
  const wordy = /^(.+?)\s+to\s+(.+)$/i.exec(text);
  if (wordy) {
    const lo = readNumber(wordy[1] ?? '');
    const hi = readNumber(wordy[2] ?? '');
    if (lo !== null && hi !== null && lo.value < hi.value) {
      return { lo: lo.value, hi: hi.value, label };
    }
  }

  // "54-55°F", "$419K - $426K", "0.5–1.0%", "940 - 950m", "50-60M"
  const dash = text.search(DASHES);
  if (dash > 0) {
    const loRaw = text.slice(0, dash);
    const hiRaw = text.slice(dash + 1);
    const lo = readNumber(loRaw);
    const hi = readNumber(hiRaw);
    if (lo !== null && hi !== null) {
      // The venue routinely writes the multiplier once, on the high side:
      // "50-60M" means 50 million to 60 million, NOT 50 to 60,000,000. Taking
      // the low side at face value understates it by six orders of magnitude
      // and would price the bracket as covering almost the whole axis.
      const loScale = /[kKmMbBtT]\s*(%|°[CF]|"|bps)?\s*$/.test(loRaw.trim());
      const hiScale = /([kKmMbBtT])\s*(%|°[CF]|"|bps)?\s*$/.exec(hiRaw.trim());
      const inherited = !loScale && hiScale !== null
        ? lo.value * (MULTIPLIERS[(hiScale[1] ?? '').toLowerCase()] ?? 1)
        : lo.value;
      if (inherited < hi.value) return { lo: inherited, hi: hi.value, label };
    }
  }

  // A bare single value: "21°C", "3.1%", "2". Width is decided by its
  // neighbours in `parseLadder`, because one point tells you nothing.
  const single = readNumber(text);
  if (single !== null) return { lo: single.value, hi: single.value, label };

  return null;
}

/** The unit the majority of labels agree on, for display only. */
function detectUnit(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) {
    const m = /(%|°C|°F|"|bps)/.exec(label) ?? /([$€£])/.exec(label);
    const unit = m?.[1] ?? '';
    if (unit === '') continue;
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  let best = '';
  let seen = 0;
  for (const [unit, n] of counts) if (n > seen) { best = unit; seen = n; }
  return best;
}

/**
 * Parses a whole event's labels into a ladder, or returns null.
 *
 * The contiguity requirement is the point of this function. Every interior
 * bracket must begin exactly where the previous ended, with one open bracket at
 * each end — the same half-open `[lo, hi)` convention the state space uses. A
 * set of labels that parses individually but does not tile is not a partition,
 * and pricing it as one would misstate what every state pays.
 */
export function parseLadder(labels: string[]): Ladder | null {
  if (labels.length < 3) return null;

  const parsed: LadderBracket[] = [];
  for (const label of labels) {
    const bracket = parseLadderLabel(label);
    if (bracket === null) return null;
    parsed.push(bracket);
  }

  const widened = parsed.map((b) => ({ ...b }));

  // Exactly one open bottom and one open top, and they must be the ends.
  const openLow = widened.filter((b) => b.lo === null);
  const openHigh = widened.filter((b) => b.hi === null);
  if (openLow.length !== 1 || openHigh.length !== 1) return null;
  if (widened[0]?.lo !== null || widened[widened.length - 1]?.hi !== null) return null;

  // Ladders written with INCLUSIVE upper bounds leave an identical hole at
  // every boundary: "<40 | 40-64 | 65-89" (counts, hole 1), "≤0.4% | 0.5% to
  // 0.6%" (percent, hole 0.1), and "20°C or below | 21°C | 22°C" (bare points,
  // hole 1). The venue means "up to and including", so those holes are
  // notation, not unpriced outcomes.
  //
  // Two things have to hold before one is closed. The holes must all be the
  // SAME width, and they must appear at a MAJORITY of boundaries. A ladder
  // with one genuinely missing bracket has a single odd gap, which passes a
  // naive uniformity test trivially — requiring most boundaries to show it is
  // what separates a notation convention from a real hole. Closing a real hole
  // would price a state nobody can actually be paid in.
  const gaps: number[] = [];
  for (let i = 0; i < widened.length - 1; i += 1) {
    const cur = widened[i]!;
    const next = widened[i + 1]!;
    if (cur.hi === null || next.lo === null) return null;
    gaps.push(next.lo - cur.hi);
  }
  if (gaps.some((g) => g < -1e-9)) return null;

  const positive = gaps.filter((g) => g > 1e-9);
  const inclusiveNotation =
    positive.length * 2 >= gaps.length
    && positive.every((g) => Math.abs(g - positive[0]!) < 1e-9);

  for (let i = 0; i < widened.length - 1; i += 1) {
    const cur = widened[i]!;
    const next = widened[i + 1]!;
    if (cur.hi === null || next.lo === null) return null;
    const gap = next.lo - cur.hi;
    if (gap > 1e-9) {
      if (!inclusiveNotation) return null;
      cur.hi = next.lo;
    }
    if (next.hi !== null && next.lo > next.hi) return null;
  }

  const bounds = widened.flatMap((b) => [b.lo, b.hi]).filter((v): v is number => v !== null);
  if (bounds.length === 0) return null;

  return {
    brackets: widened,
    unit: detectUnit(labels),
    span: { lo: Math.min(...bounds), hi: Math.max(...bounds) },
  };
}
