import { createHash } from 'node:crypto';
import type { QuoteRecord } from '@polyhedge/engine';
import type { ClobBook } from '@polyhedge/venue';
import type { ExecutionLeg, SelectedQuote } from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function quoteDigest(record: QuoteRecord, assumptions: string[], legs: ExecutionLeg[]): string {
  return createHash('sha256').update(canonical({ record, assumptions, legs })).digest('hex');
}
export interface BoundQuote { record: QuoteRecord; assumptions: string[]; selected: SelectedQuote }

/** Call on a server-owned QuoteRecord and its pinned snapshot before showing confirmation. */
export function bindQuote(record: QuoteRecord, books: ClobBook[], assumptions: string[]): BoundQuote {
  // Same encoding used by venue/saveSnapshot. Verify contents, not just the filename.
  const snapshotId = createHash('sha256').update(JSON.stringify([...books].sort((a,b) => a.assetId.localeCompare(b.assetId)))).digest('hex');
  if (snapshotId !== record.resolved.snapshotId) throw new Error('Books do not match the accepted quote snapshot');
  const byToken = new Map(books.map(b => [b.assetId,b]));
  if (byToken.size !== books.length) throw new Error('Duplicate tokens in snapshot');
  const legs = record.basket.legs.filter(l => l.shares > 0).map((leg): ExecutionLeg => {
    const resolved = record.resolved.legs.find(l => l.id === leg.legId);
    if (!resolved || resolved.tokenId !== leg.tokenId || resolved.side !== leg.side || resolved.marketId !== leg.marketId) throw new Error('Quoted leg identity changed');
    const sharesMicros = Math.round(leg.shares * 1_000_000);
    if (!Number.isSafeInteger(sharesMicros) || sharesMicros <= 0 || Math.abs(sharesMicros / 1_000_000 - leg.shares) > 1e-10) throw new Error('Invalid quoted quantity');
    const book = byToken.get(leg.tokenId);
    if (!book || !/^0x[0-9a-fA-F]{64}$/.test(book.market)) throw new Error('Snapshot lacks a verified condition ID');
    let remaining = sharesMicros;
    let referencePriceMicros = 0;
    for (const level of [...book.asks].sort((a,b) => a.priceMicros - b.priceMicros)) {
      const size = Math.floor(level.size * 1_000_000);
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(level.priceMicros) || level.priceMicros <= 0 || level.priceMicros >= 1_000_000) throw new Error('Invalid snapshot ask');
      if (size === 0) continue;
      remaining -= Math.min(remaining, size);
      referencePriceMicros = level.priceMicros;
      if (remaining === 0) break;
    }
    if (remaining > 0) throw new Error('Pinned quote lacks executable depth');
    return { id: leg.legId, tokenId: leg.tokenId, conditionId: book.market, outcome: leg.side, sharesMicros, referencePriceMicros };
  });
  if (!legs.length) throw new Error('Cannot confirm an empty quote');
  return structuredClone({ record, assumptions, selected: { hash: quoteDigest(record, assumptions, legs), legs } });
}

export function verifyBinding(bound: BoundQuote): void {
  if (quoteDigest(bound.record, bound.assumptions, bound.selected.legs) !== bound.selected.hash) throw new Error('Accepted quote, assumptions or legs changed');
}
