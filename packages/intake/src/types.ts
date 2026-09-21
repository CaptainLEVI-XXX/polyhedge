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
  /**
   * What the user says they are exposed to, in their own words — `'BTC'`,
   * `'nyc temperature'`, `'fed'`.
   *
   * Was `'BTC' | 'ETH'`, which was a statement about the VENUE (the two
   * series retrieval was hardcoded to) wearing the name of a field about the
   * USER. Retrieval now indexes every numeric ladder family on the venue, so
   * the union was both wrong and load-bearing in the wrong direction. It is a
   * label for provenance and for what the user is asked back: no code
   * branches on its value, and nothing numeric or temporal is derived from it.
   */
  underlying: string;
  holdingUsd?: Parsed<number>;
  lossUsd: Parsed<number>;
  budgetUsd?: Parsed<number>;
  hedgeRatio: number;
  /** Which way the position loses. From the `lossDirection` question, not from level order. */
  direction: 'below' | 'above' | 'outside';
  levels: NamedLevel[];
  deadline: Parsed<string>;
  followUpsAsked: number;
}
