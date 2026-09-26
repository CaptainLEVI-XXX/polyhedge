// Provider-agnostic question/answer shapes over TypeSafe's Jev model (or any
// future model behind the same shape). Nothing here talks to the network —
// see jev.ts for the concrete adapter and mock.ts for a test double.

export type Question =
  | { kind: 'choice'; instructions: string; criteria: Record<string, string> }
  | { kind: 'score'; instructions: string; criteria: string[] }
  | { kind: 'boolean'; instructions: string; criteria?: { true: string; false: string } };

export type Answer =
  | { kind: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { kind: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
  | { kind: 'boolean'; probability: number };

export interface AskResult {
  answers: Record<string, Answer>;
  /** Read from the RESPONSE's `model` field — the only trustworthy source of which model answered. */
  modelVersion: string;
}

export interface QuestionEngine {
  ask(state: unknown, questions: Record<string, Question>): Promise<AskResult>;
}
