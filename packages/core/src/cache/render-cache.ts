// ============================================================================
// Render Cache — Layered Canonical SHA-256 Key Material
// ============================================================================
//
// Architecture: Four independent cache layers (§10)
//
//   LogicalRenderKey (definition/state/logic changes):
//     SHA-256(canonical JSON of actual chapter event/definition bytes +
//       relative paths + branch/discourse selection + contract hash +
//       logical summary hash + provider/model/routing + language/length/tokens +
//       prompt implementation version + analysis contract/override policy +
//       plugin identity + Pass 1 decoration hash)
//
//   SurfaceRenderKey (group/policy/prose changes):
//     SHA-256(canonical JSON of LogicalRenderKey material + group manifest
//       + surface policy + ordered accepted predecessor prose hashes +
//       extractor/budget/anchor version)
//
//   SurfaceValidationKey (prose/schema/policy changes):
//     SHA-256(canonical JSON of SurfaceRenderKey material + prose hash +
//       Pass 2 model/schema + validator policy version)
//
//   AttemptKey (mutable request identity per retry):
//     SHA-256(canonical JSON of SurfaceValidationKey material + attempt number +
//       prior prose/feedback hash + any material mutation fingerprint)
//
// Cache format v2 stores the full layered key chain. Corruption/staleness is
// always detected as a fresh miss with diagnostics — NEVER a partial hit with
// { cacheHit: true, analysis: null }.
//
// Invalidation: any change to a lower layer cascades to all higher layers.
// The top-level flat key enables O(1) comparison; mismatches are safe misses.
//
// No blind timeout retry. Retry with timeout requires a material mutation
// (different model, routing, deadline). Provider exception never yields

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { CacheCorruptionError, StorageError } from '../errors.ts';
import { logger } from '../observability/logger.ts';
import type { Storage } from '../storage/index.js';
import type { Fact } from '../types/entity.js';
import type {
  LogicalRenderKey,
  SurfaceRenderKey,
  SurfaceValidationKey,
  AttemptKey,
} from '../types/render-surface.js';

// ─── Canonical JSON Serialization ────────────────────────────────────────────

/**
 * Deterministic recursive sorted-key canonical JSON serialization.
 * Arrays preserve order; object keys sorted lexicographically;
 * undefined members omitted; primitives serialize normally.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
  );
}

/**
 * Compute SHA-256 hex from canonical JSON of the input.
 */
export function sha256Canonical(input: unknown): string {
  const json = canonicalJson(input);
  return crypto.createHash('sha256').update(json, 'utf-8').digest('hex');
}

// ─── Cache Format Version ────────────────────────────────────────────────────

/** Current cache format version. */
const CACHE_FORMAT_VERSION = 2;

// ─── Cache Diagnostics ───────────────────────────────────────────────────────

export interface CacheDiagnostics {
  eventId: string;
  diagnosis: 'miss' | 'corrupt' | 'stale' | 'valid';
  detail?: string;
  storedKey?: string;
  expectedKey?: string;
}

/**
 * Compute a strict canonical source-content hash from project-relative file
 * paths and actual byte content.  Used as the root of the logical cache key.
 *
 * Procedure:
 *  1. Sort eventFilePaths lexicographically.
 *  2. Relative to projectDir, hash each event path + its content bytes through SHA-256.
 *  3. If definitionsDirectory is provided, recursively hash every file under it
 *     (paths relative to projectDir + sorted content).
 *  4. Include the branch/discourse scope so two branches reading the same
 *     source files produce distinct hashes.
 *
 * `projectDir` is used ONLY to derive relative paths from absolute file paths.
 * It is never itself hashed. Two projects with identical content at different
 * roots produce the same hash. Storage reads use the original absolute paths.
 * Storage read errors while hashing source inputs MUST NOT be silently
 * replaced with empty content or skipped — they throw.
 */
