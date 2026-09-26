// Runs intake's two model-driven reads — role extraction and shape
// selection — against the LIVE Jev API and compares each field to the
// answer key in exposures.json.
//
//   AI_GATEWAY_API_KEY=... npx tsx packages/intake/evals/run.ts --split fit
//
// A SCRIPT, NOT A TEST. Nothing in the test suite may touch the network, so
// this lives outside `src/` and vitest never sees it. It is also the only
// place in the repo that talks to the API on purpose, which is why it reads
// its key from the environment and never from `.env.local`: a script that
// digs a secret out of the working tree hides which credentials, and which
// account, a published number was produced with.
//
// THE TRAP this file exists to avoid: printing a table of percentages next
// to the words "accuracy" and "calibration" when every example was written
// by the same project that wrote the prompts. That is a measurement of
// self-consistency wearing the costume of a measurement of correctness, and
// it is worse than no number at all, because the next person tunes a
// threshold against it. So when every loaded example is `source: "seed"`,
// this refuses to present the run as a measurement: the per-field results
// still print, under a banner saying plainly what they are and what they do
// not support. That refusal is the hard requirement here, not the table.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJevEngine, IDENTITY_CALIBRATION, type Answer } from '@polyhedge/questions';
import { assembleExposure } from '../src/intake.js';
import { extractExposure } from '../src/exposure.js';
import { parseDeadline, parseUnderlying } from '../src/parse.js';
import { selectShape } from '../src/shape.js';
import type { NamedLevel, TypedExposure } from '../src/types.js';

interface ExpectedLevel {
  value: number;
  role: NamedLevel['role'];
}

interface Expectation {
  underlying?: 'BTC' | 'ETH';
  direction?: TypedExposure['direction'] | null;
  lossUsd?: number | null;
  budgetUsd?: number | null;
  levels?: ExpectedLevel[] | null;
  templateId?: string | null;
  isHedge?: boolean;
}

interface Example {
  id: string;
  split: string;
  source: string;
  text: string;
  expect: Expectation;
}

interface ExposureSet {
  version: number;
  examples: Example[];
}

/** 'match' — agreed with the key. 'miss' — produced something else. 'absent' — produced nothing where the key wanted a value. */
type Outcome = 'match' | 'miss' | 'absent';

interface Row {
  field: string;
  expected: string;
  actual: string;
  outcome: Outcome;
}

const SCORED_FIELDS = [
  'underlying',
  'isHedge',
  'direction',
  'lossUsd',
  'budgetUsd',
  'levels',
  'templateId',
] as const;

function show(value: unknown): string {
  if (value === undefined) return '(nothing)';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => show(v)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const level = value as ExpectedLevel;
    return `${level.value}:${level.role}`;
  }
  return String(value);
}

