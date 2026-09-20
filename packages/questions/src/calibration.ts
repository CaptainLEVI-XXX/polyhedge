// Per-question-type calibration via temperature scaling on logits.
//
// TypeSafe's own docs describe `confidence` as a dispersion statistic
// computed from the answer's probability distribution — NOT a probability of
// correctness. A confidently wrong answer scores high. TypeSafe publishes no
// calibration procedure, no method, and no dataset-size guidance, and its
// jev-1.13 limitations page says thresholds are not transferable between
// primitive types (`choice`, `score`, `boolean`). Per-type calibration is
// therefore a requirement, not a refinement — hence one temperature per type
// rather than one global temperature.
//
// The transform is textbook temperature scaling: convert probabilities to
// logits, divide by T, re-softmax (or re-sigmoid, for the two-outcome
// boolean case). This is NOT the same as scaling `|p - 0.5|` — that shrinks
// distance from the midpoint without ever touching the probability space
// consistently across more-than-two-outcome distributions, and was wrong in
// an earlier draft of this task.

import type { Answer } from './types.js';

export interface CalibrationMap {
  version: string;
  temperature: { choice: number; score: number; boolean: number };
}

/**
 * Temperature 1 everywhere — an honest "not yet fitted".
 *
 * The seed dataset is too small to establish a calibration curve. Shipping
 * a hand-picked temperature here would imply a fitted value that does not
 * exist; `version: 'unfitted'` makes that explicit instead of pretending.
 */
export const IDENTITY_CALIBRATION: CalibrationMap = {
  version: 'unfitted',
  temperature: { choice: 1, score: 1, boolean: 1 },
};

// Guards against Math.log(0) / Math.log(p / 0) without meaningfully
// perturbing any real answer.
const EPSILON = 1e-9;

/**
 * A malformed CalibrationMap is a configuration error, not routine input —
 * this project's rule is that refusals are loud. T = 0 would divide logits
 * by zero (NaN, which at least fails every downstream threshold); T < 0
 * would flip the sign of every logit and INVERT the distribution while
 * leaving it looking entirely plausible (still sums to 1, still has a
 * "confidence"). Both are worse silent failures than a thrown error naming
 * the bad value, so this is checked before any temperature is used.
 */
function checkTemperature(t: number, kind: string): void {
  if (!Number.isFinite(t) || t <= 0) {
    throw new Error(`calibrate: ${kind} temperature must be a finite number greater than 0, got ${t}`);
  }
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return exps.map((value) => value / sum);
}

/** Temperature-scale a probability distribution and recompute confidence as its new max probability. */
function scaleDistribution(
  probabilities: Record<string, number>,
  temperature: number,
): { probabilities: Record<string, number>; confidence: number } {
  const keys = Object.keys(probabilities);
  const logits = keys.map((key) => Math.log(Math.max(probabilities[key] ?? 0, EPSILON)) / temperature);
  const scaled = softmax(logits);

  const out: Record<string, number> = {};
  let confidence = 0;
  keys.forEach((key, i) => {
    const p = scaled[i] ?? 0;
    out[key] = p;
    if (p > confidence) confidence = p;
  });

  return { probabilities: out, confidence };
}

/** Temperature-scale a single probability (a two-outcome distribution) via logit/sigmoid. */
function scaleProbability(p: number, temperature: number): number {
  const clamped = Math.min(Math.max(p, EPSILON), 1 - EPSILON);
  const logit = Math.log(clamped / (1 - clamped)) / temperature;
  return 1 / (1 + Math.exp(-logit));
}

/**
 * A `score` answer's `score` field is the probability-weighted position
 * over its ordered levels, so once calibration moves the probabilities the
 * old `score` is stale and the two fields disagree. This recomputes it as
 * Σ(level × p_level) against the NEW distribution. Keys of a score answer's
 * `probabilities` are level-number strings; a key that doesn't parse as a
 * number is a malformed answer, not something to skip over quietly.
 */
function weightedScore(probabilities: Record<string, number>): number {
  let total = 0;
  for (const [key, p] of Object.entries(probabilities)) {
    const level = Number(key);
    if (!Number.isFinite(level)) {
      throw new Error(`calibrate: score probability key "${key}" is not a numeric level`);
    }
    total += level * p;
  }
  return total;
}

export function calibrate(answer: Answer, map: CalibrationMap): Answer {
  const temperature = map.temperature[answer.kind];
  checkTemperature(temperature, answer.kind);

  // T === 1 is an exact identity, not an approximation: skip the
  // logit/softmax round trip entirely rather than relying on floating-point
  // math to land back where it started.
  if (temperature === 1) return answer;

  switch (answer.kind) {
    case 'choice': {
      const { probabilities, confidence } = scaleDistribution(answer.probabilities, temperature);
      return { kind: 'choice', choice: answer.choice, probabilities, confidence };
    }
    case 'score': {
      const { probabilities, confidence } = scaleDistribution(answer.probabilities, temperature);
      return { kind: 'score', score: weightedScore(probabilities), probabilities, confidence };
    }
    case 'boolean': {
      return { kind: 'boolean', probability: scaleProbability(answer.probability, temperature) };
    }
  }
}
