import { beforeEach, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => vi.fn());
vi.mock('../../packages/core/node_modules/highs/build/highs.mjs', () => ({ default: loader }));
const model = { text: 'diagnostic', hash: 'diagnostic', legLevelVars: [] };
const optimal = { Status: 'Optimal', ObjectiveValue: 1, Columns: { x: { Primal: 1 } } };

beforeEach(() => { vi.resetModules(); loader.mockReset(); });

it('discards an aborted runtime so another queued quote can load a healthy solver', async () => {
  const broken = { solve: vi.fn(() => { throw new WebAssembly.RuntimeError('Aborted()'); }) };
  const healthy = { solve: vi.fn(() => optimal) };
  loader.mockResolvedValueOnce(broken).mockResolvedValueOnce(healthy);
  const { solveLp } = await import('../../packages/core/src/lp/solve.js');
  const results = await Promise.allSettled([solveLp(model), solveLp(model)]);
  expect(results[0]!.status).toBe('rejected');
  expect(results[1]).toEqual({ status: 'fulfilled', value: { objective: 1, primal: { x: 1 } } });
  expect(broken.solve).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenCalledTimes(2);
  await expect(solveLp(model)).resolves.toEqual({ objective: 1, primal: { x: 1 } });
  expect(loader).toHaveBeenCalledTimes(2);
});

it('does not permanently cache a failed solver load', async () => {
  loader.mockRejectedValueOnce(new Error('load failed')).mockResolvedValueOnce({ solve: () => optimal });
  const { solveLp } = await import('../../packages/core/src/lp/solve.js');
  await expect(solveLp(model)).rejects.toThrow('load failed');
  await expect(solveLp(model)).resolves.toEqual({ objective: 1, primal: { x: 1 } });
});

it('recovers into the real WASM solver after an injected abort and solves LP and integer models', async () => {
  const actual = await vi.importActual<{ default: () => Promise<unknown> }>('../../packages/core/node_modules/highs/build/highs.mjs');
  loader.mockResolvedValueOnce({ solve: () => { throw new WebAssembly.RuntimeError('Aborted()'); } })
    .mockImplementation(() => actual.default());
  const { solveLp } = await import('../../packages/core/src/lp/solve.js');
  const lp = { ...model, text: 'Minimize\n obj: x\nSubject To\n c: x >= 1.5\nBounds\n x >= 0\nEnd' };
  await expect(solveLp(lp)).rejects.toThrow('Aborted()');
  await expect(solveLp(lp)).resolves.toEqual({ objective: 1.5, primal: { x: 1.5 } });
  const mip = { ...lp, mixedInteger: true, text: lp.text.replace('End', 'Generals\n x\nEnd') };
  await expect(solveLp(mip)).resolves.toEqual({ objective: 2, primal: { x: 2 } });
  expect(loader).toHaveBeenCalledTimes(2);
});

it('rejects a nonoptimal result without discarding a healthy runtime', async () => {
  const solve = vi.fn().mockReturnValueOnce({ Status: 'Infeasible' }).mockReturnValueOnce(optimal);
  loader.mockResolvedValue({ solve });
  const { solveLp } = await import('../../packages/core/src/lp/solve.js');
  await expect(solveLp(model)).rejects.toThrow('Infeasible');
  await expect(solveLp(model)).resolves.toEqual({ objective: 1, primal: { x: 1 } });
  expect(loader).toHaveBeenCalledTimes(1);
});
