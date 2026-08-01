// ============================================================================
// OverlayStorage — read-only storage overlay for preview operations.
//
// Wraps a base Storage with proposed-change overrides. Paths are opaque and
// match the base Storage's convention (typically absolute filesystem paths).
// Provides read access for EntityMapper consumption and per-file metadata.
// ============================================================================

import { computeContentHash } from '../storage/hash.ts';
import type { DirEntry, Storage } from '../storage/types.ts';
import type { EditorialError } from '../types/editorial.ts';

// ─── OverlayDocument ─────────────────────────────────────────────────────────

export interface OverlayDocument {
  /** Path as stored in the storage backend (typically absolute). */
  path: string;
  /** Full UTF-8 content string. */
  content: string;
  /** sha256 hex of content. */
  hash: string;
  /** Parsed value (caller-provided parser), null if parse failed. */
  parsedValue: unknown;
  /** Diagnostics from the caller-provided parser. */
  diagnostics: EditorialError[];
  /** True when this path is overridden by the overlay. */
  tracked: boolean;
}

// ─── OverlayStorage ──────────────────────────────────────────────────────────

export class OverlayStorage {
  private readonly overlays = new Map<string, string | null>();

  constructor(private readonly base: Storage) {}

  // ── Overlay management ──────────────────────────────────────────────────

  /** Register proposed content. null = deletion. */
  setOverlay(filePath: string, content: string | null): void {
    this.overlays.set(filePath, content);
  }

  /** Remove a single overlay entry. */
  clearOverlay(filePath: string): void {
    this.overlays.delete(filePath);
  }

  /** Remove all overlay entries. */
  clearAll(): void {
    this.overlays.clear();
  }

  /** All paths that have an overlay entry. */
  overlayPaths(): string[] {
    return [...this.overlays.keys()];
  }

  /** True when path is overridden (including explicit deletion). */
  isOverlaid(filePath: string): boolean {
    return this.overlays.has(filePath);
  }

  // ── Storage-like read API (for EntityMapper consumption) ────────────────

  exists(filePath: string): boolean {
    if (this.overlays.has(filePath)) return (this.overlays.get(filePath) ?? null) !== null;
    return this.base.exists(filePath);
  }

  read(filePath: string): string {
    if (this.overlays.has(filePath)) {
      const v = this.overlays.get(filePath);
      if (v == null) throw new Error(`File not found (deleted in overlay): ${filePath}`);
      return v;
    }
    return this.base.read(filePath);
  }

  readOptional(filePath: string): string | null {
    if (this.overlays.has(filePath)) return this.overlays.get(filePath) ?? null;
    return this.base.readOptional(filePath);
  }

  /** List directory entries (files + subdirectories) at dirPath. */
  listDir(dirPath: string): DirEntry[] {
    const baseEntries = this.base.exists(dirPath) ? this.base.list(dirPath) : [];
    const seen = new Set(baseEntries.map((e) => e.name));
    const extra: DirEntry[] = [];
    for (const op of this.overlays.keys()) {
      const idx = op.lastIndexOf('/');
      const parent = idx === -1 ? '' : op.slice(0, idx);
      if (parent === dirPath || (dirPath === '' && parent === '')) {
        const name = idx === -1 ? op : op.slice(idx + 1);
        if (!seen.has(name)) {
          seen.add(name);
          extra.push({ name, isFile: () => true, isDirectory: () => false });
        }
      }
    }
    return [...baseEntries, ...extra];
  }

  listFiles(dirPath: string): string[] {
    return this.listDir(dirPath)
      .filter((e) => e.isFile())
      .map((e) => e.name);
  }

  /** Direct pass-through to base.list for EntityMapper. */
  list(dirPath: string): DirEntry[] {
    return this.listDir(dirPath);
  }

  resolvePath(filePath: string): string {
    return this.base.resolvePath(filePath);
  }

  // ── High-level document API ─────────────────────────────────────────────

  /** List every tracked overlay path as an OverlayDocument. */
  listOverlay(
    parseCallback?: (
      path: string,
      content: string,
    ) => { parsedValue: unknown; diagnostics: EditorialError[] },
  ): OverlayDocument[] {
    const docs: OverlayDocument[] = [];
    for (const [filePath, content] of this.overlays) {
      if (content !== null) {
        docs.push(this.buildDocument(filePath, content, true, parseCallback));
      }
    }
    docs.sort((a, b) => a.path.localeCompare(b.path));
    return docs;
  }

  /** Get a document by path from overlay (tracked=true) or base (tracked=false). */
  get(
    filePath: string,
    parseCallback?: (
      path: string,
      content: string,
    ) => { parsedValue: unknown; diagnostics: EditorialError[] },
  ): OverlayDocument {
    const tracked = this.overlays.has(filePath);
    const content = this.read(filePath);
    return this.buildDocument(filePath, content, tracked, parseCallback);
  }

  private buildDocument(
    filePath: string,
    content: string,
    tracked: boolean,
    parseCallback?: (
      path: string,
      content: string,
    ) => { parsedValue: unknown; diagnostics: EditorialError[] },
  ): OverlayDocument {
    const hash = computeContentHash(content);
    let parsedValue: unknown = content;
    const diagnostics: EditorialError[] = [];

    if (parseCallback) {
      const result = parseCallback(filePath, content);
      parsedValue = result.parsedValue;
      diagnostics.push(...result.diagnostics);
    }

    return { path: filePath, content, hash, parsedValue, diagnostics, tracked };
  }
}
