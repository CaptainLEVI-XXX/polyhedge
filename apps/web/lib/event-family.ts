import type { EventKind } from '@polyhedge/venue';
/** Stops new quotes only; historical records and settlement remain readable. */
export function familyEnabled(kind:EventKind):boolean {
  return process.env[`POLYHEDGE_${kind.toUpperCase()}_HEDGES`] !== '0';
}
