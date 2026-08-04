import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
  REFERENCE_MCP_LIMITS_V1,
  type McpReferencePort,
} from '@novalistically/workbench-protocol';
import { createWorkbenchReferencePort } from '../src/host/mcp/reference-port.js';

const roots: string[] = [];

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(): Promise<{ readonly projectRoot: string; readonly jobsRoot: string; readonly port: McpReferencePort }> {
  const projectRoot = await fs.mkdtemp(path.join(tmpdir(), 'workbench-reference-project-'));
  const jobsRoot = await fs.mkdtemp(path.join(tmpdir(), 'workbench-reference-jobs-'));
  roots.push(projectRoot, jobsRoot);
  const referenceLimits = {
    ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
    maxFileBytes: 1024,
    maxBytesPerProject: 4096,
    maxItemsPerProject: 8,
    maxPendingJobsPerProject: 8,
    maxChunksPerProject: 128,
    maxExtractedCharactersPerProject: 4096,
    maxChunkCharacters: 128,
    chunkOverlapCharacters: 1,
    mcpImportChunkBytes: 3,
    extractionTimeoutMs: 10_000,
  } as const;
  return {
    projectRoot,
    jobsRoot,
    port: createWorkbenchReferencePort({ projectId: 'project-a', projectRoot, jobsRoot, referenceLimits }),
  };
}

