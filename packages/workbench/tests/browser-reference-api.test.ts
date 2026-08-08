import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  type McpReferencePort,
  type WorkbenchReferenceLimitsV1,
} from '@novalistically/workbench-protocol';
import {
  BROWSER_PROJECT_REFERENCE_CONTENT_PATH,
  BROWSER_PROJECT_REFERENCE_PATH,
  BROWSER_PROJECT_REFERENCES_IMPORT_PATH,
  BROWSER_PROJECT_REFERENCES_PATH,
  BROWSER_SESSION_HEADER,
  type BrowserApiErrorV1,
  type BrowserProjectReferenceDeleteResultV1,
  type BrowserProjectReferenceImportResultV1,
  type BrowserProjectReferenceListV1,
  type BrowserSessionPrincipalV1,
} from '../src/contracts/browser-api.js';
import type {
  BrowserGraphProjector,
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
  BrowserProjectOverviewSource,
  BrowserReadApiOptions,
  BrowserSourceStudioSource,
} from '../src/host/browser-read-api.js';
import { createBrowserReferenceApi } from '../src/host/browser-reference-api.js';
import { createWorkbenchReferencePort } from '../src/host/mcp/reference-port.js';
import { createHostServer, type HostServer } from '../src/host/server.js';

const roots: string[] = [];

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const principal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'u-owner',
  role: 'owner',
  displayName: 'Owner',
  capabilityVersion: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const authHeaders = { [BROWSER_SESSION_HEADER]: 'session-1' };

const resolver: BrowserPrincipalResolver = {
  resolve: async (request) => {
    const session = request.headers.get(BROWSER_SESSION_HEADER);
    if (session !== 'session-1') return { ok: false, failure: 'SESSION_NOT_FOUND' };
    return { ok: true, principal };
  },
};

const authorization: BrowserProjectAuthorization = {
  canAccessProject: async (_userId, projectId) => projectId !== 'secret-project',
};

const catalog: BrowserProjectCatalog = {
  listProjects: async (current) =>
    current.userId === 'u-owner'
      ? [
          {
            version: 1,
            projectId: 'proj-a',
            displayName: 'Alpha',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
            open: true,
          },
        ]
      : [],
};

const overview: BrowserProjectOverviewSource = { loadOverview: async () => null };
const source: BrowserSourceStudioSource = { loadSourceStudio: async () => null };
const graph: BrowserGraphProjector = {
  project: async () => {
    throw new Error('graph projector is not exercised by reference tests');
  },
};

function browserOptions(): BrowserReadApiOptions {
  return {
    principal: resolver,
    authorization,
    catalog,
    overview,
    graph,
    source,
  };
}

function testLimits(
  overrides: Partial<WorkbenchReferenceLimitsV1> = {},
): WorkbenchReferenceLimitsV1 {
  return {
    ...DEFAULT_WORKBENCH_REFERENCE_LIMITS,
    maxFileBytes: 1024,
    maxBytesPerProject: 4096,
    maxItemsPerProject: 8,
    maxPendingJobsPerProject: 8,
    maxChunksPerProject: 128,
    maxExtractedCharactersPerProject: 4096,
    maxChunkCharacters: 128,
    chunkOverlapCharacters: 1,
    mcpImportChunkBytes: 256,
    extractionTimeoutMs: 10_000,
    ...overrides,
  };
}

interface Harness {
  readonly app: HostServer['app'];
  readonly close: () => Promise<void>;
  readonly port: McpReferencePort;
  readonly projectRoot: string;
}

