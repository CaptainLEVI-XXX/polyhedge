import type { Answer, Question, QuestionEngine } from '@polyhedge/questions';
import { holdingLoss } from './studio-input.js';
import { setField, type StudioDraft } from './studio-draft.js';

export interface HoldingCandidate { quantity: number; coin: string }
export interface HoldingReading { candidates: HoldingCandidate[]; answers: Record<string, Answer> }
const COIN = '(?:btc|bitcoin|eth|ether|ethereum|sol|solana|xrp|doge|dogecoin)';

/** Only proposes explicitly written quantities; it does not decide whether they are holdings. */
export function holdingCandidates(text: string): HoldingCandidate[] {
  const candidates: HoldingCandidate[] = [];
  for (const match of text.matchAll(new RegExp(`(?<![\\w$.,-])((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)\\s*(${COIN})\\b`, 'gi'))) {
    const quantity = Number(match[1]!.replace(/,/g, ''));
    const coin = match[2]!.toUpperCase();
    if (quantity > 0 && Number.isFinite(quantity) && !candidates.some(c => c.coin === coin && c.quantity === quantity)) candidates.push({ quantity, coin });
  }
  return candidates.slice(0, 16);
}
function confident(answers: Record<string, Answer>, id: string): string | undefined {
  const a = answers[id];
  return a?.kind === 'choice' && Number.isFinite(a.confidence) && a.confidence >= .8 ? a.choice : undefined;
}

/** Add semantic choices to the existing extraction request, never a separate call. */
export function withHoldingQuestions(engine: QuestionEngine, save: (reading: HoldingReading) => void): QuestionEngine {
  return { async ask(state, questions) {
    const candidates = typeof state === 'string' && 'lossDirection' in questions ? holdingCandidates(state) : [];
    if (!candidates.length) return engine.ask(state, questions);
    const extra: Record<string, Question> = {
      holdingQuantity: { kind: 'choice', instructions: 'Which explicitly stated coin quantity is an EXISTING holding or short position whose loss the user wants to hedge? Respect negation. A hypothetical purchase, sold holding, price, or someone else’s position is not an existing holding. Choose unclear for multiple relevant positions or ambiguity.', criteria: {
        ...Object.fromEntries(candidates.map((c, i) => [`h${i}`, `${c.quantity} ${c.coin} is the existing position being hedged.`])),
        none: 'No existing coin position is being hedged.', unclear: 'The existing position or its quantity is unclear.',
      } },
      holdingMeaning: { kind: 'choice', instructions: 'For the stated one-level price trigger and dollar loss, what payout/loss shape does the user explicitly mean? Do not assume that “lose $X below $K” means a gradual loss reaching $X at $K. Prefer an explicit fixed payout request over inferred holding economics.', criteria: {
        starts: 'Gradual holding loss begins at zero at the named price and grows with adverse price movement, capped at the stated dollar amount.',
        reaches: 'Gradual holding loss reaches the stated dollar amount at the named price.',
        fixed: 'The user explicitly wants a fixed all-or-nothing dollar payout when the named price condition holds.',
        unclear: 'The text does not distinguish these meanings, or gives multiple price endpoints.',
      } },
    };
    const result = await engine.ask(state, { ...questions, ...extra });
    save({ candidates, answers: result.answers });
    return result;
  } };
}

function meaningQuestion(d: StudioDraft) {
  const shape = d.request!.shape;
  if (shape.templateId !== 'threshold_digital' && shape.templateId !== 'tail_only') return;
  d.pending = { key: 'holdingMeaning', text: `At the price ${shape.k.toLocaleString('en-US')}, how should the $${shape.payoutUsd.toLocaleString('en-US')} protection work?`, choices: [
    { value: 'starts', label: 'Loss starts here and grows as the price moves further' },
    { value: 'reaches', label: 'My loss reaches this dollar amount here' },
    { value: 'fixed', label: 'Pay the fixed amount when the condition holds' },
  ] };
}
export function applyHoldingMeaning(d: StudioDraft, meaning: string, confirmed = false) {
  const shape = d.request?.shape, holding = d.holdingInterpretation?.selected;
  if (!shape || !holding || !['threshold_digital', 'tail_only'].includes(shape.templateId)) throw Error('bad_request: no pending holding interpretation');
  if (!['starts', 'reaches', 'fixed'].includes(meaning)) {
    meaningQuestion(d);
    return;
  }
  if (shape.templateId !== 'threshold_digital' && shape.templateId !== 'tail_only') return;
  if (meaning !== 'fixed') {
    const end = meaning === 'starts' ? shape.k + (shape.direction === 'below' ? -1 : 1) * shape.payoutUsd / holding.quantity : shape.k;
    if (end < 0) throw Error('bad_request: this holding cannot reach the stated loss before a zero price; reduce the loss or clarify the trigger');
    const converted = holdingLoss(holding, shape.direction, end, shape.payoutUsd);
    d.request!.shape = converted.shape;
    setField(d, 'trigger', converted.trigger, confirmed ? 'stated' : 'inferred');
  }
  delete d.holdingInterpretation;
  delete d.pending;
}
export function selectHolding(d: StudioDraft, value: string) {
  if (value === 'none') { delete d.holdingInterpretation; delete d.pending; return; }
  const i = /^h(\d+)$/.exec(value)?.[1];
  const selected = i === undefined ? undefined : d.holdingInterpretation?.candidates[Number(i)];
  if (!selected) throw Error('bad_request: choose a listed holding or no coin holding');
  d.holdingInterpretation!.selected = selected;
  meaningQuestion(d);
}
export function interpretHolding(d: StudioDraft, eventTitle: string, reading: HoldingReading | undefined) {
  const shape = d.request?.shape;
  if (!reading || !shape || !['threshold_digital', 'tail_only'].includes(shape.templateId)) return;
  const aliases: Record<string, string> = { BTC: 'bitcoin', BITCOIN: 'btc', ETH: 'ethereum|ether', ETHER: 'eth|ethereum', ETHEREUM: 'eth|ether', SOL: 'solana', SOLANA: 'sol', DOGE: 'dogecoin', DOGECOIN: 'doge' };
  const matches = (c: HoldingCandidate) => new RegExp(`\\b(${c.coin}|${aliases[c.coin] ?? c.coin})\\b`, 'i').test(eventTitle);
  if (!reading.candidates.some(matches)) return;
  const answer = confident(reading.answers, 'holdingQuantity');
  if (answer === 'none') return;
  // Preserve candidate indices from the model request; only matching assets may be selected.
  const candidates = reading.candidates;
  const id = answer ? /^h(\d+)$/.exec(answer)?.[1] : undefined;
  const selected = id === undefined ? undefined : candidates[Number(id)];
  d.holdingInterpretation = { candidates: candidates.filter(matches) };
  if (!selected || !matches(selected)) {
    d.pending = { key: 'holdingQuantity', text: 'Which existing coin position are you protecting?', choices: [
      ...d.holdingInterpretation.candidates.map((c, i) => ({ value: `h${i}`, label: `${c.quantity} ${c.coin}` })),
      { value: 'none', label: 'This is not a coin holding' },
    ] };
    return;
  }
  d.holdingInterpretation.selected = selected;
  const meaning = confident(reading.answers, 'holdingMeaning');
  if (!meaning || !['starts', 'reaches', 'fixed'].includes(meaning)) meaningQuestion(d);
  else applyHoldingMeaning(d, meaning);
}
