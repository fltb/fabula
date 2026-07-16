// ============================================================================
// MemoryStorage — in-memory Storage implementation for tests
// Backed by a Map<string, string> for file contents and a Set<string> for
// directory entries. All paths are stored without a leading or trailing slash
// to keep the implementation simple and path-agnostic (absolute vs relative).
// ============================================================================

import type { DirEntry, Storage } from './types.ts';

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
    this.files.delete(p);
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
}
