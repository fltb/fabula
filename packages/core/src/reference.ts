import { sha256Bytes } from './cache/pure-sha256.ts';

const HASH_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_CHUNKS = 4096;
const DEFAULT_MAX_QUOTE_LENGTH = 4096;

/** Versioned, path-free output of deterministic reference ingestion. */
export interface ReferenceChunkV1 {
  readonly version: 1;
  readonly referenceId: string;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly range: { readonly version: 1; readonly offset: number; readonly length: number };
  readonly byteLength: number;
  readonly contentHash: string;
  readonly chunkHash: string;
  readonly locator: string;
  readonly quote: string | null;
}

/** A non-authoritative citation accepted by the render/context boundary. */
export interface ReferenceCitationV1 {
  readonly version: 1;
  readonly citationId: string;
  readonly referenceId: string;
  readonly chunkId: string;
  readonly contentHash: string;
  readonly chunkHash: string;
  readonly quote: string;
  readonly locator: string;
  readonly authoritative: false;
}

/** Explicitly bounded reference material for a project render. */
export interface ProjectReferencePacketV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly citations: readonly ReferenceCitationV1[];
}

export interface ReferenceExtractionInputV1 {
  readonly referenceId: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
  /** SHA-256 of the exact bytes supplied to the extractor. */
  readonly contentHash: string;
  readonly chunkBytes?: number;
  readonly maxChunks?: number;
  readonly maxQuoteLength?: number;
}

export interface ReferenceExtractorV1 {
  readonly version: 'reference-text-v1';
  extract(input: ReferenceExtractionInputV1): readonly ReferenceChunkV1[];
}

export interface ReferenceExtractorOptionsV1 {
  readonly chunkBytes?: number;
  readonly maxChunks?: number;
  readonly maxQuoteLength?: number;
}

export class ReferenceExtractionError extends Error {
  override readonly name = 'ReferenceExtractionError';
}

function requireBound(value: number | undefined, label: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ReferenceExtractionError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requireText(value: string, label: string): void {
  if (value.length === 0 || CONTROL_RE.test(value)) {
    throw new ReferenceExtractionError(`${label} must be non-empty text without control characters`);
  }
}

function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  return normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('yaml') ||
    normalized.includes('javascript');
}

/**
 * Deterministically split immutable bytes into bounded chunks. The extractor
 * never reads a Host path and never performs network or model inference.
 */
export class DeterministicReferenceExtractor implements ReferenceExtractorV1 {
  readonly version = 'reference-text-v1' as const;
  readonly #chunkBytes: number;
  readonly #maxChunks: number;
  readonly #maxQuoteLength: number;

  constructor(options: ReferenceExtractorOptionsV1 = {}) {
    this.#chunkBytes = requireBound(options.chunkBytes, 'chunkBytes', 1) ?? DEFAULT_CHUNK_BYTES;
    this.#maxChunks = requireBound(options.maxChunks, 'maxChunks', 1) ?? DEFAULT_MAX_CHUNKS;
    this.#maxQuoteLength = requireBound(options.maxQuoteLength, 'maxQuoteLength', 0) ?? DEFAULT_MAX_QUOTE_LENGTH;
  }