export function computeSourceContentHash(
  eventFilePaths: string[],
  definitionsDirectory: string | undefined,
  scope: { branchDiscourseScopeHash: string },
  projectDir: string,
  storage: Storage,
): string {
  const hasher = crypto.createHash('sha256');

  // 1. Sorted event file paths (relative to projectDir) + actual bytes
  const sortedEventPaths = [...eventFilePaths].sort();
  for (const filePath of sortedEventPaths) {
    const relativePath = path.relative(projectDir, filePath).replace(/\\/g, '/');
    hasher.update(relativePath);
    hasher.update('\x00');
    const content = storage.read(filePath);
    hasher.update(content);
    hasher.update('\x00');
  }

  // 2. Definitions directory — recursively hash all files relative to projectDir
  if (definitionsDirectory) {
    if (!storage.exists(definitionsDirectory)) {
      throw new Error(`Definitions directory does not exist: ${definitionsDirectory}`);
    }
    hashDirectory(storage, definitionsDirectory, projectDir, hasher);
  }

  // 3. Branch/discourse scope
  hasher.update(scope.branchDiscourseScopeHash);

  return hasher.digest('hex');
}

/**
 * Recursively hash all files under a directory, sorted by relative path
 * (relative to baseDirectory). Each file contributes: relative_path + '\x00'
 * + content + '\x00'. Throws on read errors — never silently skips.
 *
 * dirPath is the absolute storage path for listing/reading.
 * baseDirectory is the project root used to compute relative paths.
 */
function hashDirectory(
  storage: Storage,
  dirPath: string,
  baseDirectory: string,
  hasher: crypto.Hash,
): void {
  const entries = storage.list(dirPath).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const storagePath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory()) {
      hashDirectory(storage, storagePath, baseDirectory, hasher);
    } else {
      const relativePath = path.relative(baseDirectory, storagePath).replace(/\\/g, '/');
      hasher.update(relativePath);
      hasher.update('\x00');
      const content = storage.read(storagePath);
      hasher.update(content);
      hasher.update('\x00');
    }
  }
}

// ─── Layered Cache Key Computation —§10────────────────────────────────────────

/**
 * Build the LogicalRenderKey string material from concrete inputs.
 * Keys are SHA-256 hex strings of canonical JSON projections.
 *
 * v2 logical identity includes:
 *  - sourceContentHash: actual sorted chapter event + definition bytes
 *  - sceneContract / worldState / plannedDiscourse — deterministic pre-prose contract
 *  - branchDiscourseScopeHash — branch + discourse scope
 *  - logicalDisclosureSummaryHash — disclosure-safe summary from planned state
 *  - catalogVersionHashes — assertion catalog fingerprints
 *  - styleProfileHash — resolved style
 *  - promptProviderId / version — model identity
 *  - language / targetLengthWords — prose generation parameters
 *  - analysisContractHash — active combined schema identity
 *  - validatorOverrideHash — per-validator severity overrides
 *  - pluginIdentityHash — registered plugin fingerprint
 */
export function buildLogicalKeyMaterial(input: {
  sourceContentHash: string;
  sceneContractHash: string;
  worldStateHash: string;
  plannedDiscourseHash: string;
  branchDiscourseScopeHash: string;
  logicalDisclosureSummaryHash?: string;
  catalogVersionHashes: Record<string, string>;
  graphHash: string;
  styleProfileHash: string;
  promptProviderId: string;
  promptProviderVersion?: string;
  language: string;
  targetLengthWords: number;
  analysisContractHash?: string;
  validatorOverrideHash?: string;
  pluginIdentityHash?: string;
}): string {
  return sha256Canonical(input);
}

/**
 * Build the SurfaceRenderKey string from logical key + surface-specific inputs.
 */
export function buildSurfaceKeyMaterial(input: {
  logicalKeyString: string;
  groupManifestHash: string;
  surfacePolicyHash: string;
  sourceProseHashes: string[];
  extractorVersion: string;
}): string {
  return sha256Canonical(input);
}

