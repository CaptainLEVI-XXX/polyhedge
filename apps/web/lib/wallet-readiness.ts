import { checkFunding, type FundingCheck } from './funding.js';

/**
 * Everything that must be true before a basket may be offered, in the order a
 * user actually hits it.
 *
 * Each of these is a first-run step with its own failure, and every one of them
 * currently fails at submit time if unchecked — which is the worst place for
 * any of them to fail. Approvals are the least obvious: the CLOB caches
 * allowances, so a wallet that has granted everything can still have its orders
 * rejected until that cache is refreshed per traded token. Nothing about that
 * is visible from the error the venue returns.
 */

export type ReadinessStep =
  | 'connect'
  | 'provision'
  | 'approvals'
  | 'funding'
  | 'ready';

export interface Readiness {
  step: ReadinessStep;
  /** Plain register: what the user does next. */
  message: string;
  /** May an order be offered at all? */
  canPlace: boolean;
  funding: FundingCheck;
}

export interface WalletFacts {
  address: string | null;
  /** A Deposit Wallet exists and is deployed for this owner. */
  provisioned: boolean;
  /** All four approvals granted AND the CLOB allowance cache refreshed. */
  approvalsReady: boolean;
  /** pUSD, net of resting-order reservations. Null when unknown. */
  availableMicros: number | null;
  pendingDepositMicros: number;
}

export function readiness(facts: WalletFacts, neededCents: number): Readiness {
  const funding = checkFunding(facts.availableMicros, facts.pendingDepositMicros, neededCents);

  if (facts.address === null) {
    return {
      step: 'connect',
      message: 'Connect a wallet to see whether this can be placed.',
      canPlace: false,
      funding,
    };
  }

  if (!facts.provisioned) {
    return {
      step: 'provision',
      message: 'A trading wallet has not been set up for this account yet. It is created once.',
      canPlace: false,
      funding,
    };
  }

  if (!facts.approvalsReady) {
    return {
      step: 'approvals',
      message:
        'This wallet has not approved the exchange to move its funds yet. It is a one-time step, ' +
        'and orders are rejected without it.',
      canPlace: false,
      funding,
    };
  }

  if (!funding.canPlace) {
    return { step: 'funding', message: funding.message, canPlace: false, funding };
  }

  return { step: 'ready', message: funding.message, canPlace: true, funding };
}