  extract(input: ReferenceExtractionInputV1): readonly ReferenceChunkV1[] {
    requireText(input.referenceId, 'referenceId');
    requireText(input.mediaType, 'mediaType');
    if (!(input.content instanceof Uint8Array)) {
      throw new ReferenceExtractionError('content must be Uint8Array');
    }
    if (!HASH_RE.test(input.contentHash)) {
      throw new ReferenceExtractionError('contentHash must be lowercase SHA-256 hex');
    }
    if (sha256Bytes(input.content) !== input.contentHash) {
      throw new ReferenceExtractionError('contentHash does not match content bytes');
    }
    const chunkBytes = requireBound(input.chunkBytes, 'chunkBytes', 1) ?? this.#chunkBytes;
    const maxChunks = requireBound(input.maxChunks, 'maxChunks', 1) ?? this.#maxChunks;
    const maxQuoteLength = requireBound(input.maxQuoteLength, 'maxQuoteLength', 0) ?? this.#maxQuoteLength;
    const count = input.content.length === 0 ? 0 : Math.ceil(input.content.length / chunkBytes);
    if (count > maxChunks) {
      throw new ReferenceExtractionError(`reference produces ${count} chunks; limit is ${maxChunks}`);
    }
    const isText = isTextMediaType(input.mediaType);
    const chunks: ReferenceChunkV1[] = [];
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const offset = ordinal * chunkBytes;
      const bytes = input.content.slice(offset, Math.min(offset + chunkBytes, input.content.length));
      const end = offset + bytes.length;
      const quote = isText ? new TextDecoder().decode(bytes).slice(0, maxQuoteLength) : null;
      chunks.push({
        version: 1,
        referenceId: input.referenceId,
        chunkId: `${input.referenceId}:${ordinal}`,
        ordinal,
        range: { version: 1, offset, length: bytes.length },
        byteLength: bytes.length,
        contentHash: input.contentHash,
        chunkHash: sha256Bytes(bytes),
        locator: `byte:${offset}-${end}`,
        quote,
      });
    }
    return chunks;
  }
}

/** Convenience function for callers that do not need an extractor instance. */
export function extractReferenceChunks(input: ReferenceExtractionInputV1): readonly ReferenceChunkV1[] {
  return new DeterministicReferenceExtractor().extract(input);
}

export interface BuildReferencePacketOptionsV1 {
  readonly maxCitations?: number;
  readonly maxQuoteLength?: number;
}

/** Validate and bound citations before they enter a render/context packet. */
export function buildReferencePacket(
  projectId: string,
  citations: readonly ReferenceCitationV1[],
  options: BuildReferencePacketOptionsV1 = {},
): ProjectReferencePacketV1 {
  requireText(projectId, 'projectId');
  if (!Array.isArray(citations)) throw new ReferenceExtractionError('citations must be an array');
  const maxCitations = requireBound(options.maxCitations, 'maxCitations', 0) ?? 32;
  const maxQuoteLength = requireBound(options.maxQuoteLength, 'maxQuoteLength', 0) ?? DEFAULT_MAX_QUOTE_LENGTH;
  if (citations.length > maxCitations) {
    throw new ReferenceExtractionError(`citation count exceeds ${maxCitations}`);
  }
  const seen = new Set<string>();
  const bounded = citations.map((citation, index) => {
    if (citation.version !== 1 || citation.authoritative !== false) {
      throw new ReferenceExtractionError(`citation ${index} must be version 1 and non-authoritative`);
    }
    for (const [label, value] of [
      ['citationId', citation.citationId],
      ['referenceId', citation.referenceId],
      ['chunkId', citation.chunkId],
      ['locator', citation.locator],
    ] as const) requireText(value, `citation ${index} ${label}`);
    if (seen.has(citation.citationId)) throw new ReferenceExtractionError(`duplicate citationId: ${citation.citationId}`);
    seen.add(citation.citationId);
    if (!HASH_RE.test(citation.contentHash) || !HASH_RE.test(citation.chunkHash)) {
      throw new ReferenceExtractionError(`citation ${index} has invalid hash`);
    }
    if (typeof citation.quote !== 'string' || citation.quote.length === 0 || CONTROL_RE.test(citation.quote)) {
      throw new ReferenceExtractionError(`citation ${index} quote is invalid`);
    }
    return {
      version: 1 as const,
      citationId: citation.citationId,
      referenceId: citation.referenceId,
      chunkId: citation.chunkId,
      contentHash: citation.contentHash,
      chunkHash: citation.chunkHash,
      quote: citation.quote.slice(0, maxQuoteLength),
      locator: citation.locator,
      authoritative: false as const,
    };
  });
  return { version: 1, projectId, citations: bounded };
}
