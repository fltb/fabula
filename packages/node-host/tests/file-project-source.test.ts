import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '@novalistically/core';
import { sourceParseResultV1Schema } from '@novalistically/core/schema';
import {
  buildSourceSnapshot,
  computeSourceDocumentHash,
  computeSourceHash,
} from '@novalistically/core/source';
import { describe, expect, it } from 'vitest';
import {
  ProjectWriteCoordinator,
  StandaloneMutationBlockedError,
} from '../src/index.js';
import { FileProjectSourceLoaderImpl } from '../src/source/file-project-source-loader.js';
import { FileProjectSourceWriterImpl } from '../src/source/file-project-source-writer.js';
import { SourceConflictError, SourceInputError, SourcePathError } from '../src/source/types.js';
import { writeAuthoringFixture } from './fixtures.js';

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'node-host-source-'));
  writeAuthoringFixture(root);
  return root;
};

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
    expect(canonical.documents.map((document) => document.logicalPath)).toEqual(
      loaded.documents.map((document) => document.logicalPath),
    );
  });

  it('invalidates the shared sourceHash on an exact byte change', () => {
    const root = project();
    const first = new FileProjectSourceLoaderImpl().load(root);
    const nova = join(root, 'nova.yaml');
    writeFileSync(
      nova,
      readFileSync(nova, 'utf8').replace('project: fixture\n', 'project: fixtured\n'),
      'utf8',
    );
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
    const characterDocs = snapshot.documents.filter((document) =>
      document.logicalPath.startsWith('definitions/characters/'),
    );
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
    expect(snapshot.documents.map((document) => document.logicalPath)).toEqual(
      [...snapshot.documents].map((document) => document.logicalPath).sort(),
    );
    expect(
      snapshot.documents.some(
        (document) => document.logicalPath === 'definitions/discourse-ledger.yaml',
      ),
    ).toBe(false);
  });
  it('includes the optional discourse ledger when present and keeps it writable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-host-source-'));
    writeAuthoringFixture(root, { discourseLedger: true });
    const loader = new FileProjectSourceLoaderImpl();
    const snapshot = loader.load(root);
    const ledger = snapshot.documents.find(
      (document) => document.logicalPath === 'definitions/discourse-ledger.yaml',
    );
    if (!ledger) throw new Error('fixture missing discourse ledger');
    expect(ledger.content).toBe('version: 1\n');
    expect(snapshot.documents.map((document) => document.logicalPath)).toContain(
      'definitions/discourse-ledger.yaml',
    );

    const next = await new FileProjectSourceWriterImpl().apply(root, snapshot.sourceHash, [
      {
        logicalPath: ledger.logicalPath,
        beforeContent: ledger.content,
        beforeHash: ledger.contentHash,
        afterContent: 'version: 2\n',
        afterHash: computeSourceDocumentHash('version: 2\n'),
      },
    ]);
    expect(
      next.documents.find(
        (document) => document.logicalPath === 'definitions/discourse-ledger.yaml',
      )?.content,
    ).toBe('version: 2\n');
    expect(next.sourceHash).not.toBe(snapshot.sourceHash);
  });
  it('injects a custom parse hook that shapes parse results without touching source bytes', () => {
    const root = project();
    const calls: Array<{ content: string; logicalPath: string }> = [];
    const loader = new FileProjectSourceLoaderImpl({
      parse: (content, logicalPath) => {
        calls.push({ content, logicalPath });
        return { injected: true, logicalPath, byteLength: content.length };
      },
    });
    const snapshot = loader.load(root);
    expect(calls.length).toBe(snapshot.documents.length);
    expect(calls).toContainEqual({ content: 'project: fixture\n', logicalPath: 'nova.yaml' });

    const nova = snapshot.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!nova) throw new Error('fixture missing nova.yaml');
    expect(nova.parseResult).toEqual({
      status: 'parsed',
      value: { injected: true, logicalPath: 'nova.yaml', byteLength: 'project: fixture\n'.length },
    });
    expect(nova.content).toBe('project: fixture\n');
    expect(nova.contentHash).toBe(computeSourceDocumentHash('project: fixture\n'));
    expect(snapshot.sourceHash).toBe(canonicalFromDisk(root).sourceHash);
  });
  it('surfaces parse hook failures as invalid documents with typed diagnostics', () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl({
      parse: () => {
        throw new Error('injected hook exploded');
      },
    });
    const snapshot = loader.load(root);
    expect(snapshot.documents.length).toBeGreaterThan(0);
    for (const document of snapshot.documents) {
      expect(document.parseResult).toEqual({ status: 'invalid', value: null });
      expect(sourceParseResultV1Schema.safeParse(document.parseResult).success).toBe(true);
      expect(document.diagnostics).toEqual([
        {
          code: 'yaml_parse_error',
          severity: 'error',
          message: expect.stringContaining('injected hook exploded'),
          logicalPath: document.logicalPath,
        },
      ]);
    }
  });
  it('runs writer CAS and final snapshot through an injected loader with a custom parse hook', async () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl({
      parse: (content, logicalPath) => ({ normalized: true, logicalPath }),
    });
    const writer = new FileProjectSourceWriterImpl({ loader });
    const current = loader.load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');

    const next = await writer.apply(root, current.sourceHash, [
      {
        logicalPath: before.logicalPath,
        beforeContent: before.content,
        beforeHash: before.contentHash,
        afterContent: 'project: changed\n',
        afterHash: computeSourceDocumentHash('project: changed\n'),
      },
    ]);
    expect(next.sourceHash).not.toBe(current.sourceHash);
    expect(
      next.documents.find((document) => document.logicalPath === 'nova.yaml')?.parseResult,
    ).toEqual({ status: 'parsed', value: { normalized: true, logicalPath: 'nova.yaml' } });
  });
  it('marks empty and null-only YAML as invalid while preserving source bytes and topology', () => {
    const root = project();
    const emptyPath = 'nova.yaml';
    const nullPath = 'definitions/characters/null.yaml';
    writeFileSync(join(root, emptyPath), '', 'utf8');
    writeFileSync(join(root, ...nullPath.split('/')), 'null\n', 'utf8');

    const snapshot = new FileProjectSourceLoaderImpl().load(root);
    const empty = snapshot.documents.find((document) => document.logicalPath === emptyPath);
    const nullOnly = snapshot.documents.find((document) => document.logicalPath === nullPath);
    if (!empty || !nullOnly) throw new Error('expected empty and null-only YAML documents');

    for (const [document, content] of [
      [empty, ''],
      [nullOnly, 'null\n'],
    ] as const) {
      expect(document.content).toBe(content);
      expect(document.parseResult).toEqual({ status: 'invalid', value: null });
      expect(sourceParseResultV1Schema.safeParse(document.parseResult).success).toBe(true);
      expect(document.diagnostics).toEqual([
        {
          code: 'yaml_empty_document',
          severity: 'error',
          message: 'YAML document must contain a value',
          logicalPath: document.logicalPath,
        },
      ]);
    }
    expect(snapshot.documents.map((document) => document.logicalPath)).toEqual([
      'chapters/chapter_01/E1.yaml',
      'chapters/chapter_01/_chapter.yaml',
      'definitions/characters/a.yaml',
      'definitions/characters/null.yaml',
      'definitions/characters/z.yaml',
      'definitions/entity-types.yaml',
      'definitions/state_initial.yaml',
      'nova.yaml',
    ]);
  });
  it('applies source hash CAS atomically', async () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl();
    const current = loader.load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');
    const next = await new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [
      {
        logicalPath: before.logicalPath,
        beforeContent: before.content,
        beforeHash: before.contentHash,
        afterContent: 'project: changed\n',
        afterHash: computeSourceDocumentHash('project: changed\n'),
      },
    ]);
    expect(next.sourceHash).not.toBe(current.sourceHash);
  });
  it('rejects an update whose afterHash is missing or mismatched without touching bytes', async () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl();
    const current = loader.load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');
    const target = join(root, ...before.logicalPath.split('/'));
    const originalBytes = readFileSync(target);
    const base = {
      logicalPath: before.logicalPath,
      beforeContent: before.content,
      beforeHash: before.contentHash,
      afterContent: 'project: changed\n',
    };
    await expect(
      new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [
        { ...base, afterHash: null },
      ]),
    ).rejects.toBeInstanceOf(SourceInputError);
    await expect(
      new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [
        { ...base, afterHash: '0'.repeat(64) },
      ]),
    ).rejects.toBeInstanceOf(SourceInputError);
    expect(readFileSync(target)).toEqual(originalBytes);
    expect(loader.load(root).sourceHash).toBe(current.sourceHash);
  });
  it('rejects an invalid deletion pairing without touching bytes', async () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl();
    const current = loader.load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');
    const target = join(root, ...before.logicalPath.split('/'));
    const originalBytes = readFileSync(target);
    await expect(
      new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [
        {
          logicalPath: before.logicalPath,
          beforeContent: before.content,
          beforeHash: before.contentHash,
          afterContent: null,
          afterHash: computeSourceDocumentHash('project: changed\n'),
        },
      ]),
    ).rejects.toBeInstanceOf(SourceInputError);
    expect(readFileSync(target)).toEqual(originalBytes);
    expect(loader.load(root).sourceHash).toBe(current.sourceHash);
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
      afterHash: computeSourceDocumentHash('project: changed once\n'),
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
    await expect(
      new FileProjectSourceWriterImpl().apply(root, '0'.repeat(64), []),
    ).rejects.toBeInstanceOf(SourceConflictError);
    const current = new FileProjectSourceLoaderImpl().load(root);
    await expect(
      new FileProjectSourceWriterImpl().apply(root, current.sourceHash, [
        {
          logicalPath: '../escape.yaml',
          beforeContent: null,
          beforeHash: null,
          afterContent: 'x',
          afterHash: computeSourceDocumentHash('x'),
        },
      ]),
    ).rejects.toBeInstanceOf(SourcePathError);
  });
  it('rejects symlink escapes', () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), 'node-host-outside-'));
    writeFileSync(join(outside, 'x.yaml'), 'x: 1\n');
    symlinkSync(outside, join(root, 'definitions', 'characters', 'linked'));
    expect(() => new FileProjectSourceLoaderImpl().load(root)).toThrow(SourcePathError);
  });
  it('refuses direct source mutation while authority is starting or ready, then allows it after release', async () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl();
    const current = loader.load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');
    const change = {
      logicalPath: before.logicalPath,
      beforeContent: before.content,
      beforeHash: before.contentHash,
      afterContent: 'project: authority-guarded\n',
      afterHash: computeSourceDocumentHash('project: authority-guarded\n'),
    };
    const coordinator = new ProjectWriteCoordinator(root, { projectId: 'fixture' });
    const authorityToken = await coordinator.acquireWorkbenchAuthority('workbench-starting');
    const writer = new FileProjectSourceWriterImpl();

    await expect(writer.apply(root, current.sourceHash, [change])).rejects.toBeInstanceOf(
      StandaloneMutationBlockedError,
    );
    await coordinator.markReady(authorityToken, { endpoint: 'http://127.0.0.1:4310' });
    await expect(writer.apply(root, current.sourceHash, [change])).rejects.toBeInstanceOf(
      StandaloneMutationBlockedError,
    );

    await coordinator.releaseWorkbenchAuthority(authorityToken);
    const next = await writer.apply(root, current.sourceHash, [change]);
    expect(next.documents.find((document) => document.logicalPath === 'nova.yaml')?.content).toBe(
      'project: authority-guarded\n',
    );
  });

  it('uses the matching Workbench authority token for source materialization', async () => {
    const root = project();
    const loader = new FileProjectSourceLoaderImpl();
    const current = loader.load(root);
    const before = current.documents.find((document) => document.logicalPath === 'nova.yaml');
    if (!before) throw new Error('fixture missing nova.yaml');
    const change = {
      logicalPath: before.logicalPath,
      beforeContent: before.content,
      beforeHash: before.contentHash,
      afterContent: 'project: workbench-authorized\n',
      afterHash: computeSourceDocumentHash('project: workbench-authorized\n'),
    };
    const coordinator = new ProjectWriteCoordinator(root, { projectId: 'fixture' });
    const authorityToken = await coordinator.acquireWorkbenchAuthority('workbench-materializer');
    const writer = new FileProjectSourceWriterImpl({
      coordinator,
      authorityToken,
    });

    const next = await writer.apply(root, current.sourceHash, [change]);
    expect(next.documents.find((document) => document.logicalPath === 'nova.yaml')?.content).toBe(
      'project: workbench-authorized\n',
    );
    await coordinator.releaseWorkbenchAuthority(authorityToken);
  });

});
