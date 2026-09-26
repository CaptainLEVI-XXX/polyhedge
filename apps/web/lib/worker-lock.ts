import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const owned = new Set<string>();
type Owner = { pid: number; token: string };

/** The catalogue is persistent; a process lock must be local to its container.
 * PIDs from a previous container have no meaning in the replacement container.
 * The deployment uses one replica and one attached volume. */
export function workerLockPath(store: string, runtimeDirectory = tmpdir()): string {
  const key = createHash('sha256').update(resolve(store)).digest('hex').slice(0, 24);
  return join(runtimeDirectory, `polyhedge-worker-${key}.lock`);
}

/** Return a release function, or null while a local worker still owns the lock. */
export async function acquireWorkerLock(store: string, runtimeDirectory = tmpdir()): Promise<(() => Promise<void>) | null> {
  const path = workerLockPath(store, runtimeDirectory);
  const owner: Owner = { pid: process.pid, token: randomUUID() };
  const value = JSON.stringify(owner);
  owned.add(owner.token);
  try {
    const file = await open(path, 'wx');
    try { await file.writeFile(value); } finally { await file.close(); }
    return async () => {
      try {
        // An old shutdown must not remove a replacement worker's lock.
        if (await readFile(path, 'utf8') === value) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally { owned.delete(owner.token); }
    };
  } catch (error) {
    owned.delete(owner.token);
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  let previous: string;
  try { previous = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let existing: Owner;
  try { existing = JSON.parse(previous); } catch { return null; } // Another writer may still be creating it.
  if (!existing || !Number.isInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== 'string') return null;
  if (existing.pid === process.pid) {
    if (owned.has(existing.token)) return null;
    // This process has not acquired that token: its PID was reused.
  } else {
    try { process.kill(existing.pid, 0); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null; }
  }
  if (await readFile(path, 'utf8').catch(() => null) === previous) {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return null; // Retry normally, competing through exclusive creation.
}
