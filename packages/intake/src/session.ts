import type { TypedExposure } from './types.js';

export interface IntakeSession {
  id: string;
  originalText: string;
  confirmed: Partial<TypedExposure>;
  assumptions: string[];
  pending?: { field: string; question: string };
  followUpsAsked: number;
  /** Which Jev version answered. Recorded because calibration is version-specific. */
  jevModelVersion: string;
  answers: { field: string; answer: string }[];
}

export function newSession(text: string, id: string, jevModelVersion = 'unknown'): IntakeSession {
  return {
    id,
    originalText: text,
    confirmed: {},
    assumptions: [],
    followUpsAsked: 0,
    jevModelVersion,
    answers: [],
  };
}

export function ask(s: IntakeSession, field: string, question: string): IntakeSession {
  return { ...s, pending: { field, question } };
}

export function applyAnswer(s: IntakeSession, answer: string): IntakeSession {
  if (!s.pending) {
    throw new Error('applyAnswer: no pending question to answer');
  }

  const { field } = s.pending;
  const { pending, ...rest } = s;

  return {
    ...rest,
    followUpsAsked: s.followUpsAsked + 1,
    answers: [...s.answers, { field, answer }],
  };
}

export function confirm<K extends keyof TypedExposure>(
  s: IntakeSession,
  field: K,
  value: TypedExposure[K],
): IntakeSession {
  return {
    ...s,
    confirmed: { ...s.confirmed, [field]: value },
  };
}

export function addAssumption(s: IntakeSession, note: string): IntakeSession {
  return { ...s, assumptions: [...s.assumptions, note] };
}
