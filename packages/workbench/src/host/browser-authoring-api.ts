/**
 * Guarded browser authoring surface.
 *
 * This module is deliberately standalone: Phase 3 Host composition injects the
 * per-project coordinator, principal resolver, project catalogue and a
 * server-owned capability resolver, then calls `register(host)`. Request
 * bodies contain only the versioned browser authoring CAS fields. Actor,
 * capability, filesystem root and Git head are always resolved inside the Host.
 *
 * The activity stream carries only versioned, secret-free state/operation,
 * candidate and presence projections. It never serializes source bytes or Yjs
 * updates.
 */
import { randomUUID } from 'node:crypto';
import type { Context, Handler } from 'hono';
import {
  AUTHORING_CONTRACT_VERSION,
  type AuthoringActivityEventV1,
  type AuthoringFailureCodeV1,
  type AuthoringOperationReceiptV1,
  type AuthoringReconcileChoiceV1,
  type AuthoringStateV1,
  type AuthoringSubmitReceiptV1,
  BROWSER_AUTHORING_EVENTS_PATH,
  BROWSER_AUTHORING_OPERATION_PATH,
  BROWSER_AUTHORING_OPERATIONS_PATH,
  BROWSER_AUTHORING_RECONCILE_PATH,
  BROWSER_AUTHORING_REVISION_DIFF_PATH,
  BROWSER_AUTHORING_REVISION_PATH,
  BROWSER_AUTHORING_REVISION_RESTORE_PATH,
  BROWSER_AUTHORING_REVISIONS_PATH,
  BROWSER_AUTHORING_STATE_PATH,
  BROWSER_AUTHORING_SUBMIT_PATH,
  type BrowserAuthoringReconcileRequestV1,
  type BrowserAuthoringReconcileResultV1,
  type BrowserAuthoringRevisionDiffV1,
  type BrowserAuthoringRevisionListV1,
  type BrowserAuthoringRevisionRestoreResultV1,
  type BrowserAuthoringRevisionV1,
  type BrowserAuthoringSubmitRequestV1,
  type BrowserAuthoringSubmitResultV1,
} from '../contracts/authoring.js';
import type { BrowserSessionPrincipalV1 } from '../contracts/browser-api.js';
import { BROWSER_API_BASE_PATH, BROWSER_SESSION_HEADER } from '../contracts/browser-api.js';
import type {
  AuthoringCoordinator,
  AuthoringRevisionPort,
  AuthoringRevisionSummary,
} from './authoring/types.js';
import type {
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from './browser-read-api.js';
import type { HostListenerEnv, MutationHttpMethod } from './listener.js';
import type { ProjectAccessRequiredRole, ProjectAccessService } from './project-access-service.js';
import type { HostServer } from './server.js';
import { getYjsTicketService, type YjsTicketService } from './yjs/index.js';
/** `GET /api/v1/projects/:projectId/source/:documentId/yjs-ticket`. */
export const BROWSER_YJS_TICKET_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/source/:documentId/yjs-ticket`;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const EVENT_HEADERS = {
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'content-type': 'text/event-stream; charset=utf-8',
};

/** Safe list response for the operation centre. */
export interface BrowserAuthoringOperationsV1 {
  readonly version: typeof AUTHORING_CONTRACT_VERSION;
  readonly projectId: string;
  readonly operations: readonly AuthoringOperationReceiptV1[];
  readonly generatedAt: string;
}

/** Project-scoped native revision service resolved by the Host. */
export interface BrowserAuthoringRevisionRegistry {
  get(projectId: string): AuthoringRevisionPort | null | Promise<AuthoringRevisionPort | null>;
}

/** Safe operation stream source. Implementations own subscription lifecycle. */
export interface BrowserAuthoringEventSource {
  subscribe(projectId: string, listener: (event: AuthoringActivityEventV1) => void): () => void;
}
export type BrowserAuthoringCapabilityKind = 'submit' | 'reconcile' | 'restore';

/**
 * Resolves a server-owned capability for one browser effect. The browser never
 * supplies an id, token, actor or scope; the resolver may return an opaque
 * persisted grant id plus its server-defined scopes for the coordinator.
 */
export interface BrowserAuthoringCapabilityResolver {
  resolve(input: {
    readonly principal: BrowserSessionPrincipalV1;
    readonly projectId: string;
    readonly kind: BrowserAuthoringCapabilityKind;
  }): Promise<{ readonly capabilityId: string; readonly scopes: readonly string[] } | null>;
}

export interface BrowserAuthoringCoordinatorRegistry {
  get(projectId: string): AuthoringCoordinator | null | Promise<AuthoringCoordinator | null>;
}
export interface BrowserAuthoringApiOptions {
  readonly principal: BrowserPrincipalResolver;
  /** Shared ACL/lifecycle service; when present it is the authoritative role gate. */
  readonly access?: Pick<ProjectAccessService, 'authorize'>;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  readonly coordinators: BrowserAuthoringCoordinatorRegistry;
  /** Native immutable revision service, resolved only after project access. */
  readonly revision?: BrowserAuthoringRevisionRegistry | null;
  readonly capabilities?: BrowserAuthoringCapabilityResolver | null;
  readonly events?: BrowserAuthoringEventSource | null;
  /** One-time ticket store shared with the Yjs gateway. */
  readonly yjsTickets?: YjsTicketService | null;
  readonly now?: () => string;
}

export interface BrowserAuthoringApiSurface {
  register(host: HostServer): void;
}

export type BrowserAuthoringErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NOT_READY'
  | 'UNKNOWN_FIELD'
  | 'INVALID_INPUT'
  | 'OPERATION_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'AUTHORING_UNAVAILABLE'
  | 'INTERNAL'
  | AuthoringFailureCodeV1;

const ERROR_STATUS: Readonly<Record<BrowserAuthoringErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PROJECT_NOT_FOUND: 404,
  PROJECT_NOT_READY: 409,
  UNKNOWN_FIELD: 400,
  INVALID_INPUT: 400,
  OPERATION_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  AUTHORING_UNAVAILABLE: 503,
  INTERNAL: 500,
  WORKSPACE_STALE: 409,
  ACCEPTED_HASH_MISMATCH: 409,
  DOCUMENT_NOT_FOUND: 404,
  CANDIDATE_INVALID: 409,
  CONFLICT_REQUIRES_RESOLUTION: 409,
  SUBMIT_BLOCKED: 409,
  HUMAN_EDITING: 409,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function authoringError(
  code: BrowserAuthoringErrorCode,
  message: string,
  status = ERROR_STATUS[code],
): Response {
  return json({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStrictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly code: 'UNKNOWN_FIELD' | 'INVALID_INPUT';
      readonly message: string;
    } {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'The authoring request must be an object.',
    };
  }
  if (value.version !== AUTHORING_CONTRACT_VERSION) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'The authoring request version is unsupported.',
    };
  }
  const allowed = [...required, ...optional];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    return { ok: false, code: 'UNKNOWN_FIELD', message: `Unknown authoring field: ${unknown}.` };
  }
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) {
    return { ok: false, code: 'INVALID_INPUT', message: `Missing authoring field: ${missing}.` };
  }
  return { ok: true, value };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalHash(value: unknown): value is string | null {
  return value === null || nonEmptyString(value);
}

function mapReceiptFailure(receipt: AuthoringOperationReceiptV1): {
  readonly code: AuthoringFailureCodeV1;
  readonly message: string;
} {
  const code = receipt.errorCode;
  const known: readonly AuthoringFailureCodeV1[] = [
    'PROJECT_NOT_FOUND',
    'PROJECT_NOT_READY',
    'WORKSPACE_STALE',
    'ACCEPTED_HASH_MISMATCH',
    'DOCUMENT_NOT_FOUND',
    'CANDIDATE_INVALID',
    'CONFLICT_REQUIRES_RESOLUTION',
    'SUBMIT_BLOCKED',
    'HUMAN_EDITING',
    'INVALID_INPUT',
    'UNKNOWN_FIELD',
    'INTERNAL',
  ];
  const mapped =
    typeof code === 'string' && known.includes(code as AuthoringFailureCodeV1)
      ? (code as AuthoringFailureCodeV1)
      : 'INTERNAL';
  return { code: mapped, message: `The ${receipt.kind} operation was ${receipt.status}.` };
}

function isSuccessfulReceipt(receipt: AuthoringOperationReceiptV1): boolean {
  return (
    receipt.status === 'queued' || receipt.status === 'running' || receipt.status === 'completed'
  );
}

async function readJson(c: Context<HostListenerEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

type AccessResult =
  | {
      readonly ok: true;
      readonly principal: BrowserSessionPrincipalV1;
      readonly projectId: string;
      readonly coordinator: AuthoringCoordinator;
    }
  | { readonly ok: false; readonly response: Response };

class BrowserAuthoringApiImpl {
  constructor(readonly options: BrowserAuthoringApiOptions) {}

  async access(
    c: Context<HostListenerEnv>,
    requiredRole: ProjectAccessRequiredRole = 'reader',
  ): Promise<AccessResult> {
    const resolution = await this.options.principal.resolve(c.req.raw);
    if (!resolution.ok) {
      return {
        ok: false,
        response: authoringError(
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
        response: authoringError('PROJECT_NOT_FOUND', 'A project id is required.'),
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
        response: authoringError('FORBIDDEN', 'The session is not authorized for this project.'),
      };
    }
    const projects = await this.options.catalog.listProjects(resolution.principal);
    if (!projects.some((project) => project.projectId === projectId)) {
      return {
        ok: false,
        response: authoringError(
          'PROJECT_NOT_FOUND',
          'The project is not in this session catalogue.',
        ),
      };
    }
    const coordinator = await this.options.coordinators.get(projectId);
    if (coordinator === null || coordinator.projectId !== projectId) {
      return {
        ok: false,
        response: authoringError('PROJECT_NOT_READY', 'Authoring is not ready for this project.'),
      };
    }
    return { ok: true, principal: resolution.principal, projectId, coordinator };
  }

  async capability(
    access: Extract<AccessResult, { readonly ok: true }>,
    kind: BrowserAuthoringCapabilityKind,
  ): Promise<{ readonly capabilityId: string; readonly scopes: readonly string[] } | Response> {
    const resolver = this.options.capabilities;
    if (resolver === undefined || resolver === null) {
      return authoringError(
        'AUTHORING_UNAVAILABLE',
        'Browser authoring capability is unavailable.',
      );
    }
    const grant = await resolver.resolve({
      principal: access.principal,
      projectId: access.projectId,
      kind,
    });
    if (
      grant === null ||
      !nonEmptyString(grant.capabilityId) ||
      grant.scopes.length === 0 ||
      grant.scopes.some((scope) => !nonEmptyString(scope))
    ) {
      return authoringError(
        'SUBMIT_BLOCKED',
        'The session has no authoring capability for this operation.',
      );
    }
    return grant;
  }
}

function yjsTicketHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'author');
    if (!access.ok) return access.response;
    const documentId = c.req.param('documentId');
    if (!nonEmptyString(documentId)) {
      return authoringError('INVALID_INPUT', 'A document id is required.');
    }
    const sessionId = c.req.raw.headers.get(BROWSER_SESSION_HEADER);
    if (!nonEmptyString(sessionId)) {
      return authoringError('UNAUTHORIZED', 'The session is missing or unknown.');
    }
    const tickets = api.options.yjsTickets ?? getYjsTicketService();
    const ticket = tickets.mint({
      sessionId,
      userId: access.principal.userId,
      capabilityVersion: access.principal.capabilityVersion,
      projectId: access.projectId,
      documentId,
    });
    return json({ ticket, expiresInMs: 30_000 });
  };
}

function stateHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    return json(access.coordinator.getState());
  };
}

function operationsHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    return json({
      version: AUTHORING_CONTRACT_VERSION,
      projectId: access.projectId,
      operations: access.coordinator.listOperations(),
      generatedAt: api.options.now?.() ?? new Date().toISOString(),
    } satisfies BrowserAuthoringOperationsV1);
  };
}

function operationHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const operationId = c.req.param('operationId');
    if (!nonEmptyString(operationId)) {
      return authoringError('OPERATION_NOT_FOUND', 'An operation id is required.');
    }
    const receipt = access.coordinator.getOperation(operationId);
    return receipt === null
      ? authoringError('OPERATION_NOT_FOUND', 'The operation does not exist.')
      : json(receipt);
  };
}

function revisionService(
  api: BrowserAuthoringApiImpl,
  access: Extract<AccessResult, { readonly ok: true }>,
): AuthoringRevisionPort | Response {
  const registry = api.options.revision;
  if (registry === undefined || registry === null) {
    return authoringError('AUTHORING_UNAVAILABLE', 'Native revision history is unavailable.');
  }
  const revision = registry.get(access.projectId);
  if (revision instanceof Promise) {
    throw new Error(
      'Asynchronous revision registries must be resolved by the Host before registration.',
    );
  }
  return revision === null
    ? authoringError('PROJECT_NOT_READY', 'Native revision history is not ready for this project.')
    : revision;
}

function revisionMetadata(revision: AuthoringRevisionSummary): BrowserAuthoringRevisionV1 {
  return {
    version: AUTHORING_CONTRACT_VERSION,
    revisionId: revision.revisionId,
    sourceHash: revision.sourceHash,
    createdAt: revision.createdAt,
    acceptedAt: revision.acceptedAt,
  };
}
function revisionListHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const service = revisionService(api, access);
    if (service instanceof Response) return service;
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && !nonEmptyString(cursor)) {
      return authoringError('INVALID_INPUT', 'cursor must be a non-empty opaque value.');
    }
    try {
      const result = await service.list(access.projectId, cursor);
      return json({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: access.projectId,
        revisions: result.revisions.map(revisionMetadata),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        generatedAt: api.options.now?.() ?? new Date().toISOString(),
      } satisfies BrowserAuthoringRevisionListV1);
    } catch {
      return authoringError('INTERNAL', 'The Host could not read native revision history.');
    }
  };
}

function revisionGetHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const service = revisionService(api, access);
    if (service instanceof Response) return service;
    const revisionId = c.req.param('revisionId');
    if (!nonEmptyString(revisionId)) {
      return authoringError('REVISION_NOT_FOUND', 'A revision id is required.');
    }
    try {
      const revision = await service.get(access.projectId, revisionId);
      return revision === null
        ? authoringError('REVISION_NOT_FOUND', 'The requested native revision does not exist.')
        : json({
            version: AUTHORING_CONTRACT_VERSION,
            projectId: access.projectId,
            revision: revisionMetadata(revision),
            generatedAt: api.options.now?.() ?? new Date().toISOString(),
          });
    } catch {
      return authoringError('INTERNAL', 'The Host could not read the native revision.');
    }
  };
}

function revisionDiffHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const service = revisionService(api, access);
    if (service instanceof Response) return service;
    const fromRevisionId = c.req.query('fromRevisionId');
    const toRevisionId = c.req.query('toRevisionId');
    if (!nonEmptyString(fromRevisionId) || !nonEmptyString(toRevisionId)) {
      return authoringError('INVALID_INPUT', 'fromRevisionId and toRevisionId are required.');
    }
    try {
      // Verify both ids through the project-scoped service before computing a
      // diff, so a cross-project id can never influence the response.
      const [from, to] = await Promise.all([
        service.get(access.projectId, fromRevisionId),
        service.get(access.projectId, toRevisionId),
      ]);
      if (from === null || to === null) {
        return authoringError(
          'REVISION_NOT_FOUND',
          'The requested native revision does not exist.',
        );
      }
      const result = await service.diff(access.projectId, fromRevisionId, toRevisionId);
      return json({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: access.projectId,
        fromRevisionId,
        toRevisionId,
        changes: result.changes,
        generatedAt: api.options.now?.() ?? new Date().toISOString(),
      } satisfies BrowserAuthoringRevisionDiffV1);
    } catch {
      return authoringError('INTERNAL', 'The Host could not compute the native revision diff.');
    }
  };
}

function revisionRestoreHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'maintainer');
    if (!access.ok) return access.response;
    const parsed = parseStrictObject(
      await readJson(c),
      ['version', 'projectId', 'revisionId'],
      ['expectedAcceptedRevisionId', 'expectedSourceHash'],
    );
    if (!parsed.ok) return authoringError(parsed.code, parsed.message);
    const body = parsed.value;
    if (body.projectId !== access.projectId) {
      return authoringError('INVALID_INPUT', 'The request project does not match its route.');
    }
    if (!nonEmptyString(body.revisionId)) {
      return authoringError('REVISION_NOT_FOUND', 'A revision id is required.');
    }
    const expectedAcceptedRevisionId =
      body.expectedAcceptedRevisionId === undefined ? null : body.expectedAcceptedRevisionId;
    const expectedSourceHash =
      body.expectedSourceHash === undefined ? null : body.expectedSourceHash;
    if (!optionalHash(expectedAcceptedRevisionId) || !optionalHash(expectedSourceHash)) {
      return authoringError('INVALID_INPUT', 'Restore CAS fields must be strings or null.');
    }
    const service = revisionService(api, access);
    if (service instanceof Response) return service;
    const grant = await api.capability(access, 'restore');
    if (grant instanceof Response) return grant;
    try {
      const outcome = await service.restore({
        projectId: access.projectId,
        revisionId: body.revisionId,
        expectedAcceptedRevisionId,
        expectedSourceHash,
        operationId: `browser-revision-restore-${randomUUID()}`,
        actorId: access.principal.userId,
      });
      if (outcome.status === 'accepted') {
        return json({
          version: AUTHORING_CONTRACT_VERSION,
          status: outcome.status,
          revisionId: outcome.revisionId,
          receiptHash: outcome.receiptHash,
        } satisfies BrowserAuthoringRevisionRestoreResultV1);
      }
      if (outcome.status === 'stale') {
        return authoringError('WORKSPACE_STALE', outcome.reason);
      }
      if (outcome.status === 'conflict') {
        return authoringError('CONFLICT_REQUIRES_RESOLUTION', outcome.reason);
      }
      return outcome.code === 'REVISION_NOT_FOUND'
        ? authoringError('REVISION_NOT_FOUND', outcome.reason)
        : authoringError('INTERNAL', outcome.reason);
    } catch {
      return authoringError('INTERNAL', 'The Host could not restore the native revision.');
    }
  };
}

function submitHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'maintainer');
    if (!access.ok) return access.response;
    const parsed = parseStrictObject(
      await readJson(c),
      ['version', 'projectId', 'expectedAcceptedSourceHash', 'expectedWorkspaceDigest'],
      ['message'],
    );
    if (!parsed.ok) return authoringError(parsed.code, parsed.message);
    const body = parsed.value;
    if (body.projectId !== access.projectId) {
      return authoringError('INVALID_INPUT', 'The request project does not match its route.');
    }
    if (!optionalHash(body.expectedAcceptedSourceHash)) {
      return authoringError('INVALID_INPUT', 'expectedAcceptedSourceHash must be a hash or null.');
    }
    if (!nonEmptyString(body.expectedWorkspaceDigest)) {
      return authoringError('INVALID_INPUT', 'expectedWorkspaceDigest must be non-empty.');
    }
    if (
      body.message !== undefined &&
      (typeof body.message !== 'string' || body.message.length > 240)
    ) {
      return authoringError('INVALID_INPUT', 'message must be at most 240 characters.');
    }
    const grant = await api.capability(access, 'submit');
    if (grant instanceof Response) return grant;
    try {
      const receipt = await access.coordinator.submit({
        expectedAcceptedSourceHash: body.expectedAcceptedSourceHash,
        expectedWorkspaceDigest: body.expectedWorkspaceDigest,
        ...(body.message === undefined ? {} : { message: body.message as string }),
        actorId: access.principal.userId,
        capabilityId: grant.capabilityId,
        capabilityScopes: grant.scopes,
      });
      if (!isSuccessfulReceipt(receipt)) {
        const failure = mapReceiptFailure(receipt);
        return json({ status: 'rejected', failure } satisfies BrowserAuthoringSubmitResultV1, 409);
      }
      // The coordinator is the sole source of Git/accepted identity. The
      // browser receives the safe operation receipt and follows its updates;
      // this adapter never invents a commit object or exposes a Git head.
      return json({ status: 'queued', receipt } satisfies BrowserAuthoringSubmitResultV1, 202);
    } catch {
      return authoringError('INTERNAL', 'The Host could not enqueue the submit operation.');
    }
  };
}

function reconcileHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'maintainer');
    if (!access.ok) return access.response;
    const parsed = parseStrictObject(await readJson(c), [
      'version',
      'projectId',
      'choice',
      'candidateHash',
      'expectedAcceptedSourceHash',
    ]);
    if (!parsed.ok) return authoringError(parsed.code, parsed.message);
    const body = parsed.value;
    if (body.projectId !== access.projectId) {
      return authoringError('INVALID_INPUT', 'The request project does not match its route.');
    }
    if (
      body.choice !== 'keep-working' &&
      body.choice !== 'accept-external' &&
      body.choice !== 'apply-proposed-disjoint-merge'
    ) {
      return authoringError('INVALID_INPUT', 'choice is not a supported reconcile action.');
    }
    if (!optionalHash(body.candidateHash) || !optionalHash(body.expectedAcceptedSourceHash)) {
      return authoringError(
        'INVALID_INPUT',
        'candidateHash and expectedAcceptedSourceHash must be hashes or null.',
      );
    }
    if (body.choice !== 'keep-working' && body.candidateHash === null) {
      return authoringError('INVALID_INPUT', 'This reconcile action requires candidateHash.');
    }
    const grant = await api.capability(access, 'reconcile');
    if (grant instanceof Response) return grant;
    try {
      const receipt = await access.coordinator.reconcileExternal({
        choice: body.choice as AuthoringReconcileChoiceV1,
        candidateHash: body.candidateHash,
        expectedAcceptedSourceHash: body.expectedAcceptedSourceHash,
        actorId: access.principal.userId,
        capabilityId: grant.capabilityId,
        capabilityScopes: grant.scopes,
      });
      if (!isSuccessfulReceipt(receipt)) {
        const failure = mapReceiptFailure(receipt);
        return json(
          { status: 'rejected', failure } satisfies BrowserAuthoringReconcileResultV1,
          409,
        );
      }
      return json({ status: 'queued', receipt } satisfies BrowserAuthoringReconcileResultV1, 202);
    } catch {
      return authoringError('INTERNAL', 'The Host could not enqueue the reconcile operation.');
    }
  };
}

function eventFrame(event: AuthoringActivityEventV1): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function eventsHandler(api: BrowserAuthoringApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const access = await api.access(c, 'reader');
    if (!access.ok) return access.response;
    const source = api.options.events;
    if (source === undefined || source === null) {
      return authoringError('AUTHORING_UNAVAILABLE', 'The authoring event stream is unavailable.');
    }
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
          controller.close();
        };
        unsubscribe = source.subscribe(access.projectId, (event) => {
          if (closed) return;
          try {
            controller.enqueue(eventFrame(event));
          } catch {
            close();
          }
        });
        const initial: AuthoringActivityEventV1 = {
          type: 'state-changed',
          version: AUTHORING_CONTRACT_VERSION,
          projectId: access.projectId,
          state: access.coordinator.getState(),
          at: api.options.now?.() ?? new Date().toISOString(),
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(initial)}\n\n`));
      },
      cancel() {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
      },
    });
    return new Response(stream, { headers: EVENT_HEADERS });
  };
}

