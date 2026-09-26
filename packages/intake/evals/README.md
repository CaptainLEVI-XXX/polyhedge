# Intake evaluation

Run from the repository root:

```sh
node --env-file=.env.local --import tsx packages/intake/evals/run.ts --split all --today 2026-09-20
```

The runner reads `AI_GATEWAY_API_KEY` from its environment. Do not put keys in fixtures or reports.

Compare the sequential and combined interpretation paths:

```sh
node --env-file=.env.local --import tsx packages/intake/evals/paired.ts
```

This uses the existing seed examples plus targeted cases in `paired-cases.json`.
It alternates request order, records API-reported model versions, field mismatches,
fallback call counts and elapsed time in `.polyhedge-store/intake-evaluation/paired.json`.
Errors and new field regressions make the command exit unsuccessfully. Market-fit,
venue calls and UI rendering are excluded. Seed results cannot establish production
accuracy, so the runner never automatically changes the default.

`POLYHEDGE_COMBINED_INTAKE=0` restores the sequential web path. Combined interpretation
is the default after the 14-example regression check, including weather, rates and gold.
These are development examples, not a held-out accuracy estimate. Ambiguous or incompatible batched shape answers use
the existing detailed shape request; extraction, confidence and market-fit gates
are retained. No calibration threshold is changed by this experiment.

On 2026-09-20 the five seed examples agreed with all seven expected fields using the API-reported model `jev-1.13.0`. The crash-protection example selects `threshold_digital`; `tail_only` is available only as an alternative output. This is a smoke check, not an estimate of real-world accuracy. Calibration remains `unfitted`. Keep human-reviewed fit and evaluation data separate before fitting or claiming accuracy.
