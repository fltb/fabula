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
//   We use a hash chain: defsHash = sha256(all defs sorted by path)
//   For event 0: eventHash0 = sha256("event:" + fileContent + "|defs:" + defsHash)
//   For event N: eventHashN = sha256(eventHash{N-1} + "|event:" + fileContent + "|defs:" + defsHash)
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
import * as fs from 'node:fs';
import type { Storage } from '../storage/index.js';

/**
 * Hash event files in order to produce a deterministic chain.
 * eventsMap: Map<eventId, { narrativeOrder: number, filePath: string, chapter: number }>
 * defsDir: path to project's definitions/ directory
 * storage: FS abstraction
 */
export function computeCacheKeys(
  eventsMap: Map<string, { narrativeOrder: number; filePath: string; chapter: number }>,
  defsDir: string,
  storage: Storage,
): Map<string, string> {
  // 1. Compute defs hash: all definition YAML files sorted by path
  const defsHash = computeDefsHash(defsDir, storage);

  // 2. Sort events by narrative order
  const sorted = [...eventsMap.entries()].sort(
    (a, b) => a[1].narrativeOrder - b[1].narrativeOrder,
  );

  // 3. Chain hash
  const result = new Map<string, string>();
  let prevHash = '';
  for (const [eventId, info] of sorted) {
    const eventContent = storage.read(info.filePath);
    const eventContentHash = crypto
      .createHash('sha256')
      .update(eventContent)
      .digest('hex');

    const combined = prevHash + '|' + eventContentHash + '|' + defsHash;
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
 */
export function getCachedRender(
  cacheDir: string,
  eventId: string,
  cacheKey: string,
  storage: Storage,
): Record<string, unknown> | null {
  const metaPath = path.join(cacheDir, eventId, 'cache.meta.json');
  const dataPath = path.join(cacheDir, eventId, 'data.render.json');

  if (!storage.exists(metaPath) || !storage.exists(dataPath)) {
    return null;
  }

  try {
    const metaRaw = storage.read(metaPath);
    const meta = JSON.parse(metaRaw) as { cacheKey: string };
    if (meta.cacheKey !== cacheKey) {
      return null; // Cache invalidated by source change
    }
    const dataRaw = storage.read(dataPath);
    return JSON.parse(dataRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Store a render record in the cache.
 * Writes both cache.meta.json (for fast key check) and data.render.json.
 */
export function setCachedRender(
  cacheDir: string,
  eventId: string,
  cacheKey: string,
  renderRecord: Record<string, unknown>,
  storage: Storage,
): void {
  const eventDir = path.join(cacheDir, eventId);
  // Ensure parent dir exists before writing
  storage.mkdirp(eventDir);
  storage.write(
    path.join(eventDir, 'cache.meta.json'),
    JSON.stringify({ cacheKey, createdAt: new Date().toISOString() }, null, 2),
  );
  storage.write(
    path.join(eventDir, 'data.render.json'),
    JSON.stringify(renderRecord, null, 2),
  );
}

/**
 * Clear entire render cache for a project.
 * Call this if user wants a full re-render.
 */
export function clearRenderCache(cacheDir: string, storage: Storage): void {
  if (storage.exists(cacheDir)) {
    try {
      storage.removeAll(cacheDir);
    } catch {
      // ignore
    }
  }
}
