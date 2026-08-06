// ============================================================================
// Guarded browser publication surface (plan Step 6.6)
// ----------------------------------------------------------------------------
// The browser-only publication seam: publication catalog (canonical + custom
// branches), one-record reads, the bounded content reader and the publish
// trigger. Every route follows the same guard chain as the other browser
// surfaces — principal → project ACL → catalogue listing → 404 — and the
// browser never supplies a session, grant, actor, capability token or Host
// path. `relativeOutputPath` is always project-relative, `actorId` is never
// echoed, and content is read through the bounded content route so the
// browser never learns where the artifact file lives on the Host.
//
// The publish POST goes through the same ProjectPublicationService as
// `nova_publish` (durable `publish` operation + record CAS + stale semantics):
// it enqueues and returns `outcome: 'queued'` with the operation id.
// ============================================================================

import type { BranchPath } from '@novalistically/core';
import type { Context, Handler } from 'hono';
import {
  BROWSER_API_VERSION,
  BROWSER_PROJECT_PUBLICATION_CONTENT_PATH,
  BROWSER_PROJECT_PUBLICATION_PATH,
  BROWSER_PROJECT_PUBLICATIONS_PATH,
  BROWSER_PUBLICATION_CONTENT_LIMIT_QUERY,
  BROWSER_PUBLICATION_CONTENT_OFFSET_QUERY,
  type BrowserPublicationGetResultV1,
  type BrowserPublicationListV1,
  type BrowserPublicationReadResultV1,
  type BrowserPublicationRecordV1,
  type BrowserPublishRequestV1,
  type BrowserPublishResultV1,
  type BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import type { ProjectPublicationRecordV1 } from '../contracts/persistence.js';
import type { AgentCapabilityGrant } from './agent/index.js';
import type {
  BrowserPrincipalResolution,
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from './browser-read-api.js';
import type { HostListenerEnv, MutationHttpMethod } from './listener.js';
import type { McpAuthorizedCaller } from './mcp/auth.js';
import type { ProjectAccessRequiredRole, ProjectAccessService } from './project-access-service.js';
import type {
  ProjectPublicationService,
  PublicationProjectionV1,
} from './publication/publication-service.js';
import type { HostServer } from './server.js';

/** Per-project publication service resolved by the Host; null = not ready. */
export interface BrowserPublicationRegistry {
  get(
    projectId: string,
  ): ProjectPublicationService | null | Promise<ProjectPublicationService | null>;
}

/** Resolves a server-owned mcp:submit capability for the publish trigger. */
export interface BrowserPublicationCapabilityResolver {
  resolve(input: {
    readonly principal: BrowserSessionPrincipalV1;
    readonly projectId: string;
  }): Promise<AgentCapabilityGrant | null>;
}

export interface BrowserPublicationApiOptions {
  readonly principal: BrowserPrincipalResolver;
  /** Shared ACL/lifecycle service; when present it is the authoritative role gate. */
  readonly access?: Pick<ProjectAccessService, 'authorize'>;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  readonly publications: BrowserPublicationRegistry;
  /** Capability resolver for the publish mutation; absent → POST fails closed. */
  readonly capabilities?: BrowserPublicationCapabilityResolver | null;
  readonly now?: () => string;
}

export interface BrowserPublicationApiSurface {
  register(host: HostServer): void;
}

export type BrowserPublicationErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'PUBLICATION_NOT_FOUND'
  | 'PUBLICATION_INVALID'
  | 'PUBLICATION_UNAVAILABLE'
  | 'PUBLICATION_CONFLICT'
  | 'INTERNAL';

const ERROR_STATUS: Readonly<Record<BrowserPublicationErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PROJECT_NOT_FOUND: 404,
  INVALID_INPUT: 400,
  PUBLICATION_NOT_FOUND: 404,
  PUBLICATION_INVALID: 400,
  PUBLICATION_UNAVAILABLE: 503,
  PUBLICATION_CONFLICT: 409,
  INTERNAL: 500,
};

/** Bounds shared with the MCP publication surface. */
export const BROWSER_PUBLICATION_READ_LIMIT = 256 * 1024;
const BROWSER_PUBLICATION_MAX_ID_LENGTH = 128;
const BROWSER_PUBLICATION_MAX_TITLE_LENGTH = 256;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function publicationError(
  code: BrowserPublicationErrorCode,
  message: string,
  status = ERROR_STATUS[code],
): Response {
  return json({ error: { code, message } }, status);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function readJson(c: Context<HostListenerEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

type AccessResult =
  | { readonly ok: true; readonly principal: BrowserSessionPrincipalV1; readonly projectId: string }
  | { readonly ok: false; readonly response: Response };

class BrowserPublicationApiImpl {
  constructor(readonly options: BrowserPublicationApiOptions) {}

  async access(
    c: Context<HostListenerEnv>,
    requiredRole: ProjectAccessRequiredRole = 'reader',
  ): Promise<AccessResult> {
    const resolution: BrowserPrincipalResolution = await this.options.principal.resolve(c.req.raw);
    if (!resolution.ok) {
      return {
        ok: false,
        response: publicationError(
          'UNAUTHORIZED',
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
        response: publicationError('PROJECT_NOT_FOUND', 'A project id is required.'),
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
        response: publicationError('FORBIDDEN', 'The session is not authorized for this project.'),
      };
    }
    const projects = await this.options.catalog.listProjects(resolution.principal);
    if (!projects.some((project) => project.projectId === projectId)) {
      return {
        ok: false,
        response: publicationError(
          'PROJECT_NOT_FOUND',
          'The project is not in this session catalogue.',
        ),
      };
    }
    return { ok: true, principal: resolution.principal, projectId };
  }

  async service(projectId: string): Promise<ProjectPublicationService | Response> {
    const service = await this.options.publications.get(projectId);
    if (service === null || service.projectId !== projectId) {
      return publicationError(
        'PUBLICATION_UNAVAILABLE',
        'The publication service is not available for this project.',
      );
    }
    return service;
  }

  /** One publish capability grant, resolved server-side (never caller-supplied). */
  async capability(
    access: Extract<AccessResult, { readonly ok: true }>,
  ): Promise<AgentCapabilityGrant | Response> {
    const resolver = this.options.capabilities;
    if (resolver === undefined || resolver === null) {
      return publicationError(
        'PUBLICATION_UNAVAILABLE',
        'The browser publication capability is unavailable.',
      );
    }
    const grant = await resolver.resolve({
      principal: access.principal,
      projectId: access.projectId,
    });
    if (grant === null) {
      return publicationError(
        'PUBLICATION_CONFLICT',
        'The browser publication capability could not be resolved.',
      );
    }
    return grant;
  }
}

/** Strict branch route selector parse for the publish body. */
function parsePublishBranchPath(
  value: unknown,
):
  | { readonly ok: true; readonly branchPath: BranchPath; readonly discourseBranch?: string }
  | { readonly ok: false; readonly message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'branchPath must be a strict route selector.' };
  }
  const selector = value as Record<string, unknown>;
  if (
    selector.version !== BROWSER_API_VERSION ||
    typeof selector.branchPath !== 'object' ||
    selector.branchPath === null ||
    Array.isArray(selector.branchPath)
  ) {
    return { ok: false, message: 'branchPath must be a strict route selector.' };
  }
  const branchPath = selector.branchPath as Record<string, unknown>;
  if (!Array.isArray(branchPath.decisions)) {
    return { ok: false, message: 'branchPath must contain exactly a decisions array.' };
  }
  const decisions: BranchPath['decisions'] = [];
  for (let index = 0; index < branchPath.decisions.length; index += 1) {
    const raw = branchPath.decisions[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, message: `route decision ${index} must be an object.` };
    }
    const decision = raw as Record<string, unknown>;
    const { atEventId, choiceId, narrativeOrder } = decision;
    if (
      typeof atEventId !== 'string' ||
      atEventId.length === 0 ||
      typeof choiceId !== 'string' ||
      choiceId.length === 0 ||
      typeof narrativeOrder !== 'number' ||
      !Number.isSafeInteger(narrativeOrder) ||
      narrativeOrder < 0
    ) {
      return {
        ok: false,
        message: `route decision ${index} must contain atEventId, choiceId, narrativeOrder.`,
      };
    }
    decisions.push({ atEventId, choiceId, narrativeOrder });
  }
  let discourseBranch: string | undefined;
  if ('discourseBranch' in selector) {
    const candidate = selector.discourseBranch;
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return { ok: false, message: 'discourseBranch must be a non-empty string.' };
    }
    discourseBranch = candidate;
  }
  return {
    ok: true,
    branchPath: { decisions },
    ...(discourseBranch === undefined ? {} : { discourseBranch }),
  };
}

