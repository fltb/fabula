import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import * as path from 'node:path';
import {
  atomicWrite,
  isMissing,
  prepareDirectory,
  recoverJournal,
  withDirectoryLock,
} from '../execution/types.js';

/** The on-disk lease is deliberately limited to public routing/health data. */
export interface ProjectAuthorityLeaseV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly rootFingerprint: string;
  readonly instanceId: string;
  readonly state: 'starting' | 'ready';
  readonly endpoint?: string;
  readonly build?: {
    readonly version: 1;
    readonly packageId: string;
    readonly buildId: string;
    readonly protocolVersion: number;
  };
  readonly heartbeatAt: string;
}

export interface ProjectAuthorityTokenV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly rootFingerprint: string;
  readonly instanceNonce: string;
  readonly token: string;
}

export interface ProjectWriteCoordinatorOptions {
  readonly projectId?: string;
  readonly heartbeatTtlMs?: number;
  readonly now?: () => Date;
  /** Returns true when the matching running Host is healthy. */
  readonly healthProbe?: (lease: ProjectAuthorityLeaseV1) => boolean | Promise<boolean>;
}

export interface WorkbenchAuthorityReadyOptions {
  readonly endpoint: string;
  readonly build?: ProjectAuthorityLeaseV1['build'];
}

export class ProjectAuthorityUnavailableError extends Error {
  readonly lease: ProjectAuthorityLeaseV1 | null;

  constructor(message: string, lease: ProjectAuthorityLeaseV1 | null = null) {
    super(message);
    this.name = 'ProjectAuthorityUnavailableError';
    this.lease = lease;
  }
}

export class ProjectAuthorityTokenError extends Error {
  constructor(message = 'Invalid or expired Workbench authority token') {
    super(message);
    this.name = 'ProjectAuthorityTokenError';
  }
}

export class StandaloneMutationBlockedError extends ProjectAuthorityUnavailableError {
  constructor(lease: ProjectAuthorityLeaseV1) {
    super(`Standalone mutation is unavailable while Workbench authority is ${lease.state}`, lease);
    this.name = 'StandaloneMutationBlockedError';
  }
}

const LEASE_FILE = 'authority.json';
const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

const isLease = (value: unknown): value is ProjectAuthorityLeaseV1 => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.rootFingerprint === 'string' &&
    typeof candidate.instanceId === 'string' &&
    (candidate.state === 'starting' || candidate.state === 'ready') &&
    typeof candidate.heartbeatAt === 'string'
  );
};