function sameLevels(a: ExpectedLevel[], b: ExpectedLevel[]): boolean {
  if (a.length !== b.length) return false;
  const key = (l: ExpectedLevel): string => `${l.role}=${l.value}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}

/**
 * Compares one field. `undefined` on the actual side means the pipeline
 * never produced that field (it declined, or asked a follow-up); when the
 * key says `null`, that is exactly right and counts as a match.
 */
function compare(field: string, expected: unknown, actual: unknown): Row {
  const row = (outcome: Outcome): Row => ({
    field,
    expected: show(expected),
    actual: show(actual),
    outcome,
  });

  if (expected === null) return row(actual === undefined ? 'match' : 'miss');
  if (actual === undefined) return row('absent');

  if (field === 'levels') {
    return row(sameLevels(expected as ExpectedLevel[], actual as ExpectedLevel[]) ? 'match' : 'miss');
  }
  return row(expected === actual ? 'match' : 'miss');
}

function parseArgs(argv: string[]): { split: string; today: Date } {
  let split = 'fit';
  let today = new Date();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const eq = /^--(split|today)=(.*)$/.exec(arg);
    const name = eq?.[1] ?? (arg === '--split' || arg === '--today' ? arg.slice(2) : null);
    const value = eq?.[2] ?? (name !== null && eq === null ? argv[i + 1] : undefined);
    if (name === null) continue;
    if (eq === null) i += 1;
    if (value === undefined) throw new Error(`run: --${name} needs a value`);
    if (name === 'split') split = value;
    if (name === 'today') {
      today = new Date(value);
      if (Number.isNaN(today.getTime())) throw new Error(`run: --today "${value}" is not a date`);
    }
  }

  return { split, today };
}

function loadSet(): ExposureSet {
  const path = fileURLToPath(new URL('./exposures.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ExposureSet;
}

async function main(): Promise<void> {
  // Read once, handed straight to the engine, never logged and never echoed
  // back in an error message.
  const apiKey = process.env['AI_GATEWAY_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    console.error('run: AI_GATEWAY_API_KEY is not set in the environment.');
    console.error('run: this script does not read .env.local. Export the key for the command that runs it.');
    process.exit(1);
  }

  const { split, today } = parseArgs(process.argv.slice(2));
  const set = loadSet();
  const examples = split === 'all' ? set.examples : set.examples.filter((e) => e.split === split);

  if (examples.length === 0) {
    console.error(`run: no examples with split "${split}" in exposures.json`);
    process.exit(1);
  }

  const seedOnly = examples.every((e) => e.source === 'seed');
  const engine = createJevEngine({ apiKey });
  const calibration = IDENTITY_CALIBRATION;

  const modelVersions = new Set<string>();
  const tally = new Map<string, { match: number; miss: number; absent: number }>();
  const bump = (field: string, outcome: Outcome): void => {
    const current = tally.get(field) ?? { match: 0, miss: 0, absent: 0 };
    current[outcome] += 1;
    tally.set(field, current);
  };

  console.log(`split: ${split}   examples: ${examples.length}   calibration: ${calibration.version}`);
  console.log('');

  for (const [i, example] of examples.entries()) {
    const actual: Record<string, unknown> = {};

    const underlying = parseUnderlying(example.text);
    actual['underlying'] = underlying === 'OTHER' || underlying === null ? undefined : underlying;

    if (underlying === 'BTC' || underlying === 'ETH') {
      const deadline = parseDeadline(example.text, today);
      const extraction = await extractExposure(example.text, today, engine);
      modelVersions.add(extraction.modelVersion);

      const isHedge: Answer | undefined = extraction.answers['isHedge'];
      actual['isHedge'] = isHedge?.kind === 'boolean' ? isHedge.probability >= 0.5 : undefined;

      const assembled = assembleExposure(
        example.text,
        extraction,
        deadline,
        underlying,
        0,
        calibration,
      );

      if (assembled.kind === 'exposure') {
        const { exposure } = assembled;
        actual['direction'] = exposure.direction;
        actual['lossUsd'] = exposure.lossUsd.value;
        actual['budgetUsd'] = exposure.budgetUsd?.value;
        actual['levels'] = exposure.levels;

        const selection = await selectShape(exposure, engine, calibration);
        modelVersions.add(selection.modelVersion);
        actual['templateId'] = selection.kind === 'template' ? selection.templateId : undefined;
      }
    }

    const rows: Row[] = [];
    for (const field of SCORED_FIELDS) {
      if (!(field in example.expect)) continue;
      const row = compare(field, example.expect[field], actual[field]);
      bump(field, row.outcome);
      rows.push(row);
    }

    const mark = { match: 'ok  ', miss: 'MISS', absent: 'none' };
    console.log(`[${i + 1}/${examples.length}] ${example.id}  (split: ${example.split}, source: ${example.source})`);
    for (const row of rows) {
      console.log(
        `        ${mark[row.outcome]}  ${row.field.padEnd(11)} got ${row.actual.padEnd(28)} key ${row.expected}`,
      );
    }
    console.log('');
  }

  const versions = [...modelVersions];
  // The version the API actually reported, not the one this repo pinned:
  // a calibration fitted against one version does not transfer to another,
  // and the request's `model` field is a request, not a receipt.
  console.log(`model version(s) the API reported: ${versions.length === 0 ? '(none)' : versions.join(', ')}`);
  console.log('');

  const heading = seedOnly ? 'per-field agreement with the seed key' : 'per-field accuracy';
  console.log(`${heading}:`);
  for (const field of SCORED_FIELDS) {
    const counts = tally.get(field);
    if (counts === undefined) continue;
    const total = counts.match + counts.miss + counts.absent;
    const share = total === 0 ? 0 : Math.round((100 * counts.match) / total);
    console.log(
      `  ${field.padEnd(11)} ${String(counts.match).padStart(2)}/${total}  (${String(share).padStart(3)}%)` +
        `  miss ${counts.miss}, produced nothing ${counts.absent}`,
    );
  }
  console.log('');

  if (seedOnly) {
    console.log('='.repeat(78));
    console.log('SMOKE TEST OF THE FORMAT — NOT A MEASUREMENT.');
    console.log('');
    console.log(`Every one of the ${examples.length} examples loaded is source: "seed": this project wrote`);
    console.log('both the text and the answer key, alongside the prompts being scored. The numbers');
    console.log('above therefore show that the pipeline runs end to end and that the set parses.');
    console.log('They do NOT support any claim about accuracy, and no threshold, temperature or');
    console.log('calibration version may be fitted or justified from them. Percentages above are');
    console.log('agreement with a key this project wrote, i.e. self-consistency.');
    console.log('');
    console.log('To make this a measurement, add examples whose text and key came from somewhere');
    console.log('other than this project, and give them a `source` other than "seed".');
    console.log('='.repeat(78));
  }
}

await main();
