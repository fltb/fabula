/**
 * Shared in-process ProjectSession.
 *
 * One session per project ID owns:
 *  - the accepted immutable source snapshot (content identity = `sourceHash`),
 *  - the last-valid browser-safe projection (never mutated by invalid input),
 *  - the injected Core runtime (constructed once, never per request),
 *  - a strictly serialized operation queue gated by opaque server-side
 *    capabilities, and
 *  - immutable presence/projection update methods.
 *
 * MCP, HTTP, Yjs and internal Agents later attach to this single session via
 * the registry; nothing is rebuilt per request. Only the browser-safe
 * projection DTOs (`ProjectSessionProjectionV1` and friends) cross the
 * contract boundary (contracts/index.ts). No filesystem, Git, provider, or
 * database handle is ever part of a projection, operation payload, or audit
 * record.
 *
 * Capability gating consumes the host Agent capability boundary
 * (`AgentCapabilityService.checkGrant`): every effect is validated against the
 * persisted grant (existence, version, revocation, expiry, project, scope)
 * immediately before it runs, and typed secret-free audit metadata is recorded
 * through the injected audit sink.
 */

import {
  getProjectStatus,
  type JsonValue,
  type ProjectSourceSnapshotV1,
  type ProjectStatusResult,
  sanitizeError,
} from '@novalistically/core';
import {
  type AgentAuditEffect,
  type AgentCapabilityFailureCode,
  type AgentCapabilityGrant,
  type AgentCapabilityService,
  buildAuditEffect,
} from './agent/index.js';
import type { ProjectCoreRuntime } from './core-runtime.js';
import type {
  PresenceUpdateV1,
  ProjectPresenceV1,
  ProjectSessionProjectionV1,
  ProjectSourceDiagnosticV1,
  SessionPresenceSurfaceV1,
} from '@novalistically/workbench-protocol';
export type {
  PresenceUpdateV1,
  ProjectPresenceV1,
  ProjectSessionProjectionV1,
  ProjectSourceDiagnosticV1,
  SessionPresenceSurfaceV1,
} from '@novalistically/workbench-protocol';

// ─── Projection derivation ──────────────────────────────────────────────────

export interface ProjectionDerivationInput {
  readonly projectId: string;
  readonly revision: number;
  readonly snapshot: ProjectSourceSnapshotV1 | null;
  readonly presence: readonly ProjectPresenceV1[];
  readonly generatedAt: string;
}

export type ProjectionDeriver = (input: ProjectionDerivationInput) => ProjectSessionProjectionV1;

/**
 * Pure projection derivation. `status` MUST be the Core status for `snapshot`
 * (or null together with a null snapshot); it is passed in so this function
 * stays deterministic and testable without Core fixtures.
 */
export function deriveProjectSessionProjection(
  input: ProjectionDerivationInput,
  status: ProjectStatusResult | null,
): ProjectSessionProjectionV1 {
  const { projectId, revision, snapshot, presence, generatedAt } = input;
  const base = {
    version: 1 as const,
    projectId,
    revision,
    presence: deepFreeze([...presence]),
    generatedAt,
  };
  if (snapshot === null) {
    return deepFreeze({
      ...base,
      sourceHash: null,
      documents: 0,
      events: 0,
      rendered: 0,
      pending: 0,
      blocked: 0,
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
    });
  }
  if (status === null) {
    throw new TypeError(
      'deriveProjectSessionProjection requires status when a snapshot is provided',
    );
  }
  const diagnostics = collectSourceDiagnostics(snapshot);
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const pending = Math.max(
    0,
    status.summary.totalEvents - status.summary.renderedCount - status.summary.blockedCount,
  );
  return deepFreeze({
    ...base,
    sourceHash: snapshot.sourceHash,
    documents: snapshot.documents.length,
    events: status.events.length,
    rendered: status.summary.renderedCount,
    pending,
    blocked: status.summary.blockedCount,
    errorCount,
    warningCount,
    diagnostics,
  });
}

/** Default deriver: Core status projection over the accepted snapshot. */
export const defaultProjectionDeriver: ProjectionDeriver = (input) =>
  deriveProjectSessionProjection(
    input,
    input.snapshot === null ? null : getProjectStatus(input.snapshot),
  );

