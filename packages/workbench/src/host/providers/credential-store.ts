/**
 * Host-only provider credential boundary.
 *
 * Provider API credentials are owned exclusively by the Workbench Host: they
 * are stored per provider, restricted to the owning OS user, and never cross
 * browser contracts, Yjs documents, MCP tools, or Git commits. This module is
 * never imported by client code, and `src/contracts/index.ts` deliberately
 * does not re-export any of its types.
 *
 * Storage is pluggable. Host construction injects an OS credential adapter
 * (Keychain / Secret Service / DPAPI) when one is available; otherwise the
 * concrete XDG file fallback persists credentials in a single JSON document
 * per config directory (`<configDir>/fabula/providers.json`). Every operation
 * is an exclusive critical section guarded by a cross-process lock file
 * (`providers.json.lock`, created with O_EXCL), so concurrent Host processes
 * cannot interleave a read-modify-write and lose entries. Mutations are
 * written via unique temp file + fsync + rename (atomic on the same
 * filesystem), the config directory is locked to 0700 and the credential file
 * to 0600, and provider ids are validated against a fixed pattern so a key
 * can never address an arbitrary path or smuggle JSON structure. Stale temp
 * and lock files from crashed writers are detected and recovered, so a crash
 * never corrupts the committed document.
 *
 * Error invariant: `CredentialStoreError` messages never contain credential
 * values. A `cause` is attached only for filesystem failures, whose messages
 * (path/syscall/errno) cannot echo file contents; parse failures and injected
 * adapter failures surface with static messages only.
 */
import { randomBytes } from 'node:crypto';
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Fabula config sub-directory under the resolved config base directory. */
const FABULA_CONFIG_SUBDIR = 'fabula';
/** Credential document file name inside the Fabula config sub-directory. */
const CREDENTIALS_FILE_NAME = 'providers.json';
/** A lock older than this is considered abandoned and is stolen. */
const DEFAULT_LOCK_STALE_MS = 10_000;
/** Poll interval while waiting for a held lock. */
const DEFAULT_LOCK_RETRY_MS = 10;
/** Fail after waiting this long for a held lock. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** Locks opened by this process but whose payload may not be visible yet. */
const IN_PROCESS_LOCKS = new Set<string>();

/** Minimal host-only credential surface shared by OS and file backends. */
export interface ProviderCredentialStore {
  /** Store (or replace) the credential for a provider. */
  set(providerId: string, secret: string): Promise<void>;
  /** Return the stored credential, or `null` when none exists. */
  get(providerId: string): Promise<string | null>;
  /** Remove any stored credential for a provider; succeeds when none exists. */
  remove(providerId: string): Promise<void>;
}

/**
 * Injectable OS credential adapter (Keychain / Secret Service / DPAPI) with
 * the same surface as {@link ProviderCredentialStore}. The Host supplies a
 * concrete implementation wired to the platform secret service; the XDG file
 * store is the fallback when no adapter is injected.
 */
export interface OsCredentialStore extends ProviderCredentialStore {
  /** Human-readable backend name for host diagnostics (never a secret). */
  readonly label: string;
}

/**
 * Allowed provider credential key: a lowercase ASCII letter followed by up to
 * 62 lowercase letters, digits, or hyphens, optionally prefixed by the
 * profile-scoped AI-SDK form `ai-sdk:<profileId>` (the `<profileId>` part
 * follows the same rules). Covers known providers (`openai`, `anthropic`,
 * `deepseek`, `openrouter`, ...), the legacy bare `ai-sdk` key, and
 * profile-scoped keys such as `ai-sdk:default`, without a hardcoded
 * allowlist that would go stale.
 */
export const PROVIDER_ID_PATTERN = /^(?:ai-sdk:)?[a-z][a-z0-9-]{0,62}$/;

/** Default provider profile bound by every legacy (V1/V2) project. */
export const DEFAULT_PROVIDER_PROFILE = 'default' as const;

/** Legacy bare credential key used by V1/V2 Hosts before profile-scoped keys. */
export const LEGACY_AI_SDK_CREDENTIAL_KEY = 'ai-sdk' as const;

/** Canonical credential key for the AI-SDK provider under one profile. */
export function providerCredentialKey(profileId: string): string {
  return `ai-sdk:${profileId}`;
}

