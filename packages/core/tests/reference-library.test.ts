import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../src/cache/pure-sha256.ts';
import {
  buildReferencePacket,
  DeterministicReferenceExtractor,
  ReferenceExtractionError,
} from '../src/reference.ts';

describe('deterministic reference ingestion', () => {
  it('chunks verified bytes deterministically and emits bounded non-authoritative metadata', () => {
    const content = new TextEncoder().encode('alpha beta gamma delta');
    const contentHash = sha256Bytes(content);
    const extractor = new DeterministicReferenceExtractor({ chunkBytes: 6, maxQuoteLength: 4 });
    const first = extractor.extract({
      referenceId: 'guide',
      mediaType: 'text/plain',
      content,
      contentHash,
    });
    const second = extractor.extract({
      referenceId: 'guide',
      mediaType: 'text/plain',
      content,
      contentHash,
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    expect(first[0]).toMatchObject({
      version: 1,
      chunkId: 'guide:0',
      range: { version: 1, offset: 0, length: 6 },
      byteLength: 6,
      contentHash,
      quote: 'alph',
      locator: 'byte:0-6',
    });
    expect(first.every((chunk) => chunk.quote === null || chunk.quote.length <= 4)).toBe(true);
  });

  it('repeats the configured overlap while preserving byte offsets and hashes', () => {
    const content = new TextEncoder().encode('abcdefghij');
    const contentHash = sha256Bytes(content);
    const chunks = new DeterministicReferenceExtractor({
      chunkBytes: 4,
      chunkOverlapBytes: 1,
    }).extract({ referenceId: 'guide', mediaType: 'text/plain', content, contentHash });
    expect(chunks.map((chunk) => chunk.range)).toEqual([
      { version: 1, offset: 0, length: 4 },
      { version: 1, offset: 3, length: 4 },
      { version: 1, offset: 6, length: 4 },
    ]);
    expect(chunks.map((chunk) => chunk.quote)).toEqual(['abcd', 'defg', 'ghij']);
  });

  it('uses Unicode character overlap while preserving exact UTF-8 byte ranges', () => {
    const content = new TextEncoder().encode('áβ猫z');
    const contentHash = sha256Bytes(content);
    const chunks = new DeterministicReferenceExtractor({
      chunkCharacters: 2,
      chunkOverlapCharacters: 1,
    }).extract({ referenceId: 'guide', mediaType: 'text/plain', content, contentHash });
    expect(chunks.map((chunk) => chunk.range)).toEqual([
      { version: 1, offset: 0, length: 4 },
      { version: 1, offset: 2, length: 5 },
      { version: 1, offset: 4, length: 4 },
    ]);
    expect(chunks.map((chunk) => chunk.quote)).toEqual(['áβ', 'β猫', '猫z']);
  });

  it('rejects a content hash mismatch and bounded chunk explosion', () => {
    const content = new TextEncoder().encode('abcdef');
    const hash = sha256Bytes(content);
    const extractor = new DeterministicReferenceExtractor({ chunkBytes: 2, maxChunks: 2 });
    expect(() =>
      extractor.extract({
        referenceId: 'x',
        mediaType: 'text/plain',
        content,
        contentHash: '0'.repeat(64),
      }),
    ).toThrow(ReferenceExtractionError);
    expect(() =>
      extractor.extract({ referenceId: 'x', mediaType: 'text/plain', content, contentHash: hash }),
    ).toThrow(/more than 2 chunks/);
  });
});

describe('bounded render reference packet', () => {
  const hash = 'a'.repeat(64);
  const chunkHash = 'b'.repeat(64);
  const citation = {
    version: 1 as const,
    citationId: 'citation-1',
    referenceId: 'guide',
    chunkId: 'guide:0',
    contentHash: hash,
    chunkHash,
    quote: 'quoted fact',
    locator: 'byte:0-11',
    authoritative: false as const,
  };

  it('copies bounded citations and labels them non-authoritative', () => {
    const packet = buildReferencePacket('project-a', [citation], { maxQuoteLength: 6 });
    expect(packet).toEqual({
      version: 1,
      projectId: 'project-a',
      citations: [{ ...citation, quote: 'quoted' }],
    });
    expect(packet.citations[0]?.authoritative).toBe(false);
  });

  it('rejects over-limit and authoritative citations', () => {
    expect(() =>
      buildReferencePacket('project-a', [citation, { ...citation, citationId: 'citation-2' }], {
        maxCitations: 1,
      }),
    ).toThrow(/citation count exceeds 1/);
    expect(() =>
      buildReferencePacket('project-a', [{ ...citation, authoritative: true as never }]),
    ).toThrow(/non-authoritative/);
  });
});