// ─── Capability gate and audit ───────────────────────────────────────────────

/**
 * One typed, secret-free audit entry. Granted effects are built with
 * `buildAuditEffect` (no token, no digest); denied entries carry only the
 * opaque capability id and the typed denial reason.
 */
export type SessionAuditRecord =
  | (AgentAuditEffect & {
      readonly operationId: string;
      readonly outcome: 'completed' | 'failed';
    })
  | {
      readonly outcome: 'denied';
      readonly operationId: string;
      readonly projectId: string;
      readonly capabilityId: string;
      readonly reason: AgentCapabilityFailureCode;
      readonly at: string;
    };

export interface SessionAuditSink {
  /**
   * Records one typed audit entry. Best-effort observability: a throwing sink
   * never changes an operation result.
   */
  record(record: SessionAuditRecord): void | Promise<void>;
}

// ─── Operations ──────────────────────────────────────────────────────────────

export interface SessionOperationRunContext {
  readonly projectId: string;
  readonly operationId: string;
  /** Server-resolved actor from the validated grant; callers never supply it. */
  readonly actorId: string;
  readonly capabilityVersion: number;
  readonly scopes: readonly string[];
}

export interface SessionOperation<TPayload extends JsonValue = JsonValue, TResult = unknown> {
  /** Operation kind; included in audit metadata (`operation.<kind>.<outcome>`). */
  readonly kind: string;
  /** Opaque server-side grant id; the actor and permissions are never client-chosen. */
  readonly capabilityId: string;
  /** Capability scope required for this effect; validated against the grant before running. */
  readonly scope: readonly string[];
  /** When set, a persisted grant version different from this fails the gate. */
  readonly expectedVersion?: number;
  /** JSON-safe command payload; never a host handle and never audited. */
  readonly payload?: TPayload;
  /** The effect itself; executed strictly serially, after the capability gate. */
  run(context: SessionOperationRunContext): Promise<TResult> | TResult;
}

export type SessionOperationResult<T = unknown> =
  | {
      readonly status: 'denied';
      readonly operationId: string;
      readonly reason: AgentCapabilityFailureCode;
    }
  | { readonly status: 'completed'; readonly operationId: string; readonly result: T }
  | {
      readonly status: 'failed';
      readonly operationId: string;
      readonly errorCode: string;
      readonly message: string;
    };

// ─── Source refresh ──────────────────────────────────────────────────────────

export type SourceRefreshResult =
  | { readonly status: 'unchanged'; readonly projection: ProjectSessionProjectionV1 }
  | { readonly status: 'accepted'; readonly projection: ProjectSessionProjectionV1 }
  | {
      readonly status: 'rejected';
      readonly projection: ProjectSessionProjectionV1;
      readonly diagnostics: readonly ProjectSourceDiagnosticV1[];
    };

// ─── Session ─────────────────────────────────────────────────────────────────

export interface CreateProjectSessionOptions {
  readonly projectId: string;
  /** Injected Core runtime; constructed once, shared by every consumer. */
  readonly runtime: ProjectCoreRuntime;
  /**
   * Server-side capability gate. Only `checkGrant` is consumed: it re-loads
   * the persisted grant before every effect, so revocation, version bumps,
   * and expiry stop the next effect at the next safe checkpoint.
   */
  readonly capabilities: Pick<AgentCapabilityService, 'checkGrant'>;
  /** Typed, secret-free audit sink for every effect and denial. */
  readonly audit: SessionAuditSink;
  /** Optional already-accepted source; must be a valid compiled snapshot or creation fails closed. */
  readonly initialSource?: ProjectSourceSnapshotV1;
  /** Projection derivation; defaults to the Core status projection. */
  readonly derive?: ProjectionDeriver;
  /** Timestamp source; defaults to the injected runtime clock. */
  readonly now?: () => string;
}