export function isValidProviderId(providerId: string): boolean {
  return PROVIDER_ID_PATTERN.test(providerId);
}

export function assertValidProviderId(providerId: string): void {
  if (!isValidProviderId(providerId)) {
    throw new CredentialStoreError(
      'INVALID_PROVIDER_ID',
      `Invalid provider id; expected ${PROVIDER_ID_PATTERN}.`,
    );
  }
}

export type CredentialStoreErrorCode =
  | 'INVALID_PROVIDER_ID'
  | 'UNRESOLVED_XDG_CONFIG_DIR'
  | 'CORRUPT_CREDENTIAL_FILE'
  | 'CREDENTIAL_IO_ERROR'
  | 'OS_CREDENTIAL_STORE_ERROR';

/**
 * Typed credential-store failure. The message never contains a credential
 * value; it may name a validated provider id or the credential file path.
 */
export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

/** Environment inputs used to resolve the XDG config directory. */
export interface XdgConfigEnv {
  XDG_CONFIG_HOME?: string;
  HOME?: string;
}

/**
 * Resolve the XDG config directory: `XDG_CONFIG_HOME` when set, otherwise
 * `$HOME/.config`. Fails closed (typed error) when neither is available.
 */
export function resolveXdgConfigDir(env: XdgConfigEnv = process.env): string {
  const explicit = env.XDG_CONFIG_HOME;
  if (explicit !== undefined && explicit !== '') return explicit;
  const home = env.HOME;
  if (home === undefined || home === '') {
    throw new CredentialStoreError(
      'UNRESOLVED_XDG_CONFIG_DIR',
      'Cannot resolve the XDG config directory: neither XDG_CONFIG_HOME nor HOME is set.',
    );
  }
  return join(home, '.config');
}

export interface XdgCredentialFileStoreOptions {
  /** Config base directory; defaults to the resolved XDG config directory. */
  configDir?: string;
  /** Environment used only when `configDir` is absent. */
  env?: XdgConfigEnv;
  /** A lock older than this is considered abandoned and is stolen. Default 10_000 ms. */
  lockStaleMs?: number;
  /** Poll interval while waiting for a held lock. Default 10 ms. */
  lockRetryMs?: number;
  /** Fail with `CREDENTIAL_IO_ERROR` after waiting this long for a held lock. Default 5_000 ms. */
  lockTimeoutMs?: number;
}

/**
 * Restricted XDG file fallback for provider credentials. One JSON document per
 * config directory maps validated provider ids to secrets. Every operation
 * runs under a cross-process exclusive lock (the `providers.json.lock` file,
 * created with O_EXCL next to the document), so a read-modify-write from one
 * store instance or Host process can never interleave with another and lose
 * entries. Each mutation is atomic: read the committed file, apply the change
 * in memory, then write a 0600 temp file, fsync it, and rename it over the
 * target (atomic on the same filesystem). The config directory is created and
 * locked to 0700. Provider ids are validated before use and are never
 * interpolated into file paths, so the credential document cannot be
 * redirected or polluted.
 */
export class XdgCredentialFileStore implements ProviderCredentialStore {
  /** Absolute path of the credential document. */
  readonly filePath: string;

  readonly #configDir: string;
  readonly #lockPath: string;
  readonly #lockStaleMs: number;
  readonly #lockRetryMs: number;
  readonly #lockTimeoutMs: number;

