import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluate, policies } from './hedge-benchmark/evaluate.js';
import { scenarios } from './hedge-benchmark/scenarios.js';

const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith('-')) {
  throw new Error('usage: pnpm benchmark:hedge [output-directory]');
}
const directory = args[0] ?? '.polyhedge-store/benchmarks';
const rows: Awaited<ReturnType<typeof evaluate>>[] = [];
const failures: { scenario: string; policy: string; error: string }[] = [];
const dataset = scenarios();
for (const scenario of dataset) {
  for (const policy of policies) {
    try { rows.push(await evaluate(scenario, policy)); }
    catch (error) {
      failures.push({ scenario: scenario.id, policy: policy.id, error: String(error) });
    }
  }
}
const report = {
  kind: 'synthetic-scenario-benchmark', version: 1, policies, scenarios: dataset,
  assumptions: [
    'Known, exhaustive mutually exclusive ladder; target payout is the modelled loss, not a real holding.',
    'Synthetic asks, fees and explicit assumed probabilities; no historical data or annualized performance. Includes a deliberately wrong-odds evaluation.',
    'Stress retains 50% of every ask level; independent per-leg FOK at original limit and zero-slippage cost cap, held to settlement.',
    'Only the executable policy enforces synthetic minimum sizes, quantity increments and a leg limit. No unwind, latency, gas or source/time basis risk model.',
    'Worst metrics range over evaluation states; no frequency-weighted aggregation or tuning winner.',
  ],
  rows, failures,
};
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const header = ['scenario', 'policy', 'budgetUsd', 'costUsd', 'worstUncoveredUsd', 'worstNetLossUsd',
  'maxExcessPayoutUsd', 'activeLegs', 'stressCostUsd', 'stressWorstUncoveredUsd', 'stressWorstNetLossUsd', 'completion','marketImpliedNetCostUsd','evaluationNetCostUsd'];
const csv = [header, ...rows.map(r => [r.scenario, r.policy, r.budgetUsd,
  r.quoted.costUsd, r.quoted.worstUncoveredUsd, r.quoted.worstNetLossUsd,
  r.quoted.maxExcessPayoutUsd, r.quoted.activeLegs, r.stressed.costUsd,
  r.stressed.worstUncoveredUsd, r.stressed.worstNetLossUsd, r.completion,r.marketImpliedNetCostUsd,r.evaluationNetCostUsd])]
  .map(row => row.map(value => JSON.stringify(value)).join(',')).join('\n');
await writeFile(join(directory, 'results.csv'), csv + '\n');
console.log(`Synthetic benchmark: ${dataset.length} scenarios × ${policies.length} policies.`);
console.log(`${rows.length} results; ${failures.length} failures. Reports: ${directory}`);
console.log('Compare policies within each scenario. These are stress cases, not historical performance.');
if (failures.length) process.exitCode = 1;
