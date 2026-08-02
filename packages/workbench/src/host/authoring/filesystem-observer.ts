/**
 * Topology-limited authoring-tree filesystem observer.
 *
 * The observer is the watcher side of the AuthoringCoordinator: it debounces
 * filesystem change hints, performs a FULL re-read of the authoring tree
 * through the injected {@link AuthoringTreeLoader} (a
 * `FileProjectSourceLoader` adapter over the allowed authoring-manifest
 * topology — `.git`, `.nova`, cache, output and Host staging are excluded),
 * stages the re-read content into a private content-addressed candidate
 * store, and emits external candidates.
 *
 * Boundary rules (never violated here):
 *
 *  - The observer ONLY produces external candidates. It never refreshes the
 *    accepted session source, never writes files, never touches Git, and
 *    never accepts or commits anything. There is no write surface at all.
 *  - A filesystem event is only a hint: the observer debounces, then always
 *    performs a full re-read before emitting, so a torn/partial write cannot
 *    produce a candidate from half-written bytes.
 *  - Identical re-reads (same tree hash) are suppressed: no re-stage, no
 *    re-emit. Self-write alignment is suppressed by the coordinator, which
 *    compares the observed tree hash against the accepted source identity.
 *  - No filesystem path ever leaves this module; emitted snapshots carry only
 *    manifest-relative logical paths, content, and hashes.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ProjectSourceSnapshotV1 } from '@novalistically/core';
import { FileProjectSourceLoader } from '@novalistically/node-host';
import type { AuthoringDiagnosticV1 } from '../../contracts/authoring.js';
import type { AuthoringTreeLoader, AuthoringTreeSnapshot } from './types.js';

// ─── Content-addressed candidate staging ────────────────────────────────────

/** One staged external candidate: full manifest entries keyed by candidate hash. */
export interface AuthoringCandidateBundle {
  readonly projectId: string;
  readonly candidateHash: string;
  readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
}

/**
 * Private content-addressed staging for external candidates. SQLite and the
 * browser contract only ever see hashes/metadata; the raw entries live here
 * (a Host-private staging directory in production wiring; the in-memory
 * default is for tests). The store never exposes paths to any surface.
 */
export interface AuthoringCandidateStore {
  put(bundle: AuthoringCandidateBundle): Promise<void>;
  get(input: {
    readonly projectId: string;
    readonly candidateHash: string;
  }): Promise<AuthoringCandidateBundle | null>;
  delete(input: { readonly projectId: string; readonly candidateHash: string }): Promise<void>;
}

/** In-memory content-addressed staging (tests and un-wired hosts). */
export function createInMemoryCandidateStore(): AuthoringCandidateStore {
  const bundles = new Map<string, AuthoringCandidateBundle>();
  return {
    async put(bundle) {
      bundles.set(`${bundle.projectId}\u0000${bundle.candidateHash}`, bundle);
    },
    async get(input) {
      return bundles.get(`${input.projectId}\u0000${input.candidateHash}`) ?? null;
    },
    async delete(input) {
      bundles.delete(`${input.projectId}\u0000${input.candidateHash}`);
    },
  };
}

/**
 * Private durable candidate store for production coordinator recovery. Bundles
 * are content-addressed under the Host home staging directory, not the
 * authoring project, and are written atomically with owner-only permissions.
 * SQLite receives only the candidate hash and metadata.
 */
