# Hedge benchmark

Run `pnpm benchmark:hedge` from the repository root. An optional output directory
can follow the command. The default is `.polyhedge-store/benchmarks` (ignored by
Git). Each run replaces `report.json` and `results.csv` in that directory.

This is a deterministic synthetic evaluation, not a historical backtest. It runs
56 cases across nine policies: no hedge, YES-only, the original YES/NO optimizer,
a 50% planning-depth buffer, a higher excess-payout penalty, premium-aware
loss minimization, two experimental market-implied expected-cost policies (full depth and 60% planning depth),
and an execution-constrained policy with at most three legs,
0.01-share increments and a synthetic five-share minimum. Cases cover
digital, range and linear targets, strikes within brackets, three budgets and
three liquidity/cost profiles, including a holding-derived loss layer. YES-only uses the same optimizer with fewer
eligible instruments; it is not an independent algorithm.

The default application policy minimizes worst net loss, then premium. The experimental
`market_expected` policy minimizes market-implied expected net cost at the same worst-loss
bound, then premium in a separate final solve. It is explicitly opt-in. Assumed
state probabilities are recorded with each scenario; the wrong-odds case also has
a separate evaluation distribution. These are synthetic assumptions, not calibrated forecasts.

Compare rows with the same scenario ID. Lower worst uncovered loss means better
target protection; lower worst net loss includes the premium and fees paid.
Net loss is target minus payout plus purchase cost. The report also includes
market-implied net cost and net cost under the separate evaluation distribution. The target is a hypothetical
loss, not a measured holding. Maximum excess payout and active leg count show
unnecessary cover and complexity. No average across these hand-picked cases is
a probability or an estimate of investment performance.

The execution stress removes half of each original ask level. Each leg either
fills fully at or below its quoted limit AND quoted cost, or fails with zero
cost and payout. The per-leg cost cap allows no slippage; it prevents cheaper
depth disappearing from silently causing budget overruns.
Successful legs remain held to settlement, even if another leg fails. This is
an isolated depth-sensitivity experiment, not the production executor: it does
not model sequencing, unwind, latency, gas,
or disagreement between exposure observations and market settlement sources.
Only the execution-constrained policy enforces synthetic minimum sizes and
quantity increments when building its basket; other policies remain continuous.
The depth buffer is fixed in advance; stressed books never reach the optimizer.
The higher penalty changes the secondary objective, not worst-shortfall priority.

`report.json` includes exact synthetic inputs, policies, holdings, assumptions
and failures. Failures make the command exit unsuccessfully and are never counted
as successful hedges. The small test suite checks known cost/payout accounting,
budget comparability, separation of planning and stress inputs, and invalid data.

For a historical evaluation, first obtain and validate timestamped books for
all eligible tokens, as-of market rules/listing status/fees, settlement outcomes,
and a separately defined exposure loss series. Split evaluation chronologically
and by independent events. Sparse quote snapshots support replay but cannot
establish fills between observations. Do not tune on the final held-out events.
