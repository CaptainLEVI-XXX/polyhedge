import type { PricePoint } from './basket-tracking.js';
export interface MarketHistory { points:PricePoint[]; status:'ready'|'empty'|'unavailable'|'stale'; fetchedAt:number }
export type MarketHistories=Record<string,MarketHistory>;