export function createFileCandidateStore(stagingRoot: string): AuthoringCandidateStore {
  if (typeof stagingRoot !== 'string' || !isAbsolute(stagingRoot)) {
    throw new TypeError('createFileCandidateStore requires an absolute staging root');
  }
  const root = resolve(stagingRoot);
  const filename = (projectId: string, candidateHash: string): string => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId)) {
      throw new TypeError('candidate projectId must be a safe non-empty identifier');
    }
    if (!/^[a-f0-9]{64}$/.test(candidateHash)) {
      throw new TypeError('candidateHash must be a lowercase sha256 hex digest');
    }
    return join(root, `${projectId}-${candidateHash}.json`);
  };
  const validate = (value: unknown): AuthoringCandidateBundle => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('staged authoring candidate is malformed');
    }
    const candidate = value as {
      projectId?: unknown;
      candidateHash?: unknown;
      entries?: unknown;
    };
    if (
      typeof candidate.projectId !== 'string' ||
      typeof candidate.candidateHash !== 'string' ||
      !Array.isArray(candidate.entries) ||
      candidate.entries.some(
        (entry) =>
          typeof entry !== 'object' ||
          entry === null ||
          Array.isArray(entry) ||
          typeof (entry as { logicalPath?: unknown }).logicalPath !== 'string' ||
          typeof (entry as { content?: unknown }).content !== 'string',
      )
    ) {
      throw new Error('staged authoring candidate has an invalid shape');
    }
    return {
      projectId: candidate.projectId,
      candidateHash: candidate.candidateHash,
      entries: candidate.entries.map((entry) => {
        const value = entry as { logicalPath: string; content: string };
        return { logicalPath: value.logicalPath, content: value.content };
      }),
    };
  };
  return {
    async put(bundle) {
      const path = filename(bundle.projectId, bundle.candidateHash);
      const validated = validate(bundle);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(validated), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async get(input) {
      const path = filename(input.projectId, input.candidateHash);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const bundle = validate(JSON.parse(raw) as unknown);
      if (bundle.projectId !== input.projectId || bundle.candidateHash !== input.candidateHash) {
        throw new Error('staged authoring candidate identity mismatch');
      }
      return bundle;
    },
    async delete(input) {
      await rm(filename(input.projectId, input.candidateHash), { force: true });
    },
  };
}

// ─── Tree loader adapter ─────────────────────────────────────────────────────

/** One full authoring-tree re-read through the allowed topology loader. */
export function createFileTreeLoader(
  projectRoot: string,
  options: { readonly now?: () => string } = {},
): AuthoringTreeLoader {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('createFileTreeLoader requires a non-empty projectRoot');
  }
  const loader = new FileProjectSourceLoader();
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async loadTree(input): Promise<AuthoringTreeSnapshot> {
      const snapshot = loader.load(projectRoot);
      return {
        projectId: input.projectId,
        treeHash: snapshot.sourceHash,
        entries: snapshot.documents.map((document) => ({
          logicalPath: document.logicalPath,
          content: document.content,
        })),
        diagnostics: collectTreeDiagnostics(snapshot),
        observedAt: now(),
      };
    },
  };
}

function collectTreeDiagnostics(
  snapshot: ProjectSourceSnapshotV1,
): readonly AuthoringDiagnosticV1[] {
  const diagnostics: AuthoringDiagnosticV1[] = [];
  for (const document of snapshot.documents) {
    for (const diagnostic of document.diagnostics) {
      diagnostics.push({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        logicalPath: diagnostic.logicalPath,
      });
    }
    if (document.parseResult.status !== 'parsed') {
      diagnostics.push({
        code: 'source.parse_failed',
        severity: 'error',
        message: `Document "${document.logicalPath}" did not parse`,
        logicalPath: document.logicalPath,
      });
    }
  }
  return diagnostics;
}

// ─── Observer ────────────────────────────────────────────────────────────────

export interface AuthoringFilesystemObserverOptions {
  readonly projectId: string;
  /**
   * Full re-read of the allowed authoring tree. The wiring supplies a
   * `createFileTreeLoader` adapter over the resolved project root; tests
   * inject deterministic fakes. The observer itself never resolves paths.
   */
  readonly loader: AuthoringTreeLoader;
  /** Private content-addressed staging for emitted candidates. */
  readonly staging: AuthoringCandidateStore;
  /** Debounce window for filesystem hints; defaults to 150ms. */
  readonly debounceMs?: number;
  /** Timestamp source; defaults to the host clock. */
  readonly now?: () => string;
}