function toBrowserRecord(
  projectId: string,
  record: ProjectPublicationRecordV1,
  projection: PublicationProjectionV1,
): BrowserPublicationRecordV1 {
  return {
    version: BROWSER_API_VERSION,
    projectId,
    publicationId: record.publicationId,
    kind: record.kind,
    status: projection.status,
    sourceHash: record.value.sourceHash,
    scopeHash: record.value.scopeHash,
    revisionIds: [...record.value.revisionIds],
    novelHash: record.value.novelHash,
    relativeOutputPath: record.value.relativeOutputPath,
    byteLength: record.value.byteLength,
    sceneCount: projection.sceneCount,
    wordCount: projection.wordCount,
    staleReasons: [...projection.staleReasons],
    operationId: record.value.operationId,
    createdAt: record.value.createdAt,
    updatedAt: record.updatedAt,
  };
}

function listHandler(api: BrowserPublicationApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const records = await serviceOrError.list();
    const publications = await Promise.all(
      records.map(async (record) =>
        toBrowserRecord(access.projectId, record, await serviceOrError.projectRecord(record)),
      ),
    );
    return json({
      version: BROWSER_API_VERSION,
      projectId: access.projectId,
      publications,
      generatedAt: api.options.now?.() ?? new Date().toISOString(),
    } satisfies BrowserPublicationListV1);
  };
}

