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
  /** Optional premium-aware policy; absence preserves the original compiler. */
  protectionGoal?: ProtectionGoal;
  execution?: ExecutionConstraints;
}

export interface ExecutionConstraints {
  quantityStep: number;
  /** One minimum per candidate leg, from the venue. */
  minShares: number[];
  maxLegs?: number;
}

export type ProtectionGoal =
  | { kind: 'minimize_net_loss' }
  | { kind: 'limit_net_loss'; maxNetLossUsd: number };

export type Phase =
  | { kind: 'minimax' }
  | { kind: 'cost'; maxShortfallDollars: number };

export interface LpModel {
  text: string;
  hash: string;
  legLevelVars: { leg: number; level: number; name: string }[];
  mixedInteger?: boolean;
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
    if (!input.protectionGoal) {
      for (const v of legLevelVars) { obj.push(term(EPSILON * idx, v.name)); idx += 1; }
      for (let t = 0; t < nStates; t += 1) { obj.push(term(EPSILON * idx, `o_${t}`)); idx += 1; }
    }
  } else {
    for (const v of legLevelVars) {
      obj.push(term(cost(v.leg, v.level) + (input.protectionGoal ? 0 : EPSILON * idx), v.name));
      idx += 1;
    }
    for (let t = 0; t < nStates; t += 1) { obj.push(term(mu + (input.protectionGoal ? 0 : EPSILON * idx), `o_${t}`)); idx += 1; }
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

  // Net loss includes premium in every state. Surplus payout offsets loss;
  // the risk bound is floored at zero so we never optimize for arbitrage profit.
  const riskTerms = (t: number): string[] => input.protectionGoal
    ? [term(1, `s_${t}`), term(-1, `o_${t}`),
       ...legLevelVars.map(v => term(cost(v.leg, v.level), v.name))]
    : [term(1, `s_${t}`)];

  if (phase.kind === 'minimax') {
    for (let t = 0; t < nStates; t += 1) {
      lines.push(` m_${t}: ${join([...riskTerms(t), term(-1, 'M')])} <= 0.000000000000`);
    }
  } else {
    for (let t = 0; t < nStates; t += 1) {
      lines.push(` cap_${t}: ${join(riskTerms(t))} <= ${fmt(phase.maxShortfallDollars)}`);
    }
  }

  if (budgetCents !== null) {
    const parts = legLevelVars.map((v) => term(cost(v.leg, v.level), v.name));
    lines.push(` budget: ${join(parts)} <= ${fmt(centsToDollars(budgetCents))}`);
  }

  const execution = input.execution;
  if (execution) {
    for (let j = 0; j < nLegs; j++) {
      const quantity = legLevelVars.filter(v => v.leg === j).map(v => term(1, v.name));
      const depth = (books[j] ?? []).reduce((sum, l) => sum + l.size, 0);
      const cheapest = Math.min(...(books[j] ?? []).map((_, l) => cost(j, l)));
      // A leg cannot spend more than the whole basket budget. Tight activation
      // bounds avoid making the integer solver branch over unreachable depth.
      const affordable = budgetCents !== null && cheapest > 0
        ? centsToDollars(budgetCents) / cheapest : depth;
      const units = Math.floor(Math.min(depth, affordable) / execution.quantityStep + 1e-8);
      const minimum = Math.max(1, Math.ceil(execution.minShares[j]! / execution.quantityStep - 1e-8));
      lines.push(` quantity_${j}: ${join([...quantity, term(-execution.quantityStep, `n_${j}`)])} = 0`);
      lines.push(` active_max_${j}: n_${j} - ${fmt(units)} z_${j} <= 0`);
      lines.push(` active_min_${j}: n_${j} - ${fmt(minimum)} z_${j} >= 0`);
    }
    if (execution.maxLegs !== undefined) {
      lines.push(` leg_count: ${join(Array.from({ length: nLegs }, (_, j) => term(1, `z_${j}`)))} <= ${execution.maxLegs}`);
    }
  }

  lines.push('Bounds');
  for (const v of legLevelVars) {
    lines.push(` ${v.name} <= ${fmt(books[v.leg]![v.level]!.size)}`);
  }
  if (execution) {
    lines.push('Generals', ...Array.from({ length: nLegs }, (_, j) => ` n_${j}`));
    lines.push('Binaries', ...Array.from({ length: nLegs }, (_, j) => ` z_${j}`));
  }
  lines.push('End', '');

  const text = lines.join('\n');
  return { text, hash: createHash('sha256').update(text, 'utf8').digest('hex'), legLevelVars,
    ...(execution ? { mixedInteger: true } : {}) };
}
