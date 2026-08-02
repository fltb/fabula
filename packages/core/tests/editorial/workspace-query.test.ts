// ============================================================================
// EditorialWorkspace — read-only source snapshot query facade tests
//
// All tests operate on immutable ProjectSourceSnapshotV1 values with
// deterministic SHA-256 content hashes and sorted logical documents. No
// filesystem, host paths, or network access.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ProjectSourceSnapshotV1,
  SourceChangeV1,
  SourceDocumentV1,
} from '../../src/contracts/source.ts';
import { getSourceDocument, listSourceDocuments } from '../../src/editorial/facade.ts';
import { QueryService } from '../../src/editorial/query-service.ts';
import { EditorialWorkspace, getEditorialWorkspace } from '../../src/editorial/workspace.ts';
import { buildSourceSnapshot, compareLogicalPaths } from '../../src/source/source-identity.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function document(logicalPath: string, content: string): SourceDocumentV1 {
  return {
    version: 1,
    logicalPath,
    content,
    contentHash: hash(content),
    parseResult: { status: 'parsed', value: { value: content } },
    diagnostics: [],
  };
}

/** Build an immutable snapshot from logical text; documents are sorted and hashes are deterministic. */
function snapshot(entries: Record<string, string>): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot(
    Object.entries(entries).map(([logicalPath, content]) => document(logicalPath, content)),
  );
}

const FULL_PROJECT: Record<string, string> = {
  'nova.yaml': 'title: "Test Novel"\n',
  'definitions/characters/hero.yaml': 'name: "Hero"\n',
  'chapters/chapter_01/_chapter.yaml': 'title: "Chapter 1"\n',
  'chapters/chapter_01/E001.yaml': 'event: E001\n',
  'chapters/chapter_01/E002.yaml': 'event: E002\n',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EditorialWorkspace — snapshot query facade', () => {
  describe('listSources / getSource', () => {
    it('lists all project source documents sorted by logical path', () => {
      const ws = getEditorialWorkspace(snapshot(FULL_PROJECT));

      const paths = ws.listSources().map((s) => s.logicalPath);
      expect(paths).toEqual([...paths].sort(compareLogicalPaths));
      expect(paths).toContain('nova.yaml');
      expect(paths).toContain('definitions/characters/hero.yaml');
      expect(paths).toContain('chapters/chapter_01/E002.yaml');
    });

    it('gets a single source document by logical path', () => {
      const ws = getEditorialWorkspace(snapshot(FULL_PROJECT));

      const doc = ws.getSource('nova.yaml');
      expect(doc).not.toBeNull();
      expect(doc!.logicalPath).toBe('nova.yaml');
      expect(doc!.contentHash).toBe(hash('title: "Test Novel"\n'));
    });

    it('returns null for a missing document', () => {
      const ws = getEditorialWorkspace(snapshot({ 'nova.yaml': 'title: Test\n' }));
      expect(ws.getSource('nonexistent.yaml')).toBeNull();
    });
  });

  describe('immutable snapshot contract', () => {
    it('exposes sourceHash and sorted documents for the materialized snapshot', () => {
      const src = snapshot(FULL_PROJECT);
      const ws = new EditorialWorkspace(src);

      const value = ws.snapshotValue();
      expect(value.version).toBe(1);
      expect(value.sourceHash).toBe(src.sourceHash);
      expect(value.documents).toEqual(src.documents);
    });

    it('identical bytes produce identical sourceHash; one byte change invalidates it', () => {
      const a = snapshot(FULL_PROJECT);
      const b = snapshot(FULL_PROJECT);
      expect(b.sourceHash).toBe(a.sourceHash);

      const changed = snapshot({
        ...FULL_PROJECT,
        'chapters/chapter_01/E001.yaml': 'event: E001\nnarrativeOrder: 1\n',
      });
      expect(changed.sourceHash).not.toBe(a.sourceHash);
    });

    it('survives JSON round-trip', () => {
      const ws = getEditorialWorkspace(snapshot(FULL_PROJECT));

      const value = ws.snapshotValue();
      const parsed = JSON.parse(JSON.stringify(value)) as ProjectSourceSnapshotV1;
      expect(parsed.sourceHash).toBe(value.sourceHash);
      expect(parsed.documents).toEqual(value.documents);
      expect(parsed.documents).toHaveLength(Object.keys(FULL_PROJECT).length);
    });
  });

  describe('facade read helpers', () => {
    it('lists and resolves documents through the facade', () => {
      const src = snapshot(FULL_PROJECT);

      expect(listSourceDocuments(src)).toEqual(src.documents);
      expect(getSourceDocument(src, 'nova.yaml').content).toBe('title: "Test Novel"\n');
      expect(() => getSourceDocument(src, 'missing.yaml')).toThrow('Source document not found');
    });
  });

  describe('QueryService — error-safe wrapper', () => {
    it('wraps snapshot queries in QueryResult', () => {
      const qs = new QueryService(snapshot(FULL_PROJECT));
      const result = qs.listSources();
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('returns not-found for a missing source document', () => {
      const qs = new QueryService(snapshot({ 'nova.yaml': 'title: Test\n' }));
      const result = qs.getSource('nonexistent.yaml');
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('SOURCE_DOCUMENT_NOT_FOUND');
    });

    it('returns a pure source analysis for a candidate change', () => {
      const base = snapshot(FULL_PROJECT);
      const qs = new QueryService(base);
      const change: SourceChangeV1 = {
        logicalPath: 'nova.yaml',
        beforeContent: 'title: "Test Novel"\n',
        beforeHash: hash('title: "Test Novel"\n'),
        afterContent: 'title: "Updated"\n',
        afterHash: hash('title: "Updated"\n'),
      };

      const result = qs.analyze([change]);
      expect(result.ok).toBe(true);
      const analysis = result.data!;
      expect(analysis.current.sourceHash).toBe(base.sourceHash);
      expect(analysis.changes).toHaveLength(1);
      const candidate = analysis.candidate.documents.find((d) => d.logicalPath === 'nova.yaml');
      expect(candidate).toBeDefined();
      expect(candidate!.content).toBe('title: "Updated"\n');
      expect(base.documents.find((d) => d.logicalPath === 'nova.yaml')!.content).toBe(
        'title: "Test Novel"\n',
      );
    });
  });
});
