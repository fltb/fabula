/**
 * Immutable content-addressed bundle store for native revision source revisions.
 *
 * Bundles are stored under a configurable base path following the convention
 * `$basePath/projects/<projectId>/source-revisions/objects/sha256/<first-two>/<full-hash>`.
 * Each bundle is a JSON file containing the complete set of entries (logicalPath
 * + content) for one revision. Storage is write-once, read-many: the same
 * bundleHash always produces the same entries, and put() is idempotent.
 *
 * The store performs atomic writes (write-to-temp, fsync, rename) and verifies
 * content hash on read to detect corruption. It never exposes filesystem paths
 * to callers; only the bundleHash crosses the store boundary.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { AuthoringRevisionContentStore } from './types.js';

// ─── Bundle validation helpers ──────────────────────────────────────────────

/** Validate that a bundleHash looks like a lowercase SHA-256 hex digest. */
function assertBundleHash(bundleHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(bundleHash)) {
    throw new TypeError(`Bundle hash must be a lowercase sha256 hex digest, got: ${bundleHash}`);
  }
}

/** Validate that an entry shape is well-formed. */
function assertEntry(entry: { logicalPath: unknown; content: unknown }): void {
  if (typeof entry.logicalPath !== 'string' || entry.logicalPath.length === 0) {
    throw new TypeError('Each bundle entry must have a non-empty string logicalPath');
  }
  if (typeof entry.content !== 'string') {
    throw new TypeError('Each bundle entry must have a string content');
  }
}

/** Validate a parsed bundle value. */
function validateBundle(value: unknown): {
  readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Native revision bundle is malformed: expected an object');
  }
  const candidate = value as { entries?: unknown };
  if (!Array.isArray(candidate.entries)) {
    throw new Error('Native revision bundle is malformed: entries must be an array');
  }
  for (const entry of candidate.entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Native revision bundle entry is malformed: expected an object');
    }
    assertEntry(entry as { logicalPath: unknown; content: unknown });
  }
  return {
    entries: (candidate.entries as { logicalPath: string; content: string }[]).map((e) => ({
      logicalPath: e.logicalPath,
      content: e.content,
    })),
  };
}

function canonicalBundle(
  entries: readonly { readonly logicalPath: string; readonly content: string }[],
): string {
  const sorted = [...entries].sort((left, right) =>
    left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.logicalPath === sorted[index]?.logicalPath) {
      throw new TypeError(`Duplicate source bundle path: ${sorted[index]?.logicalPath}`);
    }
  }
  return JSON.stringify({
    entries: sorted.map((entry) => ({ logicalPath: entry.logicalPath, content: entry.content })),
  });
}

function _bundleHashFor(
  entries: readonly { readonly logicalPath: string; readonly content: string }[],
): string {
  return createHash('sha256').update(canonicalBundle(entries), 'utf8').digest('hex');
}

// ─── Path helpers ───────────────────────────────────────────────────────────

/**
 * Compute the on-disk path for a bundle object.
 * Conforms to: `<base>/projects/<projectId>/source-revisions/objects/sha256/<first-two>/<full-hash>.json`
 */
function objectPath(basePath: string, projectId: string, bundleHash: string): string {
  assertBundleHash(bundleHash);
  const firstTwo = bundleHash.slice(0, 2);
  return join(
    basePath,
    'projects',
    projectId,
    'source-revisions',
    'objects',
    'sha256',
    firstTwo,
    `${bundleHash}.json`,
  );
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface FileRevisionContentStoreOptions {
  /** Absolute base path for the store (typically $WORKBENCH_HOME). */
  readonly basePath: string;
}

/**
 * File-based implementation of AuthoringRevisionContentStore.
 *
 * Bundles are stored as JSON files under a content-addressed directory
 * structure. Each write is atomic: data is written to a temporary file with
 * exclusive-creation semantics, then atomically renamed to the final path.
 * On read, the bundle hash is verified against the file path.
 */
export function createFileRevisionContentStore(
  options: FileRevisionContentStoreOptions,
): AuthoringRevisionContentStore {
  const base = resolve(options.basePath);

  return {
    async put(input) {
      const { projectId, bundleHash, entries } = input;
      assertBundleHash(bundleHash);

      // Validate every entry before any I/O.
      for (const entry of entries) {
        assertEntry(entry as { logicalPath: unknown; content: unknown });
      }

      const payload = canonicalBundle(entries);
      const actualHash = createHash('sha256').update(payload, 'utf8').digest('hex');
      if (actualHash !== bundleHash) {
        throw new TypeError('Source revision bundle hash does not match canonical bundle content');
      }
      const dir = join(
        base,
        'projects',
        projectId,
        'source-revisions',
        'objects',
        'sha256',
        bundleHash.slice(0, 2),
      );
      const target = objectPath(base, projectId, bundleHash);

      // Check existing bytes too: idempotency must never accept corruption.
      try {
        const existing = validateBundle(JSON.parse(await readFile(target, 'utf8')) as unknown);
        if (
          createHash('sha256').update(canonicalBundle(existing.entries), 'utf8').digest('hex') !==
          bundleHash
        ) {
          throw new TypeError('Stored source revision bundle hash mismatch');
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async get(input) {
      const { projectId, bundleHash } = input;
      assertBundleHash(bundleHash);
      const target = objectPath(base, projectId, bundleHash);
      let raw: string;
      try {
        raw = await readFile(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const parsed = validateBundle(JSON.parse(raw) as unknown);
      if (
        createHash('sha256').update(canonicalBundle(parsed.entries), 'utf8').digest('hex') !==
        bundleHash
      ) {
        throw new TypeError('Stored source revision bundle hash mismatch');
      }
      return parsed;
    },
  };
}
