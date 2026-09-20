export type Provenance = 'stated' | 'inferred';

export interface Parsed<T> {
  value: T;
  provenance: Provenance;
  /** The user's own words this came from. Questions to the model quote this back. */
  raw: string;
}

export type LevelRole = 'threshold' | 'range_low' | 'range_high';
export interface NamedLevel { value: number; role: LevelRole }

export interface TypedExposure {
  rawText: string;
  underlying: 'BTC' | 'ETH';
  holdingUsd?: Parsed<number>;
  lossUsd: Parsed<number>;
  budgetUsd?: Parsed<number>;
  hedgeRatio: number;
  levels: NamedLevel[];
  deadline: Parsed<string>;
  followUpsAsked: number;
}
