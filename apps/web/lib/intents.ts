import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Orders waiting for a browser signature.
 *
 * `execute()` calls `venue.prepare()` and expects a signed envelope back inside
 * that call. With a session key the server holds, that is fine. With the user
 * signing each order it is not: holding an HTTP request open across a wallet
 * prompt is not a recovery design — it dies with the tab, the timeout, or a
 * deploy, and leaves nobody able to say what was actually submitted.
 *
 * So the wait becomes durable. An intent is written down before it is shown,
 * and the rules are deliberately narrow:
 *
 * - **Nothing is submitted before its signature is persisted.** Submission is
 *   the only irreversible step here, so it never happens on state that exists
 *   solely in a request that might not survive.
 * - **Nothing is re-prepared once a signature exists.** Re-preparing would
 *   produce a second signable order for the same leg, and a user who signed
 *   both would have placed the leg twice.
 * - **An expired intent is never signed late.** It is re-prepared at current
 *   prices, because a signature against a stale book is a trade at a price
 *   nobody agreed to.
 */

const ROOT = process.env.POLYHEDGE_STORE ?? join(process.cwd(), '.polyhedge-store');
const INTENTS = join(ROOT, 'intents');

/** Long enough to read and approve a wallet prompt; short enough that the book has not moved under it. */
export const INTENT_TTL_MS = 90_000;

export type IntentStatus = 'awaiting_signature' | 'signed' | 'submitted' | 'declined' | 'expired';

export interface OrderIntent {
  id: string;
  executionId: string;
  owner: string;
  /** Which wallet this was prepared for. A different wallet may not sign it. */
  wallet: string;
  /** Which leg of the basket, so a resume knows what is still unsigned. */
  legIndex: number;
  /** The exact thing to sign, opaque here and meaningful to the venue adapter. */
  payload: unknown;
  status: IntentStatus;
  signature: string | null;
  createdAt: string;
  expiresAt: string;
}

export class IntentProblem extends Error {
  readonly code:
    | 'not_found'
    | 'expired'
    | 'already_signed'
    | 'wrong_wallet'
    | 'declined'
    | 'not_signable';
  constructor(code: IntentProblem['code'], message: string) {
    super(message);
    this.name = 'IntentProblem';
    this.code = code;
  }
}

async function pathFor(id: string): Promise<string> {
  await mkdir(INTENTS, { recursive: true });
  return join(INTENTS, `${id}.json`);
}

async function write(intent: OrderIntent): Promise<OrderIntent> {
  await writeFile(await pathFor(intent.id), JSON.stringify(intent), 'utf8');
  return intent;
}

export async function prepareIntent(args: {
  executionId: string;
  owner: string;
  wallet: string;
  legIndex: number;
  payload: unknown;
  now?: Date;
}): Promise<OrderIntent> {
  const now = args.now ?? new Date();
  return write({
    id: randomUUID(),
    executionId: args.executionId,
    owner: args.owner,
    wallet: args.wallet.toLowerCase(),
    legIndex: args.legIndex,
    payload: args.payload,
    status: 'awaiting_signature',
    signature: null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INTENT_TTL_MS).toISOString(),
  });
}

export async function getIntent(id: string, owner: string): Promise<OrderIntent> {
  let text: string;
  try {
    text = await readFile(await pathFor(id), 'utf8');
  } catch {
    throw new IntentProblem('not_found', 'no such order to sign');
  }
  const intent = JSON.parse(text) as OrderIntent;
  // A missing intent and someone else's intent fail identically, so an id
  // cannot be probed for existence.
  if (intent.owner !== owner) throw new IntentProblem('not_found', 'no such order to sign');
  return intent;
}

/**
 * Accepts a signature for one intent, or explains precisely why not.
 *
 * Idempotent on a repeat of the SAME signature: a retry after a dropped
 * response is one decision, and must not become two orders. A DIFFERENT
 * signature for an already-signed intent is refused rather than overwritten —
 * whichever it is, one of them was not what the user saw.
 */
export async function signIntent(
  id: string,
  owner: string,
  wallet: string,
  signature: string,
  now: Date = new Date(),
): Promise<OrderIntent> {
  const intent = await getIntent(id, owner);

  if (intent.status === 'declined') {
    throw new IntentProblem('declined', 'this order was declined and will not be placed');
  }

  if (intent.status === 'signed' || intent.status === 'submitted') {
    if (intent.signature === signature) return intent;
    throw new IntentProblem('already_signed', 'this order already has a different signature');
  }

  if (wallet.toLowerCase() !== intent.wallet) {
    // A wallet swap mid-basket is not a resume: the remaining legs were priced
    // and reserved against the first wallet's balance.
    throw new IntentProblem('wrong_wallet', 'this order was prepared for a different wallet');
  }

  if (now.getTime() > Date.parse(intent.expiresAt)) {
    await write({ ...intent, status: 'expired' });
    throw new IntentProblem('expired', 'this order expired; it will be re-priced before you sign');
  }

  return write({ ...intent, status: 'signed', signature });
}

/** Marks the user's refusal, so the basket stops rather than retrying forever. */
export async function declineIntent(id: string, owner: string): Promise<OrderIntent> {
  const intent = await getIntent(id, owner);
  if (intent.status === 'signed' || intent.status === 'submitted') {
    throw new IntentProblem('already_signed', 'this order was already signed');
  }
  return write({ ...intent, status: 'declined' });
}

/**
 * Only a persisted signature may be submitted. This is the guard that keeps
 * the irreversible step from running on state that might not survive.
 */
export async function markSubmitted(id: string, owner: string): Promise<OrderIntent> {
  const intent = await getIntent(id, owner);
  if (intent.status !== 'signed') {
    throw new IntentProblem('not_signable', 'nothing may be submitted before its signature is stored');
  }
  return write({ ...intent, status: 'submitted' });
}
