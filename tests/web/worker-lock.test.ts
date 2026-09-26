import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkerLock, workerLockPath } from '../../apps/web/lib/worker-lock.js';

const folders: string[] = [];
afterEach(async () => { for (const p of folders.splice(0)) await rm(p, { recursive: true, force: true }); });
async function directory() { const p = await mkdtemp(join(tmpdir(), 'polyhedge-lock-test-')); folders.push(p); return p; }

it('ignores the legacy persistent PID lock after a container redeploy', async () => {
  const store = await directory(), runtime = await directory();
  await writeFile(join(store, 'catalogue-worker.lock'), String(process.pid));
  const release = await acquireWorkerLock(store, runtime);
  expect(release).not.toBeNull();
  expect(workerLockPath(store, runtime).startsWith(runtime)).toBe(true);
  expect(await acquireWorkerLock(store, runtime)).toBeNull();
  await release!();
  const next = await acquireWorkerLock(store, runtime);
  expect(next).not.toBeNull();
  await next!();
});

it('recovers a stale local lock whose PID is reused by the new worker', async () => {
  const runtime = await directory(), store = '/data/polyhedge';
  await writeFile(workerLockPath(store, runtime), JSON.stringify({ pid: process.pid, token: 'previous-process' }));
  expect(await acquireWorkerLock(store, runtime)).toBeNull();
  const release = await acquireWorkerLock(store, runtime);
  expect(release).not.toBeNull();
  await release!();
});

it('does not delete a replacement lock when the previous owner shuts down', async () => {
  const runtime = await directory(), store = '/data/polyhedge';
  const release = await acquireWorkerLock(store, runtime);
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
  await writeFile(workerLockPath(store, runtime), replacement);
  await release!();
  expect(await readFile(workerLockPath(store, runtime), 'utf8')).toBe(replacement);
});
