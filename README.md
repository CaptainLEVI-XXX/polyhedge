# Polyhedge

Polyhedge turns a described exposure into a priced prediction-market hedge. It reports the gap between requested protection and achievable payout, including basis risk. Execution is sequential and can leave a partial position.

This repository contains backend libraries and command-line examples. There is no web UI yet.

## Run locally

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm demo
```

The demo uses the real compiler, execution logic, SQL persistence and settlement accounting with a simulated venue. It prints winning and losing outcomes, needs no credentials and moves no money.

To create the application database tables, set `DATABASE_URL` and run `pnpm db:migrate`. Production storage uses PostgreSQL through `pg`; the offline demo and persistence tests use PGlite.

## Libraries

- `intake`: interprets an exposure, asks follow-up questions and produces quotes with explicit assumptions and alternatives.
- `core` and `engine`: construct and price baskets, compute residual risk, and replay quotes from pinned books.
- `venue` and `questions`: market data and structured model integration.
- `execution`: binds accepted quotes to spend/slippage limits, persists signed orders, reconciles uncertain submissions, and attempts bounded unwinds.
- `settlement`: tracks confirmed resolution, redeems by condition, attributes payouts across baskets, and compares actual protection with the accepted quote.

Tests live under `tests/` and never submit live orders.

## Integration

Keep quote records and their book snapshots on the server. `bindQuote()` binds the accepted record, assumptions and executable legs; the application must separately authenticate the user and record consent. Reuse the same confirmation ID when retrying `execute()`.

Use `PostgresExecutionJournal.listRecoverable()` to resume interrupted executions. Register reconciled holdings with `basketFromExecution()` and `registerBasket()`. Poll resolution with `pollPending()`, recover pending redemptions with `resumeSettlement()`, and expose `basketStatus()`, `redemptionFor()` and `settlementFor()` to the application.

Live integration requires authenticated custody-backed SDK clients, protected credential storage, Builder/Relayer authorization, a Polygon RPC and venue-status monitoring. Contract configuration must match the SDK environment. Live funded execution and redemption have not been validated; the demo is a simulation.

`polymarketEvidence()` verifies finalized fill receipts and reserves collateral conservatively; supply an operational health reader that distinguishes open, post-only and cancel-only modes. `DepositWalletRedemptionTransport` signs with the owner and reuses persisted batches. Ordinary pending submissions use their stored relayer ID; recovery after a lost submission response requires an exact signed-batch lookup. Absence of evidence remains unknown.

The live CTF-v2 adapter rejects quantities that cannot be expressed at the venue's order precision. Such quotes need resizing and renewed confirmation. It never silently rounds away the accepted hedge.

Settlement needs the verified reference price, time and source. Missing observations produce an unknown target rather than an invented price. Split resolutions are accounted for but fall outside the ordinary partition model used for the quoted residual bound.