export interface ProjectSession {
  readonly projectId: string;
  /** The injected Core runtime; shared by every consumer of this session. */
  readonly runtime: ProjectCoreRuntime;
  /** Immutable accepted source snapshot; null before the first accepted load. */
  readonly source: ProjectSourceSnapshotV1 | null;
  /** Last-valid accepted projection; invalid refreshes never mutate it. */
  readonly projection: ProjectSessionProjectionV1;
  /** True while operations are queued or in flight. */
  readonly busy: boolean;
  /** True while any human presence entry is attached (browser, mcp, or yjs surface). */
  readonly hasHumanPresence: boolean;
  /**
   * Monotonic generation of the human-presence state. Document mutations
   * capture it at observation time and atomically reject when it changes
   * before application, so a human that starts editing between an agent's
   * precheck and its document mutation blocks that mutation without applying.
   */
  readonly presenceGeneration: number;
  /**
   * Atomically refresh from a candidate snapshot. Only a valid compiled
   * snapshot (all documents parsed, no error-severity diagnostics, and a
   * successful compile) replaces the accepted source; anything else returns
   * its diagnostics and leaves the last-valid projection untouched. A
   * candidate with the current `sourceHash` is a memoized no-op.
   */
  refreshSource(candidate: ProjectSourceSnapshotV1): SourceRefreshResult;
  /**
   * Host-internal serial adoption hook (NOT a public write interface).
   *
   * The AuthoringCoordinator's capability-gated queued operations call this
   * to refresh the accepted projection after a Git receipt; it runs the
   * exact same valid-compiled gate as {@link refreshSource} and adopts
   * inside the serialized operation queue. External writers never see it:
   * the call FAILS CLOSED with a rejected result when it is not invoked from
   * inside an in-flight queued operation, so adoption can never race or
   * bypass the capability gate and serialization.
   */
  adoptSourceWithinOperation(candidate: ProjectSourceSnapshotV1): SourceRefreshResult;
  /** Update human/Agent presence; Host-internal transport surfaces call this. */
  updatePresence(update: PresenceUpdateV1): ProjectSessionProjectionV1;
  /**
   * Enqueue an operation. Operations run strictly serially in enqueue order;
   * the capability gate is checked inside the serialized slot, immediately
   * before the effect.
   */
  enqueueOperation<TPayload extends JsonValue = JsonValue, TResult = unknown>(
    operation: SessionOperation<TPayload, TResult>,
  ): Promise<SessionOperationResult<TResult>>;
}

/** Maximum characters retained from a failed-operation message. */
const MAX_OPERATION_MESSAGE_LENGTH = 512;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value) as T;
}

function collectSourceDiagnostics(
  snapshot: ProjectSourceSnapshotV1,
): readonly ProjectSourceDiagnosticV1[] {
  const diagnostics: ProjectSourceDiagnosticV1[] = [];
  for (const document of snapshot.documents) {
    for (const diagnostic of document.diagnostics) {
      diagnostics.push({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        logicalPath: diagnostic.logicalPath,
      });
    }
    if (document.parseResult.status !== 'parsed') {
      diagnostics.push({
        code: 'source.parse_failed',
        severity: 'error',
        message: `Document "${document.logicalPath}" did not parse`,
        logicalPath: document.logicalPath,
      });
    }
  }
  return deepFreeze(diagnostics);
}

/** A snapshot is compilable when every document parses and no error remains. */
function isCompilableSource(snapshot: ProjectSourceSnapshotV1): boolean {
  for (const document of snapshot.documents) {
    if (document.parseResult.status !== 'parsed') return false;
  }
  for (const document of snapshot.documents) {
    for (const diagnostic of document.diagnostics) {
      if (diagnostic.severity === 'error') return false;
    }
  }

  return true;
}

/** Presence surfaces that represent a live human, as opposed to internal Agents. */
const HUMAN_PRESENCE_SURFACES: readonly SessionPresenceSurfaceV1[] = ['browser', 'mcp', 'yjs'];

function presenceEntriesEqual(
  a: readonly ProjectPresenceV1[],
  b: readonly ProjectPresenceV1[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        b[index] !== undefined &&
        entry.actorId === b[index].actorId &&
        entry.surface === b[index].surface &&
        entry.since === b[index].since,
    )
  );
}

