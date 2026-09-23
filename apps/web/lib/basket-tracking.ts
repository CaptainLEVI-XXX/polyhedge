import { walkBook, priceMicros } from '@polyhedge/core';
import type { QuoteRecord } from '@polyhedge/engine';
import type { ClobBook } from '@polyhedge/venue';

/** Cost to buy the original quantities now, including current venue fees.
 * Never substitute a new allocation or treat a partial fill as a full price. */
export function fixedBasketCost(original: QuoteRecord, current: QuoteRecord, books: Map<string, ClobBook>): number|null {
  let cost=0;
  for(const leg of original.basket.legs){
    const index=current.resolved.legs.findIndex(l=>l.tokenId===leg.tokenId);
    const fee=current.resolved.feeRates[index];
    const book=books.get(leg.tokenId);
    if(!book||fee===undefined||!Number.isFinite(fee)||fee<0)return null;
    const fill=walkBook([...book.asks].sort((a,b)=>a.priceMicros-b.priceMicros).map(l=>({priceMicros:priceMicros(l.priceMicros),size:l.size})),leg.shares,fee);
    if(fill.filled+1e-8<leg.shares)return null;
    cost+=fill.costDollars;
  }
  return cost;
}
export interface PricePoint { at:number; cost:number|null }
export type BasketHistory=Record<string,PricePoint[]>;