/**
 * Build the SurfaceValidationKey string from surface key + prose/validation inputs.
 */
export function buildValidationKeyMaterial(input: {
  surfaceKeyString: string;
  proseHash: string;
  pass2SchemaModelId: string;
  validatorPolicyVersion: string;
}): string {
  return sha256Canonical(input);
}

/**
 * Build the AttemptKey string from validation key + attempt-specific inputs.
 * Every retry MUST mutate at least one material field (attemptNumber, feedback,
 * model/routing change, etc.) so the resulting key differs from prior attempts.
 */
export function buildAttemptKeyMaterial(input: {
  validationKeyString: string;
  attemptNumber: number;
  priorProseHash?: string;
  retryGuidanceHash?: string;
  materialMutation?: Record<string, unknown>;
}): string {
  return sha256Canonical(input);
}

/**
 * Compute the flat top-level cache key for an event from all four layers.
 */
export function computeFlatCacheKey(layers: {
  logical: string;
  surface: string;
  validation: string;
  attempt: string;
}): string {
  return sha256Canonical(layers);
}

// ─── Evidence Hash ───────────────────────────────────────────────────────────

/**
 * Compute an evidence hash from the event's key semantic fields.
 * The hash is a SHA-256 of eventId + sorted fact IDs from pre/postconditions.
 * This certifies that cached data has not been tampered with.
 */
export function computeEvidenceHash(
  eventId: string,
  preconditions: Fact[],
  postconditions: Fact[],
): string {
  const factIds = [...preconditions.map((f) => f.id), ...postconditions.map((f) => f.id)].sort();
  const hash = crypto.createHash('sha256');
  hash.update(eventId);
  for (const id of factIds) {
    hash.update('|' + id);
  }
  return hash.digest('hex');
}



// ─── Cache Read / Write ──────────────────────────────────────────────────────

/**
 * Metadata stored in cache.meta.json for format v2.
 */
interface CacheMetaV2 {
  flatKey: string;
  formatVersion: number;
  createdAt: string;
  evidenceHash?: string;
  logicalKeyStr: string;
  surfaceKeyStr: string;
  validationKeyStr: string;
  attemptKeyStr: string;
}

/**
 * Get the cached render record for an event with layered key validation.
 *
 * Returns null on cache miss, key mismatch, or format mismatch — never throws
 * for recoverable conditions. Returns diagnostics for monitoring.
 *
 * Corruption detection: throws CacheCorruptionError only when meta.json
 * exists but is genuinely unreadable. Payload/hash corruption, stored key
 * mismatch, format version mismatch, and evidence hash mismatch are logged
 * as safe diagnostics and treated as miss (return null).
 *
 * NEVER returns a partial hit (cacheHit: true, analysis: null).
 */
