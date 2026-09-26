import {
  buildLpModel,
  buildStateSpace,
  cents,
  priceMicros,
  solveLp,
  targetVector,
  type TargetShape,
  type TradableItem,
} from '@polyhedge/core';

/** Node, never Edge: the LP solver is WASM and Edge cannot load it. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Proves the WASM solver actually runs in this runtime.
 *
 * A health check that reports "ok" without solving would pass in exactly the
 * configuration this app most easily gets wrong: `serverExternalPackages`
 * missing from `next.config.ts`, so the bundler inlines the `.wasm` and every
 * real solve fails at request time with nothing readable in the stack.
 *
 * So this runs a genuine solve — two brackets, a digital target, one real
 * `solveLp` call — and reports the shares it came back with. Building the
 * state space and target vector is pure TypeScript and would prove nothing on
 * its own; `solveLp` is the line that touches WASM.
 */
export async function GET() {
  const started = Date.now();

  try {
    const items: TradableItem[] = [
      { key: 'below', bracket: { lo: null, hi: 100 } },
      { key: 'above', bracket: { lo: 100, hi: null } },
    ];
    const shape: TargetShape = {
      templateId: 'threshold_digital',
      payoutUsd: 100,
      direction: 'below',
      k: 100,
    };

    const stateSpace = buildStateSpace(items, [100]);
    const { target } = targetVector(shape, stateSpace);

    // One YES leg per bracket. The payoff matrix is the identity here: each
    // leg pays a dollar in its own state and nothing anywhere else.
    const matrix = stateSpace.evals.map((evalState) =>
      stateSpace.tradable.map((t) => (t.key === evalState.tradableKey ? 1 : 0)),
    );
    const books = stateSpace.tradable.map(() => [
      { priceMicros: priceMicros(500_000), size: 1_000 },
    ]);

    const model = buildLpModel(
      {
        target,
        matrix,
        books,
        feeRates: stateSpace.tradable.map(() => 0),
        mu: 0.001,
        budgetCents: cents(1_000_000),
      },
      { kind: 'minimax' },
    );

    const solution = await solveLp(model, 'health');

    return Response.json({
      ok: true,
      solver: 'wasm loaded and solved',
      states: stateSpace.evals.length,
      objective: solution.objective,
      variables: Object.keys(solution.primal).length,
      tookMs: Date.now() - started,
    });
  } catch (error) {
    // A failure here almost always means the solver could not load. Say so
    // plainly rather than returning a bare 500 — this is the one route whose
    // job is to make that legible.
    return Response.json(
      {
        ok: false,
        hint: 'the LP solver failed to load or solve; check serverExternalPackages',
        error: error instanceof Error ? error.message : String(error),
        tookMs: Date.now() - started,
      },
      { status: 500 },
    );
  }
}
