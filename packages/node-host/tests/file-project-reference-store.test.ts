import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileProjectReferenceStore } from '../src/source/file-project-reference-store.js';
import { SourceInputError } from '../src/source/types.js';

const project = () => mkdtempSync(join(tmpdir(), 'reference-store-'));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

async function bytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const part of stream as AsyncIterable<Buffer>) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

const input = (content: Uint8Array, expectedManifestHash: string | null = null) => ({
  referenceId: 'guide',
  content,
  originalName: 'guide.txt',
  mediaType: 'text/plain',
  expectedManifestHash,
});

describe('FileProjectReferenceStore', () => {
  it('imports immutable content and reads complete and bounded ranges', async () => {
    const root = project();
    const store = new FileProjectReferenceStore({ now: () => '2026-08-03T00:00:00.000Z' });
    const content = new TextEncoder().encode('abcdef');
    const imported = await store.import(input(content), 'project-a', root);

    expect(imported.manifest.items[0]).toMatchObject({
      referenceId: 'guide',
      byteLength: 6,
      contentHash: hash(content),
      objectKey: `sha256/${hash(content).slice(0, 2)}/${hash(content)}`,
    });
    const full = await store.readContent('project-a', root, 'guide');
    expect(Array.from(await bytes(full.content))).toEqual(Array.from(content));
    const range = await store.readRange('project-a', root, 'guide', 1, 4);
    expect(Array.from(await bytes(range.content))).toEqual(Array.from(new TextEncoder().encode('bcd')));
    expect(range.byteLength).toBe(3);
  });

  it('rejects same-length corruption on content reads and reports it in verification', async () => {
    const root = project();
    const store = new FileProjectReferenceStore();
    const content = new TextEncoder().encode('abcdef');
    const imported = await store.import(input(content), 'project-a', root);
    const item = imported.manifest.items[0]!;
    const objectPath = join(root, 'references', 'objects', item.objectKey);
    chmodSync(objectPath, 0o600);
    writeFileSync(objectPath, 'ABCDEF');

    await expect(store.readContent('project-a', root, 'guide')).rejects.toThrow(/integrity mismatch/);
    const report = await store.verify('project-a', root);
    expect(report.corrupt).toContain(item.contentHash);
  });

  it('enforces import and read byte limits before exposing data', async () => {
    const root = project();
    const content = new TextEncoder().encode('abcdef');
    const limited = new FileProjectReferenceStore({ maxFileBytes: 5, maxReadBytes: 2 });
    await expect(limited.import(input(content), 'project-a', root)).rejects.toThrow(/5-byte limit/);

    const store = new FileProjectReferenceStore();
    const imported = await store.import(input(content), 'project-a', root);
    await expect(
      new FileProjectReferenceStore({ maxReadBytes: 2 }).readContent('project-a', root, 'guide'),
    ).rejects.toThrow(/2-byte limit/);
    await expect(
      store.readContent('project-a', root, 'guide', { start: 5, endExclusive: 7 }),
    ).rejects.toThrow(SourceInputError);
    expect(readFileSync(join(root, 'references', 'library.json'), 'utf8')).toContain(imported.manifest.items[0]!.referenceId);
  });
});
