import { z } from 'zod';

const levelSchema = z.object({ price: z.string(), size: z.string() });
const bookSchema = z.object({
  market: z.string(), asset_id: z.string(), timestamp: z.string(), hash: z.string(),
  bids: z.array(levelSchema), asks: z.array(levelSchema),
  min_order_size: z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)])
    .transform(Number).pipe(z.number().finite().nonnegative()).optional(),
});

export interface ParsedLevel { priceMicros: number; size: number }
export interface ClobBook {
  market: string; assetId: string; timestamp: string; hash: string;
  bids: ParsedLevel[]; asks: ParsedLevel[];
  minOrderSize?: number;
}

/** Tick size varies per market and can be 0.001, so cents are too coarse. */
function toMicros(price: string): number {
  return Math.round(Number(price) * 1_000_000);
}

export function parseBook(raw: unknown): ClobBook {
  const b = bookSchema.parse(raw);
  const level = (l: z.infer<typeof levelSchema>): ParsedLevel =>
    ({ priceMicros: toMicros(l.price), size: Number(l.size) });
  return {
    market: b.market, assetId: b.asset_id, timestamp: b.timestamp, hash: b.hash,
    bids: b.bids.map(level).sort((x, y) => y.priceMicros - x.priceMicros),
    asks: b.asks.map(level).sort((x, y) => x.priceMicros - y.priceMicros),
    ...(b.min_order_size === undefined ? {} : { minOrderSize: b.min_order_size }),
  };
}

const marketSchema = z.object({
  id: z.string(), question: z.string(), groupItemTitle: z.string().default(''), description: z.string(),
  // Optional because an abridged payload may omit it. Absent means we link to
  // the event rather than the bracket — never a guessed slug, which would send
  // someone to a 404 or, worse, to a different market.
  slug: z.string().optional(),
  clobTokenIds: z.string(), outcomePrices: z.string(), outcomes: z.string(),
  orderPriceMinTickSize: z.number(), endDate: z.string(),
  conditionId: z.string().optional(), questionID: z.string().optional(),
  active: z.boolean().optional(), closed: z.boolean().optional(), enableOrderBook: z.boolean().optional(), acceptingOrders: z.boolean().optional(),
  negRisk: z.boolean().optional(), negRiskMarketID: z.string().optional(),
  feeSchedule: z.object({ rate: z.number(), takerOnly: z.boolean() }).optional(),
});

const eventSchema = z.object({
  id: z.string(), slug: z.string(), title: z.string(),
  description: z.string().optional(), negRiskAugmented: z.boolean().optional(),
  negRisk: z.boolean(), negRiskMarketID: z.string().optional(), endDate: z.string(),
  tags: z.array(z.object({ label: z.string(), slug: z.string() })),
  // The `crypto` tag also pulls in Up/Down, hit-price, meme-coin and
  // person-vs-person markets. `series` is the field that actually
  // distinguishes market families, so callers must select by
  // `seriesTickers`, never by `tags`. Optional because not every raw
  // response includes it; absence maps to an empty list, never a guess.
  series: z.array(z.object({ ticker: z.string() })).optional(),
  markets: z.array(marketSchema),
});

export interface GammaMarket {
  id: string; question: string; groupItemTitle: string; description: string;
  /** The venue's own path segment for this bracket. Null if it did not say. */
  slug: string | null;
  yesTokenId: string; noTokenId: string; yesPrice: number;
  tickSize: number;
  /** null means the venue did not report one. Unknown, NOT zero. */
  feeRate: number | null;
  endDate: string;
  conditionId?: string; questionId?: string;
  active?: boolean; closed?: boolean; enableOrderBook?: boolean; acceptingOrders?: boolean;
  negRisk?: boolean; negRiskMarketId?: string;
  outcomeLabels?: [string, string]; yesOutcomeIndex?: number;
}

export interface GammaEvent {
  id: string; slug: string; title: string;
  negRisk: boolean; negRiskMarketId: string | null; endDate: string;
  description?: string; negRiskAugmented?: boolean;
  tags: string[];
  /** From `series[].ticker`. The `crypto` tag is not a substitute for this. */
  seriesTickers: string[];
  markets: GammaMarket[];
}

export function parseEvent(raw: unknown): GammaEvent {
  const e = eventSchema.parse(raw);
  return {
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(e.negRiskAugmented !== undefined ? { negRiskAugmented: e.negRiskAugmented } : {}),
    id: e.id, slug: e.slug, title: e.title,
    negRisk: e.negRisk, negRiskMarketId: e.negRiskMarketID ?? null, endDate: e.endDate,
    tags: e.tags.map((t) => t.slug),
    seriesTickers: e.series?.map((s) => s.ticker) ?? [],
    markets: e.markets.map((m) => {
      const tokens = z.array(z.string()).parse(JSON.parse(m.clobTokenIds));
      const prices = z.array(z.string()).parse(JSON.parse(m.outcomePrices));
      const outcomes = z.array(z.string()).parse(JSON.parse(m.outcomes));
      if (outcomes.length !== 2 || tokens.length !== 2 || tokens[0] === tokens[1] || tokens.some(t => !/^\d+$/.test(t))) {
        throw new Error(`market ${m.id} does not have two distinct outcome tokens`);
      }
      const yesIndex = outcomes.findIndex(o => o.toLowerCase() === 'yes');
      const noIndex = outcomes.findIndex(o => o.toLowerCase() === 'no');
      const first = yesIndex >= 0 && noIndex >= 0 ? yesIndex : 0;
      if (first !== 0) throw new Error(`market ${m.id} has unsupported reversed outcomes`);
      const second = 1 - first;
      return {
        id: m.id, question: m.question, groupItemTitle: m.groupItemTitle,
        description: m.description, slug: m.slug ?? null,
        yesTokenId: tokens[first]!, noTokenId: tokens[second]!,
        yesPrice: Number(prices[first] ?? '0'),
        outcomeLabels: [outcomes[first]!, outcomes[second]!], yesOutcomeIndex: first,
        ...(m.conditionId !== undefined ? { conditionId: m.conditionId } : {}),
        ...(m.questionID !== undefined ? { questionId: m.questionID } : {}),
        ...(m.active !== undefined ? { active: m.active } : {}),
        ...(m.closed !== undefined ? { closed: m.closed } : {}),
        ...(m.enableOrderBook !== undefined ? { enableOrderBook: m.enableOrderBook } : {}),
        ...(m.acceptingOrders !== undefined ? { acceptingOrders: m.acceptingOrders } : {}),
        ...(m.negRisk !== undefined ? { negRisk: m.negRisk } : {}),
        ...(m.negRiskMarketID !== undefined ? { negRiskMarketId: m.negRiskMarketID } : {}),
        tickSize: m.orderPriceMinTickSize,
        feeRate: m.feeSchedule?.rate ?? null,
        endDate: m.endDate,
      };
    }),
  };
}
