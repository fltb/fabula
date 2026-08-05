/**
 * Approved-tree source view materializer with expected-revision CAS.
 *
 * Materializes a complete bundle of approved source entries onto the project
 * filesystem tree under the shared per-root directory lock. The materializer:
 *
 *  - Only touches paths approved by the neutral authoring manifest
 *    (classifyAuthoringPath). Never traverses or mutates references/,
 *    .nova/, .git/, output/, caches, or unrelated files.
 *  - Acquires the shared `.nova/locks/` write lock (same lock used by
 *    FileProjectSourceWriter) before any filesystem mutation.
 *  - Re-inspects the approved tree immediately before the first write.
 *    If the expectedMaterializedRevisionId or expectedTreeHash does not
 *    match the current state, returns `external-candidate` without writing.
 *  - Writes all bundle entries, deletes any approved paths omitted from
 *    the bundle (i.e., paths that exist on disk but are not in the target
 *    bundle), then verifies the resulting tree through
 *    FileProjectSourceLoader.
 *  - Records the materialized revision ID in a private marker file under
 *    `.nova/authoring/` so that `inspect()` can report the current
 *    materialized revision without a coordinator or persistence layer.
 */

import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, type Stats, unlinkSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProjectSourceSnapshotV1 } from '@novalistically/core';
import { computeSourceDocumentHash } from '@novalistically/core/source';
import { FileProjectSourceLoader } from '@novalistically/node-host';
import { classifyAuthoringPath, ROOT_AUTHORING_FILES } from './manifest.js';
import type {
  AuthoringMaterializeOutcome,
  AuthoringPathHashEntry,
  AuthoringSourceViewInspectResult,
  AuthoringSourceViewMaterializer,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Lock wait timeout in milliseconds (must match the node-host convention). */
const LOCK_WAIT_TIMEOUT_MS = 5_000;

/** Age after which a stale lock is considered abandoned (5 min). */
const STALE_LOCK_AGE_MS = 5 * 60_000;

/** Marker file storing the last successfully materialized revision ID. */
const MATERIALIZED_REVISION_MARKER = 'materialized-revision.json';

// ─── Lock (file-level, compatible with FileProjectSourceWriter) ──────────────

interface LockRecord {
  readonly version: 1;
  readonly token: string;
  readonly acquiredAt: number;
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Record<string, unknown>).version !== 1 ||
      typeof (value as Record<string, unknown>).token !== 'string' ||
      typeof (value as Record<string, unknown>).acquiredAt !== 'number'
    ) {
      return null;
    }
    return {
      version: 1,
      token: (value as Record<string, unknown>).token as string,
      acquiredAt: (value as Record<string, unknown>).acquiredAt as number,
    };
  } catch {
    return null;
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    return parseLockRecord(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function acquireLock(_root: string, lockDirectory: string): Promise<() => Promise<void>> {
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(lockDirectory, '.write.lock');
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  for (;;) {
    const token = randomUUID();
    const owner: LockRecord = { version: 1, token, acquiredAt: Date.now() };
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Lock exists — check staleness.
      try {
        const stat = await lstat(lockPath);
        if (stat.isSymbolicLink()) {
          throw new Error('Lock path must not be a symlink');
        }
        if (Date.now() - stat.mtimeMs >= STALE_LOCK_AGE_MS) {
          const current = await readLockRecord(lockPath);
          const quarantine = `${lockPath}.${current?.token ?? 'unknown'}.${randomUUID()}.stale`;
          try {
            await rename(lockPath, quarantine);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
              // Lock was removed between stat and rename — retry.
              continue;
            }
            throw renameError;
          }
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for write lock at ${lockDirectory}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }

    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      return async () => {
        await handle.close();
        // Only unlink if we still own it.
        try {
          const current = await readLockRecord(lockPath);
          if (current?.token === token) {
            await unlink(lockPath).catch(() => undefined);
          }
        } catch {
          // Lock file already gone — fine.
        }
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
}

// ─── Materialized revision marker ───────────────────────────────────────────

interface MaterializedRevisionMarker {
  readonly version: 1;
  readonly materializedRevisionId: string | null;
  readonly treeHash: string;
  readonly updatedAt: string;
}

function markerDirectory(root: string): string {
  return join(root, '.nova', 'authoring');
}

function markerPath(root: string): string {
  return join(markerDirectory(root), MATERIALIZED_REVISION_MARKER);
}

function readMarker(root: string): MaterializedRevisionMarker | null {
  try {
    const raw = readFileSync(markerPath(root), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Record<string, unknown>).version !== 1
    ) {
      return null;
    }
    const v = value as Record<string, unknown>;
    const revisionId = v.materializedRevisionId;
    return {
      version: 1,
      materializedRevisionId: typeof revisionId === 'string' ? revisionId : null,
      treeHash: typeof v.treeHash === 'string' ? v.treeHash : '',
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    };
  } catch {
    return null;
  }
}

async function writeMarkerAsync(
  root: string,
  materializedRevisionId: string | null,
  treeHash: string,
  now: string,
): Promise<void> {
  const dir = markerDirectory(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const marker: MaterializedRevisionMarker = {
    version: 1,
    materializedRevisionId,
    treeHash,
    updatedAt: now,
  };
  const targetPath = markerPath(root);
  const temp = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, targetPath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ─── Approved path helpers ──────────────────────────────────────────────────

/** True when a logical path is approved by the neutral authoring manifest. */
function isApprovedPath(logicalPath: string): boolean {
  return classifyAuthoringPath(logicalPath).ok;
}

// ─── Tree listing helpers ───────────────────────────────────────────────────

/** Collect all file paths under a directory, relative to root. */
function collectFilesRecursive(root: string, dir: string, prefix: string): string[] {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of entries.sort()) {
    const fullPath = join(dir, name);
    const logicalPath = prefix ? `${prefix}/${name}` : name;
    let stat: Stats | null = null;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat === null) continue;
    if (stat.isSymbolicLink()) continue; // Never follow symlinks.
    if (stat.isDirectory()) {
      // Skip preserved directories entirely.
      const firstSegment = name;
      if (firstSegment === 'references' || firstSegment === '.nova' || firstSegment === '.git') {
        continue;
      }
      result.push(...collectFilesRecursive(root, fullPath, logicalPath));
    } else if (stat.isFile()) {
      result.push(logicalPath);
    }
  }
  return result;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface FileSourceViewMaterializerOptions {
  /** Absolute path to the project root that this materializer manages. */
  readonly projectRoot: string;
  /** Timestamp source; defaults to the host clock. */
  readonly now?: () => string;
}

/**
 * Create a FileSourceViewMaterializer for the given project root.
 *
 * The materializer manages the approved authoring tree at `projectRoot`,
 * using the shared `.nova/locks/` directory lock and tracking the current
 * materialized revision in `.nova/authoring/materialized-revision.json`.
 */
export function createFileSourceViewMaterializer(
  options: FileSourceViewMaterializerOptions,
): AuthoringSourceViewMaterializer {
  const root = resolve(options.projectRoot);
  const lockDirectory = join(root, '.nova', 'locks');
  const now = options.now ?? (() => new Date().toISOString());

  const loader = new FileProjectSourceLoader();

  /** Load the current tree snapshot via FileProjectSourceLoader. */
  function loadSnapshot(): ProjectSourceSnapshotV1 {
    return loader.load(root);
  }

  /** Inspect the tree without acquiring the lock (caller must hold it). */
  function inspectUnlocked(): {
    treeHash: string;
    perPathHashes: readonly AuthoringPathHashEntry[];
    materializedRevisionId: string | null;
  } {
    const snapshot = loadSnapshot();
    const marker = readMarker(root);
    const perPathHashes: AuthoringPathHashEntry[] = snapshot.documents.map((doc) => ({
      logicalPath: doc.logicalPath,
      hash: doc.contentHash,
    }));
    return {
      treeHash: snapshot.sourceHash,
      perPathHashes,
      materializedRevisionId: marker?.materializedRevisionId ?? null,
    };
  }

  return {
    async inspect(projectId: string): Promise<AuthoringSourceViewInspectResult> {
      const result = inspectUnlocked();
      return { projectId, ...result };
    },

    async materialize(input): Promise<AuthoringMaterializeOutcome> {
      const { expectedMaterializedRevisionId, expectedTreeHash, bundle } = input;
      const release = await acquireLock(root, lockDirectory);
      try {
        // Re-inspect immediately before any write.
        const preInspect = inspectUnlocked();

        // CAS: expected materialized revision ID.
        if (preInspect.materializedRevisionId !== expectedMaterializedRevisionId) {
          return {
            status: 'external-candidate',
            reason:
              preInspect.materializedRevisionId === null
                ? 'Project has never been materialized; expected a revision ID.'
                : `Materialized revision changed: expected ${expectedMaterializedRevisionId ?? '(none)'}, found ${preInspect.materializedRevisionId}`,
          };
        }

        // CAS: expected tree hash.
        if (preInspect.treeHash !== expectedTreeHash) {
          return {
            status: 'external-candidate',
            reason: `Tree hash mismatch: expected ${expectedTreeHash}, found ${preInspect.treeHash}`,
          };
        }

        // Build the set of approved paths in the bundle.
        const bundlePaths = new Set<string>();
        for (const entry of bundle.entries) {
          if (!isApprovedPath(entry.logicalPath)) {
            return {
              status: 'recovery-required',
              reason: `Bundle contains non-approved path: ${entry.logicalPath}`,
            };
          }
          bundlePaths.add(entry.logicalPath);
        }
        for (const requiredPath of ROOT_AUTHORING_FILES) {
          if (!bundlePaths.has(requiredPath)) {
            return {
              status: 'recovery-required',
              reason: `Bundle is missing required root: ${requiredPath}`,
            };
          }
        }

        // Collect all approved paths currently on disk.
        const onDiskApprovedPaths = new Set<string>();
        for (const logicalPath of collectFilesRecursive(root, root, '')) {
          if (isApprovedPath(logicalPath)) {
            onDiskApprovedPaths.add(logicalPath);
          }
        }

        // Determine which approved paths to delete (on disk but not in bundle).
        const pathsToDelete: string[] = [];
        for (const path of onDiskApprovedPaths) {
          if (!bundlePaths.has(path)) {
            pathsToDelete.push(path);
          }
        }

        // Write all bundle entries.
        for (const entry of bundle.entries) {
          const target = join(root, ...entry.logicalPath.split('/'));
          await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
          const temp = `${target}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, entry.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await rename(temp, target);
          } catch (error) {
            await rm(temp, { force: true }).catch(() => undefined);
            throw error;
          }
        }

        // Delete omitted approved paths (those that exist on disk but are not
        // in the target bundle). Only touches files — never removes directories.
        for (const logicalPath of pathsToDelete) {
          const target = join(root, ...logicalPath.split('/'));
          try {
            const stat = lstatSync(target);
            if (stat.isFile()) {
              unlinkSync(target);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }

        // Verify through FileProjectSourceLoader.
        let verified: ProjectSourceSnapshotV1;
        try {
          verified = loadSnapshot();
        } catch (error) {
          return {
            status: 'recovery-required',
            reason: `Failed to verify materialized tree: ${String(error)}`,
          };
        }

        // The source hash must match the expected tree hash.
        if (verified.sourceHash !== expectedTreeHash) {
          return {
            status: 'external-candidate',
            reason: `Materialized tree hash ${verified.sourceHash} does not match expected ${expectedTreeHash}`,
          };
        }

        // Verify each bundle entry is present with correct content.
        for (const entry of bundle.entries) {
          const found = verified.documents.find((d) => d.logicalPath === entry.logicalPath);
          if (!found || found.contentHash !== computeSourceDocumentHash(entry.content)) {
            return {
              status: 'recovery-required',
              reason: `Bundle entry ${entry.logicalPath} does not match materialized content`,
            };
          }
        }

        // Verify omitted approved paths are actually gone.
        for (const logicalPath of pathsToDelete) {
          const found = verified.documents.find((d) => d.logicalPath === logicalPath);
          if (found) {
            return {
              status: 'recovery-required',
              reason: `Approved path ${logicalPath} should have been deleted but is still present`,
            };
          }
        }

        // Record the materialized revision marker. The caller owns the
        // revision identity; we store the expectedMaterializedRevisionId as
        // the new state (the caller will supply the next expected value).
        await writeMarkerAsync(root, expectedMaterializedRevisionId, verified.sourceHash, now());

        return { status: 'completed', treeHash: verified.sourceHash };
      } finally {
        await release();
      }
    },
  };
}