async function makeHarness(limits: WorkbenchReferenceLimitsV1 = testLimits()): Promise<Harness> {
  const projectRoot = await fs.mkdtemp(path.join(tmpdir(), 'workbench-ref-api-project-'));
  const jobsRoot = await fs.mkdtemp(path.join(tmpdir(), 'workbench-ref-api-jobs-'));
  roots.push(projectRoot, jobsRoot);
  const port = createWorkbenchReferencePort({
    projectId: 'proj-a',
    projectRoot,
    jobsRoot,
    referenceLimits: limits,
  });
  const server = createHostServer({
    port: 0,
    browser: {
      ...browserOptions(),
      references: {
        loadReferences: async (projectId, query) => {
          const reference = await port;
          const listed = await reference.list({ version: 1, ...query });
          return { version: 1, projectId, items: listed.items, nextCursor: listed.nextCursor };
        },
        get: async (projectId, referenceId) => {
          const reference = await port;
          const result = await reference.get({ version: 1, referenceId });
          return result === null
            ? { version: 1, projectId, item: null }
            : { version: 1, projectId, item: result.item };
        },
        readContent: async (projectId, referenceId, query) => {
          const reference = await port;
          const result = await reference.readContent({
            version: 1,
            referenceId,
            offset: query.offset,
            limit: query.limit,
          });
          return { version: 1, projectId, content: result.content };
        },
      },
    },
  });
  createBrowserReferenceApi({
    principal: resolver,
    access: undefined,
    authorization,
    catalog,
    references: { get: async () => port },
    referenceLimits: limits,
  }).register(server);
  const handle = await server.start();
  return {
    app: server.app,
    port,
    projectRoot,
    close: async () => {
      await handle.close();
      await Promise.all(
        roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
      );
    },
  };
}

function importPath(): string {
  return BROWSER_PROJECT_REFERENCES_IMPORT_PATH.replace(':projectId', 'proj-a');
}

function referencePath(referenceId: string): string {
  return BROWSER_PROJECT_REFERENCE_PATH.replace(':projectId', 'proj-a').replace(
    ':referenceId',
    referenceId,
  );
}

function contentPath(referenceId: string): string {
  return BROWSER_PROJECT_REFERENCE_CONTENT_PATH.replace(':projectId', 'proj-a').replace(
    ':referenceId',
    referenceId,
  );
}

function multipartBody(bytes: Uint8Array, name = 'guide.txt', type = 'text/plain'): FormData {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }));
  return form;
}

async function importFile(
  harness: Harness,
  bytes: Uint8Array,
  name = 'guide.txt',
): Promise<{ readonly response: Response; readonly body: BrowserProjectReferenceImportResultV1 }> {
  const response = await harness.app.request(importPath(), {
    method: 'POST',
    headers: authHeaders,
    body: multipartBody(bytes, name),
  });
  const body = (await response.json()) as BrowserProjectReferenceImportResultV1;
  return { response, body };
}

async function expectError(
  response: Response,
  status: number,
  code: BrowserApiErrorV1['error']['code'],
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as BrowserApiErrorV1;
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
}