export interface AuthoringFilesystemObserver {
  readonly projectId: string;
  /**
   * Filesystem change hint. The event is only a hint: the observer debounces
   * and then performs a full re-read. Resolves with the re-read snapshot
   * after the debounced load completes (or the in-flight load, when one is
   * already running).
   */
  notify(input?: { readonly hintPaths?: readonly string[] }): Promise<AuthoringTreeSnapshot>;
  /** Immediate full re-read without debounce, staging, or emission. */
  loadTree(): Promise<AuthoringTreeSnapshot>;
  /** External candidate emission; fires only when the tree hash changed. */
  onCandidate(listener: (snapshot: AuthoringTreeSnapshot) => void): () => void;
  /** Cancel pending debounces; no further loads or emissions. */
  dispose(): void;
}

interface NotifyWaiter {
  resolve(snapshot: AuthoringTreeSnapshot): void;
  reject(error: unknown): void;
}

function createAuthoringFilesystemObserverImpl(
  options: AuthoringFilesystemObserverOptions,
): AuthoringFilesystemObserver {
  const { projectId, loader, staging } = options;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError('AuthoringFilesystemObserver requires a non-empty projectId');
  }
  if (loader === null || typeof loader !== 'object' || typeof loader.loadTree !== 'function') {
    throw new TypeError('AuthoringFilesystemObserver requires an injected AuthoringTreeLoader');
  }
  if (staging === null || typeof staging !== 'object' || typeof staging.put !== 'function') {
    throw new TypeError('AuthoringFilesystemObserver requires an injected AuthoringCandidateStore');
  }
  const debounceMs = Math.max(0, options.debounceMs ?? 150);
  const candidateListeners = new Set<(snapshot: AuthoringTreeSnapshot) => void>();
  const waiters: NotifyWaiter[] = [];
  /** Last tree hash the observer emitted (or loaded); identical re-reads are suppressed. */
  let lastTreeHash: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let queued = false;
  let disposed = false;
  /** Waiters coupled to the current full re-read so dispose() can reject them. */
  let inFlightWaiters: NotifyWaiter[] = [];

  async function loadSnapshot(): Promise<AuthoringTreeSnapshot> {
    return loader.loadTree({ projectId });
  }

  function scheduleFlush(): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  /**
   * Drain one already-debounced batch. A hint arriving during the async
   * re-read remains queued; when its timer has elapsed, the finally block
   * immediately starts a second re-read. This prevents waiters from being
   * stranded behind the in-flight flush.
   */
  async function flush(): Promise<void> {
    if (disposed || flushing || !queued) return;
    flushing = true;
    queued = false;
    const flushWaiters = waiters.splice(0);
    inFlightWaiters = flushWaiters;
    try {
      const snapshot = await loadSnapshot();
      if (disposed) return;
      if (snapshot.treeHash !== lastTreeHash) {
        await staging.put({
          projectId,
          candidateHash: snapshot.treeHash,
          entries: snapshot.entries,
        });
        if (disposed) return;
        lastTreeHash = snapshot.treeHash;
        for (const listener of candidateListeners) {
          if (disposed) return;
          listener(snapshot);
        }
      }
      if (disposed) return;
      for (const waiter of flushWaiters) waiter.resolve(snapshot);
    } catch (error) {
      if (!disposed) {
        for (const waiter of flushWaiters) waiter.reject(error);
      }
    } finally {
      inFlightWaiters = [];
      flushing = false;
      if (!disposed && queued && timer === null) void flush();
    }
  }

  return {
    projectId,
    async notify(_input = {}) {
      if (disposed) {
        throw new Error('AuthoringFilesystemObserver is disposed');
      }
      queued = true;
      scheduleFlush();
      return new Promise<AuthoringTreeSnapshot>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    async loadTree() {
      return loadSnapshot();
    },
    onCandidate(listener) {
      candidateListeners.add(listener);
      return () => {
        candidateListeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queued = false;
      candidateListeners.clear();
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error('AuthoringFilesystemObserver is disposed'));
      }
      for (const waiter of inFlightWaiters.splice(0)) {
        waiter.reject(new Error('AuthoringFilesystemObserver is disposed'));
      }
    },
  };
}

/** Create one topology-limited authoring-tree observer. */
export function createAuthoringFilesystemObserver(
  options: AuthoringFilesystemObserverOptions,
): AuthoringFilesystemObserver {
  return createAuthoringFilesystemObserverImpl(options);
}
