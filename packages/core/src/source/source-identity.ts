// ============================================================================
// Pure source identity — the single canonical content-hash implementation for
// ProjectSourceSnapshotV1.
//
// Core source analysis, Node Host materializers, and test fixtures all consume
// this module; no other code path may re-derive the sourceHash formula.
// Identity is derived only from sorted logical POSIX paths and UTF-8 source
// bytes: equal paths + equal bytes => equal sourceHash regardless of
// materializer, and any byte change changes the hash. Host roots, Git
// provenance, actors, and timestamps never participate.
// ============================================================================

import { sha256 } from '../cache/pure-sha256.js';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../contracts/source.js';

/** UTF-16 code-unit lexicographic ordering, locale-independent and canonical. */
export function compareLogicalPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Content identity: SHA-256 of the raw UTF-8 bytes of `content`. */
export function computeSourceDocumentHash(content: string): string {
  return sha256(content);
}

/**
 * Canonical project source identity: SHA-256 over sorted logical POSIX paths
 * and content hashes. Documents are assumed already canonically ordered; the
 * hash material is `path\0contentHash\0` per document, joined in that order.
 */
export function computeSourceHash(documents: readonly SourceDocumentV1[]): string {
  return sha256(documents.map((document) => `${document.logicalPath}\0${document.contentHash}\0`).join(''));
}

/** Build a canonical snapshot: documents sorted by logicalPath plus the content-only sourceHash. */
export function buildSourceSnapshot(documents: readonly SourceDocumentV1[]): ProjectSourceSnapshotV1 {
  const sorted = [...documents].sort((a, b) => compareLogicalPaths(a.logicalPath, b.logicalPath));
  return { version: 1, documents: sorted, sourceHash: computeSourceHash(sorted) };
}