async function importBytes(port: McpReferencePort, referenceId: string, data: Uint8Array, idempotencyKey = referenceId): Promise<string> {
  const contentHash = hash(data);
  const began = await port.importBegin({
    version: 1,
    referenceId,
    originalName: `${referenceId}.txt`,
    displayName: referenceId,
    mediaType: 'text/plain',
    byteLength: data.byteLength,
    contentHash,
    idempotencyKey,
    title: 'A guide',
    authors: ['Author'],
    tags: ['guide'],
  });
  const jobId = began.job.jobId;
  for (let offset = 0; offset < data.byteLength; offset += 3) {
    const chunk = data.slice(offset, Math.min(offset + 3, data.byteLength));
    await port.importChunk({
      version: 1,
      jobId,
      offset,
      byteLength: chunk.byteLength,
      chunkHash: hash(chunk),
      dataBase64: Buffer.from(chunk).toString('base64'),
    });
  }
  const committed = await port.importCommit({ version: 1, jobId, contentHash });
  expect(committed.job.status).toBe('succeeded');
  return jobId;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Workbench Host reference MCP port', () => {
  it('imports through durable chunks and serves safe catalog, extraction, and content DTOs', async () => {
    const { port, projectRoot, jobsRoot } = await fixture();
    const bytes = new TextEncoder().encode('abcdefghi');
    const jobId = await importBytes(port, 'guide', bytes);

    const listed = await port.list({ version: 1, pageSize: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.referenceId).toBe('guide');
    expect(listed.nextCursor).toBeNull();
    expect((await port.search({ version: 1, query: 'AUTHOR', filters: { tag: 'guide' } })).items).toHaveLength(1);
    expect((await port.get({ version: 1, referenceId: 'guide' }))?.item.displayName).toBe('guide');

    const chunk = await port.getChunk({ version: 1, referenceId: 'guide', chunkId: 'guide:0' });
    expect(chunk?.chunk.range.offset).toBe(0);
    expect(chunk?.chunk.chunkHash).toBe(hash(bytes));
    const content = await port.readContent({ version: 1, referenceId: 'guide', offset: 3, limit: 3 });
    expect(content.content.dataBase64).toBe(Buffer.from('def').toString('base64'));
    expect(content.content.range).toEqual({ version: 1, offset: 3, length: 3 });

    const job = await port.jobGet({ version: 1, jobId });
    expect(job?.job.status).toBe('succeeded');
    const output = JSON.stringify({ listed, chunk, content, job });
    expect(output).not.toContain('objectKey');
    expect(output).not.toContain(projectRoot);
    expect(output).not.toContain(jobsRoot);
  });

  it('uses bounded byte chunks with no character overlap for binary references', async () => {
    const { port } = await fixture();
    const bytes = new Uint8Array([0, 255, 4]);
    const began = await port.importBegin({
      version: 1,
      referenceId: 'binary',
      originalName: 'binary.bin',
      mediaType: 'application/octet-stream',
      byteLength: bytes.byteLength,
      contentHash: hash(bytes),
      idempotencyKey: 'binary',
    });
    await port.importChunk({
      version: 1,
      jobId: began.job.jobId,
      offset: 0,
      byteLength: bytes.byteLength,
      chunkHash: hash(bytes),
      dataBase64: Buffer.from(bytes).toString('base64'),
    });
    await port.importCommit({ version: 1, jobId: began.job.jobId, contentHash: hash(bytes) });
    const chunk = await port.getChunk({ version: 1, referenceId: 'binary', chunkId: 'binary:0' });
    expect(chunk?.chunk.quote).toBeNull();
    expect(chunk?.chunk.range).toEqual({ version: 1, offset: 0, length: bytes.byteLength });
  });

  it('caps text chunk quotes to the MCP protocol maximum', async () => {
    const { projectRoot, jobsRoot } = await fixture();
    const port = createWorkbenchReferencePort({
      projectId: 'project-a',
      projectRoot,
      jobsRoot,
      referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
    });
    await importBytes(
      port,
      'long-text',
      new TextEncoder().encode('a'.repeat(REFERENCE_MCP_LIMITS_V1.maxQuoteLength + 1)),
    );
    const chunk = await port.getChunk({
      version: 1,
      referenceId: 'long-text',
      chunkId: 'long-text:0',
    });
    expect(chunk?.chunk.quote).toHaveLength(REFERENCE_MCP_LIMITS_V1.maxQuoteLength);
  });

  it('reconstructs durable jobs and derived chunks after Host construction', async () => {
    const { projectRoot, jobsRoot, port } = await fixture();
    const bytes = new TextEncoder().encode('restart-safe reference');
    const jobId = await importBytes(port, 'restart', bytes);
    const jobFile = path.join(jobsRoot, 'project-a', jobId, 'job.json');
    const durable = JSON.parse(await fs.readFile(jobFile, 'utf8')) as Record<string, unknown>;
    durable.status = 'running';
    durable.derivedChunks = [];
    await fs.writeFile(jobFile, `${JSON.stringify(durable)}\n`, 'utf8');
    const restarted = createWorkbenchReferencePort({
      projectId: 'project-a',
      projectRoot,
      jobsRoot,
      referenceLimits: {
        ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
        maxFileBytes: 1024,
        maxBytesPerProject: 4096,
        maxItemsPerProject: 8,
        maxPendingJobsPerProject: 8,
        maxChunksPerProject: 128,
        maxExtractedCharactersPerProject: 4096,
        maxChunkCharacters: 128,
        chunkOverlapCharacters: 1,
        mcpImportChunkBytes: 3,
        extractionTimeoutMs: 10_000,
      },
    });
    expect((await restarted.jobGet({ version: 1, jobId }))?.job.status).toBe('succeeded');
    expect((await restarted.getChunk({ version: 1, referenceId: 'restart', chunkId: 'restart:0' }))?.chunk.contentHash).toBe(hash(bytes));
    expect((await restarted.get({ version: 1, referenceId: 'restart' }))?.item.byteLength).toBe(bytes.byteLength);
  });

  it('fails a bad commit durably, retries only that failed job, deletes, and serializes concurrent imports', async () => {
    const { projectRoot, jobsRoot, port } = await fixture();
    const failedData = new TextEncoder().encode('bad');
    const failedHash = hash(failedData);
    const began = await port.importBegin({
      version: 1,
      referenceId: 'retry',
      originalName: 'retry.txt',
      mediaType: 'text/plain',
      byteLength: failedData.byteLength,
      contentHash: failedHash,
      idempotencyKey: 'retry-key',
    });
    await port.importChunk({
      version: 1,
      jobId: began.job.jobId,
      offset: 0,
      byteLength: failedData.byteLength,
      chunkHash: failedHash,
      dataBase64: Buffer.from(failedData).toString('base64'),
    });
    const failed = await port.importCommit({ version: 1, jobId: began.job.jobId, contentHash: '0'.repeat(64) });
    expect(failed.job.status).toBe('failed');
    const retried = await port.retry({ version: 1, jobId: began.job.jobId });
    expect(retried.job.status).toBe('succeeded');
    await expect(port.retry({ version: 1, jobId: began.job.jobId })).rejects.toThrow(/failed durable job/);

    const other = createWorkbenchReferencePort({
      projectId: 'project-a',
      projectRoot,
      jobsRoot,
      referenceLimits: {
        ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
        maxFileBytes: 1024,
        maxBytesPerProject: 4096,
        maxItemsPerProject: 8,
        maxPendingJobsPerProject: 8,
        maxChunksPerProject: 128,
        maxExtractedCharactersPerProject: 4096,
        maxChunkCharacters: 128,
        chunkOverlapCharacters: 1,
        mcpImportChunkBytes: 3,
        extractionTimeoutMs: 10_000,
      },
    });
    await Promise.all([
      importBytes(port, 'one', new TextEncoder().encode('one')),
      importBytes(other, 'two', new TextEncoder().encode('two')),
    ]);
    const deleted = await port.delete({ version: 1, referenceId: 'retry' });
    expect(deleted.job.status).toBe('succeeded');
    expect((await port.get({ version: 1, referenceId: 'retry' }))).toBeNull();
    const firstPage = await port.list({ version: 1, pageSize: 1 });
    expect(firstPage.items.map((item) => item.referenceId)).toEqual(['one']);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await port.list({ version: 1, pageSize: 1, cursor: firstPage.nextCursor ?? undefined });
    expect(secondPage.items.map((item) => item.referenceId)).toEqual(['two']);
  });

  it('fails closed for every job operation while the reference library is disabled', async () => {
    const { projectRoot, jobsRoot } = await fixture();
    const port = createWorkbenchReferencePort({
      projectId: 'project-a',
      projectRoot,
      jobsRoot,
      referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2, enabled: false },
    });
    await expect(port.jobGet({ version: 1, jobId: 'job' })).rejects.toThrow(/disabled/);
    await expect(
      port.importChunk({
        version: 1,
        jobId: 'job',
        offset: 0,
        byteLength: 1,
        chunkHash: hash(new TextEncoder().encode('a')),
        dataBase64: 'YQ==',
      }),
    ).rejects.toThrow(/disabled/);
  });
});
