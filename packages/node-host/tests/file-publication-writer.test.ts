import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafePublicationRelativePath,
  CANONICAL_PUBLICATION_FILENAME,
  CANONICAL_PUBLICATION_ID,
  derivePublicationRelativePath,
  FilePublicationWriter,
  hashPublicationMarkdown,
  normalizePublicationMarkdown,
  PUBLICATION_OUTPUT_DIRECTORY,
  PublicationPathError,
} from '../src/index.js';

const customId = 'f'.repeat(64);

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const withTempProject = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), 'fabula-publication-writer-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('FilePublicationWriter', () => {
  it('writes the canonical novel to output/novel.md with a single trailing newline and matching hash', async () => {
    await withTempProject(async (root) => {
      const writer = new FilePublicationWriter(root);
      const result = await writer.write({
        publicationId: CANONICAL_PUBLICATION_ID,
        markdown: '# 祝福\n\n正文内容\n\n\n',
      });

      expect(result.relativeOutputPath).toBe('output/novel.md');
      expect(result.sha256).toBe(sha256('# 祝福\n\n正文内容\n'));
      const written = await readFile(path.join(root, 'output/novel.md'), 'utf8');
      expect(written).toBe('# 祝福\n\n正文内容\n');
      expect(Buffer.from(written, 'utf8').byteLength).toBe(result.byteLength);
      expect(sha256(written)).toBe(result.sha256);
    });
  });

  it('normalizes any trailing newline run to exactly one and preserves hard-break spaces', () => {
    expect(normalizePublicationMarkdown('a\nb')).toBe('a\nb\n');
    expect(normalizePublicationMarkdown('a\nb\n\n\n')).toBe('a\nb\n');
    expect(normalizePublicationMarkdown('a\nb\r\n\r\n')).toBe('a\nb\n');
    expect(normalizePublicationMarkdown('a  \n')).toBe('a  \n');
    expect(normalizePublicationMarkdown('')).toBe('\n');
    // The hash is a function of the normalized bytes, not the input shape.
    expect(hashPublicationMarkdown('a\nb\n\n\n')).toBe(hashPublicationMarkdown('a\nb'));
    expect(hashPublicationMarkdown('a\nb')).toBe(sha256('a\nb\n'));
  });

  it('names custom publications output/<publicationId>.md', async () => {
    await withTempProject(async (root) => {
      const writer = new FilePublicationWriter(root);
      const result = await writer.write({
        publicationId: customId,
        markdown: 'custom branch novel',
      });

      expect(result.relativeOutputPath).toBe(`output/${customId}.md`);
      const entries = await readdir(path.join(root, PUBLICATION_OUTPUT_DIRECTORY));
      expect(entries).toEqual([`${customId}.md`]);
      const written = await readFile(path.join(root, 'output', `${customId}.md`), 'utf8');
      expect(written).toBe('custom branch novel\n');
      expect(result.byteLength).toBe(Buffer.byteLength('custom branch novel\n', 'utf8'));
    });
  });

  it('rejects absolute paths, traversal, and ids outside the canonical/hex pair', async () => {
    expect(() => derivePublicationRelativePath('/etc/passwd')).toThrow(PublicationPathError);
    expect(() => derivePublicationRelativePath('novel')).toThrow(PublicationPathError);
    expect(() => derivePublicationRelativePath('canonical!')).toThrow(PublicationPathError);
    expect(() => derivePublicationRelativePath('')).toThrow(PublicationPathError);
    expect(derivePublicationRelativePath(CANONICAL_PUBLICATION_ID)).toBe('output/novel.md');
    expect(derivePublicationRelativePath(customId)).toBe(`output/${customId}.md`);

    for (const bad of [
      '/abs/novel.md',
      'output/../novel.md',
      '../novel.md',
      '..\\novel.md',
      'C:\\novel.md',
    ]) {
      expect(() => assertSafePublicationRelativePath(bad)).toThrow(PublicationPathError);
    }
    expect(() => assertSafePublicationRelativePath('output/novel.md')).not.toThrow();
    expect(() => assertSafePublicationRelativePath(`output/${customId}.md`)).not.toThrow();

    await withTempProject(async (root) => {
      const writer = new FilePublicationWriter(root);
      await expect(writer.write({ publicationId: '../escape', markdown: 'x' })).rejects.toThrow(
        PublicationPathError,
      );
      // Nothing was written and no output directory was created.
      await expect(readdir(path.join(root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rewrites an existing canonical file atomically with exact bytes and no leftover journal', async () => {
    await withTempProject(async (root) => {
      const writer = new FilePublicationWriter(root);
      await writer.write({ publicationId: CANONICAL_PUBLICATION_ID, markdown: 'v1' });
      expect(await readFile(path.join(root, 'output/novel.md'), 'utf8')).toBe('v1\n');

      const second = await writer.write({
        publicationId: CANONICAL_PUBLICATION_ID,
        markdown: 'v2\n',
      });
      expect(await readFile(path.join(root, 'output/novel.md'), 'utf8')).toBe('v2\n');
      expect(second.sha256).toBe(sha256('v2\n'));
      expect(second.byteLength).toBe(3);

      // A successful write leaves only the artifact: no journal or temp files.
      const entries = await readdir(path.join(root, 'output'));
      expect(entries).toEqual([CANONICAL_PUBLICATION_FILENAME]);
    });
  });
});
