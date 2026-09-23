import type { StudioChoice } from './studio-types.js';
/** Illustrative amounts become input only after an explicit user click. */
export function fieldSuggestions(key:string):StudioChoice[] {
  const values=key==='budgetUsd'?[100,500,1000]:key==='lossUsd'||key==='coverageUsd'?[1000,5000,10000]:key.startsWith('outcome:')?[0,1000,5000]:[];
  return values.map(value=>({value:String(value),label:value===0?'No loss':`$${value.toLocaleString('en-US')}`}));
}
