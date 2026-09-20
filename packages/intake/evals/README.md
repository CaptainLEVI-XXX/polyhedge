# Intake evaluation

Run from the repository root:

```sh
node --env-file=.env.local --import tsx packages/intake/evals/run.ts --split all --today 2026-09-20
```

The runner reads `AI_GATEWAY_API_KEY` from its environment. Do not put keys in fixtures or reports.

On 2026-09-20 the five seed examples agreed with all seven expected fields using the API-reported model `jev-1.13.0`. The crash-protection example selects `threshold_digital`; `tail_only` is available only as an alternative output. This is a smoke check, not an estimate of real-world accuracy. Calibration remains `unfitted`. Keep human-reviewed fit and evaluation data separate before fitting or claiming accuracy.
