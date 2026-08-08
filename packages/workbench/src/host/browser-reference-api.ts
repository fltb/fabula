// ============================================================================
// Guarded browser reference mutation surface (plan 9.1)
// ----------------------------------------------------------------------------
// The browser-only reference write seam: multipart import, one-reference
// delete, and failed-import retry. Every route follows the same guard chain
// as the other browser surfaces — principal → project ACL → catalogue listing
// → 404 — and the browser never supplies a session, grant, actor, capability
// token or Host path.
//
// The routes reuse the exact McpReferencePort the MCP `nova_reference_*`
// tools drive (reference-port.ts): import runs the durable three-phase
// begin/chunk/commit sequence and delete/retry run their durable jobs, so no
// import or deletion logic is duplicated here. `referenceLimits.maxFileBytes`
// is enforced before the port is touched so an oversized upload fails with
// REFERENCE_SIZE_EXCEEDED instead of a generic validation error; the port
// remains the authoritative quota gate for everything else.
//
// The import response carries the terminal job (the port processes commits
// synchronously): `job.status === 'failed'` keeps `jobId` available for the
// retry route, which re-runs the durable job from its persisted chunks.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto';
import {
  type McpReferencePort,
  REFERENCE_MCP_LIMITS_V1,
  type ReferenceJobV1,
  type WorkbenchReferenceLimitsV1,
} from '@novalistically/workbench-protocol';
import type { Context, Handler } from 'hono';
import {
  BROWSER_API_VERSION,
  BROWSER_PROJECT_REFERENCE_PATH,
  BROWSER_PROJECT_REFERENCE_RETRY_PATH,
  BROWSER_PROJECT_REFERENCES_IMPORT_PATH,
  type BrowserApiErrorV1,
  type BrowserProjectReferenceDeleteResultV1,
  type BrowserProjectReferenceImportResultV1,
  type BrowserProjectReferenceRetryResultV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type {
  BrowserPrincipalResolution,
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from './browser-read-api.js';
import type { HostListenerEnv, MutationHttpMethod } from './listener.js';
import type { ProjectAccessRequiredRole, ProjectAccessService } from './project-access-service.js';
import type { HostServer } from './server.js';

/** Per-project reference port resolved by the Host; null = library disabled. */
export interface BrowserReferenceRegistry {
  get(
    projectId: string,
  ): McpReferencePort | null | undefined | Promise<McpReferencePort | null | undefined>;
}

export interface BrowserReferenceApiOptions {
  readonly principal: BrowserPrincipalResolver;
  /** Shared ACL/lifecycle service. When present it is the authoritative gate. */
  readonly access?: Pick<ProjectAccessService, 'authorize' | 'listProjects'>;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  readonly references: BrowserReferenceRegistry;
  /** Host reference-library limits; `maxFileBytes` bounds the upload pre-check. */
  readonly referenceLimits: WorkbenchReferenceLimitsV1;
}

export interface BrowserReferenceApiSurface {
  register(host: HostServer): void;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

const ERROR_STATUS: Readonly<Partial<Record<BrowserApiErrorV1['error']['code'], number>>> = {
  SESSION_NOT_FOUND: 401,
  SESSION_EXPIRED: 401,
  PROJECT_MISMATCH: 403,
  PROJECT_NOT_FOUND: 404,
  REFERENCE_NOT_FOUND: 404,
  REFERENCE_INVALID: 400,
  REFERENCE_CONFLICT: 409,
  REFERENCE_SIZE_EXCEEDED: 413,
  REFERENCE_UNAVAILABLE: 503,
  REFERENCE_IMPORT_FAILED: 500,
};

function errorResponse(code: BrowserApiErrorV1['error']['code'], message: string): Response {
  return json({ error: { code, message } }, ERROR_STATUS[code] ?? 500);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Map a Host port failure to a browser error response. `ReferencePortInputError`
 * carries stable codes (quota, job state, bounds); every other failure is a
 * host-side import/delete failure.
 */
function portErrorResponse(cause: unknown): Response {
  const code =
    cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
  const message = cause instanceof Error ? cause.message : 'The reference operation failed.';
  switch (code) {
    case 'REFERENCE_NOT_FOUND':
    case 'JOB_NOT_FOUND':
      return errorResponse('REFERENCE_NOT_FOUND', message);
    case 'REFERENCE_QUOTA':
    case 'JOB_STATE_INVALID':
      return errorResponse('REFERENCE_CONFLICT', message);
    case 'REFERENCE_TOO_LARGE':
      return errorResponse('REFERENCE_SIZE_EXCEEDED', message);
    case 'CONTENT_HASH_INVALID':
    case 'INVALID_INPUT':
      return errorResponse('REFERENCE_INVALID', message);
    default:
      return errorResponse('REFERENCE_IMPORT_FAILED', message);
  }
}

/** Map a terminal job failure (the durable job already ran) to a browser error. */
function failedJobResponse(job: ReferenceJobV1): Response {
  if (job.errorCode === 'REFERENCE_NOT_FOUND') {
    return errorResponse(
      'REFERENCE_NOT_FOUND',
      job.errorMessage ?? 'The reference does not exist.',
    );
  }
  return errorResponse(
    'REFERENCE_IMPORT_FAILED',
    job.errorMessage ?? 'The reference operation failed on the host.',
  );
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function displayNameFrom(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

type AccessResult =
  | { readonly ok: true; readonly principal: BrowserSessionPrincipalV1; readonly projectId: string }
  | { readonly ok: false; readonly response: Response };

class BrowserReferenceApiImpl {
  constructor(readonly options: BrowserReferenceApiOptions) {}

  async access(
    c: Context<HostListenerEnv>,
    requiredRole: ProjectAccessRequiredRole = 'author',
  ): Promise<AccessResult> {
    const resolution: BrowserPrincipalResolution = await this.options.principal.resolve(c.req.raw);
    if (!resolution.ok) {
      return {
        ok: false,
        response: errorResponse(
          'SESSION_NOT_FOUND',
          resolution.failure === 'SESSION_EXPIRED'
            ? 'The session has expired.'
            : 'The session is missing, revoked or unknown.',
        ),
      };
    }
    const projectId = c.req.param('projectId');
    if (!nonEmptyString(projectId)) {
      return {
        ok: false,
        response: errorResponse('PROJECT_NOT_FOUND', 'A project id is required.'),
      };
    }
    const authorized =
      this.options.access === undefined
        ? await this.options.authorization.canAccessProject(
            resolution.principal.userId,
            projectId,
            requiredRole,
          )
        : (
            await this.options.access.authorize({
              userId: resolution.principal.userId,
              projectId,
              requiredRole,
            })
          ).ok;
    if (!authorized) {
      return {
        ok: false,
        response: errorResponse(
          'PROJECT_MISMATCH',
          'The session is not authorized for this project.',
        ),
      };
    }
    const projects = await this.options.catalog.listProjects(resolution.principal);
    if (!projects.some((project) => project.projectId === projectId)) {
      return {
        ok: false,
        response: errorResponse(
          'PROJECT_NOT_FOUND',
          'The project is not in this session catalogue.',
        ),
      };
    }
    return { ok: true, principal: resolution.principal, projectId };
  }

  async port(projectId: string): Promise<McpReferencePort | Response> {
    const reference = await this.options.references.get(projectId);
    if (reference === null || reference === undefined) {
      return errorResponse(
        'REFERENCE_UNAVAILABLE',
        'The reference library is not enabled for this project.',
      );
    }
    return reference;
  }
}

function importHandler(api: BrowserReferenceApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'author');
    if (!access.ok) return access.response;
    const referenceOrError = await api.port(access.projectId);
    if (referenceOrError instanceof Response) return referenceOrError;

    let body: unknown;
    try {
      body = await c.req.parseBody();
    } catch {
      return errorResponse('REFERENCE_INVALID', 'The import request must be multipart/form-data.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse('REFERENCE_INVALID', 'The import request must be multipart/form-data.');
    }
    const form = body as Record<string, unknown>;
    const file = form.file;
    if (!(file instanceof File)) {
      return errorResponse('REFERENCE_INVALID', 'A multipart file field named "file" is required.');
    }
    if (file.size <= 0) {
      return errorResponse('REFERENCE_INVALID', 'The uploaded file is empty.');
    }
    const maxFileBytes = api.options.referenceLimits.maxFileBytes;
    if (file.size > maxFileBytes) {
      return errorResponse(
        'REFERENCE_SIZE_EXCEEDED',
        `The uploaded file exceeds the ${maxFileBytes}-byte limit.`,
      );
    }
    const originalName = file.name.length === 0 ? 'reference.bin' : file.name;
    const mediaType = file.type.length === 0 ? 'application/octet-stream' : file.type;
    const displayName =
      typeof form.displayName === 'string' && form.displayName.length > 0
        ? form.displayName
        : displayNameFrom(originalName);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return errorResponse('REFERENCE_IMPORT_FAILED', 'The uploaded file could not be read.');
    }
    const contentHash = digest(bytes);
    try {
      const began = await referenceOrError.importBegin({
        version: 1,
        referenceId: randomUUID(),
        originalName,
        displayName,
        mediaType,
        byteLength: bytes.byteLength,
        contentHash,
        idempotencyKey: randomUUID(),
      });
      const chunkBytes = Math.min(
        REFERENCE_MCP_LIMITS_V1.maxChunkBytes,
        Math.max(1, api.options.referenceLimits.mcpImportChunkBytes),
      );
      let offset = 0;
      while (offset < bytes.byteLength) {
        const chunk = bytes.slice(offset, Math.min(offset + chunkBytes, bytes.byteLength));
        await referenceOrError.importChunk({
          version: 1,
          jobId: began.job.jobId,
          offset,
          byteLength: chunk.byteLength,
          chunkHash: digest(chunk),
          dataBase64: Buffer.from(chunk).toString('base64'),
        });
        offset += chunk.byteLength;
      }
      const committed = await referenceOrError.importCommit({
        version: 1,
        jobId: began.job.jobId,
        contentHash,
      });
      if (committed.job.status === 'failed') return failedJobResponse(committed.job);
      const result: BrowserProjectReferenceImportResultV1 = {
        version: BROWSER_API_VERSION,
        projectId: access.projectId,
        job: committed.job,
      };
      return json(result, 201);
    } catch (error) {
      return portErrorResponse(error);
    }
  };
}

function deleteHandler(api: BrowserReferenceApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'author');
    if (!access.ok) return access.response;
    const referenceOrError = await api.port(access.projectId);
    if (referenceOrError instanceof Response) return referenceOrError;
    const referenceId = c.req.param('referenceId');
    if (!nonEmptyString(referenceId) || referenceId.length > 128) {
      return errorResponse(
        'REFERENCE_INVALID',
        'The reference id is missing or exceeds its bound.',
      );
    }
    try {
      const result = await referenceOrError.delete({ version: 1, referenceId });
      if (result.job.status === 'failed') return failedJobResponse(result.job);
      const body: BrowserProjectReferenceDeleteResultV1 = {
        version: BROWSER_API_VERSION,
        projectId: access.projectId,
        job: result.job,
        deletedReferenceId: result.deletedReferenceId,
      };
      return json(body);
    } catch (error) {
      return portErrorResponse(error);
    }
  };
}

function retryHandler(api: BrowserReferenceApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'author');
    if (!access.ok) return access.response;
    const referenceOrError = await api.port(access.projectId);
    if (referenceOrError instanceof Response) return referenceOrError;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse('REFERENCE_INVALID', 'The retry request must be JSON.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse('REFERENCE_INVALID', 'The retry request must be an object.');
    }
    const request = body as Record<string, unknown>;
    if (request.version !== BROWSER_API_VERSION) {
      return errorResponse('REFERENCE_INVALID', 'The retry request version is unsupported.');
    }
    const jobId = request.jobId;
    if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 128) {
      return errorResponse('REFERENCE_INVALID', 'A bounded jobId is required.');
    }
    try {
      const result = await referenceOrError.retry({ version: 1, jobId });
      if (result.job.status === 'failed') return failedJobResponse(result.job);
      const bodyResult: BrowserProjectReferenceRetryResultV1 = {
        version: BROWSER_API_VERSION,
        projectId: access.projectId,
        job: result.job,
      };
      return json(bodyResult);
    } catch (error) {
      return portErrorResponse(error);
    }
  };
}

export function createBrowserReferenceApi(
  options: BrowserReferenceApiOptions,
): BrowserReferenceApiSurface {
  const api = new BrowserReferenceApiImpl(options);
  const mutations: readonly {
    readonly method: MutationHttpMethod;
    readonly path: string;
    readonly handler: Handler<HostListenerEnv>;
  }[] = [
    { method: 'POST', path: BROWSER_PROJECT_REFERENCES_IMPORT_PATH, handler: importHandler(api) },
    { method: 'POST', path: BROWSER_PROJECT_REFERENCE_RETRY_PATH, handler: retryHandler(api) },
    { method: 'DELETE', path: BROWSER_PROJECT_REFERENCE_PATH, handler: deleteHandler(api) },
  ];
  return {
    register(host: HostServer): void {
      for (const route of mutations)
        host.registerMutationRoute(route.method, route.path, route.handler);
    },
  };
}
