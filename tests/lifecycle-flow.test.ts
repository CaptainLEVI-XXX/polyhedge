import { expect, it } from 'vitest';
import { runSimulation } from '../examples/simulated-lifecycle.js';
import { verifyBinding } from '../packages/execution/src/index.js';
import { basketFromExecution } from '../packages/settlement/src/index.js';

it('compiles, executes, journals and settles a winner and a loser; binds the accepted residual and assumptions', async () => {
  const winner = await runSimulation();
  expect(winner.execution.kind).toBe('complete');
  expect(winner.state).toBe('redeemed');
  expect(winner.redemptions).toBe(1);
  expect(winner.accounting).toMatchObject({ complete: true, payoutMicros: 10_000_000, costMicros: 2_000_000,
    targetMicros: 10_000_000, shortfallMicros: 0, boundAssessment: 'within' });
  const altered = structuredClone(winner.accepted);
  altered.assumptions.push('different resolution rules');
  expect(() => verifyBinding(altered)).toThrow(/changed/);
  const uncertain = structuredClone(winner.execution.record);
  uncertain.legs[0]!.buy!.state = 'unknown';
  expect(() => basketFromExecution(winner.accepted, uncertain, { observedAt: '', source: '' })).toThrow(/uncertain/);
  const loser = await runSimulation(false);
  expect(loser.state).toBe('lost');
  expect(loser.redemptions).toBe(0);
  expect(loser.accounting).toMatchObject({ complete: true, payoutMicros: 0, targetMicros: 0, shortfallMicros: 0, netMicros: -2_000_000 });
}, 20_000);
