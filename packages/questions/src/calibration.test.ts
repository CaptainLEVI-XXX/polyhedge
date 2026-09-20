import { describe, expect, it } from 'vitest';
import { calibrate, IDENTITY_CALIBRATION } from './calibration.js';
import type { CalibrationMap } from './calibration.js';
import type { Answer } from './types.js';

describe('calibrate', () => {
  it('T = 1 leaves a choice answer exactly unchanged', () => {
    const answer: Answer = {
      kind: 'choice',
      choice: 'yes',
      probabilities: { yes: 0.7, no: 0.2, maybe: 0.1 },
      confidence: 0.7,
    };

    const result = calibrate(answer, IDENTITY_CALIBRATION);

    expect(result).toBe(answer); // exact identity, not merely an equal copy
    expect(result).toEqual(answer);
  });

  it('T > 1 flattens a choice distribution: max probability and confidence both drop, probabilities still sum to ~1', () => {
    const answer: Answer = {
      kind: 'choice',
      choice: 'yes',
      probabilities: { yes: 0.9, no: 0.06, maybe: 0.04 },
      confidence: 0.9,
    };
    const map: CalibrationMap = { version: 'test', temperature: { choice: 3, score: 1, boolean: 1 } };

    const result = calibrate(answer, map);

    if (result.kind !== 'choice') throw new Error('expected a choice answer');
    const sum = Object.values(result.probabilities).reduce((a, b) => a + b, 0);

    expect(sum).toBeCloseTo(1, 9);
    expect(result.confidence).toBeLessThan(answer.confidence);
    expect(Math.max(...Object.values(result.probabilities))).toBeCloseTo(result.confidence, 9);
    // choice selection is untouched — temperature scaling preserves argmax.
    expect(result.choice).toBe('yes');
  });

  it('T > 1 on a boolean moves its probability toward 0.5 without crossing it', () => {
    const answer: Answer = { kind: 'boolean', probability: 0.95 };
    const map: CalibrationMap = { version: 'test', temperature: { choice: 1, score: 1, boolean: 4 } };

    const result = calibrate(answer, map);

    if (result.kind !== 'boolean') throw new Error('expected a boolean answer');
    expect(result.probability).toBeLessThan(answer.probability);
    expect(result.probability).toBeGreaterThan(0.5);
  });
});
