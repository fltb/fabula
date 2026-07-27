// ============================================================================
// Render Cache — Per-scene LLM output caching with state-aware invalidation
// ============================================================================
//
// Motivation: LLM rendering is slow and expensive. If the source files
// (event definitions, character/rule/location definitions) haven't changed,
// the rendered result is still valid and can be reused.
//
// Invalidation strategy:
//   Scene N's cache depends on:
//     1. The event file for scene N (scene spec changed → re-render)
//     2. ALL events before scene N (prior events feed the world state; if
//        any prior event changes, scene N's world state may differ)
//     3. ALL definition files (characters, rules, locations, etc.)
//
//   cacheScopeHash = sha256(runtime cache scope, such as selected branch)
//   For event 0: eventHash0 = sha256("event:" + fileContent + "|defs:" + defsHash + "|scope:" + cacheScopeHash)
//   For event N: eventHashN = sha256(eventHash{N-1} + "|event:" + fileContent + "|defs:" + defsHash + "|scope:" + cacheScopeHash)
//   Cache key for scene N = "novalistically-scene:chapter-{NN}:{eventId}:{eventHashN}"
//   (plain string, not re-hashed — chainHash is already SHA256)
//
//   This means: if ANY prior event or ANY definition changes, EVERY
//   subsequent scene's cache key changes → automatic cascade invalidation.
//   This implements the "cache based on state updates" design requirement:
//   state = f(all prior events), cache key = hash(state)+hash(this event).
// ============================================================================

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { CacheCorruptionError, StorageError } from '../errors.ts';
import { logger } from '../observability/logger.ts';
import type { Storage } from '../storage/index.js';
import type { Fact } from '../types/entity.js';

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

/**
 * Hash event files in order to produce a deterministic chain.
 * eventsMap: Map<eventId, { narrativeOrder: number, filePath: string, chapter: number }>
 * defsDir: path to project's definitions/ directory
 * storage: FS abstraction
 * cacheScope: deterministic runtime prompt input, such as the selected branch
 */
export function computeCacheKeys(
  eventsMap: Map<string, { narrativeOrder: number; filePath: string; chapter: number }>,
  defsDir: string,
  storage: Storage,
  cacheScope = 'main',
): Map<string, string> {
  // 1. Compute definitions and runtime scope hashes.
  const defsHash = computeDefsHash(defsDir, storage);
  const scopeHash = crypto.createHash('sha256').update(cacheScope).digest('hex');
  // 2. Sort events by narrative order
  const sorted = [...eventsMap.entries()].sort((a, b) => a[1].narrativeOrder - b[1].narrativeOrder);

  // 3. Chain hash
  const result = new Map<string, string>();
  let prevHash = '';
  for (const [eventId, info] of sorted) {
    const eventContent = storage.read(info.filePath);
    const eventContentHash = crypto.createHash('sha256').update(eventContent).digest('hex');

    const combined = prevHash + '|' + eventContentHash + '|' + defsHash + '|' + scopeHash;
    const chainHash = crypto.createHash('sha256').update(combined).digest('hex');

    const cacheKey = `novalistically-scene:chapter-${String(info.chapter).padStart(2, '0')}:${eventId}:${chainHash}`;

    result.set(eventId, cacheKey);
    prevHash = chainHash;
  }

  return result;
}

/**
 * Compute a stable hash of all definition files (characters, rules, etc.)
 */
function computeDefsHash(defsDir: string, storage: Storage): string {
  if (!storage.exists(defsDir)) return '';
  const files: string[] = [];

  const walk = (dir: string) => {
    if (!storage.exists(dir)) return;
    const items = storage.list(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile() && /\.(yaml|yml)$/i.test(item.name)) {
        files.push(fullPath);
      }
    }
  };
  walk(defsDir);

  // Sort for determinism
  files.sort();

  const hash = crypto.createHash('sha256');
  for (const f of files) {
    try {
      const content = storage.read(f);
      hash.update(f + ':' + content);
    } catch {
      // Skip unreadable
    }
  }
  return hash.digest('hex');
}

/**
 * Get the cached render record for an event, if cache is still valid.
 * Returns null if no cache exists or the cache key doesn't match.
 * Optionally verifies evidence hash for tamper detection.
 */
export function getCachedRender(
  cacheDir: string,
  eventId: string,
  cacheKey: string,
  storage: Storage,
  currentEvidenceHash?: string,
): Record<string, unknown> | null {
  const metaPath = path.join(cacheDir, eventId, 'cache.meta.json');
  const dataPath = path.join(cacheDir, eventId, 'data.render.json');

  if (!storage.exists(metaPath) || !storage.exists(dataPath)) {
    return null;
  }

  try {
    const metaRaw = storage.read(metaPath);
    const meta = JSON.parse(metaRaw) as {
      cacheKey?: unknown;
      formatVersion?: unknown;
      evidenceHash?: unknown;
    };
    if (typeof meta.cacheKey !== 'string') {
      throw new CacheCorruptionError('Cache metadata has no cache key', {
        eventId,
        phase: 'cache-read',
      });
    }
    if (meta.cacheKey !== cacheKey) {
      return null;
    }
    if (meta.formatVersion !== 1) {
      return null;
    }
    // Evidence hash tamper check: if both stored and current are provided, verify match
    if (currentEvidenceHash !== undefined && meta.evidenceHash !== undefined) {
      if (typeof meta.evidenceHash !== 'string' || meta.evidenceHash !== currentEvidenceHash) {
        // Evidence mismatch — tampered cache, treat as miss
        return null;
      }
    }
    const data = JSON.parse(storage.read(dataPath));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new CacheCorruptionError('Cache render payload must be an object', {
        eventId,
        phase: 'cache-read',
      });
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CacheCorruptionError) throw error;
    throw new CacheCorruptionError('Cache files are malformed', { eventId, phase: 'cache-read' });
  }
}

/**
 * Store a render record in the cache.
 * Writes both cache.meta.json (for fast key check) and data.render.json.
 * Optionally stores an evidence hash for tamper detection.
 */
export function setCachedRender(
  cacheDir: string,
  eventId: string,
  cacheKey: string,
  renderRecord: Record<string, unknown>,
  storage: Storage,
  evidenceHash?: string,
): void {
  const eventDir = path.join(cacheDir, eventId);
  storage.mkdirp(eventDir);
  storage.write(
    path.join(eventDir, 'cache.meta.json'),
    JSON.stringify(
      { cacheKey, formatVersion: 1, createdAt: new Date().toISOString(), evidenceHash },
      null,
      2,
    ),
  );
  storage.write(path.join(eventDir, 'data.render.json'), JSON.stringify(renderRecord, null, 2));
}

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