describe('browser reference mutation API', () => {
  it('imports a file through the durable three-phase port and serves it via the read routes', async () => {
    const harness = await makeHarness();
    try {
      const bytes = new TextEncoder().encode('abcde');
      const { response, body } = await importFile(harness, bytes);
      expect(response.status).toBe(201);
      expect(body.projectId).toBe('proj-a');
      expect(body.job.status).toBe('succeeded');
      const referenceId = body.job.referenceId;
      expect(referenceId).not.toBeNull();
      expect(body.job.totalBytes).toBe(5);

      // The list route reflects the imported item.
      const listed = (await (
        await harness.app.request(
          `${BROWSER_PROJECT_REFERENCES_PATH.replace(':projectId', 'proj-a')}?pageSize=10`,
          { headers: authHeaders },
        )
      ).json()) as BrowserProjectReferenceListV1;
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.displayName).toBe('guide');
      expect(listed.items[0]?.originalName).toBe('guide.txt');
      expect(listed.items[0]?.mediaType).toBe('text/plain');
      expect(listed.items[0]?.byteLength).toBe(5);

      // The one-reference route returns the projected item (no Host path).
      const getResponse = await harness.app.request(referencePath(referenceId ?? ''), {
        headers: authHeaders,
      });
      expect(getResponse.status).toBe(200);
      const getText = await getResponse.text();
      const getBody = JSON.parse(getText) as { readonly item: { readonly contentHash: string } };
      expect(getBody.item.contentHash).toBe(hash(bytes));
      expect(getText).not.toContain('objectKey');
      expect(getText).not.toContain(harness.projectRoot);

      // The bounded content route returns the object bytes.
      const contentResponse = await harness.app.request(
        `${contentPath(referenceId ?? '')}?offset=2&limit=3`,
        { headers: authHeaders },
      );
      expect(contentResponse.status).toBe(200);
      const content = (await contentResponse.json()) as {
        readonly content: { readonly dataBase64: string; readonly nextOffset: number | null };
      };
      expect(content.content.dataBase64).toBe(Buffer.from('cde').toString('base64'));
      expect(content.content.nextOffset).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('deletes one reference; a second delete is a 404 REFERENCE_NOT_FOUND', async () => {
    const harness = await makeHarness();
    try {
      const bytes = new TextEncoder().encode('delete-me');
      const { body } = await importFile(harness, bytes, 'delete-me.txt');
      const referenceId = body.job.referenceId;
      expect(referenceId).not.toBeNull();

      const deleteResponse = await harness.app.request(referencePath(referenceId ?? ''), {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(deleteResponse.status).toBe(200);
      const deleted = (await deleteResponse.json()) as BrowserProjectReferenceDeleteResultV1;
      expect(deleted.deletedReferenceId).toBe(referenceId);
      expect(deleted.job.status).toBe('succeeded');

      const afterDelete = (await (
        await harness.app.request(
          `${BROWSER_PROJECT_REFERENCES_PATH.replace(':projectId', 'proj-a')}?pageSize=10`,
          { headers: authHeaders },
        )
      ).json()) as BrowserProjectReferenceListV1;
      expect(afterDelete.items).toHaveLength(0);

      const secondDelete = await harness.app.request(referencePath(referenceId ?? ''), {
        method: 'DELETE',
        headers: authHeaders,
      });
      await expectError(secondDelete, 404, 'REFERENCE_NOT_FOUND');
    } finally {
      await harness.close();
    }
  });

  it('rejects an oversized upload with REFERENCE_SIZE_EXCEEDED before touching the port', async () => {
    const harness = await makeHarness();
    try {
      const bytes = new Uint8Array(2048).fill(1);
      const response = await harness.app.request(importPath(), {
        method: 'POST',
        headers: authHeaders,
        body: multipartBody(bytes, 'big.bin', 'application/octet-stream'),
      });
      await expectError(response, 413, 'REFERENCE_SIZE_EXCEEDED');

      // The oversized file never reached the library.
      const listed = (await (
        await harness.app.request(
          `${BROWSER_PROJECT_REFERENCES_PATH.replace(':projectId', 'proj-a')}?pageSize=10`,
          { headers: authHeaders },
        )
      ).json()) as BrowserProjectReferenceListV1;
      expect(listed.items).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('maps a project byte-quota violation to 409 REFERENCE_CONFLICT', async () => {
    const harness = await makeHarness(testLimits({ maxBytesPerProject: 4, maxFileBytes: 16 }));
    try {
      const first = await importFile(harness, new TextEncoder().encode('abcd'), 'a.txt');
      expect(first.response.status).toBe(201);
      expect(first.body.job.status).toBe('succeeded');

      const second = await harness.app.request(importPath(), {
        method: 'POST',
        headers: authHeaders,
        body: multipartBody(new TextEncoder().encode('wxyz'), 'b.txt'),
      });
      await expectError(second, 409, 'REFERENCE_CONFLICT');
    } finally {
      await harness.close();
    }
  });

  it('reports a 404 when retrying a job that never existed', async () => {
    const harness = await makeHarness();
    try {
      const retryResponse = await harness.app.request(
        `${BROWSER_PROJECT_REFERENCES_IMPORT_PATH.replace(':projectId', 'proj-a')}/retry`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, jobId: 'no-such-job' }),
        },
      );
      await expectError(retryResponse, 404, 'REFERENCE_NOT_FOUND');
    } finally {
      await harness.close();
    }
  });

  it('denies unauthenticated and unauthorized mutations', async () => {
    const harness = await makeHarness();
    try {
      const noSession = await harness.app.request(importPath(), {
        method: 'POST',
        body: multipartBody(new TextEncoder().encode('x')),
      });
      await expectError(noSession, 401, 'SESSION_NOT_FOUND');

      const secretProject = await harness.app.request(
        BROWSER_PROJECT_REFERENCES_IMPORT_PATH.replace(':projectId', 'secret-project'),
        {
          method: 'POST',
          headers: authHeaders,
          body: multipartBody(new TextEncoder().encode('x')),
        },
      );
      await expectError(secretProject, 403, 'PROJECT_MISMATCH');
    } finally {
      await harness.close();
    }
  });
});
