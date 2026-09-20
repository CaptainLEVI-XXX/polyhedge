// Answer-aware routing: decide whether to proceed, ask a follow-up, or
// decline, based on whether each field's answer is the one we actually need
// — not on how far the underlying probability sits from 0.5.
//
// A probability of 0.01 is confident (it's a peaked distribution, far from
// uniform), but confidence alone can't tell you whether that's good news or
// bad news: `isHedge = 0.01` means "definitely NOT a hedge" (decline it if
// the policy requires `true`), while `edgeCaseRisk = 0.01` means "definitely
// safe" (proceed, if the policy requires `false`). Routing on distance from
// 0.5 collapses that distinction; routing on the required answer preserves
// it.

import type { Answer } from './types.js';

export interface FieldPolicy {
  /** Which answer lets us proceed. */
  required: 'true' | 'false' | 'any';
  onFail: 'decline' | 'follow_up' | 'flag';
  /** Minimum calibrated certainty needed to act on the answer. */
  threshold: number;
}

export type Route =
  | { kind: 'proceed'; flags: string[] }
  | { kind: 'follow_up'; field: string }
  | { kind: 'decline'; field: string; reason: string };

interface Evaluation {
  /** How far past the required threshold the answer sits; negative means it fails the policy. */
  margin: number;
}

/**
 * Evaluate an answer against its field policy. `margin >= 0` means the
 * policy is satisfied; `margin < 0` means it failed, and its magnitude is
 * how far short it fell (used to pick the weakest field among follow-up
 * candidates).
 */
function evaluate(field: string, answer: Answer, policy: FieldPolicy): Evaluation {
  if (answer.kind === 'boolean') {
    const p = answer.probability;
    if (policy.required === 'true') {
      return { margin: p - policy.threshold };
    }
    if (policy.required === 'false') {
      return { margin: 1 - p - policy.threshold };
    }
    // 'any': confident in either direction is enough.
    return { margin: Math.max(p, 1 - p) - policy.threshold };
  }

  // choice / score have no true/false direction — only 'any' is meaningful.
  // required:'true'/'false' against a non-boolean answer is a configuration
  // mistake (it silently behaves like 'any' with no signal that anything is
  // wrong), so it's rejected loudly instead.
  if (policy.required !== 'any') {
    throw new Error(
      `route: field "${field}" has required:'${policy.required}' but its answer kind is '${answer.kind}' — only 'any' is valid for choice/score answers`,
    );
  }

  return { margin: answer.confidence - policy.threshold };
}

function describeRequirement(policy: FieldPolicy): string {
  if (policy.required === 'any') return `confidence >= ${policy.threshold}`;
  return `P(${policy.required}) >= ${policy.threshold}`;
}

export function route(
  answers: Record<string, Answer>,
  policies: Record<string, FieldPolicy>,
  followUpsAsked: number,
  maxFollowUps = 2,
): Route {
  const flags: string[] = [];
  const declines: Array<{ field: string; reason: string }> = [];
  const followUpCandidates: Array<{ field: string; margin: number }> = [];

  // Evaluate every field before deciding anything, so that (a) a decline can
  // be found regardless of where it falls in iteration order and (b) the
  // weakest follow-up candidate can be chosen once all margins are known.
  for (const [field, policy] of Object.entries(policies)) {
    const answer = answers[field];
    if (answer === undefined) {
      declines.push({ field, reason: `no answer for required field "${field}"` });
      continue;
    }

    const { margin } = evaluate(field, answer, policy);
    if (margin >= 0) continue;

    if (policy.onFail === 'decline') {
      declines.push({
        field,
        reason: `"${field}" needs ${describeRequirement(policy)}, short by ${Math.abs(margin).toFixed(4)}`,
      });
    } else if (policy.onFail === 'flag') {
      flags.push(field);
    } else {
      followUpCandidates.push({ field, margin });
    }
  }

  // A decline outcome wins over a follow-up: if anything failed a `decline`
  // policy, no follow-up ever gets asked for it.
  if (declines.length > 0) {
    const first = declines[0]!;
    return { kind: 'decline', field: first.field, reason: first.reason };
  }

  if (followUpCandidates.length > 0) {
    let weakest = followUpCandidates[0]!;
    for (const candidate of followUpCandidates) {
      if (candidate.margin < weakest.margin) weakest = candidate;
    }

    if (followUpsAsked >= maxFollowUps) {
      return {
        kind: 'decline',
        field: weakest.field,
        reason: `follow-up cap reached (${followUpsAsked}/${maxFollowUps}) for "${weakest.field}"`,
      };
    }

    return { kind: 'follow_up', field: weakest.field };
  }

  return { kind: 'proceed', flags };
}
