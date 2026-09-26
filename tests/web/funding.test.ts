import { describe, expect, it } from 'vitest';
import { checkFunding } from '../../apps/web/lib/funding.js';

// Funding is what decides whether an order may be OFFERED. A user who has read
// a quote, agreed to it and pressed the button has already decided — telling
// them then that the money was never there is the worst possible moment, and
// the balance was knowable the whole time.

describe('checkFunding', () => {
  it('refuses before review rather than at submit', () => {
    const short = checkFunding(100_000_000, 0, 60_000); // $100 available, $600 needed
    expect(short.canPlace).toBe(false);
    expect(short.state.kind).toBe('short');
    expect(short.message).toMatch(/\$500\.00 short/);
  });

  it('names pUSD when the wallet is empty, because USDC.e feels like funded', () => {
    const empty = checkFunding(0, 0, 60_000);
    expect(empty.canPlace).toBe(false);
    // Someone holding USDC.e reasonably believes they are funded. The wrap is
    // the step nobody guesses, so the message has to name the token.
    expect(empty.message).toMatch(/pUSD/);
  });

  it('treats an arriving deposit as not yet money', () => {
    const pending = checkFunding(0, 600_000_000, 60_000);
    expect(pending.canPlace).toBe(false);
    expect(pending.state.kind).toBe('pending_deposit');
    expect(pending.message).toMatch(/still arriving/);
  });

  it('allows placing only when the balance actually covers the basket', () => {
    // 60,000 cents is $600, which is 600,000,000 micros.
    expect(checkFunding(600_000_000, 0, 60_000).canPlace).toBe(true);
    // A cent short is short.
    expect(checkFunding(599_990_000, 0, 60_000).canPlace).toBe(false);
  });

  it('says nothing about affordability with no wallet, rather than guessing', () => {
    const none = checkFunding(null, 0, 60_000);
    expect(none.canPlace).toBe(false);
    expect(none.state.kind).toBe('no_wallet');
  });
});
