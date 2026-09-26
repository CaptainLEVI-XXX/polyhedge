import { pinnedCostProtectionCurve } from '@polyhedge/intake';
import { getSnapshot, type StoredQuote } from './store.js';
import { curvePoints, type CurvePoint } from './view-model.js';

/**
 * The cost-versus-protection curve for one stored quote, solved against that
 * quote's pinned inputs. Displayed options are separate comparison markers. A stored
 * quote never changes, so its curve is computed once and kept while in use.
 */
const curves = new Map<string, Promise<CurvePoint[]>>();

async function build(stored:StoredQuote):Promise<CurvePoint[]> {
  const books=await getSnapshot(stored.record.resolved.snapshotId);
  return curvePoints(await pinnedCostProtectionCurve(stored.record,books));
}

export function curveFor(stored: StoredQuote): Promise<CurvePoint[]> {
  let pending = curves.get(stored.id);
  if (!pending) {
    pending = build(stored);
    curves.set(stored.id, pending);
    pending.catch(() => curves.delete(stored.id));
    while (curves.size > 200) curves.delete(curves.keys().next().value!);
  }
  return pending;
}
