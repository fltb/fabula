import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/entity/source-analysis.ts';
import { buildSourceSnapshot, computeSourceDocumentHash } from '../../src/source/source-identity.ts';
import type {
  ProjectSourceSnapshotV1,
  SourceChangeV1,
  SourceDocumentV1,
} from '../../src/contracts/source.ts';

const hash = (value: string) => 'a'.repeat(64);

const document = (logicalPath: string, content: string): SourceDocumentV1 => ({
  version: 1,
  logicalPath,
  content,
  contentHash: hash(content),
  parseResult: { status: 'parsed', value: { value: content } },
  diagnostics: [],
});

const current: ProjectSourceSnapshotV1 = {
  version: 1,
  documents: [
    document('chapters/chapter_01/E2.yaml', 'event: E2'),
    document('definitions/items/a.yaml', 'id: a'),
  ],
  sourceHash: hash('current'),
};

const change = (logicalPath: string, afterContent: string | null): SourceChangeV1 => ({
  logicalPath,
  beforeContent: null,
  beforeHash: null,
  afterContent,
  afterHash: afterContent === null ? null : hash(afterContent),
});

describe('pure source analysis', () => {
  it('overlays content, parses YAML, sorts candidate and identifies the affected event', () => {
    const result = analyzeSource(current, [
      change('chapters/chapter_01/E1.yaml', 'event: E1'),
      change('definitions/items/a.yaml', null),
    ]);
    expect(result.candidate.documents.map((d) => d.logicalPath)).toEqual([
      'chapters/chapter_01/E1.yaml',
      'chapters/chapter_01/E2.yaml',
    ]);
    expect(result.candidate.documents[0].parseResult.status).toBe('invalid');
    expect(result.affectedEventIds).toEqual(['E1']);
    expect(result.candidate.sourceHash).not.toBe(current.sourceHash);
  });

  it('is deterministic: same input yields an identical ordered candidate and hash', () => {
    const changes = [change('chapters/chapter_01/E1.yaml', 'event: E1')];
    const first = analyzeSource(current, changes);
    const second = analyzeSource(current, changes);
    expect(second).toEqual(first);
    expect(second.candidate.sourceHash).toBe(first.candidate.sourceHash);
  });

  it('rejects traversal and unknown topology without host path APIs', () => {
    const result = analyzeSource(current, [
      change('../secret.yaml', 'x: 1'),
      change('notes/x.yaml', 'x: 1'),
    ]);
    expect(result.diagnostics.filter((d) => d.code === 'SOURCE_PATH_INVALID')).toHaveLength(2);
    expect(result.candidate.documents).toHaveLength(2);
    expect(result.candidate.sourceHash).toBe(analyzeSource(current, []).candidate.sourceHash);
  });

  it('reports invalid YAML diagnostics and keeps a deterministic candidate', () => {
    const result = analyzeSource(current, [change('chapters/chapter_01/E3.yaml', 'event: [')]);
    expect(result.diagnostics.some((d) => d.code === 'SOURCE_YAML_INVALID')).toBe(true);
    expect(result.candidate.documents.map((d) => d.logicalPath)).toEqual([
      'chapters/chapter_01/E2.yaml',
      'chapters/chapter_01/E3.yaml',
      'definitions/items/a.yaml',
    ]);
    expect(result.affectedEventIds).toEqual(['E3']);
  });

  it('deletes a document when afterContent is null', () => {
    const result = analyzeSource(current, [change('definitions/items/a.yaml', null)]);
    expect(result.candidate.documents.map((d) => d.logicalPath)).toEqual([
      'chapters/chapter_01/E2.yaml',
    ]);
    expect(result.affectedEventIds).toEqual([]);
  });

  it('rejects every POSIX violation class and non-allowlisted topology', () => {
    const result = analyzeSource(current, [
      change('../secret.yaml', 'x: 1'),
      change('/etc/passwd', 'x: 1'),
      change('definitions\\items\\evil.yaml', 'x: 1'),
      change('definitions/items/../evil.yaml', 'x: 1'),
      change('definitions//items/a.yaml', 'x: 1'),
      change('definitions/items/nested/a.yaml', 'x: 1'),
    ]);
    const invalid = result.diagnostics.filter((d) => d.code === 'SOURCE_PATH_INVALID');
    expect(invalid.map((d) => d.logicalPath)).toEqual([
      '../secret.yaml',
      '/etc/passwd',
      'definitions\\items\\evil.yaml',
      'definitions/items/../evil.yaml',
      'definitions//items/a.yaml',
      'definitions/items/nested/a.yaml',
    ]);
    expect(result.candidate.documents).toEqual(current.documents);
    expect(result.candidate.sourceHash).toBe(buildSourceSnapshot(current.documents).sourceHash);
    expect(result.affectedEventIds).toEqual([]);
  });

  it('reports before-hash precondition mismatch without dropping the candidate change', () => {
    const result = analyzeSource(current, [
      {
        logicalPath: 'definitions/items/a.yaml',
        beforeContent: 'id: stale',
        beforeHash: 'b'.repeat(64),
        afterContent: 'id: a\n',
        afterHash: null,
      },
    ]);
    expect(result.diagnostics.some((d) => d.code === 'SOURCE_PRECONDITION_MISMATCH')).toBe(true);
    const doc = result.candidate.documents.find((d) => d.logicalPath === 'definitions/items/a.yaml');
    expect(doc?.content).toBe('id: a\n');
    expect(doc?.contentHash).toBe(computeSourceDocumentHash('id: a\n'));
  });

  it('lists an event as affected when its chapter file is deleted', () => {
    const result = analyzeSource(current, [change('chapters/chapter_01/E2.yaml', null)]);
    expect(result.affectedEventIds).toEqual(['E2']);
    expect(result.candidate.documents.map((d) => d.logicalPath)).toEqual(['definitions/items/a.yaml']);
  });

  it('keeps a no-op analysis byte-identical to the canonical snapshot', () => {
    const result = analyzeSource(current, []);
    expect(result.candidate.documents).toEqual(current.documents);
    expect(result.candidate.sourceHash).toBe(buildSourceSnapshot(current.documents).sourceHash);
    expect(result.affectedEventIds).toEqual([]);
  });
});