function applyPresenceUpdate(
  current: readonly ProjectPresenceV1[],
  update: PresenceUpdateV1,
): readonly ProjectPresenceV1[] {
  if (update.kind === 'leave') {
    const next = current.filter(
      (entry) => !(entry.actorId === update.actorId && entry.surface === update.surface),
    );
    return next.length === current.length ? current : deepFreeze(next);
  }
  const exists = current.some(
    (entry) => entry.actorId === update.actorId && entry.surface === update.surface,
  );
  if (exists) {
    return deepFreeze(
      current.map((entry) =>
        entry.actorId === update.actorId && entry.surface === update.surface
          ? { ...entry, since: update.at }
          : entry,
      ),
    );
  }
  return deepFreeze([
    ...current,
    { actorId: update.actorId, surface: update.surface, since: update.at },
  ]);
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'operation.failed';
}

function errorMessageOf(error: unknown): string {
  const message = sanitizeError(error);
  return message.length > MAX_OPERATION_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_OPERATION_MESSAGE_LENGTH)}…`
    : message;
}

class ProjectSessionImpl implements ProjectSession {
  readonly projectId: string;
  readonly runtime: ProjectCoreRuntime;
  readonly #capabilities: Pick<AgentCapabilityService, 'checkGrant'>;
  readonly #audit: SessionAuditSink;
  readonly #derive: ProjectionDeriver;
  readonly #now: () => string;
  #accepted: ProjectSourceSnapshotV1 | null;
  #presence: readonly ProjectPresenceV1[] = [];
  #revision: number;
  #projection: ProjectSessionProjectionV1;
  #tail: Promise<void> = Promise.resolve();
  #inFlight = 0;
  /** Advances whenever the human-presence entry set changes (see {@link updatePresence}). */
  #presenceGeneration = 0;
  /** True while a queued operation's effect runs (the serial adoption gate). */
  #inQueue = false;

  constructor(options: CreateProjectSessionOptions) {
    if (typeof options.projectId !== 'string' || options.projectId.length === 0) {
      throw new TypeError('ProjectSession requires a non-empty projectId');
    }
    if (
      options.runtime === null ||
      typeof options.runtime !== 'object' ||
      typeof options.runtime.compile !== 'function' ||
      options.runtime.services === null ||
      typeof options.runtime.services !== 'object'
    ) {
      throw new TypeError('ProjectSession requires an injected ProjectCoreRuntime');
    }
    if (options.runtime.projectId !== options.projectId) {
      throw new TypeError(
        `ProjectSession project "${options.projectId}" does not match the injected runtime project "${options.runtime.projectId}"`,
      );
    }
    if (
      options.capabilities === null ||
      typeof options.capabilities !== 'object' ||
      typeof options.capabilities.checkGrant !== 'function'
    ) {
      throw new TypeError('ProjectSession requires a capability gate (checkGrant)');
    }
    if (
      options.audit === null ||
      typeof options.audit !== 'object' ||
      typeof options.audit.record !== 'function'
    ) {
      throw new TypeError('ProjectSession requires an audit sink (record)');
    }

    this.projectId = options.projectId;
    this.runtime = options.runtime;
    this.#capabilities = options.capabilities;
    this.#audit = options.audit;
    this.#derive = options.derive ?? defaultProjectionDeriver;
    this.#now = options.now ?? (() => this.runtime.services.clock.now());
    this.#accepted = null;
    this.#revision = 0;
    this.#projection = this.#rebuildProjection();

    if (options.initialSource !== undefined) {
      if (!isCompilableSource(options.initialSource)) {
        throw new TypeError(
          'ProjectSession initialSource must be a valid compiled source snapshot',
        );
      }
      try {
        this.runtime.compile(options.initialSource);
      } catch (error) {
        throw new TypeError(
          `ProjectSession initialSource does not compile: ${sanitizeError(error)}`,
        );
      }
      this.#adopt(options.initialSource);
    }
  }

  /** Rebuild the projection from current state; the session always freezes it. */
  #rebuildProjection(): ProjectSessionProjectionV1 {
    this.#projection = deepFreeze(
      this.#derive({
        projectId: this.projectId,
        revision: this.#revision,
        snapshot: this.#accepted,
        presence: this.#presence,
        generatedAt: this.#now(),
      }),
    );
    return this.#projection;
  }

  get source(): ProjectSourceSnapshotV1 | null {
    return this.#accepted;
  }

  get projection(): ProjectSessionProjectionV1 {
    return this.#projection;
  }

  get busy(): boolean {
    return this.#inFlight > 0;
  }

  get hasHumanPresence(): boolean {
    return this.#presence.some((entry) => HUMAN_PRESENCE_SURFACES.includes(entry.surface));
  }

  get presenceGeneration(): number {
    return this.#presenceGeneration;
  }
  refreshSource(candidate: ProjectSourceSnapshotV1): SourceRefreshResult {
    return this.#evaluateCandidate(candidate);
  }

  adoptSourceWithinOperation(candidate: ProjectSourceSnapshotV1): SourceRefreshResult {
    if (!this.#inQueue) {
      return {
        status: 'rejected',
        projection: this.#projection,
        diagnostics: deepFreeze([
          {
            code: 'adoption.outside_queue',
            severity: 'error' as const,
            message: 'adoptSourceWithinOperation must run inside the session operation queue',
            logicalPath: null,
          },
        ]),
      };
    }
    return this.#evaluateCandidate(candidate);
  }

  /** Shared valid-compiled gate: unchanged → adopt → reject, exactly as documented. */
  #evaluateCandidate(candidate: ProjectSourceSnapshotV1): SourceRefreshResult {
    const current = this.#accepted;
    if (current !== null && candidate.sourceHash === current.sourceHash) {
      return { status: 'unchanged', projection: this.#projection };
    }
    const diagnostics = collectSourceDiagnostics(candidate);
    if (!isCompilableSource(candidate)) {
      return { status: 'rejected', projection: this.#projection, diagnostics };
    }
    try {
      this.runtime.compile(candidate);
    } catch (error) {
      return {
        status: 'rejected',
        projection: this.#projection,
        diagnostics: deepFreeze([
          ...diagnostics,
          {
            code: 'source.compile_failed',
            severity: 'error',
            message: sanitizeError(error),
            logicalPath: null,
          },
        ]),
      };
    }
    this.#adopt(candidate);
    return { status: 'accepted', projection: this.#projection };
  }

  updatePresence(update: PresenceUpdateV1): ProjectSessionProjectionV1 {
    const presence = applyPresenceUpdate(this.#presence, update);
    if (presence === this.#presence) {
      // Leaving an absent entry changes nothing: same projection, same revision.
      return this.#projection;
    }
    const humanBefore = this.#presence.filter((entry) =>
      HUMAN_PRESENCE_SURFACES.includes(entry.surface),
    );
    const humanAfter = presence.filter((entry) => HUMAN_PRESENCE_SURFACES.includes(entry.surface));
    if (!presenceEntriesEqual(humanBefore, humanAfter)) {
      // A human-presence transition invalidates in-flight agent observations:
      // document mutations re-check this generation atomically before applying.
      this.#presenceGeneration += 1;
    }
    this.#presence = presence;
    this.#revision += 1;
    return this.#rebuildProjection();
  }

  enqueueOperation<TPayload extends JsonValue, TResult>(
    operation: SessionOperation<TPayload, TResult>,
  ): Promise<SessionOperationResult<TResult>> {
    const operationId = this.runtime.services.ids.next({ kind: 'operation' });
    this.#inFlight += 1;
    const slot = this.#tail.then(() => this.#execute(operation, operationId));
    this.#tail = slot.then(
      () => undefined,
      () => undefined,
    );
    return slot.finally(() => {
      this.#inFlight -= 1;
    });
  }

  #adopt(candidate: ProjectSourceSnapshotV1): void {
    this.#accepted = deepFreeze(candidate);
    this.#revision += 1;
    this.#rebuildProjection();
  }

  async #execute<TPayload extends JsonValue, TResult>(
    operation: SessionOperation<TPayload, TResult>,
    operationId: string,
  ): Promise<SessionOperationResult<TResult>> {
    const at = (): string => this.#now();
    const check = await this.#capabilities.checkGrant({
      capabilityId: operation.capabilityId,
      projectId: this.projectId,
      scopes: operation.scope,
      expectedVersion: operation.expectedVersion,
    });
    if (!check.allowed) {
      await this.#recordAudit({
        outcome: 'denied',
        operationId,
        projectId: this.projectId,
        capabilityId: operation.capabilityId,
        reason: check.reason,
        at: at(),
      });
      return { status: 'denied', operationId, reason: check.reason };
    }
    const context: SessionOperationRunContext = {
      projectId: this.projectId,
      operationId,
      actorId: check.grant.userId,
      capabilityVersion: check.grant.version,
      scopes: check.grant.scopes,
    };
    try {
      this.#inQueue = true;
      let result: TResult;
      try {
        result = await operation.run(context);
      } finally {
        this.#inQueue = false;
      }
      await this.#recordAudit(
        this.#effectAudit(operation, check.grant, operationId, 'completed', at()),
      );
      return { status: 'completed', operationId, result };
    } catch (error) {
      this.#inQueue = false;
      const errorCode = errorCodeOf(error);
      await this.#recordAudit(
        this.#effectAudit(operation, check.grant, operationId, 'failed', at(), errorCode),
      );
      return { status: 'failed', operationId, errorCode, message: errorMessageOf(error) };
    }
  }

  #effectAudit(
    operation: { readonly kind: string },
    grant: AgentCapabilityGrant,
    operationId: string,
    outcome: 'completed' | 'failed',
    at: string,
    detail?: string,
  ): SessionAuditRecord {
    return {
      ...buildAuditEffect({ grant, kind: `operation.${operation.kind}.${outcome}`, detail, at }),
      operationId,
      outcome,
    };
  }

  async #recordAudit(record: SessionAuditRecord): Promise<void> {
    try {
      await this.#audit.record(record);
    } catch {
      // Audit is best-effort observability; it must never change an operation result.
    }
  }
}

/**
 * Create one project session. Fails closed on malformed options or an invalid
 * `initialSource`; a session must never be constructed with an accepted state
 * that did not pass the valid-compiled gate.
 */
export function createProjectSession(options: CreateProjectSessionOptions): ProjectSession {
  return new ProjectSessionImpl(options);
}

// ─── Registry ────────────────────────────────────────────────────────────────

export class ProjectSessionExistsError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`A project session already exists for project "${projectId}"`);
    this.name = 'ProjectSessionExistsError';
    this.projectId = projectId;
  }
}

export interface ProjectSessionRegistry {
  readonly size: number;
  /** Singleton lookup: the one session for a project id, or null. */
  get(projectId: string): ProjectSession | null;
  /** Create a session; throws {@link ProjectSessionExistsError} when one already exists. */
  create(options: CreateProjectSessionOptions): ProjectSession;
  /** Get the existing session for a project id, or create it (singleton open). */
  open(options: CreateProjectSessionOptions): ProjectSession;
  /** Register a preconstructed session; rejects a duplicate project id. */
  register(session: ProjectSession): ProjectSession;
  remove(projectId: string): boolean;
  list(): readonly ProjectSession[];
}

/** Create a fresh session registry enforcing one session per project ID. */
export function createProjectSessionRegistry(): ProjectSessionRegistry {
  const sessions = new Map<string, ProjectSession>();
  const create = (options: CreateProjectSessionOptions): ProjectSession => {
    if (sessions.has(options.projectId)) {
      throw new ProjectSessionExistsError(options.projectId);
    }
    const session = createProjectSession(options);
    sessions.set(options.projectId, session);
    return session;
  };
  return {
    get size() {
      return sessions.size;
    },
    get(projectId) {
      return sessions.get(projectId) ?? null;
    },
    create,
    register(session) {
      if (sessions.has(session.projectId)) {
        throw new ProjectSessionExistsError(session.projectId);
      }
      sessions.set(session.projectId, session);
      return session;
    },
    open(options) {
      return sessions.get(options.projectId) ?? create(options);
    },
    remove(projectId) {
      return sessions.delete(projectId);
    },
    list() {
      return [...sessions.values()];
    },
  };
}

let defaultRegistry: ProjectSessionRegistry | null = null;

/**
 * Shared process-wide registry that HTTP, MCP, Yjs and internal Agents attach
 * to later; one session per open project, never rebuilt per request.
 */
export function defaultProjectSessionRegistry(): ProjectSessionRegistry {
  defaultRegistry ??= createProjectSessionRegistry();
  return defaultRegistry;
}