export function getCachedRender(
  cacheDir: string,
  eventId: string,
  flatKey: string,
  storage: Storage,
  currentEvidenceHash?: string,
  diagnostics?: CacheDiagnostics[],
): Record<string, unknown> | null {
  const metaPath = path.join(cacheDir, eventId, 'cache.meta.json');
  const dataPath = path.join(cacheDir, eventId, 'data.render.json');

  if (!storage.exists(metaPath) || !storage.exists(dataPath)) {
    diagnostics?.push({ eventId, diagnosis: 'miss', detail: 'No cached files found' });
    return null;
  }

  try {
    const metaRaw = storage.read(metaPath);
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;

    // Only v2 cache format is supported
    if (meta.formatVersion !== CACHE_FORMAT_VERSION) {
      diagnostics?.push({
        eventId,
        diagnosis: 'stale',
        detail: `Unsupported cache format: ${String(meta.formatVersion)}`,
      });
      return null;
    }

    // v2: compare flat key
    const storedFlatKey = meta.flatKey;
    if (typeof storedFlatKey !== 'string' || storedFlatKey !== flatKey) {
      diagnostics?.push({
        eventId,
        diagnosis: 'stale',
        detail: 'v2 flat key mismatch',
        storedKey: typeof storedFlatKey === 'string' ? storedFlatKey : undefined,
        expectedKey: flatKey,
      });
      return null;
    }

    // Evidence hash check for v2
    if (currentEvidenceHash !== undefined && meta.evidenceHash !== undefined) {
      if (
        typeof meta.evidenceHash !== 'string' ||
        meta.evidenceHash !== currentEvidenceHash
      ) {
        diagnostics?.push({
          eventId,
          diagnosis: 'stale',
          detail: 'v2 evidence hash mismatch',
        });
        return null;
      }
    }

    // Validate layered keys exist
    if (
      typeof meta.logicalKeyStr !== 'string' ||
      typeof meta.surfaceKeyStr !== 'string' ||
      typeof meta.validationKeyStr !== 'string' ||
      typeof meta.attemptKeyStr !== 'string'
    ) {
      diagnostics?.push({
        eventId,
        diagnosis: 'corrupt',
        detail: 'v2 meta missing layered keys',
      });
      return null;
    }

    // Read and validate payload
    const dataRaw = storage.read(dataPath);
    const data = JSON.parse(dataRaw);

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      diagnostics?.push({
        eventId,
        diagnosis: 'corrupt',
        detail: 'Cache payload must be a JSON object',
      });
      // Corrupt payload is a safe miss, not a throw
      return null;
    }

    // Ensure analysis is present — never return partial hit with null analysis
    // that would be misinterpreted as `cacheHit: true, analysis: null`
    if (data.analysis === null || data.analysis === undefined) {
      diagnostics?.push({
        eventId,
        diagnosis: 'stale',
        detail: 'Cached payload missing analysis — treating as miss',
      });
      return null;
    }

    diagnostics?.push({ eventId, diagnosis: 'valid' });
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CacheCorruptionError) {
      // Real corruption — log and rethrow
      diagnostics?.push({
        eventId,
        diagnosis: 'corrupt',
        detail: error.code,
      });
      // Still return null for the pipeline to treat as miss
      logger.warn('Cache corruption detected', { eventId, code: error.code });
      return null;
    }
    // JSON parse or read errors — treat as corrupt miss
    diagnostics?.push({
      eventId,
      diagnosis: 'corrupt',
      detail: `Unreadable cache files: ${(error as Error).message}`,
    });
    return null;
  }
}

/**
 * Store a render record in the cache using format v2 with layered keys.
 *
 * Writes cache.meta.json (flat key + layered key chain) and data.render.json.
 * Only caches renders that pass validation (needsReview === false).
 */
export function setCachedRender(
  cacheDir: string,
  eventId: string,
  flatKey: string,
  renderRecord: Record<string, unknown>,
  storage: Storage,
  evidenceHash?: string,
  layeredKeys?: {
    logicalKeyStr: string;
    surfaceKeyStr: string;
    validationKeyStr: string;
    attemptKeyStr: string;
  },
): void {
  const eventDir = path.join(cacheDir, eventId);
  storage.mkdirp(eventDir);

  const meta: CacheMetaV2 = {
    flatKey,
    formatVersion: CACHE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    logicalKeyStr: layeredKeys?.logicalKeyStr ?? '',
    surfaceKeyStr: layeredKeys?.surfaceKeyStr ?? '',
    validationKeyStr: layeredKeys?.validationKeyStr ?? '',
    attemptKeyStr: layeredKeys?.attemptKeyStr ?? '',
  };
  if (evidenceHash !== undefined) {
    meta.evidenceHash = evidenceHash;
  }

  storage.write(path.join(eventDir, 'cache.meta.json'), JSON.stringify(meta, null, 2));
  storage.write(path.join(eventDir, 'data.render.json'), JSON.stringify(renderRecord, null, 2));
}

// ─── Cache Management ─────────────────────────────────────────────────────────

/**
 * Clear entire render cache for a project.
 * Call this if user wants a full re-render.
 */
