import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJevEngine, IDENTITY_CALIBRATION, type QuestionEngine } from '@polyhedge/questions';
import { extractExposure } from '../src/exposure.js';
import { assembleExposure } from '../src/intake.js';
import { parseDeadline, parseUnderlying } from '../src/parse.js';
import { selectExtractedShape, selectShape } from '../src/shape.js';
import { compile, MissingLevelError } from '../src/compile.js';

interface Example { id: string; source: string; text: string; expect: Record<string, unknown> }
type Mode = 'sequential' | 'combined';
const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw new Error('Set AI_GATEWAY_API_KEY in the process environment; it is never logged.');
const output = process.argv[2] ?? '.polyhedge-store/intake-evaluation';
const today = new Date('2026-09-21T00:00:00Z');
const engine = createJevEngine({ apiKey: key, fetchImpl: (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) });
const examples: Example[] = [];
for (const file of ['exposures.json', 'paired-cases.json']) {
  examples.push(...JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8')).examples);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value && typeof value === 'object') return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(value ?? null);
}

async function measure(example: Example, mode: Mode) {
  const started = performance.now();
  let calls = 0;
  const models: string[] = [];
  const measured: QuestionEngine = { async ask(state, questions) {
    calls++;
    const result = await engine.ask(state, questions);
    models.push(result.modelVersion);
    return result;
  } };
  const extraction = await extractExposure(example.text, today, measured, mode === 'combined');
  const underlying = parseUnderlying(example.text);
  const assembled = assembleExposure(example.text, extraction, parseDeadline(example.text, today),
    underlying ?? 'unknown', 0, IDENTITY_CALIBRATION);
  const hedge = extraction.answers.isHedge;
  const actual: Record<string, unknown> = { kind: assembled.kind, underlying,
    isHedge: hedge?.kind === 'boolean' ? hedge.probability >= 0.5 : null };
  if (assembled.kind === 'follow_up') actual.followUpField = assembled.field;
  if (assembled.kind === 'declined') actual.reason = assembled.reason;
  if (assembled.kind === 'exposure') {
    const exposure = assembled.exposure;
    Object.assign(actual, { direction: exposure.direction, lossUsd: exposure.lossUsd.value,
      budgetUsd: exposure.budgetUsd?.value ?? null, levels: exposure.levels });
    const shape = mode === 'combined'
      ? await selectExtractedShape(exposure, extraction, measured)
      : await selectShape(exposure, measured);
    actual.kind = shape.kind === 'template' ? 'interpreted' : 'declined';
    actual.templateId = shape.kind === 'template' ? shape.templateId : null;
    if (shape.kind === 'template') {
      try {
        // Exercise the same deterministic level/direction validation. This
        // placeholder only supplies an ID; no market eligibility is claimed.
        compile(exposure, shape.templateId, { eventId: 'evaluation' });
      } catch (error) {
        actual.kind = error instanceof MissingLevelError ? 'follow_up' : 'declined';
        if (error instanceof MissingLevelError) actual.followUpField = error.field;
      }
    }
  }
  const misses = Object.entries(example.expect).filter(([field, expected]) =>
    canonical(actual[field]) !== canonical(expected)).map(([field, expected]) => ({ field, expected, actual: actual[field] ?? null }));
  return { id: example.id, source: example.source, mode, calls,
    ms: Math.round(performance.now() - started), models, actual, misses };
}

const rows: Awaited<ReturnType<typeof measure>>[] = [];
const errors: { id: string; mode: Mode }[] = [];
for (const [i, example] of examples.entries()) {
  // Alternate order to reduce systematic warm-up/order bias. No concurrent
  // calls competing for provider capacity, no prompt/threshold tuning here.
  const modes: Mode[] = i % 2 ? ['combined', 'sequential'] : ['sequential', 'combined'];
  for (const mode of modes) {
    try {
      const row = await measure(example, mode);
      rows.push(row);
      console.log(`${example.id} ${mode}: ${row.calls} calls, ${row.ms}ms, ${row.misses.length} field mismatches`);
    } catch {
      // Provider errors can contain response bodies; never echo credentials or
      // raw upstream errors into the report. Failures still invalidate the run.
      errors.push({ id: example.id, mode });
      console.log(`${example.id} ${mode}: failed`);
    }
  }
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : null;
};
const regressions = examples.flatMap(example => {
  const old = rows.find(r => r.id === example.id && r.mode === 'sequential');
  const next = rows.find(r => r.id === example.id && r.mode === 'combined');
  if (!old || !next) return [];
  const oldMisses = new Set(old.misses.map(m => m.field));
  const fields = next.misses.filter(m => !oldMisses.has(m.field)).map(m => m.field);
  return fields.length ? [{ id: example.id, fields }] : [];
});
const summary = {
  examples: examples.length, independentExamples: examples.filter(e => e.source !== 'seed').length,
  sequentialMedianMs: median(rows.filter(r => r.mode === 'sequential').map(r => r.ms)),
  combinedMedianMs: median(rows.filter(r => r.mode === 'combined').map(r => r.ms)),
  regressions, errors, defaultAutomaticallyChanged: false,
  limitation: 'Seed regression check only. One run per case; no production accuracy or latency guarantee. Market-fit and venue work are unchanged and excluded.',
};
await mkdir(output, { recursive: true });
await writeFile(join(output, 'paired.json'), JSON.stringify({ today, examples, rows, summary }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (errors.length || regressions.length) process.exitCode = 1;
