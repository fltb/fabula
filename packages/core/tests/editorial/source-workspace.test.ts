// ============================================================================
// SourceWorkspace — pure authored-source snapshot facade tests
//
// The workspace holds an immutable ProjectSourceSnapshotV1 and exposes
// read-only queries plus candidate analysis under SourceChangeV1 semantics:
// logical POSIX path allowlist/containment is enforced by pure rules, and
// changes are overlaid onto the snapshot as a candidate with diagnostics and
// affected event ids. No filesystem, host paths, revisions, heads, or
// persistence appear anywhere in the surface under test.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { SourceWorkspace } from '../../src/editorial/source-workspace.ts';
import { buildSourceSnapshot, computeSourceDocumentHash } from '../../src/source/source-identity.ts';
import type {
  ProjectSourceSnapshotV1,
  SourceChangeV1,
  SourceDocumentV1,
} from '../../src/contracts/source.ts';

function document(logicalPath: string, content: string): SourceDocumentV1 {
  return {
    version: 1,
    logicalPath,
    content,
    contentHash: computeSourceDocumentHash(content),
    parseResult: { status: 'parsed', value: {} },
    diagnostics: [],
  };
}

/** Build a canonical snapshot from logical text; sorted, with content-only hashes. */
function snapshot(entries: Record<string, string>): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot(Object.entries(entries).map(([logicalPath, content]) => document(logicalPath, content)));
}

function change(logicalPath: string, afterContent: string | null): SourceChangeV1 {
  return {
    logicalPath,
    beforeContent: null,
    beforeHash: null,
    afterContent,
    afterHash: afterContent === null ? null : computeSourceDocumentHash(afterContent),
  };
}

const CURRENT = snapshot({
  'nova.yaml': 'name: test\n',
  'chapters/chapter_01/E001.yaml': 'event: E001\n',
  'definitions/characters/hero.yaml': 'name: Hero\n',
});

describe('SourceWorkspace — pure source snapshot facade', () => {
  it('lists and reads documents from the immutable snapshot', () => {
    const ws = new SourceWorkspace(CURRENT);
    expect(ws.list().map((d) => d.logicalPath)).toEqual([
      'chapters/chapter_01/E001.yaml',
      'definitions/characters/hero.yaml',
      'nova.yaml',
    ]);
    expect(ws.get('nova.yaml')?.content).toBe('name: test\n');
    expect(ws.get('missing.yaml')).toBeNull();
  });

  it('analyzes value-level changes into a candidate snapshot without mutating current', () => {
    const ws = new SourceWorkspace(CURRENT);
    const result = ws.analyze([
      change('chapters/chapter_01/E002.yaml', 'event: E002\n'),
      change('definitions/characters/hero.yaml', null),
    ]);
    expect(result.current).toBe(CURRENT);
    expect(result.candidate.documents.map((d) => d.logicalPath)).toEqual([
      'chapters/chapter_01/E001.yaml',
      'chapters/chapter_01/E002.yaml',
      'nova.yaml',
    ]);
    expect(result.candidate.sourceHash).not.toBe(CURRENT.sourceHash);
    expect(result.affectedEventIds).toEqual(['E002']);
    expect(CURRENT.documents.map((d) => d.logicalPath)).toEqual([
      'chapters/chapter_01/E001.yaml',
      'definitions/characters/hero.yaml',
      'nova.yaml',
    ]);
  });

  it('rejects traversal, absolute, and non-allowlisted paths with pure logical rules', () => {
    const ws = new SourceWorkspace(CURRENT);
    const result = ws.analyze([
      change('../secret.yaml', 'x: 1\n'),
      change('/etc/passwd', 'root:x:0\n'),
      change('definitions\\characters\\evil.yaml', 'x: 1\n'),
      change('definitions/characters/../evil.yaml', 'x: 1\n'),
      change('notes/scratch.yaml', 'x: 1\n'),
      change('definitions/items/nested/a.yaml', 'x: 1\n'),
    ]);
    const invalid = result.diagnostics.filter((d) => d.code === 'SOURCE_PATH_INVALID');
    expect(invalid.map((d) => d.logicalPath)).toEqual([
      '../secret.yaml',
      '/etc/passwd',
      'definitions\\characters\\evil.yaml',
      'definitions/characters/../evil.yaml',
      'notes/scratch.yaml',
      'definitions/items/nested/a.yaml',
    ]);
    expect(result.candidate.documents).toEqual(CURRENT.documents);
    expect(result.candidate.sourceHash).toBe(CURRENT.sourceHash);
    expect(result.affectedEventIds).toEqual([]);
  });

  it('reports before-hash precondition mismatch while still producing a candidate', () => {
    const ws = new SourceWorkspace(CURRENT);
    const result = ws.analyze([
      {
        logicalPath: 'nova.yaml',
        beforeContent: 'name: stale\n',
        beforeHash: computeSourceDocumentHash('name: stale\n'),
        afterContent: 'name: next\n',
        afterHash: computeSourceDocumentHash('name: next\n'),
      },
    ]);
    expect(result.diagnostics.some((d) => d.code === 'SOURCE_PRECONDITION_MISMATCH')).toBe(true);
    expect(result.candidate.documents.find((d) => d.logicalPath === 'nova.yaml')?.content).toBe('name: next\n');
  });

  it('produces a byte-identical candidate for byte-identical changes', () => {
    const first = new SourceWorkspace(CURRENT).analyze([change('nova.yaml', 'name: same\n')]);
    const second = new SourceWorkspace(CURRENT).analyze([change('nova.yaml', 'name: same\n')]);
    expect(second.candidate.sourceHash).toBe(first.candidate.sourceHash);
    expect(second).toEqual(first);
  });

  it('keeps a no-op analysis byte-identical to the canonical snapshot', () => {
    const ws = new SourceWorkspace(CURRENT);
    const result = ws.analyze([]);
    expect(result.candidate).toEqual(CURRENT);
    expect(result.candidate.sourceHash).toBe(CURRENT.sourceHash);
    expect(result.diagnostics).toEqual([]);
  });
});
