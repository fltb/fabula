import { randomUUID } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';

export interface FileRepositoryOptions {
  readonly relativeDirectory?: string;
}

export interface StoredRecord<T> {
  readonly version: 1;
  readonly revision: number;
  readonly value: T;
}

export interface JournalRecord {
  readonly version: 1;
  readonly target: string;
  readonly content: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasCode = (error: unknown, code: string): boolean =>
  isObject(error) && 'code' in error && error.code === code;

export const isMissing = (error: unknown): boolean => hasCode(error, 'ENOENT');
const isAlreadyExists = (error: unknown): boolean => hasCode(error, 'EEXIST');

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class RepositoryLockTimeoutError extends Error {
  constructor(directory: string) {
    super(`Timed out waiting for repository write lock: ${directory}`);
    this.name = 'RepositoryLockTimeoutError';
  }
}

export class RepositoryLockViolationError extends Error {
  constructor(directory: string, reason: string) {
    super(`Repository write lock violation in ${directory}: ${reason}`);
    this.name = 'RepositoryLockViolationError';
  }
}

interface LockRecord {
  readonly version: 1;
  readonly token: string;
  readonly acquiredAt: number;
}

const LOCK_WAIT_TIMEOUT_MS = 5_000;
const STALE_LOCK_AGE_MS = 5 * 60_000;

const sleep = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

const parseLockRecord = (raw: string): LockRecord | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isObject(value) ||
      value.version !== 1 ||
      typeof value.token !== 'string' ||
      value.token.length === 0 ||
      typeof value.acquiredAt !== 'number' ||
      !Number.isFinite(value.acquiredAt)
    ) {
      return null;
    }
    return { version: 1, token: value.token, acquiredAt: value.acquiredAt };
  } catch {
    return null;
  }
};

const readLockRecord = async (lock: string): Promise<LockRecord | null> => {
  try {
    return parseLockRecord(await fs.readFile(lock, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

const unlinkOwnedLock = async (lock: string, token: string): Promise<void> => {
  const current = await readLockRecord(lock);
  if (current?.token !== token) return;
  try {
    await fs.unlink(lock);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
};

/**
 * Quarantine only the same observed lock token. A new owner receives a
 * different token and its lock is left intact for its own release path.
 */
const quarantineStaleLock = async (
  lock: string,
  observedToken: string | null,
): Promise<boolean> => {
  const current = await readLockRecord(lock);
  if ((current?.token ?? null) !== observedToken) return false;
  const quarantine = `${lock}.${observedToken ?? 'invalid'}.${randomUUID()}.stale`;
  try {
    await fs.rename(lock, quarantine);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

/**
 * Serializes a complete read/compare/write transaction across processes
 * sharing one repository directory. The directory lock covers the one
 * recovery journal used by `atomicWrite`. A lock older than the bounded
 * mutation lease is quarantined for recovery rather than blocking forever.
 */
export async function withDirectoryLock<T>(
  root: string,
  directory: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  await assertSafeDirectory(root, directory);
  const lock = path.join(directory, '.write.lock');
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  for (;;) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    const owner: LockRecord = { version: 1, token: randomUUID(), acquiredAt: Date.now() };
    try {
      handle = await fs.open(lock, 'wx', 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      let stat: Stats;
      try {
        stat = await fs.lstat(lock);
      } catch (statError) {
        if (isMissing(statError)) continue;
        throw statError;
      }
      if (stat.isSymbolicLink()) {
        throw new RepositoryLockViolationError(directory, 'lock path must not be a symlink');
      }
      if (Date.now() - stat.mtimeMs >= STALE_LOCK_AGE_MS) {
        await quarantineStaleLock(lock, (await readLockRecord(lock))?.token ?? null);
        continue;
      }
      if (Date.now() >= deadline) throw new RepositoryLockTimeoutError(directory);
      await sleep(10);
      continue;
    }

    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      return await operation();
    } finally {
      await handle.close();
      await unlinkOwnedLock(lock, owner.token);
    }
  }
}

export const encodeKey = (parts: readonly string[]): string =>
  Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');

export const contained = (root: string, target: string): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`);

export async function assertSafeParents(root: string, target: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const relative = path.relative(realRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Repository path escapes project root');
  let current = realRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Repository path contains a symlink');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export async function assertSafeDirectory(root: string, directory: string): Promise<void> {
  await assertSafeParents(root, directory);
  const realRoot = await fs.realpath(root);
  const realDirectory = await fs.realpath(directory);
  if (!contained(realRoot, realDirectory))
    throw new Error('Repository directory escapes project root');
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Repository directory is not a directory');
}

export async function recoverJournal(root: string, directory: string): Promise<void> {
  const journal = path.join(directory, '.journal.json');
  try {
    const parsed = JSON.parse(await fs.readFile(journal, 'utf8')) as JournalRecord;
    if (
      parsed.version !== 1 ||
      typeof parsed.target !== 'string' ||
      typeof parsed.content !== 'string'
    )
      throw new Error('Invalid repository journal');
    const target = path.resolve(directory, parsed.target);
    if (!contained(directory, target) || !target.endsWith('.json'))
      throw new Error('Repository journal target escapes directory');
    await assertSafeParents(root, target);
    await fs.writeFile(target, parsed.content, { encoding: 'utf8', mode: 0o600 });
    await fs.unlink(journal);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

export async function atomicWrite(
  root: string,
  directory: string,
  file: string,
  content: string,
): Promise<void> {
  await assertSafeDirectory(root, directory);
  const relative = path.relative(directory, file);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Repository file escapes directory');
  const journal = path.join(directory, '.journal.json');
  await fs.writeFile(
    journal,
    JSON.stringify({ version: 1, target: relative, content } satisfies JournalRecord),
    { encoding: 'utf8', mode: 0o600 },
  );
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
    await fs.unlink(journal);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function prepareDirectory(root: string, directory: string): Promise<void> {
  await assertSafeParents(root, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(root, directory);
}