const parseLease = (raw: string): ProjectAuthorityLeaseV1 | null => {
  try {
    const value: unknown = JSON.parse(raw);
    return isLease(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Stable, portable identity for an authoring root. The path itself is never
 * written to a lease; callers exchange this digest with the Host health API.
 */
export async function computeProjectRootFingerprint(projectRoot: string): Promise<string> {
  const realRoot = await fs.realpath(path.resolve(projectRoot));
  return createHash('sha256').update(realRoot, 'utf8').digest('hex');
}

const isExpired = (lease: ProjectAuthorityLeaseV1, now: Date, ttl: number): boolean => {
  const heartbeat = Date.parse(lease.heartbeatAt);
  return !Number.isFinite(heartbeat) || now.getTime() - heartbeat >= ttl;
};

const safeLeaseForError = (lease: ProjectAuthorityLeaseV1): ProjectAuthorityLeaseV1 => ({
  ...lease,
  ...(lease.build ? { build: { ...lease.build } } : {}),
});

/**
 * Coordinates filesystem writers with the Workbench project authority. All
 * lease reads/writes and mutation admission checks use the same repository
 * directory lock as source/runtime repositories.
 */
export class ProjectWriteCoordinator {
  readonly #projectRoot: string;
  readonly #projectId: string;
  readonly #lockDirectory: string;
  readonly #leaseFile: string;
  readonly #heartbeatTtlMs: number;
  readonly #now: () => Date;
  readonly #healthProbe?: ProjectWriteCoordinatorOptions['healthProbe'];
  #authorityToken: ProjectAuthorityTokenV1 | null = null;

  constructor(projectRoot: string, options: ProjectWriteCoordinatorOptions | string = {}) {
    this.#projectRoot = realpathSync(path.resolve(projectRoot));
    const normalized = typeof options === 'string' ? { projectId: options } : options;
    this.#projectId = normalized.projectId ?? 'project';
    this.#heartbeatTtlMs = normalized.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
    if (!Number.isFinite(this.#heartbeatTtlMs) || this.#heartbeatTtlMs <= 0)
      throw new RangeError('heartbeatTtlMs must be positive');
    this.#now = normalized.now ?? (() => new Date());
    this.#healthProbe = normalized.healthProbe;
    this.#lockDirectory = path.join(this.#projectRoot, '.nova', 'locks');
    this.#leaseFile = path.join(this.#lockDirectory, LEASE_FILE);
  }

  get projectRoot(): string {
    return this.#projectRoot;
  }

  get projectId(): string {
    return this.#projectId;
  }

  async rootFingerprint(): Promise<string> {
    return computeProjectRootFingerprint(this.#projectRoot);
  }

  async readLease(): Promise<ProjectAuthorityLeaseV1 | null> {
    await prepareDirectory(this.#projectRoot, this.#lockDirectory);
    await recoverJournal(this.#projectRoot, this.#lockDirectory);
    try {
      const raw = await fs.readFile(this.#leaseFile, 'utf8');
      const lease = parseLease(raw);
      if (!lease) throw new Error('Invalid project authority lease');
      return safeLeaseForError(lease);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async acquireWorkbenchAuthority(instanceNonce: string): Promise<ProjectAuthorityTokenV1> {
    if (!instanceNonce || instanceNonce.length > 256) throw new TypeError('Invalid instance nonce');
    await prepareDirectory(this.#projectRoot, this.#lockDirectory);
    const fingerprint = await computeProjectRootFingerprint(this.#projectRoot);
    return withDirectoryLock(this.#projectRoot, this.#lockDirectory, async () => {
      await recoverJournal(this.#projectRoot, this.#lockDirectory);
      const current = await this.#readLeaseUnlocked();
      if (current) {
        if (current.rootFingerprint !== fingerprint || current.projectId !== this.#projectId) {
          throw new ProjectAuthorityUnavailableError(
            'Project authority lease identity mismatch',
            current,
          );
        }
        if (!isExpired(current, this.#now(), this.#heartbeatTtlMs)) {
          throw new ProjectAuthorityUnavailableError(
            'Project already has Workbench authority',
            current,
          );
        }
        // Stale leases are reclaimable only with an explicit failed matching
        // health probe. No caller, including standalone CLI, reaches this path.
        if (!this.#healthProbe) {
          throw new ProjectAuthorityUnavailableError(
            'Expired authority requires a health probe',
            current,
          );
        }
        let healthy = true;
        try {
          healthy = await this.#healthProbe(safeLeaseForError(current));
        } catch {
          healthy = false;
        }
        if (healthy)
          throw new ProjectAuthorityUnavailableError(
            'Existing Workbench authority is healthy',
            current,
          );
        await this.#removeLeaseUnlocked(current.instanceId);
      }
      const token: ProjectAuthorityTokenV1 = {
        version: 1,
        projectId: this.#projectId,
        rootFingerprint: fingerprint,
        instanceNonce,
        token: randomUUID(),
      };
      await this.#writeLeaseUnlocked({
        version: 1,
        projectId: this.#projectId,
        rootFingerprint: fingerprint,
        instanceId: instanceNonce,
        state: 'starting',
        heartbeatAt: this.#now().toISOString(),
      });
      this.#authorityToken = token;
      return token;
    });
  }

  async markReady(
    authorityToken: ProjectAuthorityTokenV1,
    options: WorkbenchAuthorityReadyOptions,
  ): Promise<ProjectAuthorityLeaseV1> {
    return this.#updateLease(authorityToken, {
      state: 'ready',
      endpoint: options.endpoint,
      ...(options.build ? { build: options.build } : {}),
    });
  }

  /** Alias matching the launch lifecycle vocabulary. */
  promoteWorkbenchAuthority(
    authorityToken: ProjectAuthorityTokenV1,
    options: WorkbenchAuthorityReadyOptions,
  ): Promise<ProjectAuthorityLeaseV1> {
    return this.markReady(authorityToken, options);
  }

  async heartbeat(authorityToken: ProjectAuthorityTokenV1): Promise<ProjectAuthorityLeaseV1> {
    return this.#updateLease(authorityToken, {});
  }

  async releaseWorkbenchAuthority(authorityToken: ProjectAuthorityTokenV1): Promise<void> {
    await this.#assertTokenShape(authorityToken);
    await prepareDirectory(this.#projectRoot, this.#lockDirectory);
    await withDirectoryLock(this.#projectRoot, this.#lockDirectory, async () => {
      const lease = await this.#readLeaseUnlocked();
      if (
        lease?.instanceId === authorityToken.instanceNonce &&
        lease.rootFingerprint === authorityToken.rootFingerprint &&
        lease.projectId === this.#projectId
      ) {
        await this.#removeLeaseUnlocked(authorityToken.instanceNonce);
      }
      if (this.#authorityToken?.token === authorityToken.token) this.#authorityToken = null;
    });
  }

  /** Instance-CAS release; unlike token release it is safe during shutdown. */
  async release(instanceNonce: string): Promise<void> {
    if (
      typeof instanceNonce !== 'string' ||
      instanceNonce.length === 0 ||
      instanceNonce.length > 256
    )
      throw new TypeError('Invalid instance nonce');
    await prepareDirectory(this.#projectRoot, this.#lockDirectory);
    await withDirectoryLock(this.#projectRoot, this.#lockDirectory, async () => {
      const lease = await this.#readLeaseUnlocked();
      if (lease?.instanceId === instanceNonce && lease.projectId === this.#projectId)
        await this.#removeLeaseUnlocked(instanceNonce);
      if (this.#authorityToken?.instanceNonce === instanceNonce) this.#authorityToken = null;
    });
  }

  async withWorkbenchMutation<T>(
    authorityToken: ProjectAuthorityTokenV1,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    await this.#assertTokenShape(authorityToken);
    await prepareDirectory(this.#projectRoot, this.#lockDirectory);
    return withDirectoryLock(this.#projectRoot, this.#lockDirectory, async () => {
      const lease = await this.#readLeaseUnlocked();
      if (
        !lease ||
        lease.instanceId !== authorityToken.instanceNonce ||
        lease.rootFingerprint !== authorityToken.rootFingerprint ||
        lease.projectId !== this.#projectId ||
        (lease.state !== 'starting' && lease.state !== 'ready') ||
        isExpired(lease, this.#now(), this.#heartbeatTtlMs)
      ) {
        throw new ProjectAuthorityTokenError();
      }
      await this.#writeLeaseUnlocked({ ...lease, heartbeatAt: this.#now().toISOString() });
      return fn();
    });
  }

  async withStandaloneMutation<T>(fn: () => T | Promise<T>): Promise<T> {
    await prepareDirectory(this.#projectRoot, this.#lockDirectory);
    return withDirectoryLock(this.#projectRoot, this.#lockDirectory, async () => {
      const lease = await this.#readLeaseUnlocked();
      if (
        lease &&
        (lease.state === 'starting' || lease.state === 'ready') &&
        !isExpired(lease, this.#now(), this.#heartbeatTtlMs)
      )
        throw new StandaloneMutationBlockedError(safeLeaseForError(lease));
      return fn();
    });
  }

  async #updateLease(
    authorityToken: ProjectAuthorityTokenV1,
    update: Partial<Pick<ProjectAuthorityLeaseV1, 'state' | 'endpoint' | 'build'>>,
  ): Promise<ProjectAuthorityLeaseV1> {
    await this.#assertTokenShape(authorityToken);
    await prepareDirectory(this.#projectRoot, this.#lockDirectory);
    return withDirectoryLock(this.#projectRoot, this.#lockDirectory, async () => {
      const lease = await this.#readLeaseUnlocked();
      if (
        !lease ||
        lease.instanceId !== authorityToken.instanceNonce ||
        lease.rootFingerprint !== authorityToken.rootFingerprint ||
        lease.projectId !== this.#projectId ||
        isExpired(lease, this.#now(), this.#heartbeatTtlMs)
      )
        throw new ProjectAuthorityTokenError();
      const next: ProjectAuthorityLeaseV1 = {
        ...lease,
        ...update,
        heartbeatAt: this.#now().toISOString(),
      };
      await this.#writeLeaseUnlocked(next);
      return safeLeaseForError(next);
    });
  }

  async #assertTokenShape(token: ProjectAuthorityTokenV1): Promise<void> {
    if (
      token?.version !== 1 ||
      token.projectId !== this.#projectId ||
      token.rootFingerprint !== (await this.rootFingerprint()) ||
      !token.instanceNonce ||
      !token.token
    )
      throw new ProjectAuthorityTokenError();
  }

  async #readLeaseUnlocked(): Promise<ProjectAuthorityLeaseV1 | null> {
    try {
      const lease = parseLease(await fs.readFile(this.#leaseFile, 'utf8'));
      if (!lease) throw new Error('Invalid project authority lease');
      return lease;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async #writeLeaseUnlocked(lease: ProjectAuthorityLeaseV1): Promise<void> {
    // JSON is intentionally explicit and excludes root paths, credentials,
    // source content, database paths, and private runtime locations.
    await atomicWrite(
      this.#projectRoot,
      this.#lockDirectory,
      this.#leaseFile,
      `${JSON.stringify(lease)}\n`,
    );
  }

  async #removeLeaseUnlocked(instanceId: string): Promise<void> {
    const current = await this.#readLeaseUnlocked();
    if (current?.instanceId !== instanceId) return;
    try {
      await fs.unlink(this.#leaseFile);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
