/**
 * Whether a wallet can pay for a basket, asked before anything is offered.
 *
 * This is the largest hole the design pass left. Collateral is **pUSD**, not
 * USDC.e — USDC.e is a deposit input that gets wrapped — so a new user holds
 * zero of the thing orders are priced in and cannot place a first order at all,
 * however good the rest of the product is.
 *
 * The rule here is that a shortfall is found BEFORE review, never at submit. A
 * user who has read a quote, agreed to it and pressed the button has already
 * decided; telling them at that point that the money was never there is the
 * worst possible moment, and it is entirely avoidable — the balance is knowable
 * the moment a wallet is known.
 */

export type FundingState =
  | { kind: 'no_wallet' }
  | { kind: 'ready'; availableUsd: number }
  | { kind: 'empty'; availableUsd: 0 }
  | { kind: 'short'; availableUsd: number; neededUsd: number }
  | { kind: 'pending_deposit'; availableUsd: number; pendingUsd: number }
  | { kind: 'unknown'; reason: string };

export interface FundingCheck {
  state: FundingState;
  /** Plain register. What the user does next, if anything. */
  message: string;
  /** May an order be offered at all? */
  canPlace: boolean;
}

const USD = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/**
 * Turns a balance and a cost into something a user can act on.
 *
 * `availableMicros` is expected to be NET of resting-order reservations —
 * `evidence.availableCashMicros` does that work, paginating open orders and
 * unsettled trades, because a resting order holds collateral before it fills.
 * Sizing against a gross balance is how a basket gets rejected on leg four for
 * money its own earlier legs reserved.
 */
export function checkFunding(
  availableMicros: number | null,
  pendingDepositMicros: number,
  neededCents: number,
): FundingCheck {
  if (availableMicros === null) {
    return {
      state: { kind: 'no_wallet' },
      message: 'Connect a wallet to see whether this can be paid for.',
      canPlace: false,
    };
  }

  const availableUsd = availableMicros / 1_000_000;
  const neededUsd = Math.ceil(neededCents) / 100;
  const pendingUsd = pendingDepositMicros / 1_000_000;

  if (availableUsd >= neededUsd) {
    return {
      state: { kind: 'ready', availableUsd },
      message: `${USD(availableUsd)} available.`,
      canPlace: true,
    };
  }

  if (availableUsd <= 0 && pendingUsd > 0) {
    return {
      state: { kind: 'pending_deposit', availableUsd, pendingUsd },
      message: `${USD(pendingUsd)} is still arriving. Nothing can be placed until it lands.`,
      canPlace: false,
    };
  }

  if (availableUsd <= 0) {
    return {
      state: { kind: 'empty', availableUsd: 0 },
      // Naming the token matters: someone holding USDC.e reasonably believes
      // they are funded, and the wrap is the step nobody guesses.
      message:
        'This wallet holds no pUSD, which is what orders settle in. Deposit and wrap before placing anything.',
      canPlace: false,
    };
  }

  return {
    state: { kind: 'short', availableUsd, neededUsd },
    message: `${USD(availableUsd)} available, ${USD(neededUsd - availableUsd)} short of this basket.`,
    canPlace: false,
  };
}