export function createBrowserAuthoringApi(
  options: BrowserAuthoringApiOptions,
): BrowserAuthoringApiSurface {
  const api = new BrowserAuthoringApiImpl(options);
  const reads: readonly { readonly path: string; readonly handler: Handler<HostListenerEnv> }[] = [
    { path: BROWSER_YJS_TICKET_PATH, handler: yjsTicketHandler(api) },
    { path: BROWSER_AUTHORING_STATE_PATH, handler: stateHandler(api) },
    { path: BROWSER_AUTHORING_OPERATIONS_PATH, handler: operationsHandler(api) },
    { path: BROWSER_AUTHORING_OPERATION_PATH, handler: operationHandler(api) },
    { path: BROWSER_AUTHORING_REVISIONS_PATH, handler: revisionListHandler(api) },
    { path: BROWSER_AUTHORING_REVISION_DIFF_PATH, handler: revisionDiffHandler(api) },
    { path: BROWSER_AUTHORING_REVISION_PATH, handler: revisionGetHandler(api) },
    { path: BROWSER_AUTHORING_EVENTS_PATH, handler: eventsHandler(api) },
  ];
  const mutations: readonly {
    readonly method: MutationHttpMethod;
    readonly path: string;
    readonly handler: Handler<HostListenerEnv>;
  }[] = [
    { method: 'POST', path: BROWSER_AUTHORING_SUBMIT_PATH, handler: submitHandler(api) },
    { method: 'POST', path: BROWSER_AUTHORING_RECONCILE_PATH, handler: reconcileHandler(api) },
    {
      method: 'POST',
      path: BROWSER_AUTHORING_REVISION_RESTORE_PATH,
      handler: revisionRestoreHandler(api),
    },
  ];
  return {
    register(host: HostServer): void {
      for (const route of reads) host.registerReadRoute(route.path, route.handler);
      for (const route of mutations)
        host.registerMutationRoute(route.method, route.path, route.handler);
    },
  };
}

export type {
  AuthoringActivityEventV1,
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
  AuthoringSubmitReceiptV1,
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringReconcileResultV1,
  BrowserAuthoringSubmitRequestV1,
  BrowserAuthoringSubmitResultV1,
};
