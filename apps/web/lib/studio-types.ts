import type { QuotedView } from './view-model.js';
export interface BriefField { key: string; label: string; value: string; readOnly?: boolean; status: 'stated' | 'inferred' | 'missing'; }
export interface StudioChoice { value: string; label: string; }
export interface StudioReply {
  kind: 'brief' | 'quoted' | 'help';
  session?: string;
  description?: string;
  brief?: BriefField[];
  message: string;
  question?: { key: string; text: string; choices?: StudioChoice[] };
  ready?: boolean;
  collectAmounts?: boolean;
  unavailable?: string;
  rules?: string[];
  quoteId?: string;
  view?: QuotedView;
}
export interface StudioExample { id: string; label: string; description: string; session: string; }

export const isAmountField=(key:string)=>['lossUsd','coverageUsd','budgetUsd'].includes(key)||key.startsWith('outcome:');
