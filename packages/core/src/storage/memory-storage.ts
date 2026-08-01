// ============================================================================
// MemoryStorage — in-memory Storage implementation for tests
// Backed by a Map<string, string> for file contents and a Set<string> for
// directory entries. All paths are stored without a leading or trailing slash
// to keep the implementation simple and path-agnostic (absolute vs relative).
// ============================================================================

import { StorageConflictError } from '../errors.ts';
import { computeContentHash, computeDirectoryManifestHash } from './hash.ts';
import type { DirEntry, Storage, StorageTransaction, StorageWrite } from './types.ts';

export class MemoryStorage implements Storage {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Normalise: strip leading and trailing slashes */
  private _norm(p: string): string {
    return p.replace(/^\/+|\/+$/g, '');
  }

  /** Ensure parent directory entries exist for a given file path */
  private _ensureParent(filePath: string): void {
    const n = this._norm(filePath);
    const parts = n.split('/');
    parts.pop(); // remove filename
    let current = '';
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      this.dirs.add(current);
    }
  }

  // ── Storage implementation ─────────────────────────────────────────────────

  exists(filePath: string): boolean {
    const p = this._norm(filePath);
    return this.files.has(p) || this.dirs.has(p);
  }

  read(filePath: string): string {
    const p = this._norm(filePath);
    if (!this.files.has(p)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return this.files.get(p)!;
  }

  readOptional(filePath: string): string | null {
    const p = this._norm(filePath);
    return this.files.get(p) ?? null;
  }

  write(filePath: string, content: string): void {
    const p = this._norm(filePath);
    this._ensureParent(p);
    this.files.set(p, content);
  }

  commitBatch(transaction: StorageTransaction): void {
    // ── 1. Validate read expectations ─────────────────────────────────
    for (const expectation of transaction.readSet) {
      if (expectation.kind === 'file') {
        this._checkFileExpectation(expectation);
      } else if (expectation.kind === 'directory') {
        this._checkDirectoryExpectation(expectation);
      }
    }

    // ── 2. Validate write preimages ───────────────────────────────────
    const seenPaths = new Set<string>();
    for (const write of transaction.writes) {
      if (seenPaths.has(write.path)) {
        throw new Error(
          `Duplicate write path in transaction ${transaction.transactionId}: ${write.path}`,
        );
      }
      seenPaths.add(write.path);

      this._checkWritePreimage(write);
    }

    // ── 3. Apply all writes atomically ─────────────────────────────────
    const nextFiles = new Map(this.files);
    const nextDirs = new Set(this.dirs);

    for (const write of transaction.writes) {
      if (write.type === 'put') {
        const normalized = this._norm(write.path);
        const segments = normalized.split('/');
        segments.pop();
        let parent = '';
        for (const segment of segments) {
          if (!segment) continue;
          parent = parent ? `${parent}/${segment}` : segment;
          nextDirs.add(parent);
        }
        nextFiles.set(normalized, write.content!);
      } else if (write.type === 'delete') {
        const normalized = this._norm(write.path);
        nextFiles.delete(normalized);
      }
    }

    this.files = nextFiles;
    this.dirs = nextDirs;
  }
  /** Throw StorageConflictError if a file expectation is stale. */
  private _checkFileExpectation(expectation: {
    kind: 'file';
    path: string;
    expectedHash: string | null;
  }): void {
    const p = this._norm(expectation.path);
    const current = this.files.get(p) ?? null;
    const currentHash = current !== null ? computeContentHash(current) : null;

    if (currentHash !== expectation.expectedHash) {
      throw new StorageConflictError(`File expectation mismatch: ${expectation.path}`, {
        path: expectation.path,
      });
    }
  }

  /** Throw StorageConflictError if a directory manifest is stale. */
  private _checkDirectoryExpectation(expectation: {
    kind: 'directory';
    path: string;
    expectedManifestHash: string;
  }): void {
    const currentHash = computeDirectoryManifestHash(this, expectation.path);
    if (currentHash !== expectation.expectedManifestHash) {
      throw new StorageConflictError(`Directory expectation mismatch: ${expectation.path}`, {
        path: expectation.path,
      });
    }
  }

  /** Throw StorageConflictError if a write preimage doesn't match. */
  private _checkWritePreimage(write: StorageWrite): void {
    const p = this._norm(write.path);
    const current = this.files.get(p) ?? null;
    const currentHash = current !== null ? computeContentHash(current) : null;

    if (write.expectedHash === null) {
      // null expectedHash = create-only for put: file must not exist
      if (write.type === 'put' && currentHash !== null) {
        throw new StorageConflictError(
          `Write preimage mismatch for ${write.path}: expected file absent but it exists`,
          { path: write.path },
        );
      }
      // delete with null expectedHash: no guard (delete-if-exists)
      return;
    }

    // String hash: exact match required
    if (currentHash !== write.expectedHash) {
      throw new StorageConflictError(`Write preimage mismatch for ${write.path}`, {
        path: write.path,
      });
    }
  }

  mkdirp(dirPath: string): void {
    const p = this._norm(dirPath);
    if (!p) return; // root
    const parts = p.split('/');
    let current = '';
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      this.dirs.add(current);
    }
  }

  list(dirPath: string): DirEntry[] {
    const p = this._norm(dirPath);
    const prefix = p ? `${p}/` : '';
    const entries: DirEntry[] = [];
    const seen = new Set<string>();

    // Helper: add an entry unless already seen
    const addEntry = (name: string, isFile: boolean) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      entries.push({
        name,
        isFile: () => isFile,
        isDirectory: () => !isFile,
      });
    };

    // Scan files
    for (const filePath of this.files.keys()) {
      if (prefix) {
        if (filePath.startsWith(prefix)) {
          const rest = filePath.slice(prefix.length);
          const name = rest.split('/')[0];
          addEntry(name, !rest.includes('/'));
        }
      } else {
        // listing root — top-level entries only
        const name = filePath.split('/')[0];
        addEntry(name, !filePath.includes('/'));
      }
    }

    // Scan directories
    for (const dirPathEntry of this.dirs) {
      if (prefix) {
        if (dirPathEntry.startsWith(prefix)) {
          const rest = dirPathEntry.slice(prefix.length);
          const name = rest.split('/')[0];
          addEntry(name, false);
        }
      } else {
        const name = dirPathEntry.split('/')[0];
        addEntry(name, false);
      }
    }

    return entries;
  }

  listFiles(dirPath: string): string[] {
    return this.list(dirPath)
      .filter((e) => e.isFile())
      .map((e) => e.name);
  }

  remove(filePath: string): void {
    const p = this._norm(filePath);
    this.files.delete(p); // no-op if missing
  }

  removeAll(dirPath: string): void {
    const p = this._norm(dirPath);
    const prefix = p ? `${p}/` : '';

    // Remove files
    for (const filePath of [...this.files.keys()]) {
      if (filePath === p || filePath.startsWith(prefix)) {
        this.files.delete(filePath);
      }
    }

    // Remove directories
    for (const dirPathEntry of [...this.dirs]) {
      if (dirPathEntry === p || dirPathEntry.startsWith(prefix)) {
        this.dirs.delete(dirPathEntry);
      }
    }
  }

  resolvePath(filePath: string): string {
    // POSIX‑style virtual resolution: normalize `/../` and `/./` segments.
    const normalized = filePath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    const parts = normalized.split('/').filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        if (resolved.length > 0) resolved.pop();
        continue;
      }
      resolved.push(part);
    }
    return '/' + resolved.join('/');
  }
}