function getHandler(api: BrowserPublicationApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const publicationId = c.req.param('publicationId');
    if (
      !nonEmptyString(publicationId) ||
      publicationId.length > BROWSER_PUBLICATION_MAX_ID_LENGTH
    ) {
      return publicationError('PUBLICATION_INVALID', 'publicationId must be a bounded identifier.');
    }
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const record = await serviceOrError.get(publicationId);
    const publication =
      record === null
        ? null
        : toBrowserRecord(access.projectId, record, await serviceOrError.projectRecord(record));
    return json({
      version: BROWSER_API_VERSION,
      publication,
    } satisfies BrowserPublicationGetResultV1);
  };
}

function readHandler(api: BrowserPublicationApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const publicationId = c.req.param('publicationId');
    if (
      !nonEmptyString(publicationId) ||
      publicationId.length > BROWSER_PUBLICATION_MAX_ID_LENGTH
    ) {
      return publicationError('PUBLICATION_INVALID', 'publicationId must be a bounded identifier.');
    }
    const rawOffset = c.req.query(BROWSER_PUBLICATION_CONTENT_OFFSET_QUERY);
    const rawLimit = c.req.query(BROWSER_PUBLICATION_CONTENT_LIMIT_QUERY);
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    const limit = rawLimit === undefined ? BROWSER_PUBLICATION_READ_LIMIT : Number(rawLimit);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > BROWSER_PUBLICATION_READ_LIMIT
    ) {
      return publicationError(
        'PUBLICATION_INVALID',
        `offset must be a non-negative integer and limit an integer between 1 and ${BROWSER_PUBLICATION_READ_LIMIT}.`,
      );
    }
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    try {
      const result = await serviceOrError.read(publicationId, offset, limit);
      return json({
        version: BROWSER_API_VERSION,
        projectId: access.projectId,
        ...result,
      } satisfies BrowserPublicationReadResultV1);
    } catch (error) {
      const rawCode =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'INTERNAL';
      const code: BrowserPublicationErrorCode =
        rawCode === 'PUBLICATION_FILE_MISSING' || rawCode === 'PUBLICATION_FILE_MISMATCH'
          ? 'PUBLICATION_NOT_FOUND'
          : rawCode === 'PUBLICATION_INVALID'
            ? 'PUBLICATION_INVALID'
            : rawCode === 'PUBLICATION_NOT_FOUND'
              ? 'PUBLICATION_NOT_FOUND'
              : 'INTERNAL';
      return publicationError(
        code,
        error instanceof Error ? error.message : 'The publication read failed.',
      );
    }
  };
}

