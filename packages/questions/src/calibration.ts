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
 * Stage 1 has no labelled data to fit a calibration curve against. Shipping
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

export function calibrate(answer: Answer, map: CalibrationMap): Answer {
  const temperature = map.temperature[answer.kind];

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
      return { kind: 'score', score: answer.score, probabilities, confidence };
    }
    case 'boolean': {
      return { kind: 'boolean', probability: scaleProbability(answer.probability, temperature) };
    }
  }
}
