import { createHash } from 'node:crypto';
import { centsToDollars, type Cents } from '../money.js';
import { unitCostDollars, type BookLevel } from '../book.js';

/** Tie-break scale, far below one cent. */
export const EPSILON = 1e-9;

export interface LpInput {
  target: Cents[];
  matrix: number[][];
  books: BookLevel[][];
  feeRates: number[];
  mu: number;
  budgetCents: Cents | null;
}

export type Phase =
  | { kind: 'minimax' }
  | { kind: 'cost'; maxShortfallDollars: number };

export interface LpModel {
  text: string;
  hash: string;
  legLevelVars: { leg: number; level: number; name: string }[];
}

function fmt(x: number): string { return x.toFixed(12); }
function term(coef: number, name: string): string {
  return `${coef < 0 ? '-' : '+'} ${fmt(Math.abs(coef))} ${name}`;
}
function join(parts: string[]): string {
  return parts.join(' ').replace(/^\+ /, '');
}

/**
 * Build one phase of the lexicographic program in CPLEX LP format.
 *
 * Phase 1 minimizes the worst-case dollar shortfall M. Phase 2 pins
 * shortfall at that optimum and minimizes real cost. Shortfall is never
 * probability-weighted: the states worth hedging are frequently the ones
 * the market prices as unlikely, and weighting would skip them.
 */
export function buildLpModel(input: LpInput, phase: Phase): LpModel {
  const { target, matrix, books, feeRates, mu, budgetCents } = input;
  const nStates = target.length;
  const nLegs = matrix.length;

  const legLevelVars: { leg: number; level: number; name: string }[] = [];
  for (let j = 0; j < nLegs; j += 1) {
    for (let l = 0; l < (books[j] ?? []).length; l += 1) {
      legLevelVars.push({ leg: j, level: l, name: `x_${j}_${l}` });
    }
  }

  const cost = (j: number, l: number): number =>
    unitCostDollars(books[j]![l]!.priceMicros, feeRates[j] ?? 0);

  let idx = 0;
  const obj: string[] = [];

  if (phase.kind === 'minimax') {
    obj.push(term(1, 'M'));
    for (const v of legLevelVars) { obj.push(term(EPSILON * idx, v.name)); idx += 1; }
    for (let t = 0; t < nStates; t += 1) { obj.push(term(EPSILON * idx, `o_${t}`)); idx += 1; }
  } else {
    for (const v of legLevelVars) {
      obj.push(term(cost(v.leg, v.level) + EPSILON * idx, v.name));
      idx += 1;
    }
    for (let t = 0; t < nStates; t += 1) { obj.push(term(mu + EPSILON * idx, `o_${t}`)); idx += 1; }
  }

  const lines: string[] = ['\\ polyhedge lp v2', 'Minimize', ` obj: ${join(obj)}`, 'Subject To'];

  for (let t = 0; t < nStates; t += 1) {
    const parts: string[] = [];
    for (const v of legLevelVars) {
      const a = matrix[v.leg]![t] ?? 0;
      if (a !== 0) parts.push(term(a, v.name));
    }
    parts.push(term(1, `s_${t}`), term(-1, `o_${t}`));
    lines.push(` c_${t}: ${join(parts)} = ${fmt(centsToDollars(target[t]!))}`);
  }

  if (phase.kind === 'minimax') {
    for (let t = 0; t < nStates; t += 1) {
      lines.push(` m_${t}: ${join([term(1, `s_${t}`), term(-1, 'M')])} <= 0.000000000000`);
    }
  } else {
    for (let t = 0; t < nStates; t += 1) {
      lines.push(` cap_${t}: ${term(1, `s_${t}`).replace(/^\+ /, '')} <= ${fmt(phase.maxShortfallDollars)}`);
    }
  }

  if (budgetCents !== null) {
    const parts = legLevelVars.map((v) => term(cost(v.leg, v.level), v.name));
    lines.push(` budget: ${join(parts)} <= ${fmt(centsToDollars(budgetCents))}`);
  }

  lines.push('Bounds');
  for (const v of legLevelVars) {
    lines.push(` ${v.name} <= ${fmt(books[v.leg]![v.level]!.size)}`);
  }
  lines.push('End', '');

  const text = lines.join('\n');
  return { text, hash: createHash('sha256').update(text, 'utf8').digest('hex'), legLevelVars };
}
