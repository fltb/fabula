import { describe, expect, it, vi } from 'vitest';
import {
  MCP_REFERENCE_READ_SCOPE,
  MCP_REFERENCE_WRITE_SCOPE,
  createProjectSessionMcpRegistry,
} from '../src/host/mcp/registry.js';
import type { McpAuthorizedCaller } from '../src/host/mcp/auth.js';
import type { McpReferencePort } from '@novalistically/workbench-protocol';
import type { ProjectSession } from '../src/host/project-session.js';

const item = {
  version: 1 as const,
  referenceId: 'guide',
  displayName: 'Guide',
  originalName: 'guide.txt',
  mediaType: 'text/plain',
  contentHash: 'a'.repeat(64),
  byteLength: 3,
  title: null,
  authors: [],
  sourceUrl: null,
  license: null,
  tags: [],
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

function referencePort(): McpReferencePort {
  const job = {
    version: 1 as const,
    jobId: 'job-1',
    operation: 'import' as const,
    status: 'succeeded' as const,
    referenceId: 'guide',
    bytesReceived: 3,
    totalBytes: 3,
    contentHash: item.contentHash,
    errorCode: null,
    errorMessage: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  return {
    list: vi.fn(async () => ({ version: 1 as const, items: [item], nextCursor: null })),
    get: vi.fn(async () => ({ version: 1 as const, item })),
    search: vi.fn(async () => ({ version: 1 as const, items: [item], nextCursor: null })),
    getChunk: vi.fn(async () => null),
    readContent: vi.fn(async () => ({
      version: 1 as const,
      content: {
        version: 1 as const,
        referenceId: item.referenceId,
        mediaType: item.mediaType,
        contentHash: item.contentHash,
        byteLength: 3,
        range: { version: 1 as const, offset: 0, length: 3 },
        dataBase64: 'YWJj',
        nextOffset: null,
      },
    })),
    importBegin: vi.fn(async () => ({ version: 1 as const, job })),
    importChunk: vi.fn(async () => ({ version: 1 as const, job })),
    importCommit: vi.fn(async () => ({ version: 1 as const, job })),
    jobGet: vi.fn(async () => ({ version: 1 as const, job })),
    retry: vi.fn(async () => ({ version: 1 as const, job })),
    delete: vi.fn(async () => ({ version: 1 as const, job, deletedReferenceId: item.referenceId })),
  };
}

const caller: McpAuthorizedCaller = {
  sessionId: null,
  userId: 'user-a',
  grant: {
    capabilityId: 'cap-a',
    userId: 'user-a',
    projectId: 'project-a',
    scopes: [MCP_REFERENCE_READ_SCOPE],
    version: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
};

describe('reference MCP registry binding', () => {
  it('binds catalog metadata and returns path-free item projections', async () => {
    const reference = referencePort();
    const session = { projectId: 'project-a' } as ProjectSession;
    const registry = createProjectSessionMcpRegistry(session, { reference, family: 'project' });
    const tool = registry.get('nova_reference_list');
    expect(tool?.requiredScopes).toEqual([MCP_REFERENCE_READ_SCOPE]);

    const result = await registry.run('nova_reference_list', caller, { version: 1 });
    expect(result).toEqual({ ok: true, data: { version: 1, items: [item], nextCursor: null } });
    expect(JSON.stringify(result)).not.toContain('objectKey');
    expect(reference.list).toHaveBeenCalledWith({ version: 1 });
  });

  it('rejects client-supplied project roots before reaching the Host port', async () => {
    const reference = referencePort();
    const session = { projectId: 'project-a' } as ProjectSession;
    const registry = createProjectSessionMcpRegistry(session, { reference, family: 'project' });
    const result = await registry.run('nova_reference_list', caller, { version: 1, projectRoot: '/private/project' });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } });
    expect(reference.list).not.toHaveBeenCalled();
  });

  it('validates import metadata shape before forwarding to the Host port', async () => {
    const reference = referencePort();
    const session = { projectId: 'project-a' } as ProjectSession;
    const registry = createProjectSessionMcpRegistry(session, { reference, family: 'project' });
    const base = {
      version: 1,
      referenceId: 'guide',
      originalName: 'guide.txt',
      mediaType: 'text/plain',
      byteLength: 3,
      contentHash: item.contentHash,
      idempotencyKey: 'idem-1',
    };
    const writeCaller: McpAuthorizedCaller = {
      ...caller,
      grant: { ...caller.grant, scopes: [MCP_REFERENCE_READ_SCOPE, MCP_REFERENCE_WRITE_SCOPE] },
    };
    const result = await registry.run('nova_reference_import_begin', writeCaller, { ...base, title: { nested: true } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(reference.importBegin).not.toHaveBeenCalled();
  });
});
