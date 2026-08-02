import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  LayeredCacheKey,
  RenderCacheRecord,
  RenderCacheRepository,
} from '@novalistically/core';
import { renderCacheRecordSchema } from '@novalistically/core/schema';
import type { FileRenderCacheRepositoryOptions } from './types.js';

const CACHE_VERSION = 1;

/**
 * Filesystem implementation of Core's derived-only render cache port.
 *
 * The Core key is treated as opaque: it is serialized solely to derive a
 * filename and is never interpreted as a path. Runtime data lives below the
 * private `.nova` directory and is never an accepted execution artifact.
 */
export class FileRenderCacheRepository implements RenderCacheRepository {
  readonly #projectRoot: string;
  readonly #cacheDirectory: string;

  constructor(projectRoot: string, options: FileRenderCacheRepositoryOptions = {}) {
    this.#projectRoot = path.resolve(projectRoot);
    const relativeDirectory = options.relativeDirectory ?? path.join('.nova', 'render-cache');
    this.#cacheDirectory = path.resolve(this.#projectRoot, relativeDirectory);
    if (!isContained(this.#projectRoot, this.#cacheDirectory)) {
      throw new Error('Render cache directory escapes project root');
    }
  }

  async get(input: { readonly key: LayeredCacheKey }): Promise<RenderCacheRecord | null> {
    const file = this.#fileFor(input.key);
    try {
      await this.#assertSafeDirectory();
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const text = await fs.readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(text);
      const result = renderCacheRecordSchema.safeParse(parsed);
      if (!result.success || !sameKey(result.data.key, input.key) || result.data.version !== CACHE_VERSION) return null;
      return result.data;
    } catch (error) {
      if (isMissing(error)) return null;
      // Corruption, races, permission errors and malformed JSON are misses.
      return null;
    }
  }

  async put(input: { readonly key: LayeredCacheKey; readonly record: RenderCacheRecord }): Promise<void> {
    if (input.record.version !== CACHE_VERSION || !sameKey(input.record.key, input.key)) {
      throw new Error('Render cache record does not match its key or version');
    }
    const checked = renderCacheRecordSchema.safeParse(input.record);
    if (!checked.success) throw new Error('Invalid render cache record');

    await this.#assertSafeParents();
    await fs.mkdir(this.#cacheDirectory, { recursive: true, mode: 0o700 });
    await this.#assertSafeDirectory();
    const file = this.#fileFor(input.key);
    const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(checked.data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async remove(input: { readonly key: LayeredCacheKey }): Promise<void> {
    try {
      await fs.unlink(this.#fileFor(input.key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  #fileFor(key: LayeredCacheKey): string {
    const digest = createHash('sha256')
      .update(JSON.stringify(canonicalKey(key)), 'utf8')
      .digest('hex');
    const file = path.resolve(this.#cacheDirectory, `${digest}.json`);
    if (!isContained(this.#projectRoot, file) || !isContained(this.#cacheDirectory, file)) {
      throw new Error('Render cache path escapes project root');
    }
    return file;
  }

  async #assertSafeParents(): Promise<void> {
    const root = await fs.realpath(this.#projectRoot);
    const relative = path.relative(root, this.#cacheDirectory);
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Render cache path contains a symlink');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  async #assertSafeDirectory(): Promise<void> {
    const root = await fs.realpath(this.#projectRoot);
    const cache = await fs.realpath(this.#cacheDirectory);
    if (!isContained(root, cache)) throw new Error('Render cache directory escapes project root');
    const stat = await fs.lstat(this.#cacheDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Render cache directory is not a directory');
  }
}

const canonicalKey = (key: LayeredCacheKey) => ({
  version: key.version,
  sourceHash: key.sourceHash,
  layers: Object.fromEntries(Object.entries(key.layers).sort(([a], [b]) => a.localeCompare(b))),
});

const sameKey = (a: LayeredCacheKey, b: LayeredCacheKey): boolean => JSON.stringify(canonicalKey(a)) === JSON.stringify(canonicalKey(b));
const isContained = (root: string, target: string): boolean => target === root || target.startsWith(`${root}${path.sep}`);
const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