function publishHandler(api: BrowserPublicationApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'maintainer');
    if (!access.ok) return access.response;
    const grant = await api.capability(access);
    if (grant instanceof Response) return grant;
    const serviceOrError = await api.service(access.projectId);
    if (serviceOrError instanceof Response) return serviceOrError;
    const body = await readJson(c);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return publicationError('PUBLICATION_INVALID', 'The publish request must be an object.');
    }
    const request = body as Record<string, unknown>;
    if (request.version !== BROWSER_API_VERSION) {
      return publicationError('PUBLICATION_INVALID', 'The publish request version is unsupported.');
    }
    if (request.projectId !== access.projectId) {
      return publicationError('INVALID_INPUT', 'The request project does not match its route.');
    }
    let branchPath: BranchPath | undefined;
    let discourseBranch: string | undefined;
    if ('branchPath' in request) {
      const parsed = parsePublishBranchPath(request.branchPath);
      if (!parsed.ok) return publicationError('PUBLICATION_INVALID', parsed.message);
      branchPath = parsed.branchPath;
      discourseBranch = parsed.discourseBranch;
    }
    if ('discourseBranch' in request) {
      const candidate = request.discourseBranch;
      if (typeof candidate !== 'string' || candidate.length === 0) {
        return publicationError('PUBLICATION_INVALID', 'discourseBranch must be non-empty.');
      }
      if (discourseBranch !== undefined) {
        return publicationError(
          'PUBLICATION_INVALID',
          'discourseBranch must not be duplicated between the branch selector and the request.',
        );
      }
      discourseBranch = candidate;
    }
    let title: string | undefined;
    if ('title' in request) {
      const candidate = request.title;
      if (
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        candidate.length > BROWSER_PUBLICATION_MAX_TITLE_LENGTH
      ) {
        return publicationError(
          'PUBLICATION_INVALID',
          `title must be a string of at most ${BROWSER_PUBLICATION_MAX_TITLE_LENGTH} characters.`,
        );
      }
      title = candidate;
    }
    const caller = {
      sessionId: null,
      userId: grant.userId,
      grant,
    } as McpAuthorizedCaller;
    try {
      const result = await serviceOrError.publish(
        {
          ...(branchPath === undefined ? {} : { branchPath }),
          ...(discourseBranch === undefined ? {} : { discourseBranch }),
          ...(title === undefined ? {} : { title }),
        },
        caller,
      );
      const operationId =
        result.enqueue.status === 'queued' || result.enqueue.status === 'replayed'
          ? result.enqueue.status === 'queued'
            ? result.enqueue.operationHandle
            : result.enqueue.record.operationId
          : null;
      const bodyResult: BrowserPublishResultV1 = {
        version: BROWSER_API_VERSION,
        projectId: access.projectId,
        publicationId: result.publicationId,
        kind: result.kind,
        outcome: operationId === null ? 'failed' : 'queued',
        operationId,
        staleReasons: [],
      };
      return json(bodyResult);
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'INTERNAL';
      return publicationError(
        code === 'NO_ACCEPTED_SOURCE' || code === 'IDEMPOTENCY_CONFLICT'
          ? 'PUBLICATION_CONFLICT'
          : code === 'OPERATION_QUEUE_FULL' || code === 'OPERATION_SERVICE_CLOSED'
            ? 'PUBLICATION_UNAVAILABLE'
            : 'INTERNAL',
        error instanceof Error ? error.message : 'The publish request failed.',
      );
    }
  };
}

export function createBrowserPublicationApi(
  options: BrowserPublicationApiOptions,
): BrowserPublicationApiSurface {
  const api = new BrowserPublicationApiImpl(options);
  const reads: readonly { readonly path: string; readonly handler: Handler<HostListenerEnv> }[] = [
    { path: BROWSER_PROJECT_PUBLICATIONS_PATH, handler: listHandler(api) },
    { path: BROWSER_PROJECT_PUBLICATION_PATH, handler: getHandler(api) },
    { path: BROWSER_PROJECT_PUBLICATION_CONTENT_PATH, handler: readHandler(api) },
  ];
  const mutations: readonly {
    readonly method: MutationHttpMethod;
    readonly path: string;
    readonly handler: Handler<HostListenerEnv>;
  }[] = [{ method: 'POST', path: BROWSER_PROJECT_PUBLICATIONS_PATH, handler: publishHandler(api) }];
  return {
    register(host: HostServer): void {
      for (const route of reads) host.registerReadRoute(route.path, route.handler);
      for (const route of mutations)
        host.registerMutationRoute(route.method, route.path, route.handler);
    },
  };
}
