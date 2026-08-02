import { MessageChannel } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { start } from '../../src/persistence/worker.js';
import { PersistenceWorkerClient } from '../../src/persistence/worker-client.js';

/**
 * Temp directories created by harnesses that were not handed an explicit
 * database path. They are removed exactly once, after the test file finishes,
 * so a restart harness created against the same path can still reopen the
 * database file (dispose must never unlink a path a restart is about to use).
 */
const ownedTempDirs = new Set<string>();

afterAll(() => {
  for (const dir of ownedTempDirs) rmSync(dir, { recursive: true, force: true });
  ownedTempDirs.clear();
});

export interface RealPersistenceHarness {
  client: PersistenceWorkerClient;
  databasePath: string;
  dispose(): Promise<void>;
}

/**
 * Boots the real persistence worker module (real `DatabaseSync`, real
 * migrations on a real SQLite file) over a real `MessageChannel`, and returns
 * an async domain client for it. The worker module itself is the only owner of
 * the database handle; the client side never touches the driver.
 *
 * Calling it without an argument creates an isolated temporary database
 * directory that is deterministically removed when the test file finishes.
 * Passing an existing `databasePath` reopens that same database file, which is
 * how the restart tests recover persisted state.
 */
export function createRealPersistence(databasePath?: string): RealPersistenceHarness {
  let tempDir: string | undefined;
  const resolvedPath = databasePath ?? (() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fabula-workbench-test-'));
    ownedTempDirs.add(tempDir);
    return join(tempDir, 'workbench.sqlite');
  })();
  const { port1, port2 } = new MessageChannel();
  const disposeWorker = start(port1, { databasePath: resolvedPath });
  const client = new PersistenceWorkerClient(port2);
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      client.dispose();
      await disposeWorker.dispose();
      port1.close();
      port2.close();
    })();
    return disposePromise;
  };
  return {
    client,
    databasePath: resolvedPath,
    // Cleans up the real worker module instance and both channel ends. The
    // worker's own disposer runs first, before the ports close: it detaches
    // the worker message listener, drains queued work, and closes the
    // DatabaseSync/Kysely handles exactly once, so a restart harness created
    // against the same path can genuinely reopen the database file. The
    // database file is deliberately NOT unlinked here: a restart harness is
    // created against the same path after dispose, so the file (and its temp
    // directory) must survive until the file-scoped afterAll cleanup above.
    dispose,
  };
}