  constructor(options: XdgCredentialFileStoreOptions = {}) {
    this.#configDir = options.configDir ?? resolveXdgConfigDir(options.env ?? process.env);
    this.filePath = join(this.#configDir, FABULA_CONFIG_SUBDIR, CREDENTIALS_FILE_NAME);
    this.#lockPath = `${this.filePath}.lock`;
    this.#lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.#lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async set(providerId: string, secret: string): Promise<void> {
    assertValidProviderId(providerId);
    await this.#withLock(async () => {
      const entries = await this.#readAll();
      entries[providerId] = secret;
      await this.#writeAll(entries);
    });
  }

  async get(providerId: string): Promise<string | null> {
    assertValidProviderId(providerId);
    return this.#withLock(async () => {
      const entries = await this.#readAll();
      return entries[providerId] ?? null;
    });
  }

  async remove(providerId: string): Promise<void> {
    assertValidProviderId(providerId);
    await this.#withLock(async () => {
      const entries = await this.#readAll();
      if (!(providerId in entries)) return;
      delete entries[providerId];
      await this.#writeAll(entries);
    });
  }

  /**
   * Run `operation` as an exclusive critical section. The lock file is
   * created with O_EXCL (0600) next to the credential document, so concurrent
   * processes serialize; a contender retries until the lock is released,
   * times out, or proves the holder abandoned (dead owner pid, or lock older
   * than `lockStaleMs`) and steals it.
   */
  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const dir = dirname(this.#lockPath);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    } catch (error) {
      throw new CredentialStoreError(
        'CREDENTIAL_IO_ERROR',
        `Cannot prepare the provider credential directory ${dir}.`,
        { cause: error },
      );
    }
    const handle = await this.#acquireLock();
    try {
      return await operation();
    } finally {
      await this.#releaseLock(handle);
    }
  }

  async #acquireLock(): Promise<FileHandle> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(this.#lockPath, 'wx', 0o600);
        IN_PROCESS_LOCKS.add(this.#lockPath);
        try {
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
            'utf8',
          );
          return handle;
        } catch (writeError) {
          IN_PROCESS_LOCKS.delete(this.#lockPath);
          await handle.close().catch(() => {});
          await unlink(this.#lockPath).catch(() => {});
          throw writeError;
        }
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw new CredentialStoreError(
            'CREDENTIAL_IO_ERROR',
            `Cannot acquire the provider credential lock at ${this.#lockPath}.`,
            { cause: error },
          );
        }
        if (await this.#tryStealLock()) continue;
        if (Date.now() >= deadline) {
          throw new CredentialStoreError(
            'CREDENTIAL_IO_ERROR',
            `Timed out waiting for the provider credential lock at ${this.#lockPath}.`,
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, this.#lockRetryMs));
      }
    }
  }

  /**
   * Decide whether the existing lock is abandoned and remove it. An
   * unreadable/unparsable payload means the writer crashed before completing
   * acquisition; a parsed owner pid that is no longer alive, or a lock older
   * than `lockStaleMs`, is also treated as abandoned.
   */
  async #tryStealLock(): Promise<boolean> {
    if (IN_PROCESS_LOCKS.has(this.#lockPath)) return false;
    let stats: { mtimeMs: number } | undefined;
    try {
      stats = await stat(this.#lockPath);
    } catch {
      return false; // the lock vanished between checks; retry acquisition
    }
    if (stats === undefined) return false;
    let ownerPid: number | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#lockPath, 'utf8'));
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'pid' in parsed &&
        typeof parsed.pid === 'number'
      ) {
        ownerPid = parsed.pid;
      }
    } catch {
      // A different process may still be writing its acquisition payload.
      // Only an old unreadable lock is safe to recover.
    }
    const ageIsStale = Date.now() - stats.mtimeMs >= this.#lockStaleMs;
    const abandoned = ownerPid === undefined ? ageIsStale : !isProcessAlive(ownerPid) || ageIsStale;
    if (!abandoned) return false;
    await unlink(this.#lockPath).catch(() => {});
    return true;
  }

  async #releaseLock(handle: FileHandle): Promise<void> {
    try {
      await handle.close();
    } finally {
      try {
        await unlink(this.#lockPath);
      } catch {
        // A crashed/recovered lock may already be absent.
      } finally {
        IN_PROCESS_LOCKS.delete(this.#lockPath);
      }
    }
  }

  /** Load and validate the committed credential document (empty when absent). */
  async #readAll(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return {};
      throw new CredentialStoreError(
        'CREDENTIAL_IO_ERROR',
        `Cannot read the provider credential file at ${this.filePath}.`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredentialStoreError(
        'CORRUPT_CREDENTIAL_FILE',
        `The provider credential file at ${this.filePath} is not valid JSON.`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CredentialStoreError(
        'CORRUPT_CREDENTIAL_FILE',
        `The provider credential file at ${this.filePath} has an unexpected top-level shape.`,
      );
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isValidProviderId(key)) {
        throw new CredentialStoreError(
          'CORRUPT_CREDENTIAL_FILE',
          `The provider credential file at ${this.filePath} contains an invalid provider key.`,
        );
      }
      if (typeof value !== 'string') {
        throw new CredentialStoreError(
          'CORRUPT_CREDENTIAL_FILE',
          `The provider credential file at ${this.filePath} contains a non-string credential value.`,
        );
      }
      entries[key] = value;
    }
    return entries;
  }

  /**
   * Atomically replace the credential document: create a unique 0600 temp
   * file next to the target, fsync it, chmod it to exactly 0600 (open modes
   * are umask-masked), rename it over the target, and fsync the directory.
   */
  async #writeAll(entries: Record<string, string>): Promise<void> {
    const dir = dirname(this.filePath);
    let tmpPath: string | undefined;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      tmpPath = join(
        dir,
        `${CREDENTIALS_FILE_NAME}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
      );
      const handle = await open(tmpPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.filePath);
      tmpPath = undefined; // consumed by the rename; nothing left to clean up
      await this.#syncDirectory(dir);
    } catch (error) {
      if (tmpPath !== undefined) await unlink(tmpPath).catch(() => {});
      throw new CredentialStoreError(
        'CREDENTIAL_IO_ERROR',
        `Cannot write the provider credential file at ${this.filePath}.`,
        { cause: error },
      );
    }
  }

  /** Directory fsync is best-effort: unsupported on some platforms. */
  async #syncDirectory(dir: string): Promise<void> {
    try {
      const handle = await open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Durability of the rename itself is already guaranteed by the file fsync.
    }
  }
}

/** Best-effort read of `error.code` without fabricating a type. */
function errorCode(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  return error.code;
}

/** `true` when `pid` refers to a live process; `false` for dead or invalid pids. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

export interface ProviderCredentialStoreOptions {
  /** Injected OS credential adapter; when provided it wins over the file fallback. */
  osCredentialStore?: OsCredentialStore;
  /** Config base directory for the file fallback (defaults to XDG). */
  configDir?: string;
}

/**
 * Host construction entry point: use the injected OS credential adapter when
 * one is available, otherwise the restricted XDG file fallback. Every backend
 * is wrapped so provider ids are validated and backend failures surface as
 * secret-free {@link CredentialStoreError}s.
 */
export function createProviderCredentialStore(
  options: ProviderCredentialStoreOptions = {},
): ProviderCredentialStore {
  const backend =
    options.osCredentialStore ?? new XdgCredentialFileStore({ configDir: options.configDir });
  return new ValidatedProviderCredentialStore(backend);
}

/** Validates provider ids and normalizes backend failures into typed errors. */
class ValidatedProviderCredentialStore implements ProviderCredentialStore {
  constructor(private readonly backend: ProviderCredentialStore) {}

  async set(providerId: string, secret: string): Promise<void> {
    assertValidProviderId(providerId);
    try {
      await this.backend.set(providerId, secret);
    } catch (error) {
      throw this.#normalize(error);
    }
  }

  async get(providerId: string): Promise<string | null> {
    assertValidProviderId(providerId);
    try {
      const value = await this.backend.get(providerId);
      if (value !== null) return value;
      // Legacy fallback: pre-profile Hosts stored the default AI-SDK key under
      // the bare `ai-sdk` id. Reading the canonical `ai-sdk:default` key
      // resolves it so existing setups keep working without re-entry.
      if (providerId === providerCredentialKey(DEFAULT_PROVIDER_PROFILE)) {
        return this.backend.get(LEGACY_AI_SDK_CREDENTIAL_KEY);
      }
      return null;
    } catch (error) {
      throw this.#normalize(error);
    }
  }

  async remove(providerId: string): Promise<void> {
    assertValidProviderId(providerId);
    try {
      await this.backend.remove(providerId);
    } catch (error) {
      throw this.#normalize(error);
    }
  }

  #normalize(error: unknown): CredentialStoreError {
    if (error instanceof CredentialStoreError) return error;
    // Static message only: an injected adapter error could echo a secret.
    return new CredentialStoreError(
      'OS_CREDENTIAL_STORE_ERROR',
      'The provider credential store backend failed.',
    );
  }
}
