import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { DeterministicReferenceExtractor } from '@novalistically/core';
import {
  FileProjectReferenceStore,
  type FileProjectReferenceStoreContract,
  type ReferenceLibraryItemV1,
  type ReferenceLibraryReadV1,
  withDirectoryLock,
} from '@novalistically/node-host';
import {
  REFERENCE_MCP_CONTRACT_VERSION,
  REFERENCE_MCP_LIMITS_V1,
  type McpReferenceChunkGetInputV1,
  type McpReferenceChunkGetOutputV1,
  type McpReferenceContentReadInputV1,
  type McpReferenceContentReadOutputV1,
  type McpReferenceDeleteInputV1,
  type McpReferenceDeleteOutputV1,
  type McpReferenceGetInputV1,
  type McpReferenceGetOutputV1,
  type McpReferenceImportBeginInputV1,
  type McpReferenceImportBeginOutputV1,
  type McpReferenceImportChunkInputV1,
  type McpReferenceImportChunkOutputV1,
  type McpReferenceImportCommitInputV1,
  type McpReferenceImportCommitOutputV1,
  type McpReferenceJobGetInputV1,
  type McpReferenceJobGetOutputV1,
  type McpReferenceListInputV1,
  type McpReferenceListOutputV1,
  type McpReferencePort,
  type McpReferenceRetryInputV1,
  type McpReferenceRetryOutputV1,
  type McpReferenceSearchInputV1,
  type McpReferenceSearchOutputV1,
  type ReferenceChunkV1,
  type ReferenceItemV1,
  type ReferenceJobV1,
  type WorkbenchReferenceLimitsV2,
} from '@novalistically/workbench-protocol';

const HASH_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const JOB_RECORD_VERSION = 1 as const;

function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  return normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('yaml') ||
    normalized.includes('javascript');
}
const DEFAULT_PAGE_SIZE = 50;

type InputChunk = {
  readonly offset: number;
  readonly byteLength: number;
  readonly chunkHash: string;
};

type StoredJob = ReferenceJobV1 & {
  readonly recordVersion: typeof JOB_RECORD_VERSION;
  readonly idempotencyKey?: string;
  readonly originalName?: string;
  readonly displayName?: string;
  readonly mediaType?: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly sourceUrl?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
  readonly declaredContentHash?: string;
  readonly inputChunks: readonly InputChunk[];
  readonly derivedChunks: readonly ReferenceChunkV1[];
  readonly originOperation?: 'import' | 'delete';
  readonly deleteExpectedContentHash?: string | null;
};

export interface WorkbenchReferencePortOptions {
  readonly projectId: string;
  readonly projectRoot: string;
  /** Host-owned durable state root. It must not be the project source root. */
  readonly jobsRoot: string;
  readonly referenceLimits: WorkbenchReferenceLimitsV2;
  readonly store?: FileProjectReferenceStoreContract;
}

class ReferencePortInputError extends Error {
  override readonly name = 'ReferencePortInputError';
  readonly code: string;

  constructor(message: string, code = 'INVALID_INPUT') {
    super(message);
    this.code = code;
  }
}

function assertText(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_RE.test(value)) {
    throw new ReferencePortInputError(`${label} must be non-empty bounded text`);
  }
}
function assertIdentifier(value: unknown, label: string, maxLength: number = REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength): asserts value is string {
  assertText(value, label, maxLength);
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new ReferencePortInputError(`${label} must not contain path separators`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new ReferencePortInputError(`${label} must be lowercase SHA-256 hex`);
  }
}

function assertVersion(value: unknown): void {
  if (value !== REFERENCE_MCP_CONTRACT_VERSION) throw new ReferencePortInputError('Reference request version must be 1');
}

function assertInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ReferencePortInputError(`${label} must be a bounded non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  assertInteger(value, label, maximum);
  if (value === 0) throw new ReferencePortInputError(`${label} must be positive`);
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function absoluteRoot(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function validateLimits(limits: WorkbenchReferenceLimitsV2): void {
  if (typeof limits !== 'object' || limits === null || typeof limits.enabled !== 'boolean') {
    throw new TypeError('referenceLimits must be a valid WorkbenchReferenceLimitsV2');
  }
  for (const key of [
    'maxFileBytes',
    'maxBytesPerProject',
    'maxItemsPerProject',
    'maxPendingJobsPerProject',
    'maxChunksPerProject',
    'maxExtractedCharactersPerProject',
    'maxChunkCharacters',
    'chunkOverlapCharacters',
    'extractionTimeoutMs',
    'mcpImportChunkBytes',
  ] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) {
      throw new TypeError(`referenceLimits.${key} must be a non-negative safe integer`);
    }
  }
  if (
    limits.chunkOverlapCharacters >= Math.max(1, limits.maxChunkCharacters)
  ) {
    throw new TypeError(
      'referenceLimits.chunkOverlapCharacters must be smaller than maxChunkCharacters',
    );
  }
}

function safeItem(item: ReferenceLibraryItemV1): ReferenceItemV1 {
  return {
    version: 1,
    referenceId: item.referenceId,
    displayName: item.displayName,
    originalName: item.originalName,
    mediaType: item.mediaType,
    contentHash: item.contentHash,
    byteLength: item.byteLength,
    title: item.title ?? null,
    authors: [...(item.authors ?? [])],
    sourceUrl: item.sourceUrl ?? null,
    license: item.license ?? null,
    tags: [...(item.tags ?? [])],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function publicJob(job: StoredJob): ReferenceJobV1 {
  return {
    version: 1,
    jobId: job.jobId,
    operation: job.operation,
    status: job.status,
    referenceId: job.referenceId,
    bytesReceived: job.bytesReceived,
    totalBytes: job.totalBytes,
    contentHash: job.contentHash,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function errorDetails(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof ReferencePortInputError) return { code: error.code, message: error.message };
  return { code: 'REFERENCE_OPERATION_FAILED', message: 'Reference operation failed' };
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string): Record<string, unknown> {
  if (value.length === 0 || value.length > REFERENCE_MCP_LIMITS_V1.maxCursorLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ReferencePortInputError('Cursor is invalid');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ReferencePortInputError('Cursor is invalid');
  }
}

function searchIdentity(input: McpReferenceSearchInputV1): string {
  return JSON.stringify({
    query: input.query.toLowerCase(),
    filters: {
      referenceId: input.filters?.referenceId ?? null,
      mediaType: input.filters?.mediaType ?? null,
      tag: input.filters?.tag ?? null,
    },
  });
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readStream(stream: NodeJS.ReadableStream, maximum: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const value of stream as AsyncIterable<Uint8Array | string>) {
    const part = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    total += part.byteLength;
    if (total > maximum) throw new ReferencePortInputError(`Reference read exceeds the ${maximum}-byte limit`, 'REFERENCE_TOO_LARGE');
    parts.push(part);
  }
  return Buffer.concat(parts, total);
}

function decodeChunk(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new ReferencePortInputError('dataBase64 is invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new ReferencePortInputError('dataBase64 is not canonical');
  return bytes;
}

function jobDirectory(root: string, jobId: string): string {
  assertIdentifier(jobId, 'jobId');
  return path.join(root, jobId);
}

async function readJob(root: string, jobId: string): Promise<StoredJob | null> {
  const file = path.join(jobDirectory(root, jobId), 'job.json');
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid job record');
    const job = value as StoredJob;
    if (job.recordVersion !== JOB_RECORD_VERSION || job.version !== 1 || job.jobId !== jobId || !Array.isArray(job.inputChunks) || !Array.isArray(job.derivedChunks)) {
      throw new Error('Invalid job record');
    }
    return job;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJob(root: string, job: StoredJob): Promise<void> {
  const directory = jobDirectory(root, job.jobId);
  await fs.mkdir(path.join(directory, 'chunks'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(directory, 'derived'), { recursive: true, mode: 0o700 });
  await atomicJson(path.join(directory, 'job.json'), job);
}

async function allJobs(root: string): Promise<StoredJob[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: StoredJob[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const job = await readJob(root, entry.name);
    if (job !== null) result.push(job);
  }
  result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
  return result;
}

function changed(job: StoredJob, update: Partial<StoredJob>): StoredJob {
  return { ...job, ...update, updatedAt: nowIso() };
}

function inputChunks(job: StoredJob): readonly InputChunk[] {
  return [...job.inputChunks].sort((a, b) => a.offset - b.offset);
}

type QuotaItem = Pick<ReferenceLibraryItemV1, 'referenceId' | 'byteLength' | 'mediaType' | 'contentHash'>;

/**
 * Build the concrete Host reference port. The project identity and source root
 * are closed over; callers only receive path-free MCP DTOs.
 */
export function createWorkbenchReferencePort(
  options: WorkbenchReferencePortOptions,
  suppliedStore?: FileProjectReferenceStoreContract,
): McpReferencePort {
  if (options === null || typeof options !== 'object') throw new TypeError('Reference port options are required');
  assertIdentifier(options.projectId, 'projectId', 4096);
  const projectRoot = absoluteRoot(options.projectRoot, 'projectRoot');
  const jobsRoot = absoluteRoot(options.jobsRoot, 'jobsRoot');
  const jobsDirectory = path.join(jobsRoot, options.projectId);
  if (
    jobsRoot === projectRoot ||
    jobsRoot.startsWith(`${projectRoot}${path.sep}`) ||
    jobsDirectory === projectRoot ||
    jobsDirectory.startsWith(`${projectRoot}${path.sep}`)
  ) {
    throw new TypeError('jobsRoot must not place durable state under projectRoot');
  }
  validateLimits(options.referenceLimits);
  const limits = options.referenceLimits;
  const store = suppliedStore ?? options.store ?? new FileProjectReferenceStore({
    maxFileBytes: limits.maxFileBytes,
    maxBytesPerProject: limits.maxBytesPerProject,
    maxItemsPerProject: limits.maxItemsPerProject,
    maxReadBytes: Math.min(limits.maxFileBytes, REFERENCE_MCP_LIMITS_V1.maxRangeBytes),
  });
  const configuredImportChunkBytes = Math.min(
    REFERENCE_MCP_LIMITS_V1.maxChunkBytes,
    Math.max(1, limits.mcpImportChunkBytes),
  );
  const configuredExtractionChunkBytes = Math.min(
    REFERENCE_MCP_LIMITS_V1.maxChunkBytes,
    Math.max(1, limits.maxChunkCharacters),
  );
  const extractorFor = (mediaType: string): DeterministicReferenceExtractor =>
    new DeterministicReferenceExtractor({
      ...(isTextMediaType(mediaType)
        ? {
            chunkCharacters: configuredExtractionChunkBytes,
            chunkOverlapCharacters: limits.chunkOverlapCharacters,
          }
        : { chunkBytes: configuredExtractionChunkBytes }),
      maxChunks: Math.max(1, limits.maxChunksPerProject),
      maxQuoteLength: Math.min(
        limits.maxChunkCharacters,
        REFERENCE_MCP_LIMITS_V1.maxQuoteLength,
      ),
    });
  const ensureEnabled = (): void => {
    if (!limits.enabled) throw new ReferencePortInputError('Reference library is disabled', 'REFERENCE_DISABLED');
  };
  const inFlightJobs = new Set<string>();
  const ensureJobsDirectory = async (): Promise<void> => {
    await fs.mkdir(jobsDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(jobsDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Reference jobs directory is not a regular directory');
  };
  const ensureReferencesDirectory = async (): Promise<string> => {
    const directory = path.join(projectRoot, 'references');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Reference directory is not a regular directory');
    return directory;
  };
  const catalog = async (): Promise<ReferenceLibraryReadV1 | null> => store.read(options.projectId, projectRoot);

  const paginate = async (
    mode: 'list' | 'search',
    input: McpReferenceListInputV1 | McpReferenceSearchInputV1,
    values: readonly ReferenceItemV1[],
    identity: string,
    manifestHash: string,
  ): Promise<{ readonly items: readonly ReferenceItemV1[]; readonly nextCursor: string | null }> => {
    const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    assertPositiveInteger(pageSize, 'pageSize', REFERENCE_MCP_LIMITS_V1.maxPageSize);
    let offset = 0;
    if (input.cursor !== undefined) {
      assertText(input.cursor, 'cursor', REFERENCE_MCP_LIMITS_V1.maxCursorLength);
      const cursor = decodeCursor(input.cursor);
      if (cursor.version !== 1 || cursor.mode !== mode || cursor.identity !== identity || cursor.manifestHash !== manifestHash) {
        throw new ReferencePortInputError('Cursor does not match the current reference catalog');
      }
      assertInteger(cursor.offset, 'cursor offset');
      offset = cursor.offset;
      if (offset > values.length) throw new ReferencePortInputError('Cursor offset is outside the result set');
    }
    const items = values.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < values.length ? encodeCursor({ version: 1, mode, identity, manifestHash, offset: nextOffset }) : null,
    };
  };

  const extract = async (item: QuotaItem): Promise<readonly ReferenceChunkV1[]> => {
    const started = Date.now();
    const content = await store.readContent(options.projectId, projectRoot, item.referenceId, {
      start: 0,
      endExclusive: item.byteLength,
      maxBytes: limits.maxFileBytes,
    });
    const bytes = await readStream(content.content, limits.maxFileBytes);
    if (bytes.byteLength !== item.byteLength || digest(bytes) !== item.contentHash) {
      throw new ReferencePortInputError(`Reference object integrity mismatch: ${item.referenceId}`, 'REFERENCE_CORRUPT');
    }
    const chunks = extractorFor(item.mediaType).extract({
      referenceId: item.referenceId,
      mediaType: item.mediaType,
      content: bytes,
      contentHash: item.contentHash,
    });
    if (Date.now() - started > limits.extractionTimeoutMs) {
      throw new ReferencePortInputError('Reference extraction timed out', 'EXTRACTION_TIMEOUT');
    }
    return chunks;
  };

  const checkQuotas = async (
    current: ReferenceLibraryReadV1 | null,
    replacingId: string | undefined,
    item: QuotaItem,
    chunks: readonly ReferenceChunkV1[],
  ): Promise<void> => {
    const existing = (current?.manifest.items ?? []).filter((entry) => entry.referenceId !== replacingId);
    if (existing.length + 1 > limits.maxItemsPerProject) throw new ReferencePortInputError(`Reference item quota exceeded: ${limits.maxItemsPerProject}`, 'REFERENCE_QUOTA');
    const bytes = existing.reduce((total, entry) => total + entry.byteLength, 0) + item.byteLength;
    if (bytes > limits.maxBytesPerProject) throw new ReferencePortInputError(`Project reference byte quota exceeded: ${limits.maxBytesPerProject}`, 'REFERENCE_QUOTA');
    let chunkCount = chunks.length;
    let extractedCharacters = chunks.reduce((total, chunk) => total + (chunk.quote?.length ?? 0), 0);
    for (const existingItem of existing) {
      const derived = await extract(existingItem);
      chunkCount += derived.length;
      extractedCharacters += derived.reduce((total, chunk) => total + (chunk.quote?.length ?? 0), 0);
    }
    if (chunkCount > limits.maxChunksPerProject) throw new ReferencePortInputError(`Reference chunk quota exceeded: ${limits.maxChunksPerProject}`, 'REFERENCE_QUOTA');
    if (extractedCharacters > limits.maxExtractedCharactersPerProject) throw new ReferencePortInputError(`Extracted reference character quota exceeded: ${limits.maxExtractedCharactersPerProject}`, 'REFERENCE_QUOTA');
  };

  const assemble = async (job: StoredJob): Promise<Buffer> => {
    let offset = 0;
    const pieces: Buffer[] = [];
    const hash = createHash('sha256');
    for (const chunk of inputChunks(job)) {
      if (chunk.offset !== offset) throw new ReferencePortInputError('Import chunks must be contiguous', 'CHUNK_SEQUENCE_INVALID');
      const file = path.join(jobDirectory(jobsDirectory, job.jobId), 'chunks', `${chunk.offset}.bin`);
      const bytes = await fs.readFile(file);
      if (bytes.byteLength !== chunk.byteLength || digest(bytes) !== chunk.chunkHash) throw new ReferencePortInputError('Import chunk integrity validation failed', 'CHUNK_INTEGRITY_INVALID');
      hash.update(bytes);
      offset += bytes.byteLength;
      pieces.push(bytes);
    }
    if (offset !== job.totalBytes || hash.digest('hex') !== job.declaredContentHash) throw new ReferencePortInputError('Import chunks do not match declared length or hash', 'CONTENT_INTEGRITY_INVALID');
    return Buffer.concat(pieces, offset);
  };

  const markFailed = async (jobId: string, error: unknown): Promise<StoredJob> => {
    await ensureJobsDirectory();
    return withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const current = await readJob(jobsDirectory, jobId);
      if (current === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
      const details = errorDetails(error);
      const failed = changed(current, { status: 'failed', errorCode: details.code, errorMessage: details.message });
      await writeJob(jobsDirectory, failed);
      return failed;
    });
  };

  const processImport = async (jobId: string): Promise<StoredJob> => {
    const job = await readJob(jobsDirectory, jobId);
    if (job === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
    const bytes = await assemble(job);
    const declaredContentHash = job.declaredContentHash;
    const referenceId = job.referenceId;
    const mediaType = job.mediaType;
    const originalName = job.originalName;
    if (declaredContentHash === undefined || referenceId === null || mediaType === undefined || originalName === undefined) {
      throw new ReferencePortInputError('Import job metadata is incomplete', 'JOB_CORRUPT');
    }
    const stagedChunks = extractorFor(mediaType).extract({
      referenceId,
      mediaType,
      content: bytes,
      contentHash: declaredContentHash,
    });
    const referencesDirectory = await ensureReferencesDirectory();
    const imported = await withDirectoryLock(projectRoot, referencesDirectory, async () => {
      const current = await catalog();
      const existing = current?.manifest.items.find((item) => item.referenceId === referenceId);
      const itemForQuota: QuotaItem = {
        referenceId,
        byteLength: bytes.byteLength,
        mediaType,
        contentHash: declaredContentHash,
      };
      await checkQuotas(current, existing?.referenceId, itemForQuota, stagedChunks);
      if (existing !== undefined && existing.contentHash === declaredContentHash && existing.byteLength === bytes.byteLength) {
        const verifiedChunks = await extract(existing);
        if (JSON.stringify(verifiedChunks) !== JSON.stringify(stagedChunks)) throw new ReferencePortInputError('Verified extraction differs from staged content', 'REFERENCE_CORRUPT');
        return { item: existing, chunks: verifiedChunks };
      }
      const input = {
        referenceId,
        originalName,
        displayName: job.displayName,
        mediaType,
        title: job.title,
        authors: job.authors,
        sourceUrl: job.sourceUrl,
        license: job.license,
        tags: job.tags,
        content: (async function* (): AsyncIterable<Uint8Array> {
          for (const chunk of inputChunks(job)) {
            yield await fs.readFile(path.join(jobDirectory(jobsDirectory, job.jobId), 'chunks', `${chunk.offset}.bin`));
          }
        })(),
        expectedManifestHash: current?.manifestHash ?? null,
        maxBytes: limits.maxFileBytes,
        maxBytesPerProject: limits.maxBytesPerProject,
        maxItemsPerProject: limits.maxItemsPerProject,
      };
      const result = await store.import(input, options.projectId, projectRoot);
      const item = result.manifest.items.find((entry) => entry.referenceId === referenceId);
      if (item === undefined || item.contentHash !== declaredContentHash || item.byteLength !== bytes.byteLength) throw new ReferencePortInputError('Node reference store returned an unexpected item', 'REFERENCE_CORRUPT');
      const verifiedChunks = await extract(item);
      if (JSON.stringify(verifiedChunks) !== JSON.stringify(stagedChunks)) throw new ReferencePortInputError('Verified extraction differs from staged content', 'REFERENCE_CORRUPT');
      return { item, chunks: verifiedChunks };
    });
    await ensureJobsDirectory();
    return withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const current = await readJob(jobsDirectory, jobId);
      if (current === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
      const succeeded = changed(current, {
        status: 'succeeded',
        bytesReceived: imported.item.byteLength,
        contentHash: imported.item.contentHash,
        errorCode: null,
        errorMessage: null,
        derivedChunks: imported.chunks,
      });
      await writeJob(jobsDirectory, succeeded);
      return succeeded;
    });
  };

  const processDelete = async (jobId: string): Promise<StoredJob> => {
    const referencesDirectory = await ensureReferencesDirectory();
    await withDirectoryLock(projectRoot, referencesDirectory, async () => {
      const job = await readJob(jobsDirectory, jobId);
      if (job === null || job.referenceId === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
      const referenceId = job.referenceId;
      const current = await catalog();
      const exists = current?.manifest.items.some((item) => item.referenceId === referenceId) ?? false;
      if (!exists) {
        if (job.deleteExpectedContentHash === null || job.deleteExpectedContentHash === undefined) {
          throw new ReferencePortInputError(`Reference not found: ${referenceId}`, 'REFERENCE_NOT_FOUND');
        }
        return;
      }
      await store.delete({ referenceId, expectedManifestHash: current?.manifestHash ?? null }, options.projectId, projectRoot);
    });
    await ensureJobsDirectory();
    return withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const current = await readJob(jobsDirectory, jobId);
      if (current === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
      const succeeded = changed(current, { status: 'succeeded', errorCode: null, errorMessage: null });
      await writeJob(jobsDirectory, succeeded);
      return succeeded;
    });
  };

  const runJob = async (jobId: string): Promise<StoredJob> => {
    const job = await readJob(jobsDirectory, jobId);
    if (job === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
    try {
      return job.originOperation === 'delete' || job.operation === 'delete' ? await processDelete(jobId) : await processImport(jobId);
    } catch (error) {
      return markFailed(jobId, error);
    }
  };
  const executeJob = async (jobId: string): Promise<StoredJob> => {
    inFlightJobs.add(jobId);
    try {
      return await runJob(jobId);
    } finally {
      inFlightJobs.delete(jobId);
    }
  };

  const list = async (input: McpReferenceListInputV1): Promise<McpReferenceListOutputV1> => {
    ensureEnabled();
    assertVersion(input.version);
    const current = await catalog();
    const values = (current?.manifest.items ?? []).map(safeItem).sort((a, b) => a.referenceId.localeCompare(b.referenceId));
    return { version: 1, ...(await paginate('list', input, values, 'list', current?.manifestHash ?? 'empty')) };
  };

  const get = async (input: McpReferenceGetInputV1): Promise<McpReferenceGetOutputV1 | null> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.referenceId, 'referenceId');
    const current = await catalog();
    const item = current?.manifest.items.find((entry) => entry.referenceId === input.referenceId);
    return item === undefined ? null : { version: 1, item: safeItem(item) };
  };

  const search = async (input: McpReferenceSearchInputV1): Promise<McpReferenceSearchOutputV1> => {
    ensureEnabled();
    assertVersion(input.version);
    assertText(input.query, 'query', REFERENCE_MCP_LIMITS_V1.maxQueryLength);
    if (input.filters !== undefined && (typeof input.filters !== 'object' || input.filters === null || Array.isArray(input.filters))) {
      throw new ReferencePortInputError('filters must be an object');
    }
    if (input.filters?.referenceId !== undefined) assertIdentifier(input.filters.referenceId, 'referenceId');
    if (input.filters?.mediaType !== undefined) assertText(input.filters.mediaType, 'mediaType', REFERENCE_MCP_LIMITS_V1.maxMediaTypeLength);
    if (input.filters?.tag !== undefined) assertText(input.filters.tag, 'tag', REFERENCE_MCP_LIMITS_V1.maxTagLength);
    const query = input.query.toLowerCase();
    const current = await catalog();
    const values = (current?.manifest.items ?? []).filter((item) => {
      const searchable = [item.referenceId, item.displayName, item.originalName, item.mediaType, item.title ?? '', ...(item.authors ?? []), item.sourceUrl ?? '', item.license ?? '', ...(item.tags ?? [])].join('\u0000').toLowerCase();
      return searchable.includes(query) &&
        (input.filters?.referenceId === undefined || item.referenceId === input.filters.referenceId) &&
        (input.filters?.mediaType === undefined || item.mediaType === input.filters.mediaType) &&
        (input.filters?.tag === undefined || (item.tags ?? []).includes(input.filters.tag));
    }).map(safeItem).sort((a, b) => a.referenceId.localeCompare(b.referenceId));
    return { version: 1, ...(await paginate('search', input, values, searchIdentity(input), current?.manifestHash ?? 'empty')) };
  };

  const getChunk = async (input: McpReferenceChunkGetInputV1): Promise<McpReferenceChunkGetOutputV1 | null> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.referenceId, 'referenceId');
    assertText(input.chunkId, 'chunkId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
    const current = await catalog();
    const item = current?.manifest.items.find((entry) => entry.referenceId === input.referenceId);
    if (item === undefined) return null;
    await ensureJobsDirectory();
    const persisted = (await allJobs(jobsDirectory)).filter((job) => job.status === 'succeeded' && job.referenceId === input.referenceId && job.contentHash === item.contentHash).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const chunks = persisted?.derivedChunks.length ? persisted.derivedChunks : await extract(item);
    const chunk = chunks.find((entry) => entry.chunkId === input.chunkId);
    return chunk === undefined ? null : { version: 1, chunk };
  };

  const readContent = async (input: McpReferenceContentReadInputV1): Promise<McpReferenceContentReadOutputV1> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.referenceId, 'referenceId');
    assertInteger(input.offset, 'offset', REFERENCE_MCP_LIMITS_V1.maxOffset);
    assertPositiveInteger(input.limit, 'limit', REFERENCE_MCP_LIMITS_V1.maxRangeBytes);
    const current = await catalog();
    const item = current?.manifest.items.find((entry) => entry.referenceId === input.referenceId);
    if (item === undefined) throw new ReferencePortInputError(`Reference not found: ${input.referenceId}`, 'REFERENCE_NOT_FOUND');
    const endExclusive = input.offset + input.limit;
    if (endExclusive < input.offset || endExclusive > item.byteLength) throw new ReferencePortInputError('Reference range is outside object bounds');
    const result = await store.readContent(options.projectId, projectRoot, input.referenceId, { start: input.offset, endExclusive, maxBytes: input.limit });
    const bytes = await readStream(result.content, REFERENCE_MCP_LIMITS_V1.maxRangeBytes);
    return {
      version: 1,
      content: {
        version: 1,
        referenceId: item.referenceId,
        mediaType: item.mediaType,
        contentHash: item.contentHash,
        byteLength: bytes.byteLength,
        range: { version: 1, offset: input.offset, length: bytes.byteLength },
        dataBase64: bytes.toString('base64'),
        nextOffset: endExclusive < item.byteLength ? endExclusive : null,
      },
    };
  };

  const importBegin = async (input: McpReferenceImportBeginInputV1): Promise<McpReferenceImportBeginOutputV1> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.referenceId, 'referenceId');
    assertText(input.originalName, 'originalName', REFERENCE_MCP_LIMITS_V1.maxNameLength);
    if (input.displayName !== undefined) assertText(input.displayName, 'displayName', REFERENCE_MCP_LIMITS_V1.maxNameLength);
    assertText(input.mediaType, 'mediaType', REFERENCE_MCP_LIMITS_V1.maxMediaTypeLength);
    assertInteger(input.byteLength, 'byteLength', Math.min(REFERENCE_MCP_LIMITS_V1.maxReferenceBytes, limits.maxFileBytes));
    assertHash(input.contentHash, 'contentHash');
    assertText(input.idempotencyKey, 'idempotencyKey', REFERENCE_MCP_LIMITS_V1.maxIdempotencyKeyLength);
    const arrays: readonly [string, readonly string[] | undefined, number, number][] = [
      ['authors', input.authors, REFERENCE_MCP_LIMITS_V1.maxAuthorCount, REFERENCE_MCP_LIMITS_V1.maxAuthorLength],
      ['tags', input.tags, REFERENCE_MCP_LIMITS_V1.maxTagCount, REFERENCE_MCP_LIMITS_V1.maxTagLength],
    ];
    for (const [label, values, maxCount, maxLength] of arrays) {
      if (values !== undefined && (!Array.isArray(values) || values.length > maxCount || values.some((value) => typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_RE.test(value)))) throw new ReferencePortInputError(`${label} is invalid`);
    }
    for (const [label, value] of [['title', input.title], ['sourceUrl', input.sourceUrl], ['license', input.license]] as const) {
      if (value !== undefined) assertText(value, label, REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength);
    }
    await ensureJobsDirectory();
    return withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const jobs = await allJobs(jobsDirectory);
      const existing = jobs.find((job) => job.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.referenceId !== input.referenceId || existing.declaredContentHash !== input.contentHash || existing.totalBytes !== input.byteLength) throw new ReferencePortInputError('Idempotency key is already bound to another import');
        return { version: 1, job: publicJob(existing) };
      }
      if (jobs.filter((job) => job.status === 'queued' || job.status === 'running').length >= limits.maxPendingJobsPerProject) throw new ReferencePortInputError(`Pending reference job quota exceeded: ${limits.maxPendingJobsPerProject}`, 'REFERENCE_QUOTA');
      const current = await catalog();
      const replacing = current?.manifest.items.some((item) => item.referenceId === input.referenceId) ?? false;
      if (!replacing && (current?.manifest.items.length ?? 0) >= limits.maxItemsPerProject) throw new ReferencePortInputError(`Reference item quota exceeded: ${limits.maxItemsPerProject}`, 'REFERENCE_QUOTA');
      const existingBytes = (current?.manifest.items ?? []).reduce((total, item) => item.referenceId === input.referenceId ? total : total + item.byteLength, 0);
      if (existingBytes > limits.maxBytesPerProject - input.byteLength) throw new ReferencePortInputError(`Project reference byte quota exceeded: ${limits.maxBytesPerProject}`, 'REFERENCE_QUOTA');
      const at = nowIso();
      const job: StoredJob = {
        recordVersion: 1,
        version: 1,
        jobId: randomUUID(),
        operation: 'import',
        originOperation: 'import',
        status: 'queued',
        referenceId: input.referenceId,
        bytesReceived: 0,
        totalBytes: input.byteLength,
        contentHash: input.contentHash,
        declaredContentHash: input.contentHash,
        errorCode: null,
        errorMessage: null,
        createdAt: at,
        updatedAt: at,
        idempotencyKey: input.idempotencyKey,
        originalName: input.originalName,
        displayName: input.displayName,
        mediaType: input.mediaType,
        title: input.title,
        authors: input.authors === undefined ? undefined : [...input.authors],
        sourceUrl: input.sourceUrl,
        license: input.license,
        tags: input.tags === undefined ? undefined : [...input.tags],
        inputChunks: [],
        derivedChunks: [],
      };
      await writeJob(jobsDirectory, job);
      return { version: 1, job: publicJob(job) };
    });
  };

  const importChunk = async (input: McpReferenceImportChunkInputV1): Promise<McpReferenceImportChunkOutputV1> => {
    assertVersion(input.version);
    assertIdentifier(input.jobId, 'jobId');
    assertInteger(input.offset, 'offset', REFERENCE_MCP_LIMITS_V1.maxOffset);
    ensureEnabled();
    assertPositiveInteger(input.byteLength, 'byteLength', configuredImportChunkBytes);
    assertHash(input.chunkHash, 'chunkHash');
    assertText(input.dataBase64, 'dataBase64', REFERENCE_MCP_LIMITS_V1.maxChunkBase64Length);
    const bytes = decodeChunk(input.dataBase64);
    if (bytes.byteLength !== input.byteLength || digest(bytes) !== input.chunkHash) throw new ReferencePortInputError('Chunk length or hash does not match dataBase64');
    await ensureJobsDirectory();
    return withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const job = await readJob(jobsDirectory, input.jobId);
      if (job === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
      if (job.operation !== 'import' || job.status !== 'queued') {
        throw new ReferencePortInputError('Import job is not accepting chunks', 'JOB_STATE_INVALID');
      }
      if (input.offset + input.byteLength > (job.totalBytes ?? 0)) throw new ReferencePortInputError('Chunk exceeds declared content length');
      const existing = job.inputChunks.find((chunk) => chunk.offset === input.offset);
      if (existing !== undefined) {
        if (existing.byteLength !== input.byteLength || existing.chunkHash !== input.chunkHash) throw new ReferencePortInputError('Chunk offset is already occupied');
        return { version: 1, job: publicJob(job) };
      }
      const chunks = [...job.inputChunks, { offset: input.offset, byteLength: input.byteLength, chunkHash: input.chunkHash }];
      await fs.writeFile(path.join(jobDirectory(jobsDirectory, job.jobId), 'chunks', `${input.offset}.bin`), bytes, { flag: 'wx', mode: 0o600 });
      const updated = changed(job, { inputChunks: chunks, bytesReceived: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
      await writeJob(jobsDirectory, updated);
      return { version: 1, job: publicJob(updated) };
    });
  };

  // The port has no cancellation method: once commit transitions a durable
  // job to running, the store mutation owns the ordering. A job becomes
  // succeeded only after the manifest commit and verified derived chunks are
  // persisted; failures are terminal and are the sole retryable state.
  const importCommit = async (input: McpReferenceImportCommitInputV1): Promise<McpReferenceImportCommitOutputV1> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.jobId, 'jobId');
    assertHash(input.contentHash, 'contentHash');
    await ensureJobsDirectory();
    let job = await withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const current = await readJob(jobsDirectory, input.jobId);
      if (current === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
      if (current.operation !== 'import') throw new ReferencePortInputError('Job is not an import', 'JOB_STATE_INVALID');
      if (current.status === 'succeeded') return current;
      if (current.status !== 'queued') throw new ReferencePortInputError('Import job is not ready to commit', 'JOB_STATE_INVALID');
      const running = changed(current, { status: 'running', errorCode: null, errorMessage: null });
      await writeJob(jobsDirectory, running);
      return running;
    });
    if (job.status === 'succeeded') return { version: 1, job: publicJob(job) };
    if (input.contentHash !== job.declaredContentHash) {
      job = await markFailed(input.jobId, new ReferencePortInputError('contentHash does not match import metadata', 'CONTENT_HASH_INVALID'));
    } else {
      job = await executeJob(input.jobId);
    }
    return { version: 1, job: publicJob(job) };
  };

  const jobGet = async (input: McpReferenceJobGetInputV1): Promise<McpReferenceJobGetOutputV1 | null> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.jobId, 'jobId');
    await ensureJobsDirectory();
    let job = await readJob(jobsDirectory, input.jobId);
    if (job !== null && job.status === 'running' && !inFlightJobs.has(job.jobId)) {
      job = await executeJob(job.jobId);
    }
    return job === null ? null : { version: 1, job: publicJob(job) };
  };

  const retry = async (input: McpReferenceRetryInputV1): Promise<McpReferenceRetryOutputV1> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.jobId, 'jobId');
    await ensureJobsDirectory();
    const job = await withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const current = await readJob(jobsDirectory, input.jobId);
      if (current === null) throw new ReferencePortInputError('Reference job not found', 'JOB_NOT_FOUND');
      if (current.status !== 'failed') throw new ReferencePortInputError('Only a failed durable job can be retried', 'JOB_STATE_INVALID');
      const queued = changed(current, { operation: 'retry', originOperation: current.originOperation ?? (current.operation === 'delete' ? 'delete' : 'import'), status: 'running', errorCode: null, errorMessage: null });
      await writeJob(jobsDirectory, queued);
      return queued;
    });
    return { version: 1, job: publicJob(await executeJob(job.jobId)) };
  };

  const deleteReference = async (input: McpReferenceDeleteInputV1): Promise<McpReferenceDeleteOutputV1> => {
    ensureEnabled();
    assertVersion(input.version);
    assertIdentifier(input.referenceId, 'referenceId');
    await ensureJobsDirectory();
    const job = await withDirectoryLock(jobsRoot, jobsDirectory, async () => {
      const jobs = await allJobs(jobsDirectory);
      if (jobs.filter((entry) => entry.status === 'queued' || entry.status === 'running').length >= limits.maxPendingJobsPerProject) throw new ReferencePortInputError(`Pending reference job quota exceeded: ${limits.maxPendingJobsPerProject}`, 'REFERENCE_QUOTA');
      const target = (await catalog())?.manifest.items.find((item) => item.referenceId === input.referenceId);
      const at = nowIso();
      const created: StoredJob = {
        recordVersion: 1,
        version: 1,
        jobId: randomUUID(),
        operation: 'delete',
        originOperation: 'delete',
        status: 'running',
        referenceId: input.referenceId,
        bytesReceived: 0,
        totalBytes: null,
        contentHash: null,
        errorCode: null,
        errorMessage: null,
        createdAt: at,
        updatedAt: at,
        inputChunks: [],
        derivedChunks: [],
        deleteExpectedContentHash: target?.contentHash ?? null,
      };
      await writeJob(jobsDirectory, created);
      return created;
    });
    return { version: 1, job: publicJob(await executeJob(job.jobId)), deletedReferenceId: input.referenceId };
  };

  return {
    list,
    get,
    search,
    getChunk,
    readContent,
    importBegin,
    importChunk,
    importCommit,
    jobGet,
    retry,
    delete: deleteReference,
  } satisfies McpReferencePort;
}
