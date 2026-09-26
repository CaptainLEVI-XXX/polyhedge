# Polyhedge

Polyhedge turns a described exposure into a priced Polymarket hedge. You describe what could lose you money; it finds a matching event, builds several whole baskets of YES/NO positions from the live order books, and shows what each costs, what it pays and what loss remains. Every figure includes venue fees and is reported against your stated loss, including basis risk.

The web app quotes and live-reprices baskets. Order execution is not live in the UI yet ("Buy cover" is disabled); the execution and settlement libraries exist and are tested against simulated venues.

## Run locally

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm web          # http://localhost:3000
```

`pnpm web` starts Next.js and a catalogue worker that walks every open Polymarket event, indexes the supported ones and refreshes the live examples. The first full walk takes a few minutes; until it completes, searches may answer "discovery is still updating".

Environment (`apps/web/.env.local`):

| Variable | Needed for |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Reading free-text descriptions. Examples and structured edits work without it. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Sign-in. Without it the button reads "Sign-in unavailable" and everything else works. |
| `POLYHEDGE_STORE` | Where quotes, book snapshots and the catalogue are kept. Default `apps/web/.polyhedge-store`. |
| `POLYHEDGE_NUMERIC_HEDGES`, `POLYHEDGE_BINARY_HEDGES`, `POLYHEDGE_CATEGORICAL_HEDGES` | Set to `0` to stop new quotes for that event family. |
| `POLYHEDGE_BUILD_DIR` | Alternative Next.js build directory, so a production build can run beside a dev server. |

After starting the app, `pnpm verify:solver` confirms the WASM LP solver loads in the running server (`HEALTH_URL` overrides the default `http://localhost:3000/api/health`).

## How a hedge is built

1. **State space.** An event's outcomes must tile an axis exactly once (a numeric ladder such as `<66k | 66–68k | … | >70k`) or be a verified categorical/binary partition. Brackets are split at the strike, so a strike inside a bracket is priced exactly rather than guessed.
2. **Target.** Your loss becomes a target payout per state: a digital below/above a level, a range, a linear strip, or an explicit loss per outcome.
3. **Legs.** Every YES and every NO token is a candidate. NO is the neg-risk complement, often the cheaper way to pay in several states at once.
4. **Solve.** A linear program over every ask level of every book (fees included) chooses shares. The web app minimises the worst-case net loss (target − payout + premium) across states; the library also supports "minimise worst shortfall, then cost" and "cheapest basket under a net-loss limit". Quantities are integer multiples of the venue step, above its minimum size.
5. **Options.** The same exposure is solved at your budget, without a budget cap, and at the cheapest basket that captures half the attainable loss reduction, all from one pinned book snapshot so they are directly comparable.
6. **Live.** A shared WebSocket watches every candidate token. When a level the basket consumed moves, or any best ask moves, all options are re-solved against a fresh REST snapshot and streamed to the browser. Accepted quotes are never re-priced.

The web app defaults to worst-case protection, then lowest premium. An experimental opt-in policy uses market-implied probabilities to break ties; these estimates do not guarantee returns.

## Layout

- `apps/web`: Next.js app. `/api/studio` (describe, edit, price), `/api/quote/[id]/stream` (live repricing, SSE), `/api/quote/[id]/history` (24h token prices). `/api/quote/[id]/accept` and `/api/intent/*` are the server side of the upcoming execution flow.
- `packages/core`: state space, target shapes, payoff matrix, book walking, the LP model and residual risk.
- `packages/venue`: Gamma/CLOB clients and schemas, ladder parsing, event eligibility, book snapshots.
- `packages/engine`: `quote()` and `replay()`: resolve an event, fetch books, build and pin a basket.
- `packages/intake` and `packages/questions`: read an exposure from text, ask follow-ups, pick a market and template, build the option set.
- `packages/execution`: binds an accepted quote to spend/slippage limits, persists signed orders, reconciles uncertain submissions and attempts bounded unwinds.
- `packages/settlement`: tracks confirmed resolution, redeems by condition, attributes payouts across baskets and compares actual protection with the accepted quote.
- `examples/`: runnable scripts (see below).
- `tests/`: Vitest suites; none submit live orders.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm demo` | Offline end-to-end simulation: real compiler, execution logic, SQL journal and settlement accounting against a simulated venue. Moves no money. |
| `pnpm benchmark:hedge [dir]` | Synthetic benchmark of hedge policies across 56 scenarios. See `examples/hedge-benchmark/README.md`. |
| `pnpm benchmark:catalogue` | Local search latency over the stored catalogue snapshot. |
| `pnpm db:migrate` | Creates the execution and settlement tables in `DATABASE_URL` (PostgreSQL). |

## Integration

Keep quote records and their book snapshots on the server. `bindQuote()` binds the accepted record, assumptions and executable legs; the application must separately authenticate the user and record consent. Reuse the same confirmation ID when retrying `execute()`.

Use `PostgresExecutionJournal.listRecoverable()` to resume interrupted executions. Register reconciled holdings with `basketFromExecution()` and `registerBasket()`. Poll resolution with `pollPending()`, recover pending redemptions with `resumeSettlement()`, and expose `basketStatus()`, `redemptionFor()` and `settlementFor()` to the application.

Live integration requires authenticated custody-backed SDK clients, protected credential storage, Builder/Relayer authorization, a Polygon RPC and venue-status monitoring. Contract configuration must match the SDK environment. Live funded execution and redemption have not been validated; the demo is a simulation.

`polymarketEvidence()` verifies finalized fill receipts and reserves collateral conservatively; supply an operational health reader that distinguishes open, post-only and cancel-only modes. `DepositWalletRedemptionTransport` signs with the owner and reuses persisted batches. Ordinary pending submissions use their stored relayer ID; recovery after a lost submission response requires an exact signed-batch lookup. Absence of evidence remains unknown.

The live CTF-v2 adapter rejects quantities that cannot be expressed at the venue's order precision. Such quotes need resizing and renewed confirmation. It never silently rounds away the accepted hedge.

Settlement needs the verified reference price, time and source. Missing observations produce an unknown target rather than an invented price. Split resolutions are accounted for but fall outside the ordinary partition model used for the quoted residual bound.