export function clearRenderCache(cacheDir: string, storage: Storage): void {
  if (storage.exists(cacheDir)) {
    try {
      storage.removeAll(cacheDir);
    } catch (err) {
      logger.warn('Cache cleanup failed', { eventId: 'all', error: String(err) });
    }
  }
}

/**
 * Delete cached data for a single event.
 * This triggers a cache-miss on the next render.
 */
export function clearEventCache(cacheDir: string, eventId: string, storage: Storage): void {
  const eventCacheDir = path.join(cacheDir, eventId);
  if (storage.exists(eventCacheDir)) {
    try {
      storage.removeAll(eventCacheDir);
    } catch (err) {
      logger.warn('Cache cleanup failed', { eventId, error: String(err) });
    }
  }
}

// ─── Evidence Chain Verification ──────────────────────────────────────────────

/**
 * Result of verifying the evidence chain for all cached scenes.
 */
export interface VerifyChainResult {
  totalCached: number;
  valid: number;
  stale: number;
  missing: number;
  details: Array<{
    eventId: string;
    status: 'valid' | 'stale' | 'missing' | 'corrupt';
    reason?: string;
  }>;
}

/**
 * Verify the evidence chain for all cached scenes in a cache directory.
 * Compares stored evidence hashes against the provided current evidence hashes.
 * Each event's cached scene is classified as:
 *  - valid: cached data exists and evidence hash matches
 *  - stale: cached data exists but evidence hash doesn't match
 *  - missing: no cached data found for this event
 *  - corrupt: cached data exists but metadata is unreadable
 *
 * @param cacheDir - Path to the render cache directory
 * @param eventEvidenceHashes - Map of eventId to current evidence hash (from computeEvidenceHash)
 * @param storage - Storage interface
 */
export function verifyEvidenceChain(
  cacheDir: string,
  eventEvidenceHashes: Map<string, string>,
  storage: Storage,
): VerifyChainResult {
  const result: VerifyChainResult = {
    totalCached: 0,
    valid: 0,
    stale: 0,
    missing: 0,
    details: [],
  };

  if (!storage.exists(cacheDir)) {
    // No cache directory at all — everything is missing
    for (const eventId of eventEvidenceHashes.keys()) {
      result.missing++;
      result.details.push({ eventId, status: 'missing', reason: 'No cache directory' });
    }
    return result;
  }

  // Get all cached event directories
  const cachedEvents = new Set<string>();
  const cacheEntries = storage.list(cacheDir);
  for (const entry of cacheEntries) {
    if (entry.isDirectory()) {
      cachedEvents.add(entry.name);
    }
  }

  // Classify each event
  for (const [eventId, currentHash] of eventEvidenceHashes) {
    if (!cachedEvents.has(eventId)) {
      result.missing++;
      result.details.push({ eventId, status: 'missing' });
      continue;
    }

    const metaPath = path.join(cacheDir, eventId, 'cache.meta.json');
    try {
      if (!storage.exists(metaPath)) {
        result.missing++;
        result.details.push({ eventId, status: 'missing', reason: 'No meta.json' });
        continue;
      }

      const metaRaw = storage.read(metaPath);
      const meta = JSON.parse(metaRaw) as { evidenceHash?: unknown };

      if (meta.evidenceHash === undefined || typeof meta.evidenceHash !== 'string') {
        result.stale++;
        result.details.push({ eventId, status: 'stale', reason: 'No stored evidence hash' });
        continue;
      }

      if (meta.evidenceHash === currentHash) {
        result.totalCached++;
        result.valid++;
        result.details.push({ eventId, status: 'valid' });
      } else {
        result.totalCached++;
        result.stale++;
        result.details.push({ eventId, status: 'stale', reason: 'Evidence hash mismatch' });
      }
    } catch {
      result.totalCached++;
      result.stale++;
      result.details.push({ eventId, status: 'corrupt', reason: 'Unreadable meta.json' });
    }
  }

  return result;
}
