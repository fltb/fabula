import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ProjectSourceSnapshotV1,
  SourceDocumentV1,
} from '@novalistically/core';
import {
  buildSourceSnapshot,
  computeSourceDocumentHash,
  computeSourceHash,
} from '@novalistically/core/source';
import { FileProjectSourceLoaderImpl } from '../src/source/file-project-source-loader.js';
import { FileProjectSourceWriterImpl } from '../src/source/file-project-source-writer.js';
import { SourceConflictError, SourcePathError } from '../src/source/types.js';
import { writeAuthoringFixture } from './fixtures.js';

const project = () => { const root = mkdtempSync(join(tmpdir(), 'node-host-source-')); writeAuthoringFixture(root); return root; };

/** Rebuild a canonical Core snapshot purely from the raw bytes on disk. */
function canonicalFromDisk(root: string): ProjectSourceSnapshotV1 {
  const documents: SourceDocumentV1[] = [];
  const loader = new FileProjectSourceLoaderImpl();
  for (const loaded of loader.load(root).documents) {
    const content = readFileSync(join(root, ...loaded.logicalPath.split('/')), 'utf8');
    documents.push({
      version: 1,
      logicalPath: loaded.logicalPath,
      content,
      contentHash: computeSourceDocumentHash(content),
      parseResult: loaded.parseResult,
      diagnostics: loaded.diagnostics,
    });
  }
  return buildSourceSnapshot(documents);
}

describe('sourceHash canonical identity across Core and Node Host', () => {
  it('gives the temp filesystem project the exact Core sourceHash for identical logical bytes', () => {
    const root = project();
    const loaded = new FileProjectSourceLoaderImpl().load(root);
    for (const document of loaded.documents) {
      expect(document.contentHash).toBe(computeSourceDocumentHash(document.content));
    }
    const canonical = canonicalFromDisk(root);
    expect(canonical.sourceHash).toBe(loaded.sourceHash);
    expect(computeSourceHash(canonical.documents)).toBe(loaded.sourceHash);
    expect(canonical.documents.map((document) => document.logicalPath)).toEqual(loaded.documents.map((document) => document.logicalPath));
  });

  it('invalidates the shared sourceHash on an exact byte change', () => {
    const root = project();
    const first = new FileProjectSourceLoaderImpl().load(root);
    const nova = join(root, 'nova.yaml');
    writeFileSync(nova, readFileSync(nova, 'utf8').replace('project: fixture\n', 'project: fixtured\n'), 'utf8');
    const second = new FileProjectSourceLoaderImpl().load(root);
    expect(second.sourceHash).not.toBe(first.sourceHash);
    const before = first.documents.find((document) => document.logicalPath === 'nova.yaml');
    const after = second.documents.find((document) => document.logicalPath === 'nova.yaml');
    expect(before?.contentHash).toBeDefined();
    expect(after?.contentHash).not.toBe(before?.contentHash);
    expect(canonicalFromDisk(root).sourceHash).toBe(second.sourceHash);
  });

  it('orders documents by UTF-16 code units, not locale collation', () => {
    const root = project();
    writeFileSync(join(root, 'definitions', 'characters', 'é.yaml'), 'id: e-acute\n', 'utf8');
    const snapshot = new FileProjectSourceLoaderImpl().load(root);
    const characterDocs = snapshot.documents.filter((document) => document.logicalPath.startsWith('definitions/characters/'));
    expect(characterDocs.map((document) => document.logicalPath)).toEqual([
      'definitions/characters/a.yaml',
      'definitions/characters/z.yaml',
      'definitions/characters/é.yaml',
    ]);
  });
});


describe('file project source boundary', () => {
  it('orders approved topology and omits optional ledger', () => {
    const snapshot = new FileProjectSourceLoaderImpl().load(project());
    expect(snapshot.documents.map((document) => document.logicalPath)).toEqual([...snapshot.documents].map((document) => document.logicalPath).sort());
    expect(snapshot.documents.some((document) => document.logicalPath === 'definitions/discourse-ledger.yaml')).toBe(false);
  });
  it('applies source hash CAS atomically', async () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl();
    const current = loader.load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');
    const next = await new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [{
      logicalPath: before.logicalPath,
      beforeContent: before.content,
      beforeHash: before.contentHash,
      afterContent: 'project: changed\n',
      afterHash: null,
    }]);
    expect(next.sourceHash).not.toBe(current.sourceHash);
  });
  it('serializes concurrent source compare-and-swap writers', async () => {
    const root = project();
    const current = new FileProjectSourceLoaderImpl().load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');
    const change = {
      logicalPath: before.logicalPath,
      beforeContent: before.content,
      beforeHash: before.contentHash,
      afterContent: 'project: changed once\n',
      afterHash: null,
    };
    const results = await Promise.allSettled([
      new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [change]),
      new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [change]),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(SourceConflictError);
  });
  it('rejects stale CAS and traversal', async () => {
    const root = project();
    await expect(new FileProjectSourceWriterImpl().apply(root, '0'.repeat(64), [])).rejects.toBeInstanceOf(SourceConflictError);
    const current = new FileProjectSourceLoaderImpl().load(root);
    await expect(new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [{
      logicalPath: '../escape.yaml',
      beforeContent: null,
      beforeHash: null,
      afterContent: 'x',
      afterHash: null,
    }])).rejects.toBeInstanceOf(SourcePathError);
  });
  it('rejects symlink escapes', () => {
    const root = project(); const outside = mkdtempSync(join(tmpdir(), 'node-host-outside-')); writeFileSync(join(outside, 'x.yaml'), 'x: 1\n');
    symlinkSync(outside, join(root, 'definitions', 'characters', 'linked'));
    expect(() => new FileProjectSourceLoaderImpl().load(root)).toThrow(SourcePathError);
  });
});
