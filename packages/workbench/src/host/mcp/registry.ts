/**
 * Host-only MCP tool registry bound to one open ProjectSession.
 *
 * Every tool derives its inputs exclusively from the session's accepted
 * `session.source` (never client-supplied paths) and, for effects, from the
 * session's serialized operation queue. Read tools (`mcp:read`) are pure
 * reads of the accepted source/projection; render (`mcp:render`) enqueues a
 * durable operation through the injected ProjectOperationService, whose
 * runner uses the session's two-phase detached lane (prepare/commit inside
 * the serialized lane, execute outside it) with a server-derived operation
 * id and actor id, so no request field can impersonate an actor or reuse an
 * operation id.
 *
 * Tool input schemas are plain JSON Schema objects — this module has no zod
 * dependency; the transport converts them at registration if needed.
 * Business errors are always returned as typed {@link McpToolResult} failures
 * (nonsecret), never thrown.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type BranchPath,
  buildWorkflowStatus,
  type JsonValue,
  listEntities,
  type NovelValidationResult,
  type PluginExtensionSchemaRegistrar,
  type ProjectReferencePacketV1,
  type ProjectSourceSnapshotV1,
  type ReviewGateV1,
  sanitizeError,
  showEntity,
  type ValidationIssue,
  validateNovel,
  type WorkflowExecutionProjectionV1,
  type WorkflowPublicationProjectionV1,
  type WorkflowReviewProjectionV1,
  type WorkflowStatusV1,
  type WorkflowWorkingProjectionV1,
} from '@novalistically/core';
import {
  commitEditorialCandidates,
  type EditorialCandidateSetV1,
  type EditorialCandidatesOutcome,
  type EditorialCommitResultV1,
  type EditorialRenderRequestV1,
  type EditorialRuntime,
  executeEditorialCandidates,
  getSourceDocument,
  listSourceDocuments,
  previewSourceChange,
  type ReleaseGateResolutionV1,
  type RenderGameDialogueTreeRequestV1,
  type RenderGameDialogueTreeResult,
  type RenderNovelResult,
  renderGameDialogueTree,
  type SceneSelector,
  type SourceChangeV1,
} from '@novalistically/core/editorial';
import type { SourceAnalysisOptions, SourceDiagnosticV1 } from '@novalistically/core/source';
import { diffEvent } from '@novalistically/core/tooling';
import type { NodePluginActivationResult } from '@novalistically/node-host';
import {
  AUTHORING_DOCUMENT_LIMITS_V1,
  MCP_TOOL_CATALOG_V1,
  type McpJsonSchemaProperty,
  type McpJsonSchemaV1,
  type McpReferencePort,
  type McpReferenceSearchInputV1,
  type McpToolDescriptorV1,
  REFERENCE_MCP_LIMITS_V1,
  type ReferenceChunkV1,
  type ReferenceContentV1,
  type ReferenceItemV1,
  type ReferenceJobV1,
  type ReferenceRangeV1,
} from '@novalistically/workbench-protocol';
import YAML from 'yaml';
import {
  AUTHORING_CONTRACT_VERSION,
  type AuthoringFailureV1,
  type AuthoringNextWorkingActionV1,
  type AuthoringStateV1,
  type McpAuthoringApplyInputV1,
  type McpAuthoringApplyOutputV1,
  type McpAuthoringConflictReadOutputV1,
  type McpAuthoringDocumentCreateInputV1,
  type McpAuthoringDocumentDeleteInputV1,
  type McpAuthoringDocumentEditInputV1,
  type McpAuthoringDocumentGetInputV1,
  type McpAuthoringDocumentGetOutputV1,
  type McpAuthoringDocumentListInputV1,
  type McpAuthoringDocumentListOutputV1,
  type McpAuthoringDocumentMoveInputV1,
  type McpAuthoringDocumentMutationOutputV1,
  type McpAuthoringDocumentReadInputV1,
  type McpAuthoringDocumentReadOutputV1,
  type McpAuthoringStatusOutputV1,
  type McpAuthoringSubmitInputV1,
  type McpAuthoringSubmitOutputV1,
  type McpConflictResolveInputV1,
  type McpConflictResolveOutputV1,
  type McpOperationGetInputV1,
  type McpOperationGetOutputV1,
  type WorkingValidationResultV1,
} from '../../contracts/authoring.js';
import {
  type ConfigChangeRequestV1,
  type ConfigOperationReceiptV1,
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  PROJECT_ACCESS_ROLES,
  type ProjectAccessRole,
  type WorkbenchConfigurationV1,
  type WorkbenchProviderConfigurationV1,
} from '../../contracts/configuration.js';
import {
  WORKBENCH_GRAPH_VIEW_VERSION,
  type WorkbenchBranchDecisionV1,
  type WorkbenchRouteSelectorV1,
} from '../../contracts/graph.js';
import type { ProjectPublicationRecordV1 } from '../../contracts/persistence.js';
import type { AuthoringRevisionPort } from '../authoring/types.js';
import { projectCanonicalGraphRuntime } from '../graph-projection.js';
import type {
  ProjectOperationEnqueueResult,
  ProjectOperationRunner,
  ProjectOperationRunnerResult,
  ProjectOperationService,
} from '../operation-service.js';
import type { ProjectSession, SessionDetachedOperationResult } from '../project-session.js';
import type {
  PublicationReadResultV1,
  PublishEnqueueResultV1,
  PublishPublicationRequestV1,
} from '../publication/publication-service.js';
import type { HostNewReviewCommentV1, HostReviewCommentV1 } from '../review/review-service.js';
import type { CanonicalStateProjectionService } from '../state/canonical-state-projection.js';
import type { McpAuthorizedCaller } from './auth.js';

function toolDescriptor(name: string): McpToolDescriptorV1 {
  const descriptor = MCP_TOOL_CATALOG_V1.find((candidate) => candidate.name === name);
  if (descriptor === undefined) {
    throw new Error(`MCP tool is missing from the protocol catalog: ${name}`);
  }
  return descriptor;
}
function toolScope(name: string): string {
  const [scope] = toolDescriptor(name).scopes;
  if (scope === undefined)
    throw new Error(`MCP tool has no scope in the protocol catalog: ${name}`);
  return scope;
}

function toolMetadata(
  name: string,
): Pick<McpToolDefinition, 'name' | 'description' | 'requiredScopes' | 'inputSchema'> {
  const descriptor = toolDescriptor(name);
  return {
    name: descriptor.name,
    description: descriptor.description,
    requiredScopes: descriptor.scopes,
    inputSchema: descriptor.inputSchema,
  };
}

/** Exact capability scopes for MCP tools, sourced from the protocol catalog. */
export const MCP_READ_SCOPE = toolScope('nova_status');
const REFERENCE_MCP_CONTRACT_VERSION = 1 as const;
export const MCP_RENDER_SCOPE = toolScope('nova_render');
export const MCP_AUTHOR_SCOPE = toolScope('nova_authoring_status');
export const MCP_SUBMIT_SCOPE = toolScope('nova_authoring_submit');
export const MCP_REFERENCE_READ_SCOPE = toolScope('nova_reference_list');
export const MCP_REFERENCE_WRITE_SCOPE = toolScope('nova_reference_import_begin');
export const MCP_ADMIN_SCOPE = toolScope('nova_admin_config_apply');

// Protocol-owned strict JSON Schema; the registry only executes handlers.
export type McpJsonInputSchema = McpJsonSchemaV1;
export type { McpJsonSchemaProperty };

// ─── Tool result contract ────────────────────────────────────────────────────

/** Typed, secret-free outcome of one tool invocation. */
export type McpToolResult =
  | { readonly ok: true; readonly data: JsonValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export function mcpToolOk(data: unknown): McpToolResult {
  return { ok: true, data: data as JsonValue };
}

export function mcpToolError(code: string, message: string): McpToolResult {
  return { ok: false, error: { code, message } };
}

function mcpErrorMessage(result: McpToolResult): string {
  return result.ok ? 'Invalid MCP tool input.' : result.error.message;
}

// ─── Definition and registry ─────────────────────────────────────────────────

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Exact capability scopes required to run this tool; every one must be granted. */
  readonly requiredScopes: readonly string[];
  /** Plain JSON Schema for the tool arguments; never zod. */
  readonly inputSchema: McpJsonInputSchema;
  /** Execute with a fully authorized caller; business errors return, never throw. */
  run(caller: McpAuthorizedCaller, input: unknown): Promise<McpToolResult>;
}

export interface McpToolRegistry {
  readonly projectId: string;
  /** The one ProjectSession this registry is bound to; the single source/runtime/queue. */
  readonly session: ProjectSession;
  /**
   * Union of every tool's `requiredScopes`, in definition order. Discovery
   * traffic authenticates against exactly these finite scopes.
   */
  readonly availableScopes: readonly string[];
  /**
   * Definitions the given grant covers: `requiredScopes` must be a subset of
   * `permittedScopes`. tools/list must pass the caller's grant scopes.
   */
  list(permittedScopes: readonly string[]): readonly McpToolDefinition[];
  /**
   * Every definition this registry can serve (family-filtered), including
   * tools a particular grant may not cover. Read-only; the shared
   * `ProjectToolExecutor` and agent model use it to build the AI SDK tool
   * set without duplicating handler or scope logic.
   */
  definitions(): readonly McpToolDefinition[];
  get(name: string): McpToolDefinition | null;
  /**
   * Run one tool. Re-checks the caller's grant against the tool's required
   * scopes (per-call reauthorization), then executes; unexpected throws are
   * normalized to a sanitized, nonsecret INTERNAL_ERROR result.
   */
  run(name: string, caller: McpAuthorizedCaller, input: unknown): Promise<McpToolResult>;
}

export interface McpAuthoringCoordinatorPort {
  readonly projectId: string;
  /** Native revision seam; absent projects fail closed for revision tools. */
  readonly revision?: AuthoringRevisionPort;
  getState(): AuthoringStateV1;
  getDocument(
    input: McpAuthoringDocumentGetInputV1,
  ): Promise<McpAuthoringDocumentGetOutputV1 | AuthoringFailureV1>;
  apply(
    input: McpAuthoringApplyInputV1,
    caller: McpAuthorizedCaller,
  ): Promise<McpAuthoringApplyOutputV1>;
  /** Canonical bounded working-document list/read/edit/lifecycle seams. */
  listDocuments?: (
    input: McpAuthoringDocumentListInputV1,
  ) => Promise<McpAuthoringDocumentListOutputV1 | AuthoringFailureV1>;
  readDocument?: (
    input: McpAuthoringDocumentReadInputV1,
  ) => Promise<McpAuthoringDocumentReadOutputV1 | AuthoringFailureV1>;
  editDocument?: (
    input: McpAuthoringDocumentEditInputV1,
    caller: McpAuthorizedCaller,
  ) => Promise<McpAuthoringApplyOutputV1>;
  createDocument?: (
    input: McpAuthoringDocumentCreateInputV1,
    caller: McpAuthorizedCaller,
  ) => Promise<McpAuthoringDocumentMutationOutputV1 | AuthoringFailureV1>;
  moveDocument?: (
    input: McpAuthoringDocumentMoveInputV1,
    caller: McpAuthorizedCaller,
  ) => Promise<McpAuthoringDocumentMutationOutputV1 | AuthoringFailureV1>;
  deleteDocument?: (
    input: McpAuthoringDocumentDeleteInputV1,
    caller: McpAuthorizedCaller,
  ) => Promise<McpAuthoringDocumentMutationOutputV1 | AuthoringFailureV1>;
  readConflict?: (
    input: McpAuthoringDocumentListInputV1,
  ) => Promise<McpAuthoringConflictReadOutputV1 | AuthoringFailureV1>;
  submit(
    input: McpAuthoringSubmitInputV1,
    caller: McpAuthorizedCaller,
  ): Promise<McpAuthoringSubmitOutputV1>;
  getOperation(input: McpOperationGetInputV1): Promise<McpOperationGetOutputV1>;
  resolveConflict(
    input: McpConflictResolveInputV1,
    caller: McpAuthorizedCaller,
  ): Promise<McpConflictResolveOutputV1>;
  /**
   * Validate the materialized working layer without accepting it. CAS
   * mismatches fail closed with typed `WORKSPACE_STALE` / `ACCEPTED_HASH_MISMATCH`
   * errors; the accepted layer and authoring phase never change.
   */
  validateWorking(input: {
    readonly expectedWorkspaceDigest: string;
    readonly expectedAcceptedSourceHash: string | null;
  }): Promise<WorkingValidationResultV1>;
}

/** Project-scoped comment read filter (wire mirror of the `nova_review_list` schema). */
export interface McpReviewCommentFilterV1 {
  readonly status?: HostReviewCommentV1['status'];
  readonly severity?: HostReviewCommentV1['severity'];
  readonly targetType?: string;
  readonly targetId?: string;
  /** Narrow to comments whose target.id equals this event id. */
  readonly eventId?: string;
}

export type McpReviewCommentUpdateV1 =
  | {
      readonly action: 'replace';
      readonly commentId: string;
      readonly input: HostNewReviewCommentV1;
    }
  | {
      readonly action: 'resolve' | 'wontfix' | 'reopen' | 'escalate';
      readonly commentId: string;
    };

/**
 * Host review/gate seam over the append-only Core review stream (plan Step 5).
 * Every mutation derives actorId/capabilityVersion from the caller grant and
 * writes a durable `ProjectOperationRecordV1`; gate decisions flow through
 * Core `resolveReleaseGate` and never re-invoke the provider. Absent ports
 * fail closed with a typed `REVIEW_SERVICE_UNAVAILABLE` error.
 */
export interface McpReviewPort {
  readonly projectId: string;
  listComments(filter?: McpReviewCommentFilterV1): Promise<readonly HostReviewCommentV1[]>;
  getComment(commentId: string): Promise<HostReviewCommentV1 | null>;
  addComment(
    input: HostNewReviewCommentV1,
    caller: McpAuthorizedCaller,
  ): Promise<HostReviewCommentV1>;
  updateComment(
    input: McpReviewCommentUpdateV1,
    caller: McpAuthorizedCaller,
  ): Promise<HostReviewCommentV1>;
  listGates(eventId?: string): Promise<readonly ReviewGateV1[]>;
  decideGate(
    input: {
      readonly eventId: string;
      readonly candidateRevisionId: string;
      readonly decision: 'accept' | 'reject';
      readonly reason: string;
    },
    caller: McpAuthorizedCaller,
  ): Promise<ReleaseGateResolutionV1>;
}

/**
 * Host publication seam (plan Step 6.6): the durable `publish` queue, the
 * record store and the bounded artifact reader. Reads never leak absolute
 * Host paths — records carry only `relativeOutputPath` and `read` returns
 * bounded markdown slices. Absent ports fail closed with a typed
 * `PUBLICATION_UNAVAILABLE` error.
 */
export interface McpPublicationPort {
  readonly projectId: string;
  /** Enqueue a durable `publish` operation; idempotency is source-scoped. */
  publish(
    input: PublishPublicationRequestV1,
    caller: McpAuthorizedCaller,
  ): Promise<PublishEnqueueResultV1>;
  /** Read one durable row; null when absent. */
  get(publicationId: string): Promise<ProjectPublicationRecordV1 | null>;
  /** Bounded markdown slice of one written artifact. */
  read(publicationId: string, offset: number, limit: number): Promise<PublicationReadResultV1>;
}
/** Owner-scoped configuration surface for `nova_admin_config_*` (revision CAS). */
export interface McpAdminConfigurationPort {
  /** Safe active configuration view; never includes roots, credentials, or tokens. */
  get?: (input: { readonly version: 1 }) => Promise<unknown>;
  preview(input: ConfigChangeRequestV1): Promise<ConfigOperationReceiptV1>;
  apply(input: ConfigChangeRequestV1): Promise<ConfigOperationReceiptV1>;
}

export interface McpAdminProjectSaveInput {
  readonly version: 1;
  readonly projectId: string;
  readonly displayName: string;
  readonly root: string;
}
export interface McpAdminProjectIdInput {
  readonly version: 1;
  readonly projectId: string;
}
export interface McpAdminMembershipListInput {
  readonly version: 1;
  readonly projectId?: string;
}
export interface McpAdminMembershipInput {
  readonly version: 1;
  readonly userId: string;
  readonly projectId: string;
  readonly role?: ProjectAccessRole;
}
export interface McpAdminInviteListInput {
  readonly version: 1;
  readonly projectId?: string;
}
export interface McpAdminInviteCreateInput {
  readonly version: 1;
  readonly projectId: string;
  readonly role: ProjectAccessRole;
  readonly ttlMs: number;
}
export interface McpAdminInviteRevokeInput {
  readonly version: 1;
  readonly inviteId: string;
}
export interface McpAdminDevicePairInput {
  readonly version: 1;
  readonly kind?: 'project' | 'admin';
  readonly projectId?: string;
  readonly role?: ProjectAccessRole;
  readonly ttlMs?: number;
}
export interface McpAdminDeviceRevokeInput {
  readonly version: 1;
  readonly deviceId: string;
}
export interface McpAdminOperationListInput {
  readonly version: 1;
  readonly limit?: number;
}
export interface McpAdminOperationGetInput {
  readonly version: 1;
  readonly operationHandle: string;
}
export interface McpAdminPluginsDiscoveredInput {
  readonly version: 1;
  readonly projectId: string;
}

/** Narrow owner-admin service seams; every method is optional for fail-closed legacy wiring. */
export interface McpAdminPort extends McpAdminConfigurationPort {
  projectList?: (input: { readonly version: 1 }) => Promise<unknown>;
  projectValidate?: (input: McpAdminProjectSaveInput) => Promise<unknown>;
  projectCreate?: (input: McpAdminProjectSaveInput) => Promise<unknown>;
  projectUpdate?: (input: McpAdminProjectSaveInput) => Promise<unknown>;
  projectDelete?: (input: McpAdminProjectIdInput) => Promise<unknown>;
  projectOpen?: (input: McpAdminProjectIdInput) => Promise<unknown>;
  projectClose?: (input: McpAdminProjectIdInput) => Promise<unknown>;
  projectRecover?: (input: McpAdminProjectIdInput) => Promise<unknown>;
  membershipList?: (input: McpAdminMembershipListInput) => Promise<unknown>;
  membershipUpsert?: (input: McpAdminMembershipInput) => Promise<unknown>;
  membershipRevoke?: (input: McpAdminMembershipInput) => Promise<unknown>;
  inviteList?: (input: McpAdminInviteListInput) => Promise<unknown>;
  inviteCreate?: (input: McpAdminInviteCreateInput) => Promise<unknown>;
  inviteRevoke?: (input: McpAdminInviteRevokeInput) => Promise<unknown>;
  deviceList?: (input: { readonly version: 1 }) => Promise<unknown>;
  devicePairBegin?: (input: McpAdminDevicePairInput) => Promise<unknown>;
  deviceRevoke?: (input: McpAdminDeviceRevokeInput) => Promise<unknown>;
  operationList?: (input: McpAdminOperationListInput) => Promise<unknown>;
  operationGet?: (input: McpAdminOperationGetInput) => Promise<unknown>;
  /** Discovered trusted-plugin identities for one configured project root. */
  pluginsDiscovered?: (input: McpAdminPluginsDiscoveredInput) => Promise<unknown>;
}

/**
 * Candidate/commit render seams for the two-phase render path. The runner
 * calls `execute` (compile + provider + validation + archive) inside the
 * detached execute phase and `commit` (accepted-head CAS + publication
 * readiness) inside the detached commit phase; defaults are Core's
 * `executeEditorialCandidates` / `commitEditorialCandidates`.
 */
export interface McpCandidatesSeam {
  execute(
    request: EditorialRenderRequestV1,
    runtime: EditorialRuntime,
  ): Promise<EditorialCandidatesOutcome>;
  commit(
    candidateSet: EditorialCandidateSetV1,
    runtime: EditorialRuntime,
  ): Promise<EditorialCommitResultV1>;
}

/** Injected dialogue-tree render implementation; defaults to Core `renderGameDialogueTree`. */
export type McpRenderTreeFunction = (
  request: RenderGameDialogueTreeRequestV1,
  runtime: EditorialRuntime,
) => Promise<RenderGameDialogueTreeResult>;

/**
 * Host-supplied accepted-layer workflow status seams for `nova_status` and
 * the derived `PROJECT_STATUS.md` refresh. Every member is optional so legacy
 * wiring and tests degrade deterministically; an absent review/publication
 * seam reports honest zeros / `missing` instead of fabricated state.
 */
export interface McpWorkflowStatusPort {
  /**
   * Review projection: a snapshot value or a live accessor (so `nova_status`
   * reflects the append-only review stream at call time). When absent the
   * workflow status reports honest zeros instead of invented counts.
   */
  readonly review?:
    | WorkflowReviewProjectionV1
    | (() => WorkflowReviewProjectionV1 | Promise<WorkflowReviewProjectionV1>);
  /**
   * Publication projection: a snapshot value or a live accessor (so
   * `nova_status` reflects the durable publication store at call time). When
   * absent the workflow status reports honest `missing`.
   */
  readonly publication?:
    | WorkflowPublicationProjectionV1
    | (() => WorkflowPublicationProjectionV1 | Promise<WorkflowPublicationProjectionV1>);
  /** ISO-8601 clock; defaults to the session runtime clock. */
  readonly now?: () => string;
}

/**
 * Live or snapshot plugin activation health for one project. `null` means
 * plugins were never activated for the project (disabled or not configured);
 * an activation result carries active/blocked/disabled records plus the
 * hooks manager identity.
 */
export type McpPluginHealthSource =
  | NodePluginActivationResult
  | null
  | (() => NodePluginActivationResult | null);

/**
 * Session-derived workflow status sources for {@link buildWorkflowStatusForSession}.
 */
export interface McpWorkflowStatusSource {
  /** Authoring coordinator working-state seam; absent → a clean working projection. */
  readonly coordinator?: Pick<McpAuthoringCoordinatorPort, 'projectId' | 'getState'>;
  /**
   * Plugin activation health. When a required plugin is blocked (identity
   * mismatch, init failure, or a conflict awaiting human arbitration) the
   * status gains a blocking diagnostic and the guidance names the health
   * counts; a live accessor is resolved at call time.
   */
  readonly plugins?: McpPluginHealthSource;
  /** Native revision seam for the accepted revision id. */
  readonly revision?: AuthoringRevisionPort;
  /**
   * Accepted-source validation seam; defaults to the same `validateNovel`
   * path `nova_validate` uses. Injectable for deterministic tests. The
   * optional `SourceAnalysisOptions` is forwarded to `validateNovel` so the
   * enabled-plugin extension gate (plan 7.5) applies to injected seams too.
   */
  readonly validate?: (
    snapshot: ProjectSourceSnapshotV1,
    sourceOptions?: SourceAnalysisOptions,
  ) => Promise<NovelValidationResult>;
  /**
   * Enabled-plugin extension gate for the accepted source (plan 7.5). When
   * present, `validateNovel` reports unknown/disabled EventFile `extensions`
   * namespaces as error-severity source diagnostics; absent → no extension
   * diagnostics (legacy behavior).
   */
  readonly extensionRegistrar?: PluginExtensionSchemaRegistrar;
  /** Review/publication projections and clock. */
  readonly status?: McpWorkflowStatusPort;
  /**
   * Per-source/route canonical state projection service (plan 8.1). When
   * present, `nova_status` orders its per-event execution reads by the
   * derived stream's canonical replay sequence; absent → the compile's
   * authored order (full-replay fallback).
   */
  readonly stateProjection?: CanonicalStateProjectionService;
}

export interface McpRegistryOptions {
  /** Project operation service (durable FIFO render queue + cancel); absent render tools fail closed. */
  readonly operations?: ProjectOperationService;
  /** Project-scoped reference catalog; absent tools fail closed. */
  readonly reference?: McpReferencePort;
  /** Candidate/commit seams for the two-phase render path; default to Core's split. */
  readonly candidates?: McpCandidatesSeam;
  /** Dialogue-tree render seam; defaults to Core `renderGameDialogueTree`. */
  readonly renderTree?: McpRenderTreeFunction;
  /** Author/submit coordinator port; when absent the authoring tools fail closed. */
  readonly coordinator?: McpAuthoringCoordinatorPort;
  /** Native immutable revision service for this project; absent fails closed. */
  readonly revision?: AuthoringRevisionPort;
  /** Owner admin service ports; missing individual methods fail closed. */
  readonly admin?: McpAdminPort;
  /** Project review/gate service; absent review tools fail closed. */
  readonly review?: McpReviewPort;
  /** Project publication service; absent publication tools fail closed. */
  readonly publication?: McpPublicationPort;
  /**
   * Accepted-layer workflow status seams for `nova_status`. Absent review and
   * publication members report honest zeros / `missing` (no stores yet).
   */
  readonly status?: McpWorkflowStatusPort;
  /**
   * Plugin activation health for `nova_status` blockers/guidance (plan 7.3).
   * Absent → no plugin diagnostics surface, even when a required plugin is
   * blocked; the launch always wires it for configured projects.
   */
  readonly plugins?: McpPluginHealthSource;
  /**
   * Enabled-plugin extension gate (plan 7.5) for the accepted-source
   * validation paths. When present, `nova_validate`/`nova_status` report
   * unknown/disabled EventFile `extensions` namespaces as error-severity
   * source diagnostics; absent → legacy behavior.
   */
  readonly extensionRegistrar?: PluginExtensionSchemaRegistrar;
  /**
   * Per-source/route canonical state projection service (plan 8.1). When
   * present, `nova_event_state_diff` reads through the derived stream
   * (nearest verified snapshot → suffix, full-replay fallback) instead of a
   * raw per-request compile; absent → the raw `diffEvent` path. This is a
   * derived cache, never a second authority.
   */
  readonly stateProjection?: CanonicalStateProjectionService;
  /**
   * Select the descriptor family exposed by this registry. The legacy
   * `all` default is retained for direct callers; Host routes always choose
   * an explicit family so project and admin discovery cannot overlap.
   */
  readonly family?: 'all' | 'project' | 'admin';
}
/** Reject unknown keys so client payloads can never smuggle server-only fields. */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): McpToolResult | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return mcpToolError(
        'UNKNOWN_FIELD',
        `Unknown field "${key}"; this tool accepts only: ${allowed.join(', ')}.`,
      );
    }
  }
  return null;
}
interface ParsedInput {
  readonly ok: true;
  readonly value: Record<string, unknown>;
}
interface InputFailure {
  readonly ok: false;
  readonly result: McpToolResult;
}
type ParseOutcome = ParsedInput | InputFailure;

const NO_ACCEPTED_SOURCE = mcpToolError(
  'NO_ACCEPTED_SOURCE',
  'The session has no accepted source yet; load and validate a project first.',
);

function invalidInput(message: string): McpToolResult {
  return mcpToolError('INVALID_INPUT', message);
}

/** Strict object check: non-object inputs are invalid, never coerced. */
function parseObject(input: unknown, message: string): ParseOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, result: invalidInput(message) };
  }
  return { ok: true, value: input as Record<string, unknown> };
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { ok: false, result: invalidInput(`${key} must be a non-empty string.`) };
  }
  return { ok: true, value: candidate };
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string') {
    throw new InputShapeError(`${key} must be a string when present.`);
  }
  return candidate;
}

function _boundedString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.length > maxLength) {
    return {
      ok: false,
      result: invalidInput(`${key} must be a string of at most ${maxLength} characters.`),
    };
  }
  return { ok: true, value: candidate };
}

/** Internal signal for validation failures discovered mid-parse; normalized by the caller. */
class InputShapeError extends Error {
  override readonly name = 'InputShapeError';
}
function parseSceneSelector(value: unknown): SceneSelector {
  const parsed = parseObject(value, 'sceneSelector must be an object.');
  if (!parsed.ok) throw new InputShapeError(mcpErrorMessage(parsed.result));
  const selector = parsed.value;
  // Mirror Core `sceneSelectorSchema`: a discriminated union of strict shapes,
  // so every variant rejects keys that belong to the other variants.
  if (selector.type === 'all') {
    const extra = rejectUnknownKeys(selector, ['type']);
    if (extra !== null && !extra.ok) throw new InputShapeError(mcpErrorMessage(extra));
    return { type: 'all' };
  }
  if (selector.type === 'chapter') {
    const extra = rejectUnknownKeys(selector, ['type', 'chapter']);
    if (extra !== null && !extra.ok) throw new InputShapeError(mcpErrorMessage(extra));
    if (
      typeof selector.chapter !== 'number' ||
      !Number.isInteger(selector.chapter) ||
      selector.chapter < 1
    ) {
      throw new InputShapeError('chapter must be a positive integer when type is "chapter".');
    }
    return { type: 'chapter', chapter: selector.chapter };
  }
  if (selector.type === 'events') {
    const extra = rejectUnknownKeys(selector, ['type', 'eventIds']);
    if (extra !== null && !extra.ok) throw new InputShapeError(mcpErrorMessage(extra));
    if (!Array.isArray(selector.eventIds) || selector.eventIds.length === 0) {
      throw new InputShapeError('eventIds must be a non-empty array when type is "events".');
    }
    if (!selector.eventIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      throw new InputShapeError(
        'each eventIds entry must be a non-empty string when type is "events".',
      );
    }
    if (new Set(selector.eventIds).size !== selector.eventIds.length) {
      throw new InputShapeError('eventIds must be unique when type is "events".');
    }
    return { type: 'events', eventIds: selector.eventIds };
  }
  throw new InputShapeError(
    'sceneSelector must be {type:"all"}, {type:"chapter",chapter:positive integer}, or {type:"events",eventIds:non-empty unique strings}.',
  );
}

/** One validated render/chunk identity pair for a reference-backed render. */
// Type alias (not interface) so the shape keeps its implicit index signature
// and stays assignable to Core's JsonObject payload contract.
type ParsedReferenceChunk = {
  readonly referenceId: string;
  readonly chunkId: string;
};

/** Outcome of the shared render input parser (nova_render/nova_revise/nova_render_tree). */
type RenderInputOutcome =
  | {
      readonly ok: true;
      readonly value: {
        readonly selector: SceneSelector;
        readonly model: string | undefined;
        readonly references: readonly ParsedReferenceChunk[];
        /** The validated input record; only schema-allowed keys can survive. */
        readonly fields: Record<string, unknown>;
      };
    }
  | { readonly ok: false; readonly result: McpToolResult };

/**
 * Shared strict parser for the three render-surface tools. Every tool rejects
 * unknown keys, wrong selector shapes, unbounded chunk lists, reference
 * chunks without `mcp:reference:read`, and duplicate chunk pairs exactly the
 * same way; capability/source/reference identity handling stays identical to
 * `nova_render`.
 */
function parseRenderInput(
  input: unknown,
  caller: McpAuthorizedCaller,
  _options: Pick<McpRegistryOptions, 'reference'>,
  extraAllowed: readonly string[] = [],
): RenderInputOutcome {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  // Fail closed: no actorId/operationId (or any other server field) may reach the queue.
  const unknown = rejectUnknownKeys(parsed.value, [
    'sceneSelector',
    'model',
    'referenceChunks',
    ...extraAllowed,
  ]);
  if (unknown) return { ok: false, result: unknown };
  let selector: SceneSelector;
  let model: string | undefined;
  try {
    selector = parseSceneSelector(parsed.value.sceneSelector);
    model = optionalString(parsed.value, 'model');
  } catch (error) {
    return { ok: false, result: mcpToolError('INVALID_INPUT', (error as Error).message) };
  }
  const references: ParsedReferenceChunk[] = [];
  if (parsed.value.referenceChunks !== undefined) {
    if (
      !Array.isArray(parsed.value.referenceChunks) ||
      parsed.value.referenceChunks.length > REFERENCE_MCP_LIMITS_V1.maxCitations
    ) {
      return { ok: false, result: invalidInput('referenceChunks must be a bounded array.') };
    }
    if (!caller.grant.scopes.includes(MCP_REFERENCE_READ_SCOPE)) {
      return {
        ok: false,
        result: mcpToolError(
          'SCOPE_MISMATCH',
          'Reference-backed renders require mcp:reference:read.',
        ),
      };
    }
    for (const value of parsed.value.referenceChunks) {
      const candidate = parseObject(value, 'Each reference chunk must be an object.');
      if (!candidate.ok) return candidate;
      const chunkUnknown = rejectUnknownKeys(candidate.value, ['referenceId', 'chunkId']);
      if (chunkUnknown) return { ok: false, result: chunkUnknown };
      const referenceId = referenceString(
        candidate.value,
        'referenceId',
        REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
      );
      const chunkId = referenceString(
        candidate.value,
        'chunkId',
        REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
      );
      if (!referenceId.ok) return referenceId;
      if (!chunkId.ok) return chunkId;
      references.push({
        referenceId: requiredParsedValue(referenceId.value),
        chunkId: requiredParsedValue(chunkId.value),
      });
    }
    if (
      new Set(references.map((value) => `${value.referenceId}\u0000${value.chunkId}`)).size !==
      references.length
    ) {
      return { ok: false, result: invalidInput('referenceChunks must not contain duplicates.') };
    }
  }
  return { ok: true, value: { selector, model, references, fields: parsed.value } };
}

/**
 * Strict route selector for `nova_graph`: exactly `version` + `branchPath`
 * (with optional `discourseBranch`), mirroring the browser graph route's
 * validation — unknown keys, wrong types, malformed decisions and
 * non-integer `narrativeOrder` are all rejected before any graph work.
 */
function parseRouteSelector(
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: WorkbenchRouteSelectorV1 }
  | { readonly ok: false; readonly result: McpToolResult } {
  const topKeys = Object.keys(value);
  if (
    topKeys.length < 2 ||
    !('version' in value) ||
    !('branchPath' in value) ||
    (topKeys.length === 3 && !('discourseBranch' in value)) ||
    topKeys.length > 3 ||
    topKeys.some((key) => key !== 'version' && key !== 'branchPath' && key !== 'discourseBranch')
  ) {
    return {
      ok: false,
      result: invalidInput(
        'nova_graph requires exactly version and branchPath, with optional discourseBranch.',
      ),
    };
  }
  if (value.version !== WORKBENCH_GRAPH_VIEW_VERSION) {
    return {
      ok: false,
      result: invalidInput(`route selector version must be ${WORKBENCH_GRAPH_VIEW_VERSION}.`),
    };
  }
  const branchPath = value.branchPath;
  if (
    typeof branchPath !== 'object' ||
    branchPath === null ||
    Array.isArray(branchPath) ||
    Object.keys(branchPath).length !== 1 ||
    !('decisions' in branchPath) ||
    !Array.isArray((branchPath as Record<string, unknown>).decisions)
  ) {
    return {
      ok: false,
      result: invalidInput('branchPath must contain exactly a decisions array.'),
    };
  }
  const rawDecisions = (branchPath as Record<string, unknown>).decisions as unknown[];
  const decisions: WorkbenchBranchDecisionV1[] = [];
  for (let index = 0; index < rawDecisions.length; index += 1) {
    const raw = rawDecisions[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        result: invalidInput(`route decision ${index} must be an object.`),
      };
    }
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 3 ||
      !('atEventId' in record) ||
      !('choiceId' in record) ||
      !('narrativeOrder' in record)
    ) {
      return {
        ok: false,
        result: invalidInput(
          `route decision ${index} must contain exactly atEventId, choiceId, narrativeOrder.`,
        ),
      };
    }
    const { atEventId, choiceId, narrativeOrder } = record;
    if (typeof atEventId !== 'string' || atEventId.length === 0) {
      return {
        ok: false,
        result: invalidInput(`route decision ${index} atEventId must be a non-empty string.`),
      };
    }
    if (typeof choiceId !== 'string' || choiceId.length === 0) {
      return {
        ok: false,
        result: invalidInput(`route decision ${index} choiceId must be a non-empty string.`),
      };
    }
    if (
      typeof narrativeOrder !== 'number' ||
      !Number.isSafeInteger(narrativeOrder) ||
      narrativeOrder < 0
    ) {
      return {
        ok: false,
        result: invalidInput(
          `route decision ${index} narrativeOrder must be a non-negative integer.`,
        ),
      };
    }
    decisions.push({ atEventId, choiceId, narrativeOrder });
  }
  let discourseBranch: string | undefined;
  if ('discourseBranch' in value) {
    const candidate = value.discourseBranch;
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return {
        ok: false,
        result: invalidInput('discourseBranch must be a non-empty string.'),
      };
    }
    discourseBranch = candidate;
  }
  return {
    ok: true,
    value: {
      version: WORKBENCH_GRAPH_VIEW_VERSION,
      branchPath: { decisions },
      ...(discourseBranch === undefined ? {} : { discourseBranch }),
    },
  };
}

function parseSourceChange(value: unknown): SourceChangeV1 {
  const parsed = parseObject(value, 'each change must be an object.');
  if (!parsed.ok) throw new InputShapeError(mcpErrorMessage(parsed.result));
  const change = parsed.value;
  const unknown = rejectUnknownKeys(change, [
    'logicalPath',
    'beforeContent',
    'beforeHash',
    'afterContent',
    'afterHash',
  ]);
  if (unknown !== null && !unknown.ok) throw new InputShapeError(mcpErrorMessage(unknown));
  const logicalPath = requiredString(change, 'logicalPath');
  if (!logicalPath.ok) throw new InputShapeError(mcpErrorMessage(logicalPath.result));
  const nullableString = (key: string): string | null => {
    const candidate = change[key];
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate !== 'string') {
      throw new InputShapeError(`${key} must be a string or null when present.`);
    }
    return candidate;
  };
  return {
    logicalPath: logicalPath.value,
    beforeContent: nullableString('beforeContent'),
    beforeHash: nullableString('beforeHash'),
    afterContent: nullableString('afterContent'),
    afterHash: nullableString('afterHash'),
  };
}
/** Serialize `validateNovel` results: its `results` map is not JSON. */
async function serializeValidation(
  snapshot: ProjectSourceSnapshotV1,
  sourceOptions?: SourceAnalysisOptions,
): Promise<McpToolResult> {
  const validation = await validateNovel(snapshot, undefined, sourceOptions);
  // Object.fromEntries defines own data properties (CreateDataProperty), so an
  // event id like "__proto__" becomes real JSON data instead of a prototype
  // mutation; never copy into a plain `{}` with `results[key] = value`.
  const results = Object.fromEntries(validation.results);
  // `nova_validate` always validates the accepted layer; the working layer is
  // validated by `nova_authoring_validate` and never inferred implicitly.
  return mcpToolOk({
    layer: 'accepted',
    passed: validation.passed,
    iss: validation.iss,
    results,
    ...(validation.sourceDiagnostics === undefined
      ? {}
      : { sourceDiagnostics: validation.sourceDiagnostics }),
  });
}

/**
 * Event id of an EventFile logical path: the parsed `event:` field (the
 * authoritative id, e.g. `E5` for `E5_threshold_rejection.yaml`), falling
 * back to the file stem for loaders that keep no parse value.
 */
function eventIdForDocument(snapshot: ProjectSourceSnapshotV1, logicalPath: string | null): string {
  if (logicalPath === null) return '';
  const document = snapshot.documents.find((candidate) => candidate.logicalPath === logicalPath);
  if (document !== undefined) {
    const parsed = document.parseResult.value;
    if (parsed !== null && typeof parsed === 'object') {
      const event = (parsed as Record<string, unknown>).event;
      if (typeof event === 'string' && event.length > 0) return event;
    }
    try {
      const reparsed = YAML.parse(document.content);
      if (reparsed !== null && typeof reparsed === 'object') {
        const event = (reparsed as Record<string, unknown>).event;
        if (typeof event === 'string' && event.length > 0) return event;
      }
    } catch {
      // The document is already flagged elsewhere; fall through to the stem.
    }
  }
  const match = logicalPath.match(/^chapters\/chapter_\d{2}\/(E[^/]+)\.(?:yaml|yml)$/);
  return match?.[1] ?? '';
}

/**
 * Convert one source diagnostic into a workflow-validatable issue. The
 * registrar emits error-severity diagnostics for unknown/disabled namespaces,
 * which must block the scene like any other accepted-source error.
 */
function sourceDiagnosticIssue(
  diagnostic: SourceDiagnosticV1,
  snapshot: ProjectSourceSnapshotV1,
): ValidationIssue {
  return {
    validator: 'source',
    severity: diagnostic.severity,
    kind: 'compiler_invariant',
    event: eventIdForDocument(snapshot, diagnostic.logicalPath),
    entity: '',
    message: `${diagnostic.code}: ${diagnostic.message}`,
    fixSuggestion: 'Edit the source document to resolve the source diagnostic.',
    fixAction: 'edit_file',
    fixTarget: { file: diagnostic.logicalPath ?? '' },
  };
}

// ─── Accepted-layer workflow status (nova_status / PROJECT_STATUS.md) ───────

/**
 * Build the full accepted-layer workflow status for one session, or null when
 * the session has no accepted source. This is the single composition point
 * behind `nova_status` and the per-project `PROJECT_STATUS.md` refresh.
 *
 * Everything is derived from injected session state: the accepted snapshot,
 * the same `validateNovel` accepted-source validation path `nova_validate`
 * uses, per-event execution state from the injected execution repository, the
 * authoring coordinator's working state, and the injected review/publication
 * seams (honest zeros / `missing` until the Step 5/6 stores exist). Event
 * order is the canonical compile order and issue order follows it, so the
 * result is deterministic; no provider/LLM call and no filesystem access
 * beyond the injected execution repository happens here.
 */
export async function buildWorkflowStatusForSession(
  session: ProjectSession,
  source: McpWorkflowStatusSource = {},
): Promise<WorkflowStatusV1 | null> {
  const snapshot = session.source;
  if (snapshot === null) return null;
  const projectId = session.projectId;

  // Accepted-layer validation through the same path `nova_validate` uses.
  const validation = await (source.validate ?? validateNovel)(
    snapshot,
    undefined,
    source.extensionRegistrar === undefined
      ? undefined
      : { extensionRegistrar: source.extensionRegistrar },
  );

  // Planned events in canonical compile order. Per-event execution state comes
  // from the injected repository; a scene whose accepted record carries the
  // current sourceHash is completed (the core applies that identity rule).
  // `renderBlockedReasons` is empty at this step: failed render attempts
  // (empty prose / missing analysis / exhausted retries) are only observable
  // in-memory during a render run — Step 4's durable scene revision archive
  // makes them queryable per event, which is where this projection fills in.
  const compilation = session.runtime.compile(snapshot);
  // Planned events in canonical order. With the per-source/route projection
  // service wired (plan 8.1), the per-event list is ordered by the derived
  // stream's canonical replay sequence (never narrativeOrder), restricted to
  // the authored render plan; without it the compile's authored order is used
  // (full-replay fallback). Per-event rendered/blocked state still comes from
  // the injected execution repository — the service is a derived cache, never
  // a second authority.
  const plannedIds = new Set(compilation.events.map((event) => event.id));
  let orderedEventIds = compilation.events.map((event) => event.id);
  if (source.stateProjection !== undefined) {
    const stream = await source.stateProjection.events(snapshot);
    if (stream.length > 0) {
      const streamed = stream
        .map((event) => event.eventId)
        .filter((eventId) => plannedIds.has(eventId));
      if (streamed.length > 0) orderedEventIds = streamed;
    }
  }
  const execution: WorkflowExecutionProjectionV1 = {
    events: await Promise.all(
      orderedEventIds.map(async (eventId) => {
        const read = await session.runtime.services.execution.readAcceptedScene({
          projectId,
          eventId,
        });
        return {
          eventId,
          acceptedScene: read?.value ?? null,
          renderBlockedReasons: [],
        };
      }),
    ),
  };

  // Deterministic issue order: canonical event order first, then any event id
  // outside the render plan in sorted order.
  const orderedIds = [
    ...orderedEventIds,
    ...[...validation.results.keys()].filter((id) => !plannedIds.has(id)).sort(),
  ];
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const eventId of orderedIds) {
    const result = validation.results.get(eventId);
    if (result === undefined) continue;
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  // Source-level extension-gate diagnostics (plan 7.5): unknown/disabled
  // namespaces are error-severity and must surface exactly like per-event
  // validation errors (FIX_ACCEPTED_SOURCE, blocked scenes).
  for (const diagnostic of validation.sourceDiagnostics ?? []) {
    const issue = sourceDiagnosticIssue(diagnostic, snapshot);
    if (issue.severity === 'error') errors.push(issue);
    else warnings.push(issue);
  }

  // Accepted revision identity: the coordinator's persisted state when
  // present, else the native revision port.
  const coordinatorState = source.coordinator?.getState();
  let acceptedRevisionId: string | null = coordinatorState?.acceptedRevisionId ?? null;
  if (acceptedRevisionId === null && source.revision !== undefined) {
    acceptedRevisionId = (await source.revision.loadAccepted(projectId))?.revisionId ?? null;
  }

  // Working projection from the coordinator state. `validated` /
  // `validationPassed` stay false because the coordinator state does not track
  // `validateWorking` runs yet (plan Step 5 completes it); dirty and conflict
  // are real coordinator state, never guessed.
  const working: WorkflowWorkingProjectionV1 =
    coordinatorState === undefined
      ? { dirty: false, validated: false, validationPassed: false, conflict: false }
      : {
          dirty: coordinatorState.workingDirty,
          validated: false,
          validationPassed: false,
          conflict:
            coordinatorState.conflicts.length > 0 ||
            coordinatorState.phase === 'conflict' ||
            coordinatorState.phase === 'recovery-required',
        };

  // The review seam may be a snapshot or a live accessor; resolve either so
  // `nova_status` always reflects the append-only review stream at call time.
  const reviewSeam = source.status?.review;
  const review =
    typeof reviewSeam === 'function'
      ? await reviewSeam()
      : (reviewSeam ?? { open: 0, blocking: 0, pendingGates: 0 });

  // Same for the publication seam: a snapshot or a live accessor over the
  // durable publication store (current/stale/missing, never fabricated).
  const publicationSeam = source.status?.publication;
  const publication =
    typeof publicationSeam === 'function'
      ? await publicationSeam()
      : (publicationSeam ?? {
          status: 'missing',
          publicationId: null,
          novelHash: null,
        });

  const status = buildWorkflowStatus({
    projectId,
    snapshot,
    acceptedRevisionId,
    validation: { errors, warnings },
    iss: validation.iss,
    execution,
    working,
    review,
    publication,
    now: source.status?.now ?? (() => session.runtime.services.clock.now()),
  });

  // Plugin activation health (plan 7.3): plugins were activated for this
  // project, so the status names the health counts in guidance; a required
  // plugin that is blocked (identity mismatch, init failure, or a conflict
  // awaiting human arbitration) makes render unavailable and must also
  // surface as a blocking diagnostic. The WorkflowStatusV1 wire shape has no
  // plugin field, so this goes through the existing blockers + guidance
  // surface without reshaping the contract.
  const pluginsSeam = source.plugins;
  const plugins = typeof pluginsSeam === 'function' ? await pluginsSeam() : (pluginsSeam ?? null);
  if (plugins !== null) {
    const pluginBlockers =
      plugins.blocked.length === 0
        ? []
        : plugins.blocked.map((blocked) => ({
            code: 'PLUGIN_BLOCKED' as const,
            message: `Plugin "${blocked.name}" is blocked: ${blocked.reason}`,
            severity: 'error' as const,
          }));
    const health = `Plugin health: ${plugins.active.length} active, ${plugins.blocked.length} blocked, ${plugins.disabled.length} disabled.`;
    return {
      ...status,
      ...(pluginBlockers.length === 0 ? {} : { blockers: [...pluginBlockers, ...status.blockers] }),
      guidance: `${health} ${status.guidance}`,
    };
  }
  return status;
}

/**
 * Deterministic next working-layer action for the authoring loop. A conflict
 * or recovery-required phase maps to RESOLVE_CONFLICT; a dirty layer maps to
 * VALIDATE_WORKING; a clean layer has no next action. SUBMIT_WORKING is
 * produced only once the coordinator tracks a passing `validateWorking` on
 * the current digest (plan Step 5); today a dirty layer always validates
 * first, matching the workflow-status action chain.
 */
function authoringNextWorkingAction(state: AuthoringStateV1): AuthoringNextWorkingActionV1 | null {
  if (
    state.conflicts.length > 0 ||
    state.phase === 'conflict' ||
    state.phase === 'recovery-required'
  ) {
    return 'RESOLVE_CONFLICT';
  }
  if (state.workingDirty) return 'VALIDATE_WORKING';
  return null;
}

// ─── Authoring/admin input parsing (strict, fail closed) ────────────────────

/** The one accepted version for authoring MCP tool inputs. */
const AUTHORING_MCP_CONTRACT_VERSION = AUTHORING_CONTRACT_VERSION;
/** Configuration MCP retains its dedicated version-1 DTO contract. */
const CONFIG_CONTRACT_VERSION = 1;

const NO_AUTHORING_COORDINATOR = mcpToolError(
  'PROJECT_NOT_READY',
  'The authoring coordinator is not available for this project.',
);
const NO_ADMIN_CONFIGURATION = mcpToolError(
  'NO_ADMIN_CONFIGURATION',
  'The owner configuration service is not available for this Host.',
);
const NO_ADMIN_SERVICE = mcpToolError(
  'NO_ADMIN_SERVICE',
  'The requested owner administration service is not available for this Host.',
);
const NO_REFERENCE_PORT = mcpToolError(
  'REFERENCE_UNAVAILABLE',
  'The reference catalog is not available for this project.',
);
const NO_OPERATION_SERVICE = mcpToolError(
  'OPERATION_SERVICE_UNAVAILABLE',
  'The project operation service is not available for this project.',
);
const NO_REVIEW_SERVICE = mcpToolError(
  'REVIEW_SERVICE_UNAVAILABLE',
  'The review service is not available for this project.',
);
const NO_PUBLICATION_SERVICE = mcpToolError(
  'PUBLICATION_UNAVAILABLE',
  'The publication service is not available for this project.',
);

// ─── Review/gate input parsing (strict, fail closed) ─────────────────────────

/** The one accepted version for review/gate MCP tool inputs. */
const REVIEW_MCP_CONTRACT_VERSION = 1;
const REVIEW_COMMENT_STATUSES = ['open', 'addressed', 'resolved', 'wontfix', 'superseded'] as const;
const REVIEW_SEVERITIES = ['nit', 'suggestion', 'blocking'] as const;
const REVIEW_TARGET_TYPES = [
  'novel',
  'chapter',
  'scene',
  'line',
  'character',
  'worldrule',
] as const;
const REVIEW_CATEGORIES = [
  'style',
  'pacing',
  'character_voice',
  'plot_logic',
  'world_consistency',
  'reader_experience',
] as const;
const REVIEW_UPDATE_ACTIONS = ['replace', 'resolve', 'wontfix', 'reopen', 'escalate'] as const;

function parseReviewInput(
  input: unknown,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== REVIEW_MCP_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput('review request version must be 1.') };
  }
  return parsed;
}

function reviewOptionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined) return { ok: true, value: undefined };
  if (typeof candidate !== 'string' || !allowed.includes(candidate)) {
    return {
      ok: false,
      result: invalidInput(`${key} must be one of: ${allowed.join(', ')}.`),
    };
  }
  return { ok: true, value: candidate };
}

function reviewOptionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 4096,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined) return { ok: true, value: undefined };
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maxLength) {
    return {
      ok: false,
      result: invalidInput(`${key} must be a bounded non-empty string when present.`),
    };
  }
  return { ok: true, value: candidate };
}

/** Strict review target parse mirroring Core `newReviewCommentSchema`. */
function parseReviewTarget(
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: HostNewReviewCommentV1['target'] }
  | { readonly ok: false; readonly result: McpToolResult } {
  const target = parseObject(value.target, 'target must be an object.');
  if (!target.ok) return target;
  const unknown = rejectUnknownKeys(target.value, ['type', 'id', 'lineRange', 'lineBasis']);
  if (unknown) return { ok: false, result: unknown };
  const type = target.value.type;
  if (typeof type !== 'string' || !(REVIEW_TARGET_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      result: invalidInput(
        'target.type must be novel, chapter, scene, line, character, or worldrule.',
      ),
    };
  }
  const id = requiredString(target.value, 'id');
  if (!id.ok) return { ok: false, result: id.result };
  if (type === 'novel' && id.value !== 'novel') {
    return { ok: false, result: invalidInput('a novel target id must be "novel".') };
  }
  if (type === 'chapter' && !/^chapter:[1-9]\d*$/.test(id.value)) {
    return {
      ok: false,
      result: invalidInput('a chapter target id must match chapter:<n> with n >= 1.'),
    };
  }
  if (type !== 'line') {
    return {
      ok: true,
      value: { type: type as HostNewReviewCommentV1['target']['type'], id: id.value },
    };
  }
  // Line targets require an accepted-scene line basis; the Core facade
  // additionally validates the basis against the archived scene revision.
  const lineRange = target.value.lineRange;
  if (
    !Array.isArray(lineRange) ||
    lineRange.length !== 2 ||
    !lineRange.every((entry) => Number.isInteger(entry) && (entry as number) >= 1)
  ) {
    return {
      ok: false,
      result: invalidInput('a line target requires a [start, end] lineRange of positive integers.'),
    };
  }
  const [start, end] = lineRange as [number, number];
  if (end < start) {
    return { ok: false, result: invalidInput('lineRange end must be >= start.') };
  }
  const lineBasis = parseObject(target.value.lineBasis, 'lineBasis must be an object.');
  if (!lineBasis.ok) return { ok: false, result: lineBasis.result };
  const basisUnknown = rejectUnknownKeys(lineBasis.value, ['revisionId', 'proseHash']);
  if (basisUnknown) return { ok: false, result: basisUnknown };
  const revisionId = requiredString(lineBasis.value, 'revisionId');
  const proseHash = requiredString(lineBasis.value, 'proseHash');
  if (!revisionId.ok) return { ok: false, result: revisionId.result };
  if (!proseHash.ok) return { ok: false, result: proseHash.result };
  if (!/^[0-9a-f]{64}$/.test(proseHash.value)) {
    return { ok: false, result: invalidInput('lineBasis.proseHash must be a 64-char hex hash.') };
  }
  return {
    ok: true,
    value: {
      type: 'line',
      id: id.value,
      lineRange: [start, end],
      lineBasis: { revisionId: revisionId.value, proseHash: proseHash.value },
    },
  };
}

/** Secret-free wire serialization of a projected comment (nulls made explicit). */
function safeReviewComment(comment: HostReviewCommentV1): JsonValue {
  return {
    id: comment.id,
    author: comment.author,
    actorId: comment.actorId,
    target: {
      type: comment.target.type,
      id: comment.target.id,
      ...(comment.target.lineRange === undefined ? {} : { lineRange: comment.target.lineRange }),
      ...(comment.target.lineBasis === undefined
        ? {}
        : {
            lineBasis: {
              revisionId: comment.target.lineBasis.revisionId,
              proseHash: comment.target.lineBasis.proseHash,
            },
          }),
    },
    severity: comment.severity,
    category: comment.category,
    content: comment.content,
    status: comment.status,
    applications: comment.applications.map((application) => ({
      eventId: application.eventId,
      revisionId: application.revisionId,
      operationId: application.operationId,
      appliedAt: application.appliedAt,
    })),
    supersedesId: comment.supersedesId ?? null,
    resolvedBy: comment.resolvedBy ?? null,
    createdAt: comment.createdAt,
    resolvedAt: comment.resolvedAt ?? null,
  };
}

/** Secret-free wire serialization of a projected gate (nulls made explicit). */
function safeReviewGate(gate: ReviewGateV1): JsonValue {
  return {
    gateId: gate.gateId,
    sourceHash: gate.sourceHash,
    eventId: gate.eventId,
    proseHash: gate.proseHash,
    scopeHash: gate.scopeHash,
    validationIdentity: gate.validationIdentity,
    warningFingerprints: gate.warningFingerprints,
    revisionId: gate.revisionId,
    openedAt: gate.openedAt,
    openedBy: gate.openedBy,
    status: gate.status,
    decision:
      gate.decision === null
        ? null
        : {
            gateId: gate.decision.gateId,
            decision: gate.decision.decision,
            revisionId: gate.decision.revisionId,
            capabilityVersion: gate.decision.capabilityVersion,
            reason: gate.decision.reason,
            actorId: gate.decision.actorId,
            createdAt: gate.decision.createdAt,
          },
    supersededAt: gate.supersededAt ?? null,
    supersededBy: gate.supersededBy ?? null,
    supersedeReason: gate.supersedeReason ?? null,
  };
}

/** Core business errors (EditorialOperationError etc.) surface as typed results. */
function reviewErrorResult(error: unknown, fallback = 'INTERNAL_ERROR'): McpToolResult {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : fallback;
  return mcpToolError(
    code,
    error instanceof Error ? error.message : 'The review operation failed.',
  );
}

// ─── Publication tools (plan Step 6.6) ──────────────────────────────────────

/** The one accepted version for publication MCP tool inputs. */
const PUBLICATION_MCP_CONTRACT_VERSION = 1;
const PUBLICATION_MAX_ID_LENGTH = 128;
const PUBLICATION_MAX_TITLE_LENGTH = 256;
const PUBLICATION_MAX_READ_BYTES = 256 * 1024;

/** Strict versioned publication input: object + known keys + version 1. */
function parsePublicationVersionedInput(
  input: unknown,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== PUBLICATION_MCP_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput('publication request version must be 1.') };
  }
  return parsed;
}

/**
 * Parse the publish request: an optional strict route selector (branchPath),
 * an optional top-level discourseBranch and an optional bounded title. A
 * selector and a top-level discourseBranch are aliases; supplying both is a
 * shape error. No branch identity → canonical publish.
 */
function parsePublishRequest(
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: PublishPublicationRequestV1 }
  | { readonly ok: false; readonly result: McpToolResult } {
  let branchPath: BranchPath | undefined;
  let discourseBranch: string | undefined;
  if ('branchPath' in value) {
    const raw = value.branchPath;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        result: invalidInput('branchPath must be a strict route selector object.'),
      };
    }
    const selector = parseRouteSelector(raw as Record<string, unknown>);
    if (!selector.ok) {
      return {
        ok: false,
        result: invalidInput(
          'branchPath must contain exactly version and branchPath, with optional discourseBranch.',
        ),
      };
    }
    branchPath = {
      decisions: selector.value.branchPath.decisions.map((decision) => ({
        atEventId: decision.atEventId,
        choiceId: decision.choiceId,
        narrativeOrder: decision.narrativeOrder,
      })),
    };
    discourseBranch = selector.value.discourseBranch;
  }
  if ('discourseBranch' in value) {
    const candidate = value.discourseBranch;
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return {
        ok: false,
        result: invalidInput('discourseBranch must be a non-empty string.'),
      };
    }
    if (discourseBranch !== undefined) {
      return {
        ok: false,
        result: invalidInput(
          'discourseBranch must not be supplied both inside branchPath and at the top level.',
        ),
      };
    }
    discourseBranch = candidate;
  }
  let title: string | undefined;
  if ('title' in value) {
    const candidate = value.title;
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > PUBLICATION_MAX_TITLE_LENGTH
    ) {
      return {
        ok: false,
        result: invalidInput(
          `title must be a string of at most ${PUBLICATION_MAX_TITLE_LENGTH} characters.`,
        ),
      };
    }
    title = candidate;
  }
  return {
    ok: true,
    value: {
      ...(branchPath === undefined ? {} : { branchPath }),
      ...(discourseBranch === undefined ? {} : { discourseBranch }),
      ...(title === undefined ? {} : { title }),
    },
  };
}

/** Bounded publication id: non-empty, at most 128 characters. */
function parsePublicationId(
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly result: McpToolResult } {
  const publicationId = requiredString(value, 'publicationId');
  if (!publicationId.ok) return publicationId;
  if (publicationId.value.length > PUBLICATION_MAX_ID_LENGTH) {
    return {
      ok: false,
      result: invalidInput(
        `publicationId must be at most ${PUBLICATION_MAX_ID_LENGTH} characters.`,
      ),
    };
  }
  return { ok: true, value: publicationId.value };
}

/** Secret-free wire serialization of a durable publication row (relative paths only). */
function safePublicationRecord(record: ProjectPublicationRecordV1): JsonValue {
  return {
    publicationId: record.publicationId,
    kind: record.kind,
    value: {
      sourceHash: record.value.sourceHash,
      scopeHash: record.value.scopeHash,
      revisionIds: [...record.value.revisionIds],
      novelHash: record.value.novelHash,
      relativeOutputPath: record.value.relativeOutputPath,
      byteLength: record.value.byteLength,
      actorId: record.value.actorId,
      operationId: record.value.operationId,
      createdAt: record.value.createdAt,
      status: record.value.status,
    },
    updatedAt: record.updatedAt,
  };
}

/** Publication service failures surface as typed, nonsecret results. */
function publicationErrorResult(error: unknown): McpToolResult {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'INTERNAL_ERROR';
  return mcpToolError(
    code,
    error instanceof Error ? error.message : 'The publication operation failed.',
  );
}

function parseAdminVersionedInput(
  input: unknown,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== CONFIG_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput('admin request version must be 1.') };
  }
  return parsed;
}

function adminString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 4096,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly result: McpToolResult } {
  const result = requiredString(value, key);
  if (!result.ok) return result;
  if (result.value.length > maxLength) {
    return { ok: false, result: invalidInput(`${key} exceeds the bounded length.`) };
  }
  return result;
}

function adminOptionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 4096,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined) return { ok: true, value: undefined };
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maxLength) {
    return {
      ok: false,
      result: invalidInput(`${key} must be a bounded non-empty string when present.`),
    };
  }
  return { ok: true, value: candidate };
}

function adminRole(
  value: Record<string, unknown>,
  key = 'role',
):
  | { readonly ok: true; readonly value: ProjectAccessRole }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (
    typeof candidate !== 'string' ||
    !(PROJECT_ACCESS_ROLES as readonly string[]).includes(candidate)
  ) {
    return { ok: false, result: invalidInput(`${key} must be reader, author, or maintainer.`) };
  }
  return { ok: true, value: candidate as ProjectAccessRole };
}

function adminOptionalRole(
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: ProjectAccessRole | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  if (value.role === undefined) return { ok: true, value: undefined };
  return adminRole(value);
}

function adminInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  required = true,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined && !required) return { ok: true, value: undefined };
  if (
    typeof candidate !== 'number' ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    return { ok: false, result: invalidInput(`${key} must be a bounded integer.`) };
  }
  return { ok: true, value: candidate };
}

function parseAdminProjectSave(
  input: unknown,
):
  | { readonly ok: true; readonly value: McpAdminProjectSaveInput }
  | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseAdminVersionedInput(input, ['version', 'projectId', 'displayName', 'root']);
  if (!parsed.ok) return parsed;
  const projectId = adminString(parsed.value, 'projectId');
  const displayName = adminString(parsed.value, 'displayName');
  const root = adminString(parsed.value, 'root');
  if (!projectId.ok) return projectId;
  if (!displayName.ok) return displayName;
  if (!root.ok) return root;
  return {
    ok: true,
    value: {
      version: 1,
      projectId: projectId.value,
      displayName: displayName.value,
      root: root.value,
    },
  };
}

function parseAdminProjectId(
  input: unknown,
):
  | { readonly ok: true; readonly value: McpAdminProjectIdInput }
  | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseAdminVersionedInput(input, ['version', 'projectId']);
  if (!parsed.ok) return parsed;
  const projectId = adminString(parsed.value, 'projectId');
  if (!projectId.ok) return projectId;
  return { ok: true, value: { version: 1, projectId: projectId.value } };
}
function parseToolInput(
  input: unknown,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== AUTHORING_MCP_CONTRACT_VERSION) {
    return {
      ok: false,
      result: invalidInput(`version must be ${AUTHORING_MCP_CONTRACT_VERSION}.`),
    };
  }
  return parsed;
}

function parseReferenceInput(
  input: unknown,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== REFERENCE_MCP_CONTRACT_VERSION) {
    return {
      ok: false,
      result: invalidInput(`version must be ${REFERENCE_MCP_CONTRACT_VERSION}.`),
    };
  }
  return parsed;
}

function referenceString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  required = true,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined && !required) return { ok: true, value: undefined };
  if (
    typeof candidate !== 'string' ||
    (required && candidate.length === 0) ||
    candidate.length > maxLength
  ) {
    return {
      ok: false,
      result: invalidInput(
        `${key} must be ${required ? 'a non-empty ' : 'a '}string of at most ${maxLength} characters.`,
      ),
    };
  }
  return { ok: true, value: candidate };
}

function referenceInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  required = true,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined && !required) return { ok: true, value: undefined };
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    return {
      ok: false,
      result: invalidInput(`${key} must be an integer between ${minimum} and ${maximum}.`),
    };
  }
  return { ok: true, value: candidate };
}

function referenceStringList(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  maxCount: number,
):
  | { readonly ok: true; readonly value: string[] | undefined }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(candidate) || candidate.length > maxCount) {
    return {
      ok: false,
      result: invalidInput(`${key} must be an array of at most ${maxCount} strings.`),
    };
  }
  if (
    !candidate.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= maxLength,
    )
  ) {
    return {
      ok: false,
      result: invalidInput(
        `${key} entries must be non-empty strings of at most ${maxLength} characters.`,
      ),
    };
  }
  return { ok: true, value: candidate as string[] };
}

function safeObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function safeText(value: unknown, label: string): string;
function safeText(value: unknown, label: string, allowNull: true): string | null;
function safeText(value: unknown, label: string, allowNull = false): string | null {
  if ((value === null || value === undefined) && allowNull) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function requiredParsedValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Parsed required value is missing');
  return value;
}

function safeHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function safeReferenceItem(value: unknown): ReferenceItemV1 {
  const item = safeObject(value, 'Reference item');
  const authors = item.authors;
  const tags = item.tags;
  if (!Array.isArray(authors) || !authors.every((entry) => typeof entry === 'string'))
    throw new Error('Reference authors are invalid');
  if (!Array.isArray(tags) || !tags.every((entry) => typeof entry === 'string'))
    throw new Error('Reference tags are invalid');
  const byteLength = item.byteLength;
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > REFERENCE_MCP_LIMITS_V1.maxReferenceBytes
  ) {
    throw new Error('Reference byteLength is invalid');
  }
  return {
    version: 1,
    referenceId: safeText(item.referenceId, 'referenceId'),
    displayName: safeText(item.displayName, 'displayName'),
    originalName: safeText(item.originalName, 'originalName'),
    mediaType: safeText(item.mediaType, 'mediaType'),
    contentHash: safeHash(item.contentHash, 'contentHash'),
    byteLength,
    title: safeText(item.title, 'title', true),
    authors: [...authors],
    sourceUrl: safeText(item.sourceUrl, 'sourceUrl', true),
    license: safeText(item.license, 'license', true),
    tags: [...tags],
    createdAt: safeText(item.createdAt, 'createdAt'),
    updatedAt: safeText(item.updatedAt, 'updatedAt'),
  };
}

function safeReferenceJob(value: unknown): ReferenceJobV1 {
  const job = safeObject(value, 'Reference job');
  const message = safeText(job.errorMessage, 'errorMessage', true);
  const redactPath = (text: string | null): string | null => {
    if (text === null) return null;
    return text
      .split(/[ \t\r\n]+/)
      .map((part) => (part.includes('/') || part.includes('\\') ? '[redacted-path]' : part))
      .join(' ');
  };
  return {
    version: 1,
    jobId: safeText(job.jobId, 'jobId'),
    operation: job.operation as ReferenceJobV1['operation'],
    status: job.status as ReferenceJobV1['status'],
    referenceId: safeText(job.referenceId, 'referenceId', true),
    bytesReceived: job.bytesReceived as number,
    totalBytes: job.totalBytes as number | null,
    contentHash: job.contentHash === null ? null : safeHash(job.contentHash, 'contentHash'),
    errorCode: safeText(job.errorCode, 'errorCode', true),
    errorMessage: redactPath(message),
    createdAt: safeText(job.createdAt, 'createdAt'),
    updatedAt: safeText(job.updatedAt, 'updatedAt'),
  };
}

function safeReferenceRange(value: unknown): ReferenceRangeV1 {
  const range = safeObject(value, 'Reference range');
  if (typeof range.offset !== 'number' || typeof range.length !== 'number')
    throw new Error('Reference range is invalid');
  return { version: 1, offset: range.offset, length: range.length };
}

function safeReferenceContent(value: unknown): ReferenceContentV1 {
  const content = safeObject(value, 'Reference content');
  const dataBase64 = safeText(content.dataBase64, 'dataBase64');
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) ||
    dataBase64.length > REFERENCE_MCP_LIMITS_V1.maxChunkBase64Length
  ) {
    throw new Error('Reference content encoding is invalid');
  }
  return {
    version: 1,
    referenceId: safeText(content.referenceId, 'referenceId'),
    mediaType: safeText(content.mediaType, 'mediaType'),
    contentHash: safeHash(content.contentHash, 'contentHash'),
    byteLength: content.byteLength as number,
    range: safeReferenceRange(content.range),
    dataBase64,
    nextOffset: content.nextOffset as number | null,
  };
}

/** Strict `string | null` field; null only when explicitly allowed. */

function safeReferenceChunk(value: unknown): ReferenceChunkV1 {
  const chunk = safeObject(value, 'Reference chunk');
  const quote = safeText(chunk.quote, 'quote', true);
  const locator = safeText(chunk.locator, 'locator');
  if (locator.includes('/') || locator.includes('\\'))
    throw new Error('Reference locator contains a path');
  return {
    version: 1,
    referenceId: safeText(chunk.referenceId, 'referenceId'),
    chunkId: safeText(chunk.chunkId, 'chunkId'),
    ordinal: chunk.ordinal as number,
    range: safeReferenceRange(chunk.range),
    byteLength: chunk.byteLength as number,
    contentHash: safeHash(chunk.contentHash, 'contentHash'),
    chunkHash: safeHash(chunk.chunkHash, 'chunkHash'),
    locator,
    quote,
  };
}
function nullableStringField(
  value: Record<string, unknown>,
  key: string,
):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === null) return { ok: true, value: null };
  if (typeof candidate !== 'string') {
    return { ok: false, result: invalidInput(`${key} must be a string or null.`) };
  }
  return { ok: true, value: candidate };
}

/** Map a coordinator `apply` outcome: stale/conflict/rejected are typed failures. */
function authoringApplyResult(outcome: McpAuthoringApplyOutputV1): McpToolResult {
  if (outcome.status === 'applied') return mcpToolOk(outcome);
  return mcpToolError(outcome.failure.code, outcome.failure.message);
}

/** Map a coordinator submit/resolve outcome: queued/completed are results, rejected is a typed failure. */
function authoringAsyncResult(
  outcome: McpAuthoringSubmitOutputV1 | McpConflictResolveOutputV1,
): McpToolResult {
  if (outcome.status === 'rejected') {
    return mcpToolError(outcome.failure.code, outcome.failure.message);
  }
  return mcpToolOk(outcome);
}
type NativeRevisionRestoreOutcome = Awaited<ReturnType<AuthoringRevisionPort['restore']>>;

function nativeRevisionResult(
  outcome: NativeRevisionRestoreOutcome,
  version: number,
): McpToolResult {
  if (outcome.status === 'accepted') {
    return mcpToolOk({
      version,
      status: outcome.status,
      revisionId: outcome.revisionId,
      receiptHash: outcome.receiptHash,
    });
  }
  if (outcome.status === 'stale') {
    return mcpToolError('WORKSPACE_STALE', outcome.reason);
  }
  if (outcome.status === 'conflict') {
    return mcpToolError('CONFLICT_REQUIRES_RESOLUTION', outcome.reason);
  }
  return mcpToolError(outcome.code, outcome.reason);
}

function stringList(
  value: Record<string, unknown>,
  key: string,
):
  | { readonly ok: true; readonly value: string[] }
  | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return { ok: false, result: invalidInput(`${key} must be an array of strings.`) };
  }
  if (!candidate.every((entry) => typeof entry === 'string')) {
    return { ok: false, result: invalidInput(`${key} must be an array of strings.`) };
  }
  return { ok: true, value: candidate };
}

/**
 * Deep-structural validation of a `ConfigChangeRequestV1`. Every level rejects
 * unknown fields and wrong types; semantic validation (path accessibility,
 * duplicate ids, listener policy) is the configuration service's job, so the
 * MCP tool only guarantees the request shape before it reaches the port.
 */
function parseConfigChangeRequest(
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: ConfigChangeRequestV1 }
  | { readonly ok: false; readonly result: McpToolResult } {
  const unknown = rejectUnknownKeys(value, ['version', 'expectedRevision', 'configuration']);
  if (unknown) return { ok: false, result: unknown };
  if (value.version !== CONFIG_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput('configuration request version must be 1.') };
  }
  const expectedRevision = value.expectedRevision;
  if (typeof expectedRevision !== 'string' && expectedRevision !== null) {
    return { ok: false, result: invalidInput('expectedRevision must be a string or null.') };
  }
  if (
    typeof value.configuration !== 'object' ||
    value.configuration === null ||
    Array.isArray(value.configuration)
  ) {
    return { ok: false, result: invalidInput('configuration must be an object.') };
  }
  const configuration = parseConfiguration(value.configuration as Record<string, unknown>);
  if (!configuration.ok) return configuration;
  return {
    ok: true,
    value: {
      version: CONFIG_CONTRACT_VERSION,
      expectedRevision,
      configuration: configuration.value,
    },
  };
}

function parseConfiguration(
  value: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: WorkbenchConfigurationV1 }
  | { readonly ok: false; readonly result: McpToolResult } {
  const unknown = rejectUnknownKeys(value, [
    'version',
    'projects',
    'defaultProjectId',
    'provider',
    'network',
  ]);
  if (unknown) return { ok: false, result: unknown };
  if (value.version !== CONFIG_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput('configuration version must be 1.') };
  }
  if (!Array.isArray(value.projects)) {
    return { ok: false, result: invalidInput('configuration.projects must be an array.') };
  }
  const projects: WorkbenchConfigurationV1['projects'][number][] = [];
  for (const entry of value.projects) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        result: invalidInput('each configuration.projects entry must be an object.'),
      };
    }
    const record = entry as Record<string, unknown>;
    const entryUnknown = rejectUnknownKeys(record, ['projectId', 'displayName', 'root']);
    if (entryUnknown) return { ok: false, result: entryUnknown };
    const projectId = requiredString(record, 'projectId');
    if (!projectId.ok) return { ok: false, result: projectId.result };
    const displayName = requiredString(record, 'displayName');
    if (!displayName.ok) return { ok: false, result: displayName.result };
    const root = requiredString(record, 'root');
    if (!root.ok) return { ok: false, result: root.result };
    projects.push({
      projectId: projectId.value,
      displayName: displayName.value,
      root: root.value,
      revisionMirror: { mode: 'disabled' },
      providerProfile: 'default',
      trustedPlugins: [],
    });
  }
  const defaultProjectId = value.defaultProjectId;
  if (typeof defaultProjectId !== 'string' && defaultProjectId !== null) {
    return {
      ok: false,
      result: invalidInput('configuration.defaultProjectId must be a string or null.'),
    };
  }
  const provider = value.provider;
  let parsedProvider: WorkbenchProviderConfigurationV1 | null = null;
  if (provider !== null) {
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
      return {
        ok: false,
        result: invalidInput('configuration.provider must be an object or null.'),
      };
    }
    const providerRecord = provider as Record<string, unknown>;
    const providerUnknown = rejectUnknownKeys(providerRecord, ['kind', 'baseUrl', 'model']);
    if (providerUnknown) return { ok: false, result: providerUnknown };
    if (providerRecord.kind !== 'ai-sdk') {
      return { ok: false, result: invalidInput('configuration.provider.kind must be "ai-sdk".') };
    }
    const baseUrl = nullableStringField(providerRecord, 'baseUrl');
    if (!baseUrl.ok) return baseUrl;
    const model = nullableStringField(providerRecord, 'model');
    if (!model.ok) return model;
    parsedProvider = { kind: 'ai-sdk', baseUrl: baseUrl.value, model: model.value };
  }
  if (typeof value.network !== 'object' || value.network === null || Array.isArray(value.network)) {
    return { ok: false, result: invalidInput('configuration.network must be an object.') };
  }
  const networkRecord = value.network as Record<string, unknown>;
  const networkUnknown = rejectUnknownKeys(networkRecord, [
    'mode',
    'port',
    'allowedHosts',
    'allowedOrigins',
    'unixSocket',
  ]);
  if (networkUnknown) return { ok: false, result: networkUnknown };
  const mode = networkRecord.mode;
  if (mode !== 'loopback' && mode !== 'lan' && mode !== 'unix') {
    return {
      ok: false,
      result: invalidInput('configuration.network.mode must be loopback, lan, or unix.'),
    };
  }
  if (
    typeof networkRecord.port !== 'number' ||
    !Number.isInteger(networkRecord.port) ||
    networkRecord.port < 1
  ) {
    return {
      ok: false,
      result: invalidInput('configuration.network.port must be a positive integer.'),
    };
  }
  const allowedHosts = stringList(networkRecord, 'allowedHosts');
  if (!allowedHosts.ok) return allowedHosts;
  const allowedOrigins = stringList(networkRecord, 'allowedOrigins');
  if (!allowedOrigins.ok) return allowedOrigins;
  const unixSocket = nullableStringField(networkRecord, 'unixSocket');
  if (!unixSocket.ok) return unixSocket;
  return {
    ok: true,
    value: {
      version: CONFIG_CONTRACT_VERSION,
      projects,
      defaultProjectId,
      providers: parsedProvider === null ? {} : { default: parsedProvider },
      network: {
        mode,
        port: networkRecord.port,
        allowedHosts: allowedHosts.value,
        allowedOrigins: allowedOrigins.value,
        unixSocket: unixSocket.value,
      },
      referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
      operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
      agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
      renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
    },
  };
}

// ─── Shared render-surface execution (nova_render / nova_revise / nova_render_tree) ──

/**
 * Resolve the project-scoped reference packet inside the queued operation.
 * Citations are built server-side only, after queue authorization; missing
 * chunks and empty quotes fail the operation as input errors.
 */
async function resolveReferencePacket(
  referencePacket: McpReferencePort,
  references: readonly ParsedReferenceChunk[],
  projectId: string,
): Promise<ProjectReferencePacketV1> {
  return {
    version: 1 as const,
    projectId,
    citations: await Promise.all(
      references.map(async ({ referenceId, chunkId }, index) => {
        const result = await referencePacket.getChunk({
          version: 1,
          referenceId,
          chunkId,
        });
        if (result === null) throw new InputShapeError('Reference chunk was not found.');
        const chunk = result.chunk;
        if (chunk.quote === null || chunk.quote.length === 0) {
          throw new InputShapeError('Reference chunk has no text quote.');
        }
        return {
          version: 1 as const,
          citationId: `${chunk.referenceId}:${chunk.chunkId}:${index}`,
          referenceId: chunk.referenceId,
          chunkId: chunk.chunkId,
          contentHash: chunk.contentHash,
          chunkHash: chunk.chunkHash,
          quote: chunk.quote,
          locator: chunk.locator,
          authoritative: false as const,
        };
      }),
    ),
  };
}

/** Capability scope for a render-surface operation, shared by all three tools. */
function renderSurfaceScope(references: readonly ParsedReferenceChunk[]): readonly string[] {
  return references.length === 0
    ? [MCP_RENDER_SCOPE]
    : [MCP_RENDER_SCOPE, MCP_REFERENCE_READ_SCOPE];
}

/**
 * Identity captured by the render prepare phase and re-verified by the commit
 * phase. `sourceHash` is the primary staleness signal (the session's accepted
 * source); `acceptedRevisionId` closes the native-revision identity when a
 * coordinator seam exists; `sceneHeads` is a per-event accepted-head
 * fingerprint for explicit `events` selectors (the Core commit CAS covers
 * every other selector); `references` is the request's static reference
 * identity.
 */
interface RenderCaptureIdentity {
  readonly sourceHash: string;
  readonly source: ProjectSourceSnapshotV1;
  readonly acceptedRevisionId: string | null;
  readonly sceneHeads: ReadonlyMap<
    string,
    { readonly revisionId: string; readonly version: number }
  >;
  readonly references: readonly ParsedReferenceChunk[];
}

/** sha256 hex digest; deterministic identity hashing for queued operation payloads. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Live accepted native revision id from the optional coordinator seam. */
function acceptedRevisionIdFor(options: McpRegistryOptions): () => string | null {
  return () => {
    const coordinator = options.coordinator;
    return coordinator === undefined ? null : coordinator.getState().acceptedRevisionId;
  };
}

/**
 * Capture the render identity inside the serialized lane. Fails closed when
 * the accepted source disappeared between enqueue and prepare.
 */
async function captureRenderIdentity(
  session: ProjectSession,
  acceptedRevisionId: () => string | null,
  eventIdsForHeads: readonly string[],
  references: readonly ParsedReferenceChunk[],
): Promise<RenderCaptureIdentity> {
  const source = session.source;
  if (source === null) {
    throw Object.assign(new Error('The session has no accepted source to render.'), {
      code: 'NO_ACCEPTED_SOURCE',
    });
  }
  const sceneHeads = new Map<string, { revisionId: string; version: number }>();
  if (eventIdsForHeads.length > 0) {
    const execution = session.runtime.services.execution;
    for (const eventId of eventIdsForHeads) {
      const read = await execution.readAcceptedScene({ projectId: session.projectId, eventId });
      if (read !== null) {
        sceneHeads.set(eventId, { revisionId: read.value.revisionId, version: read.revision });
      }
    }
  }
  return {
    sourceHash: source.sourceHash,
    source,
    acceptedRevisionId: acceptedRevisionId(),
    sceneHeads,
    references,
  };
}

/**
 * Re-verify the captured identities at commit time. Returns a typed reason
 * when the source/revision/scene heads moved; null means the candidate is
 * still current and may be promoted.
 */
async function stalenessReason(
  session: ProjectSession,
  capture: RenderCaptureIdentity,
  acceptedRevisionId: () => string | null,
): Promise<string | null> {
  const current = session.source;
  if (current === null || current.sourceHash !== capture.sourceHash) {
    return 'SOURCE_MOVED: the accepted source changed while the render ran; candidate archived and never promoted.';
  }
  if (capture.acceptedRevisionId !== acceptedRevisionId()) {
    return 'REVISION_MOVED: the accepted native revision changed while the render ran; candidate archived and never promoted.';
  }
  const execution = session.runtime.services.execution;
  for (const [eventId, head] of capture.sceneHeads) {
    const read = await execution.readAcceptedScene({ projectId: session.projectId, eventId });
    if (read === null || read.revision !== head.version) {
      return `SCENE_HEAD_MOVED: accepted scene ${eventId} changed while the render ran; candidate archived and never promoted.`;
    }
  }
  return null;
}

/**
 * Assemble the final `RenderNovelResult` from the candidate set and the
 * commit outcome. Mirrors the tail of Core's composed `executeEditorialRender`
 * (which is not exported piecewise): result mapping, release decisions and
 * the publication projection are derived from the commit result, never from
 * in-run state.
 */
function buildSurfaceRenderResult(
  candidateSet: EditorialCandidateSetV1,
  commitResult: EditorialCommitResultV1,
): RenderNovelResult {
  const results = candidateSet.orderedResults.map((result) => {
    const decision = commitResult.decisions.get(result.eventId) ?? null;
    const revisionId = commitResult.revisionIds.get(result.eventId) ?? null;
    const disposition = commitResult.sceneDispositions.get(result.eventId) ?? 'candidate_blocked';
    return {
      eventId: result.eventId,
      prose: result.prose,
      wordCount: result.prose ? result.prose.split(/\s+/).filter(Boolean).length : 0,
      cacheHit: result.cacheHit,
      released: decision ? decision.status === 'accepted' : false,
      revisionId,
      promoted: disposition === 'candidate_promoted' || disposition === 'head_reused',
      locked: false,
      disposition,
      releaseDecision: decision,
      analysis: result.analysis,
      validationErrors: result.validation?.errors.length ?? 0,
      validationIssueMessages: result.validation?.errors.map((issue) => issue.message) ?? [],
      providerCalls: result.providerCalls.map((entry) => ({
        phase: entry.phase,
        attempt: entry.attempt,
        outcome: entry.outcome,
        requestHash: entry.requestHash,
        model: entry.model,
        seed: entry.seed,
        failureReason: entry.failureReason,
      })),
      promptHash: result.promptHash,
      pass2Rejection: result.pass2Rejection,
      errors: result.errors,
      editorialErrors: [],
    };
  });
  return {
    operationId: candidateSet.operationId,
    results,
    errors: commitResult.editorialErrors.map((error) => error.message),
    editorialErrors: [...commitResult.editorialErrors],
    publication: commitResult.publication,
  };
}

/** Map the session's detached-operation outcome onto the service's runner contract. */
function mapDetachedOutcome<T>(
  outcome: SessionDetachedOperationResult<T>,
): ProjectOperationRunnerResult {
  switch (outcome.status) {
    case 'completed':
      return { status: 'succeeded', result: outcome.result };
    case 'stale':
      return { status: 'stale' };
    case 'cancelled':
      return { status: 'cancelled' };
    case 'denied':
      return {
        status: 'failed',
        errorCode: `DENIED:${outcome.reason}`,
        message: `The capability gate denied the operation: ${outcome.reason}.`,
      };
    case 'failed':
      return { status: 'failed', errorCode: outcome.errorCode, message: outcome.message };
  }
}

/** Map the operation service's enqueue outcome onto the tool result contract. */
function mapOperationEnqueue(result: ProjectOperationEnqueueResult): McpToolResult {
  switch (result.status) {
    case 'queued':
      return mcpToolOk({ status: 'queued', operationHandle: result.operationHandle });
    case 'replayed':
      return mcpToolOk({ status: 'queued', operationHandle: result.record.operationId });
    case 'conflict':
      return mcpToolError(
        'IDEMPOTENCY_CONFLICT',
        `An operation with the same idempotency key but a different request already exists (${result.record.operationId}).`,
      );
    case 'queue-full':
      return mcpToolError(
        'OPERATION_QUEUE_FULL',
        `The project operation queue is full (${result.active} active operations).`,
      );
    case 'closed':
      return mcpToolError('OPERATION_SERVICE_CLOSED', 'The project operation service is closed.');
  }
}

interface RenderSurfaceRunnerOptions {
  readonly session: ProjectSession;
  readonly caller: McpAuthorizedCaller;
  readonly candidates: McpCandidatesSeam;
  readonly kind: 'render' | 'revise';
  readonly selector: SceneSelector;
  readonly model: string | undefined;
  readonly references: readonly ParsedReferenceChunk[];
  readonly revision?: { readonly instruction?: string; readonly reviewIds?: readonly string[] };
  readonly referencePort: McpReferencePort | undefined;
  readonly acceptedRevisionId: () => string | null;
  readonly payload: JsonValue;
}

/**
 * Runner wiring for `nova_render` / `nova_revise`: prepare captures the
 * source/revision/scene-head identity inside the lane, execute runs the
 * candidate computation off-lane with the abort signal, commit re-verifies
 * the identity and promotes through the Core commit split.
 */
function buildRenderSurfaceRunner(options: RenderSurfaceRunnerOptions): ProjectOperationRunner {
  const {
    session,
    caller,
    candidates,
    kind,
    selector,
    model,
    references,
    revision,
    referencePort,
    acceptedRevisionId,
    payload,
  } = options;
  return async (context) => {
    const outcome = await session.enqueueDetachedOperation({
      kind,
      capabilityId: caller.grant.capabilityId,
      scope: renderSurfaceScope(references),
      expectedVersion: caller.grant.version,
      operationId: context.operationId,
      payload,
      signal: context.signal,
      prepare: () =>
        captureRenderIdentity(
          session,
          acceptedRevisionId,
          selector.type === 'events' ? selector.eventIds : [],
          references,
        ),
      execute: async (runContext, capture, executeSignal) => {
        const resolvedReferencePacket =
          referencePort === undefined
            ? undefined
            : await resolveReferencePacket(referencePort, references, session.projectId);
        const request: EditorialRenderRequestV1 = {
          version: 1,
          source: capture.source,
          selector,
          mutation: { operationId: runContext.operationId, actorId: runContext.actorId },
          ...(model !== undefined ? { model } : {}),
          ...(revision === undefined ? {} : { revision }),
          ...(resolvedReferencePacket === undefined
            ? {}
            : { referencePacket: resolvedReferencePacket }),
        };
        return candidates.execute(request, {
          services: session.runtime.services,
          signal: executeSignal,
        });
      },
      commit: async (_runContext, capture, candidate) => {
        if (candidate.kind === 'failed') {
          // Preflight failure: nothing to promote; the failed result is final.
          return { status: 'completed', result: candidate.result };
        }
        const stale = await stalenessReason(session, capture, acceptedRevisionId);
        if (stale !== null) return { status: 'stale', reason: stale };
        const commitResult = await candidates.commit(candidate.candidateSet, {
          services: session.runtime.services,
        });
        if (commitResult.stale) {
          return {
            status: 'stale',
            reason:
              'ACCEPTED_HEAD_CONFLICT: an accepted scene head moved while the render ran; candidate archived and never promoted.',
          };
        }
        return {
          status: 'completed',
          result: buildSurfaceRenderResult(candidate.candidateSet, commitResult),
        };
      },
    });
    return mapDetachedOutcome(outcome);
  };
}

interface RenderTreeRunnerOptions {
  readonly session: ProjectSession;
  readonly caller: McpAuthorizedCaller;
  readonly renderTree: McpRenderTreeFunction;
  readonly model: string | undefined;
  readonly references: readonly ParsedReferenceChunk[];
  readonly referencePort: McpReferencePort | undefined;
  readonly acceptedRevisionId: () => string | null;
  readonly payload: JsonValue;
}

/**
 * Runner wiring for `nova_render_tree`: same two-phase lane discipline as the
 * surface runners. Core exposes only the composed tree render, so execute
 * runs it whole (its internal per-route commits use the request snapshot) and
 * commit re-verifies the captured source/revision identity before the result
 * is reported; a moved source archives the result as stale.
 */
function buildRenderTreeRunner(options: RenderTreeRunnerOptions): ProjectOperationRunner {
  const {
    session,
    caller,
    renderTree,
    model,
    references,
    referencePort,
    acceptedRevisionId,
    payload,
  } = options;
  return async (context) => {
    const outcome = await session.enqueueDetachedOperation({
      kind: 'render-tree',
      capabilityId: caller.grant.capabilityId,
      scope: renderSurfaceScope(references),
      expectedVersion: caller.grant.version,
      operationId: context.operationId,
      payload,
      signal: context.signal,
      prepare: () => captureRenderIdentity(session, acceptedRevisionId, [], references),
      execute: async (runContext, capture, executeSignal) => {
        const resolvedReferencePacket =
          referencePort === undefined
            ? undefined
            : await resolveReferencePacket(referencePort, references, session.projectId);
        const request: RenderGameDialogueTreeRequestV1 = {
          version: 1,
          source: capture.source,
          mutation: { operationId: runContext.operationId, actorId: runContext.actorId },
          ...(model !== undefined ? { model } : {}),
          ...(resolvedReferencePacket === undefined
            ? {}
            : { referencePacket: resolvedReferencePacket }),
        };
        return renderTree(request, {
          services: session.runtime.services,
          signal: executeSignal,
        });
      },
      commit: async (_runContext, capture, candidate) => {
        const stale = await stalenessReason(session, capture, acceptedRevisionId);
        if (stale !== null) return { status: 'stale', reason: stale };
        return { status: 'completed', result: candidate };
      },
    });
    return mapDetachedOutcome(outcome);
  };
}

/**
 * Shared enqueue path for `nova_render` / `nova_revise`. Both tools carry the
 * same capability/source/reference identity handling; revise additionally
 * forwards the bounded `revision` (instruction + reviewIds) into the actual
 * Pass 1 render request. The tool returns `{status:'queued', operationHandle}`
 * immediately; the durable FIFO queue runs the two-phase render.
 */
async function enqueueRenderSurfaceOperation(options: {
  readonly session: ProjectSession;
  readonly caller: McpAuthorizedCaller;
  readonly operations?: ProjectOperationService;
  readonly candidates: McpCandidatesSeam;
  readonly kind: 'render' | 'revise';
  readonly selector: SceneSelector;
  readonly model: string | undefined;
  readonly references: readonly ParsedReferenceChunk[];
  readonly revision?: { readonly instruction?: string; readonly reviewIds?: readonly string[] };
  readonly referencePort: McpReferencePort | undefined;
  readonly acceptedRevisionId: () => string | null;
}): Promise<McpToolResult> {
  const {
    session,
    caller,
    operations,
    candidates,
    kind,
    selector,
    model,
    references,
    revision,
    referencePort,
    acceptedRevisionId,
  } = options;
  const source = session.source;
  if (source === null) return NO_ACCEPTED_SOURCE;
  const referencePacket = references.length === 0 ? undefined : (referencePort ?? null);
  if (referencePacket === null) return NO_REFERENCE_PORT;
  if (operations === undefined) return NO_OPERATION_SERVICE;
  const payload: JsonValue = {
    selector,
    ...(model !== undefined ? { model } : {}),
    ...(references.length === 0 ? {} : { referenceChunks: [...references] }),
    ...(revision === undefined
      ? {}
      : {
          revision: {
            ...(revision.instruction === undefined ? {} : { instruction: revision.instruction }),
            ...(revision.reviewIds === undefined ? {} : { reviewIds: [...revision.reviewIds] }),
          },
        }),
  };
  const requestHash = sha256Hex(JSON.stringify(payload));
  const enqueued = await operations.enqueue({
    kind,
    idempotencyKey: sha256Hex(requestHash),
    actorId: caller.grant.userId,
    capabilityVersion: caller.grant.version,
    sourceHash: source.sourceHash,
    acceptedRevisionId: null,
    requestHash,
    runner: buildRenderSurfaceRunner({
      session,
      caller,
      candidates,
      kind,
      selector,
      model,
      references,
      revision,
      referencePort,
      acceptedRevisionId,
      payload,
    }),
  });
  return mapOperationEnqueue(enqueued);
}

/**
 * Enqueue path for `nova_render_tree`. The tree request has no selector or
 * revision (Core `RenderGameDialogueTreeRequestV1`), but capability, source
 * and reference identity handling is identical to `nova_render`.
 */
async function enqueueRenderTreeOperation(options: {
  readonly session: ProjectSession;
  readonly caller: McpAuthorizedCaller;
  readonly operations?: ProjectOperationService;
  readonly renderTree: McpRenderTreeFunction;
  readonly selector: SceneSelector;
  readonly model: string | undefined;
  readonly references: readonly ParsedReferenceChunk[];
  readonly referencePort: McpReferencePort | undefined;
  readonly acceptedRevisionId: () => string | null;
}): Promise<McpToolResult> {
  const {
    session,
    caller,
    operations,
    renderTree,
    selector,
    model,
    references,
    referencePort,
    acceptedRevisionId,
  } = options;
  const source = session.source;
  if (source === null) return NO_ACCEPTED_SOURCE;
  const referencePacket = references.length === 0 ? undefined : (referencePort ?? null);
  if (referencePacket === null) return NO_REFERENCE_PORT;
  if (operations === undefined) return NO_OPERATION_SERVICE;
  const payload: JsonValue = {
    selector,
    ...(model !== undefined ? { model } : {}),
    ...(references.length === 0 ? {} : { referenceChunks: [...references] }),
  };
  const requestHash = sha256Hex(JSON.stringify(payload));
  const enqueued = await operations.enqueue({
    kind: 'render-tree',
    idempotencyKey: sha256Hex(requestHash),
    actorId: caller.grant.userId,
    capabilityVersion: caller.grant.version,
    sourceHash: source.sourceHash,
    acceptedRevisionId: null,
    requestHash,
    runner: buildRenderTreeRunner({
      session,
      caller,
      renderTree,
      model,
      references,
      referencePort,
      acceptedRevisionId,
      payload,
    }),
  });
  return mapOperationEnqueue(enqueued);
}

/**
 * Build the canonical Workbench MCP tool registry over one ProjectSession.
 * The registry owns no path, storage, credentials, or transport; it is a pure
 * session-bound adapter the authenticated transport consults.
 */
export function createProjectSessionMcpRegistry(
  session: ProjectSession,
  options: McpRegistryOptions = {},
): McpToolRegistry {
  const candidates: McpCandidatesSeam = options.candidates ?? {
    execute: (request, runtime) => executeEditorialCandidates(request, runtime),
    commit: (candidateSet, runtime) => commitEditorialCandidates(candidateSet, runtime),
  };
  const renderTree: McpRenderTreeFunction = options.renderTree ?? renderGameDialogueTree;
  const definitions: readonly McpToolDefinition[] = [
    {
      ...toolMetadata('nova_status'),
      run: async () => {
        const status = await buildWorkflowStatusForSession(session, {
          coordinator: options.coordinator,
          revision: options.revision,
          status: options.status,
          plugins: options.plugins,
          stateProjection: options.stateProjection,
          extensionRegistrar: options.extensionRegistrar,
        });
        return status === null ? NO_ACCEPTED_SOURCE : mcpToolOk(status);
      },
    },
    {
      ...toolMetadata('nova_validate'),
      run: async () => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        return serializeValidation(
          source,
          options.extensionRegistrar === undefined
            ? undefined
            : { extensionRegistrar: options.extensionRegistrar },
        );
      },
    },
    {
      ...toolMetadata('nova_source_list'),
      run: async () => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        return mcpToolOk(listSourceDocuments(source));
      },
    },
    {
      ...toolMetadata('nova_source_get'),
      run: async (_caller, input) => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const unknown = rejectUnknownKeys(parsed.value, ['logicalPath']);
        if (unknown) return unknown;
        const logicalPath = requiredString(parsed.value, 'logicalPath');
        if (!logicalPath.ok) return logicalPath.result;
        try {
          return mcpToolOk(getSourceDocument(source, logicalPath.value));
        } catch (error) {
          const isNotFound =
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'SOURCE_DOCUMENT_NOT_FOUND';
          return mcpToolError(
            isNotFound ? 'SOURCE_DOCUMENT_NOT_FOUND' : 'INTERNAL_ERROR',
            sanitizeError(error),
          );
        }
      },
    },
    {
      ...toolMetadata('nova_source_preview'),
      run: async (_caller, input) => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const unknown = rejectUnknownKeys(parsed.value, ['changes']);
        if (unknown) return unknown;
        if (!Array.isArray(parsed.value.changes)) {
          return invalidInput('changes must be an array.');
        }
        try {
          const changes = parsed.value.changes.map((change) => parseSourceChange(change));
          return mcpToolOk(previewSourceChange(source, changes));
        } catch (error) {
          return mcpToolError(
            error instanceof InputShapeError ? 'INVALID_INPUT' : 'INTERNAL_ERROR',
            error instanceof Error ? error.message : sanitizeError(error),
          );
        }
      },
    },
    {
      ...toolMetadata('nova_entity_get'),
      run: async (_caller, input) => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const unknown = rejectUnknownKeys(parsed.value, ['entityId']);
        if (unknown) return unknown;
        const entityId = requiredString(parsed.value, 'entityId');
        if (!entityId.ok) return entityId.result;
        return mcpToolOk(showEntity(source, entityId.value));
      },
    },
    {
      ...toolMetadata('nova_entity_list'),
      run: async (_caller, input) => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const unknown = rejectUnknownKeys(parsed.value, ['kind']);
        if (unknown) return unknown;
        let kind: string | undefined;
        try {
          kind = optionalString(parsed.value, 'kind');
        } catch (error) {
          return mcpToolError('INVALID_INPUT', (error as Error).message);
        }
        return mcpToolOk(listEntities(source, kind));
      },
    },
    {
      ...toolMetadata('nova_graph'),
      run: async (_caller, input) => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const selector = parseRouteSelector(parsed.value);
        if (!selector.ok) return selector.result;
        return mcpToolOk(projectCanonicalGraphRuntime(source, selector.value));
      },
    },
    {
      ...toolMetadata('nova_render'),
      run: async (caller, input) => {
        const parsed = parseRenderInput(input, caller, options);
        if (!parsed.ok) return parsed.result;
        return enqueueRenderSurfaceOperation({
          session,
          caller,
          operations: options.operations,
          candidates,
          kind: 'render',
          selector: parsed.value.selector,
          model: parsed.value.model,
          references: parsed.value.references,
          referencePort: options.reference,
          acceptedRevisionId: acceptedRevisionIdFor(options),
        });
      },
    },
    {
      ...toolMetadata('nova_revise'),
      run: async (caller, input) => {
        const parsed = parseRenderInput(input, caller, options, ['instruction', 'reviewIds']);
        if (!parsed.ok) return parsed.result;
        const { selector, model, references, fields } = parsed.value;
        let instruction: string | undefined;
        if (fields.instruction !== undefined) {
          if (typeof fields.instruction !== 'string' || fields.instruction.length > 4096) {
            return invalidInput('instruction must be a string of at most 4096 characters.');
          }
          instruction = fields.instruction;
        }
        let reviewIds: readonly string[] | undefined;
        if (fields.reviewIds !== undefined) {
          const ids = fields.reviewIds;
          if (!Array.isArray(ids) || ids.length > 256) {
            return invalidInput('reviewIds must be an array of at most 256 review ids.');
          }
          if (!ids.every((entry) => typeof entry === 'string' && entry.length > 0)) {
            return invalidInput('each reviewIds entry must be a non-empty string.');
          }
          if (new Set(ids).size !== ids.length) {
            return invalidInput('reviewIds must not contain duplicates.');
          }
          reviewIds = ids;
        }
        const revision =
          instruction === undefined && reviewIds === undefined
            ? undefined
            : {
                ...(instruction === undefined ? {} : { instruction }),
                ...(reviewIds === undefined ? {} : { reviewIds }),
              };
        const operations = options.operations;
        return enqueueRenderSurfaceOperation({
          session,
          caller,
          operations,
          candidates,
          kind: 'revise',
          selector,
          model,
          references,
          revision,
          referencePort: options.reference,
          acceptedRevisionId: acceptedRevisionIdFor(options),
        });
      },
    },
    {
      ...toolMetadata('nova_render_tree'),
      run: async (caller, input) => {
        const parsed = parseRenderInput(input, caller, options);
        if (!parsed.ok) return parsed.result;
        return enqueueRenderTreeOperation({
          session,
          caller,
          operations: options.operations,
          renderTree,
          selector: parsed.value.selector,
          model: parsed.value.model,
          references: parsed.value.references,
          referencePort: options.reference,
          acceptedRevisionId: acceptedRevisionIdFor(options),
        });
      },
    },
    {
      ...toolMetadata('nova_reference_list'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'pageSize', 'cursor']);
        if (!parsed.ok) return parsed.result;
        const pageSize = referenceInteger(
          parsed.value,
          'pageSize',
          1,
          REFERENCE_MCP_LIMITS_V1.maxPageSize,
          false,
        );
        const cursor = referenceString(
          parsed.value,
          'cursor',
          REFERENCE_MCP_LIMITS_V1.maxCursorLength,
          false,
        );
        if (!pageSize.ok) return pageSize.result;
        if (!cursor.ok) return cursor.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.list({
          version: REFERENCE_MCP_CONTRACT_VERSION,
          ...(pageSize.value === undefined ? {} : { pageSize: pageSize.value }),
          ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
        });
        return mcpToolOk({
          version: REFERENCE_MCP_CONTRACT_VERSION,
          items: result.items.map(safeReferenceItem),
          nextCursor: result.nextCursor ?? null,
        });
      },
    },
    {
      ...toolMetadata('nova_reference_get'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'referenceId']);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(
          parsed.value,
          'referenceId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        if (!referenceId.ok) return referenceId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.get({
          version: 1,
          referenceId: requiredParsedValue(referenceId.value),
        });
        return result === null
          ? mcpToolError('REFERENCE_NOT_FOUND', 'The requested reference does not exist.')
          : mcpToolOk({ version: 1, item: safeReferenceItem(result.item) });
      },
    },
    {
      ...toolMetadata('nova_reference_search'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, [
          'version',
          'query',
          'pageSize',
          'cursor',
          'filters',
        ]);
        if (!parsed.ok) return parsed.result;
        const query = referenceString(
          parsed.value,
          'query',
          REFERENCE_MCP_LIMITS_V1.maxQueryLength,
        );
        const pageSize = referenceInteger(
          parsed.value,
          'pageSize',
          1,
          REFERENCE_MCP_LIMITS_V1.maxPageSize,
          false,
        );
        const cursor = referenceString(
          parsed.value,
          'cursor',
          REFERENCE_MCP_LIMITS_V1.maxCursorLength,
          false,
        );
        if (!query.ok) return query.result;
        if (!pageSize.ok) return pageSize.result;
        if (!cursor.ok) return cursor.result;
        let filters: McpReferenceSearchInputV1['filters'];
        if (parsed.value.filters !== undefined) {
          const filterRecord = parseObject(parsed.value.filters, 'filters must be an object.');
          if (!filterRecord.ok) return filterRecord.result;
          const unknown = rejectUnknownKeys(filterRecord.value, [
            'referenceId',
            'mediaType',
            'tag',
          ]);
          if (unknown) return unknown;
          const referenceId = referenceString(
            filterRecord.value,
            'referenceId',
            REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
            false,
          );
          const mediaType = referenceString(
            filterRecord.value,
            'mediaType',
            REFERENCE_MCP_LIMITS_V1.maxMediaTypeLength,
            false,
          );
          const tag = referenceString(
            filterRecord.value,
            'tag',
            REFERENCE_MCP_LIMITS_V1.maxTagLength,
            false,
          );
          if (!referenceId.ok) return referenceId.result;
          if (!mediaType.ok) return mediaType.result;
          if (!tag.ok) return tag.result;
          filters = {
            ...(referenceId.value === undefined ? {} : { referenceId: referenceId.value }),
            ...(mediaType.value === undefined ? {} : { mediaType: mediaType.value }),
            ...(tag.value === undefined ? {} : { tag: tag.value }),
          };
        }
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.search({
          version: 1,
          query: requiredParsedValue(query.value),
          ...(pageSize.value === undefined ? {} : { pageSize: pageSize.value }),
          ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
          ...(filters === undefined ? {} : { filters }),
        });
        return mcpToolOk({
          version: 1,
          items: result.items.map(safeReferenceItem),
          nextCursor: result.nextCursor ?? null,
        });
      },
    },
    {
      ...toolMetadata('nova_reference_chunk_get'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'referenceId', 'chunkId']);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(
          parsed.value,
          'referenceId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        const chunkId = referenceString(
          parsed.value,
          'chunkId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        if (!referenceId.ok) return referenceId.result;
        if (!chunkId.ok) return chunkId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.getChunk({
          version: 1,
          referenceId: requiredParsedValue(referenceId.value),
          chunkId: requiredParsedValue(chunkId.value),
        });
        return result === null
          ? mcpToolError(
              'REFERENCE_CHUNK_NOT_FOUND',
              'The requested reference chunk does not exist.',
            )
          : mcpToolOk({ version: 1, chunk: safeReferenceChunk(result.chunk) });
      },
    },
    {
      ...toolMetadata('nova_reference_content_read'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'referenceId', 'offset', 'limit']);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(
          parsed.value,
          'referenceId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        const offset = referenceInteger(
          parsed.value,
          'offset',
          0,
          REFERENCE_MCP_LIMITS_V1.maxOffset,
        );
        const limit = referenceInteger(
          parsed.value,
          'limit',
          1,
          REFERENCE_MCP_LIMITS_V1.maxRangeBytes,
        );
        if (!referenceId.ok) return referenceId.result;
        if (!offset.ok) return offset.result;
        if (!limit.ok) return limit.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.readContent({
          version: 1,
          referenceId: requiredParsedValue(referenceId.value),
          offset: requiredParsedValue(offset.value),
          limit: requiredParsedValue(limit.value),
        });
        return mcpToolOk({ version: 1, content: safeReferenceContent(result.content) });
      },
    },
    {
      ...toolMetadata('nova_reference_import_begin'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, [
          'version',
          'referenceId',
          'originalName',
          'displayName',
          'mediaType',
          'byteLength',
          'contentHash',
          'title',
          'authors',
          'sourceUrl',
          'license',
          'tags',
          'idempotencyKey',
        ]);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(
          parsed.value,
          'referenceId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        const originalName = referenceString(
          parsed.value,
          'originalName',
          REFERENCE_MCP_LIMITS_V1.maxNameLength,
        );
        const displayName = referenceString(
          parsed.value,
          'displayName',
          REFERENCE_MCP_LIMITS_V1.maxNameLength,
          false,
        );
        const mediaType = referenceString(
          parsed.value,
          'mediaType',
          REFERENCE_MCP_LIMITS_V1.maxMediaTypeLength,
        );
        const contentHash = referenceString(parsed.value, 'contentHash', 64);
        const idempotencyKey = referenceString(
          parsed.value,
          'idempotencyKey',
          REFERENCE_MCP_LIMITS_V1.maxIdempotencyKeyLength,
        );
        const byteLength = referenceInteger(
          parsed.value,
          'byteLength',
          0,
          REFERENCE_MCP_LIMITS_V1.maxReferenceBytes,
        );
        const title = referenceString(
          parsed.value,
          'title',
          REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength,
          false,
        );
        const sourceUrl = referenceString(
          parsed.value,
          'sourceUrl',
          REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength,
          false,
        );
        const license = referenceString(
          parsed.value,
          'license',
          REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength,
          false,
        );
        const authors = referenceStringList(
          parsed.value,
          'authors',
          REFERENCE_MCP_LIMITS_V1.maxAuthorLength,
          REFERENCE_MCP_LIMITS_V1.maxAuthorCount,
        );
        const tags = referenceStringList(
          parsed.value,
          'tags',
          REFERENCE_MCP_LIMITS_V1.maxTagLength,
          REFERENCE_MCP_LIMITS_V1.maxTagCount,
        );
        if (!referenceId.ok) return referenceId.result;
        if (!originalName.ok) return originalName.result;
        if (!displayName.ok) return displayName.result;
        if (!mediaType.ok) return mediaType.result;
        if (!contentHash.ok) return contentHash.result;
        if (!idempotencyKey.ok) return idempotencyKey.result;
        if (!byteLength.ok) return byteLength.result;
        if (!title.ok) return title.result;
        if (!sourceUrl.ok) return sourceUrl.result;
        if (!license.ok) return license.result;
        if (!authors.ok) return authors.result;
        if (!tags.ok) return tags.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.importBegin({
          version: 1,
          referenceId: requiredParsedValue(referenceId.value),
          originalName: requiredParsedValue(originalName.value),
          ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
          mediaType: requiredParsedValue(mediaType.value),
          byteLength: requiredParsedValue(byteLength.value),
          contentHash: requiredParsedValue(contentHash.value),
          ...(title.value === undefined ? {} : { title: title.value }),
          ...(authors.value === undefined ? {} : { authors: authors.value }),
          ...(sourceUrl.value === undefined ? {} : { sourceUrl: sourceUrl.value }),
          ...(license.value === undefined ? {} : { license: license.value }),
          ...(tags.value === undefined ? {} : { tags: tags.value }),
          idempotencyKey: requiredParsedValue(idempotencyKey.value),
        });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_import_chunk'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, [
          'version',
          'jobId',
          'offset',
          'byteLength',
          'chunkHash',
          'dataBase64',
        ]);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(
          parsed.value,
          'jobId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        const chunkHash = referenceString(parsed.value, 'chunkHash', 64);
        const dataBase64 = referenceString(
          parsed.value,
          'dataBase64',
          REFERENCE_MCP_LIMITS_V1.maxChunkBase64Length,
        );
        const offset = referenceInteger(
          parsed.value,
          'offset',
          0,
          REFERENCE_MCP_LIMITS_V1.maxOffset,
        );
        const byteLength = referenceInteger(
          parsed.value,
          'byteLength',
          1,
          REFERENCE_MCP_LIMITS_V1.maxChunkBytes,
        );
        if (!jobId.ok) return jobId.result;
        if (!chunkHash.ok) return chunkHash.result;
        if (!dataBase64.ok) return dataBase64.result;
        if (!offset.ok) return offset.result;
        if (!byteLength.ok) return byteLength.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.importChunk({
          version: 1,
          jobId: requiredParsedValue(jobId.value),
          offset: requiredParsedValue(offset.value),
          byteLength: requiredParsedValue(byteLength.value),
          chunkHash: requiredParsedValue(chunkHash.value),
          dataBase64: requiredParsedValue(dataBase64.value),
        });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_import_commit'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'jobId', 'contentHash']);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(
          parsed.value,
          'jobId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        const contentHash = referenceString(parsed.value, 'contentHash', 64);
        if (!jobId.ok) return jobId.result;
        if (!contentHash.ok) return contentHash.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.importCommit({
          version: 1,
          jobId: requiredParsedValue(jobId.value),
          contentHash: requiredParsedValue(contentHash.value),
        });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_job_get'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'jobId']);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(
          parsed.value,
          'jobId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        if (!jobId.ok) return jobId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.jobGet({
          version: 1,
          jobId: requiredParsedValue(jobId.value),
        });
        return result === null
          ? mcpToolError('REFERENCE_JOB_NOT_FOUND', 'The requested reference job does not exist.')
          : mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_retry'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'jobId']);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(
          parsed.value,
          'jobId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        if (!jobId.ok) return jobId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.retry({
          version: 1,
          jobId: requiredParsedValue(jobId.value),
        });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_delete'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'referenceId']);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(
          parsed.value,
          'referenceId',
          REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength,
        );
        if (!referenceId.ok) return referenceId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.delete({
          version: 1,
          referenceId: requiredParsedValue(referenceId.value),
        });
        return mcpToolOk({
          version: 1,
          job: safeReferenceJob(result.job),
          deletedReferenceId: result.deletedReferenceId,
        });
      },
    },
    {
      ...toolMetadata('nova_authoring_document_list'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.listDocuments === undefined) return NO_AUTHORING_COORDINATOR;
        const result = await coordinator.listDocuments({ version: AUTHORING_CONTRACT_VERSION });
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_status'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const state = coordinator.getState();
        const output: McpAuthoringStatusOutputV1 = {
          version: AUTHORING_CONTRACT_VERSION,
          projectId: session.projectId,
          state,
          nextWorkingAction: authoringNextWorkingAction(state),
          generatedAt: state.generatedAt,
        };
        return mcpToolOk(output);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_read'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'documentId', 'offset', 'limit']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.readDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const documentId = requiredString(parsed.value, 'documentId');
        if (!documentId.ok) return documentId.result;
        const offset = parsed.value.offset;
        const limit = parsed.value.limit;
        if (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 0))
          return invalidInput('offset must be a non-negative integer.');
        if (
          limit !== undefined &&
          (!Number.isInteger(limit) ||
            (limit as number) < 1 ||
            (limit as number) > AUTHORING_DOCUMENT_LIMITS_V1.maxReadCharacters)
        )
          return invalidInput('limit is outside the bounded read range.');
        const result = await coordinator.readDocument({
          version: AUTHORING_CONTRACT_VERSION,
          documentId: documentId.value,
          ...(offset === undefined ? {} : { offset: offset as number }),
          ...(limit === undefined ? {} : { limit: limit as number }),
        });
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_edit'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'documentId',
          'expectedWorkspaceDigest',
          'expectedAcceptedSourceHash',
          'expectedStateVectorHash',
          'replacementText',
          'edits',
        ]);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.editDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const documentId = requiredString(parsed.value, 'documentId');
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        const vector = requiredString(parsed.value, 'expectedStateVectorHash');
        if (!documentId.ok) return documentId.result;
        if (!digest.ok) return digest.result;
        if (!vector.ok) return vector.result;
        const expectedAccepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!expectedAccepted.ok) return expectedAccepted.result;
        const replacement = parsed.value.replacementText;
        const editsValue = parsed.value.edits;
        if ((replacement === undefined) === (editsValue === undefined))
          return invalidInput('Provide exactly one of replacementText or edits.');
        if (
          replacement !== undefined &&
          (typeof replacement !== 'string' ||
            new TextEncoder().encode(replacement).byteLength >
              AUTHORING_DOCUMENT_LIMITS_V1.maxEditBytes)
        )
          return invalidInput('replacementText exceeds the edit limit.');
        let edits:
          | Array<{
              readonly start: number;
              readonly end: number;
              readonly replacementText: string;
            }>
          | undefined;
        if (editsValue !== undefined) {
          if (!Array.isArray(editsValue) || editsValue.length === 0)
            return invalidInput('edits must be a non-empty array.');
          let previousEnd = 0;
          let bytes = 0;
          edits = [];
          for (const raw of editsValue) {
            const item = parseObject(raw, 'each edit must be an object.');
            if (!item.ok) return item.result;
            const unknown = rejectUnknownKeys(item.value, ['start', 'end', 'replacementText']);
            if (unknown) return unknown;
            const start = item.value.start;
            const end = item.value.end;
            const text = item.value.replacementText;
            if (
              !Number.isInteger(start) ||
              !Number.isInteger(end) ||
              (start as number) < previousEnd ||
              (end as number) < (start as number) ||
              typeof text !== 'string'
            )
              return invalidInput('edits must be sorted, non-overlapping spans.');
            bytes += new TextEncoder().encode(text).byteLength;
            if (bytes > AUTHORING_DOCUMENT_LIMITS_V1.maxEditBytes)
              return invalidInput('edits exceed the edit limit.');
            previousEnd = end as number;
            edits.push({ start: start as number, end: end as number, replacementText: text });
          }
        }
        const result = await coordinator.editDocument(
          {
            version: AUTHORING_CONTRACT_VERSION,
            documentId: documentId.value,
            expectedWorkspaceDigest: digest.value,
            expectedAcceptedSourceHash: expectedAccepted.value,
            expectedStateVectorHash: vector.value,
            ...(replacement === undefined ? {} : { replacementText: replacement as string }),
            ...(edits === undefined ? {} : { edits }),
          },
          caller,
        );
        return authoringApplyResult(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_create'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'logicalPath',
          'kind',
          'expectedWorkspaceDigest',
          'expectedAcceptedSourceHash',
        ]);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.createDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const path = requiredString(parsed.value, 'logicalPath');
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!path.ok) return path.result;
        if (!digest.ok) return digest.result;
        const accepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!accepted.ok) return accepted.result;
        const kind = parsed.value.kind;
        if (kind !== undefined && kind !== 'prose' && kind !== 'raw-yaml')
          return invalidInput('kind must be prose or raw-yaml.');
        const result = await coordinator.createDocument(
          {
            version: AUTHORING_CONTRACT_VERSION,
            logicalPath: path.value,
            expectedWorkspaceDigest: digest.value,
            expectedAcceptedSourceHash: accepted.value,
            ...(kind === undefined ? {} : { kind }),
          },
          caller,
        );
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_move'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'documentId',
          'logicalPath',
          'expectedWorkspaceDigest',
          'expectedAcceptedSourceHash',
        ]);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.moveDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const id = requiredString(parsed.value, 'documentId');
        const path = requiredString(parsed.value, 'logicalPath');
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!id.ok) return id.result;
        if (!path.ok) return path.result;
        if (!digest.ok) return digest.result;
        const accepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!accepted.ok) return accepted.result;
        const result = await coordinator.moveDocument(
          {
            version: AUTHORING_CONTRACT_VERSION,
            documentId: id.value,
            logicalPath: path.value,
            expectedWorkspaceDigest: digest.value,
            expectedAcceptedSourceHash: accepted.value,
          },
          caller,
        );
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_delete'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'documentId',
          'expectedWorkspaceDigest',
          'expectedAcceptedSourceHash',
        ]);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.deleteDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const id = requiredString(parsed.value, 'documentId');
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!id.ok) return id.result;
        if (!digest.ok) return digest.result;
        const accepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!accepted.ok) return accepted.result;
        const result = await coordinator.deleteDocument(
          {
            version: AUTHORING_CONTRACT_VERSION,
            documentId: id.value,
            expectedWorkspaceDigest: digest.value,
            expectedAcceptedSourceHash: accepted.value,
          },
          caller,
        );
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_validate'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'expectedWorkspaceDigest',
          'expectedAcceptedSourceHash',
        ]);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!digest.ok) return digest.result;
        const accepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!accepted.ok) return accepted.result;
        try {
          return mcpToolOk(
            await coordinator.validateWorking({
              expectedWorkspaceDigest: digest.value,
              expectedAcceptedSourceHash: accepted.value,
            }),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            typeof (error as { readonly code?: unknown }).code === 'string'
          ) {
            return mcpToolError((error as { readonly code: string }).code, error.message);
          }
          return mcpToolError('INTERNAL_ERROR', sanitizeError(error));
        }
      },
    },
    {
      ...toolMetadata('nova_authoring_submit'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, ['version', 'expectedWorkspaceDigest', 'message']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!digest.ok) return digest.result;
        let message: string | undefined;
        try {
          message = optionalString(parsed.value, 'message');
        } catch (error) {
          return mcpToolError('INVALID_INPUT', (error as Error).message);
        }
        if (message !== undefined && message.length > 4096) {
          return invalidInput('message must be at most 4096 characters.');
        }
        const request: McpAuthoringSubmitInputV1 = {
          version: AUTHORING_CONTRACT_VERSION,
          projectId: session.projectId,
          expectedWorkspaceDigest: digest.value,
          ...(message !== undefined ? { message } : {}),
        };
        return authoringAsyncResult(await coordinator.submit(request, caller));
      },
    },
    {
      ...toolMetadata('nova_operation_get'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'operationHandle']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const operationHandle = requiredString(parsed.value, 'operationHandle');
        if (!operationHandle.ok) return operationHandle.result;
        const request: McpOperationGetInputV1 = {
          version: AUTHORING_CONTRACT_VERSION,
          operationId: operationHandle.value,
        };
        return mcpToolOk(await coordinator.getOperation(request));
      },
    },
    {
      ...toolMetadata('nova_operation_cancel'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'operationHandle']);
        if (!parsed.ok) return parsed.result;
        const operations = options.operations;
        if (operations === undefined) return NO_OPERATION_SERVICE;
        const operationHandle = requiredString(parsed.value, 'operationHandle');
        if (!operationHandle.ok) return operationHandle.result;
        const result = await operations.cancel(operationHandle.value);
        if (result.status === 'not-found') {
          return mcpToolError(
            'OPERATION_NOT_FOUND',
            `No operation "${operationHandle.value}" exists for this project.`,
          );
        }
        return mcpToolOk({
          version: AUTHORING_CONTRACT_VERSION,
          operationId: operationHandle.value,
          status: result.record.status,
        });
      },
    },
    {
      ...toolMetadata('nova_authoring_conflict_read'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined || coordinator.readConflict === undefined) {
          return NO_AUTHORING_COORDINATOR;
        }
        return mcpToolOk(await coordinator.readConflict({ version: AUTHORING_CONTRACT_VERSION }));
      },
    },
    {
      ...toolMetadata('nova_conflict_resolve'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, ['version', 'choice', 'candidateHash']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const choice = parsed.value.choice;
        if (
          choice !== 'keep-working' &&
          choice !== 'accept-external' &&
          choice !== 'apply-proposed-disjoint-merge'
        ) {
          return invalidInput(
            'choice must be keep-working, accept-external, or apply-proposed-disjoint-merge.',
          );
        }
        const candidateHash = nullableStringField(parsed.value, 'candidateHash');
        if (!candidateHash.ok) return candidateHash.result;
        const request: McpConflictResolveInputV1 = {
          version: AUTHORING_CONTRACT_VERSION,
          projectId: session.projectId,
          choice,
          candidateHash: candidateHash.value,
        };
        return authoringAsyncResult(await coordinator.resolveConflict(request, caller));
      },
    },
    {
      ...toolMetadata('nova_revision_list'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'cursor']);
        if (!parsed.ok) return parsed.result;
        const revision = options.revision;
        if (revision === undefined) return NO_AUTHORING_COORDINATOR;
        let cursor: string | undefined;
        try {
          cursor = optionalString(parsed.value, 'cursor');
        } catch (error) {
          return invalidInput(error instanceof Error ? error.message : 'cursor must be a string.');
        }
        return mcpToolOk({
          version: AUTHORING_CONTRACT_VERSION,
          ...(await revision.list(session.projectId, cursor)),
        });
      },
    },
    {
      ...toolMetadata('nova_revision_get'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'revisionId']);
        if (!parsed.ok) return parsed.result;
        const revision = options.revision;
        if (revision === undefined) return NO_AUTHORING_COORDINATOR;
        const revisionId = requiredString(parsed.value, 'revisionId');
        if (!revisionId.ok) return revisionId.result;
        const record = await revision.get(session.projectId, revisionId.value);
        return record === null
          ? mcpToolError('REVISION_NOT_FOUND', 'The requested native revision does not exist.')
          : mcpToolOk({ version: AUTHORING_CONTRACT_VERSION, revision: record });
      },
    },
    {
      ...toolMetadata('nova_revision_diff'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'fromRevisionId', 'toRevisionId']);
        if (!parsed.ok) return parsed.result;
        const revision = options.revision;
        if (revision === undefined) return NO_AUTHORING_COORDINATOR;
        const from = requiredString(parsed.value, 'fromRevisionId');
        const to = requiredString(parsed.value, 'toRevisionId');
        if (!from.ok) return from.result;
        if (!to.ok) return to.result;
        return mcpToolOk({
          version: AUTHORING_CONTRACT_VERSION,
          ...(await revision.diff(session.projectId, from.value, to.value)),
        });
      },
    },
    {
      ...toolMetadata('nova_event_state_diff'),
      run: async (_caller, input) => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const unknown = rejectUnknownKeys(parsed.value, ['eventId']);
        if (unknown) return unknown;
        const eventId = requiredString(parsed.value, 'eventId');
        if (!eventId.ok) return eventId.result;
        // Plan 8.4: read through the per-source/route projection service when
        // wired (nearest verified snapshot → suffix, full-replay fallback);
        // the raw `diffEvent` compile stays as the fallback when the service
        // is unavailable. The service is a derived cache, never a second
        // authority — its per-event states are pinned to the full canonical
        // replay by the state-projection equivalence gate.
        const projection = options.stateProjection;
        const diff =
          projection === undefined
            ? diffEvent(source, eventId.value)
            : await projection.diff(source, eventId.value);
        if (diff === null) {
          return mcpToolError(
            'EVENT_NOT_FOUND',
            `The event "${eventId.value}" is not present in the accepted source.`,
          );
        }
        return mcpToolOk({
          eventId: eventId.value,
          before: diff.before,
          after: diff.after,
          changed: diff.changed,
        });
      },
    },
    {
      ...toolMetadata('nova_revision_restore'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'revisionId',
          'expectedAcceptedRevisionId',
          'expectedSourceHash',
        ]);
        if (!parsed.ok) return parsed.result;
        const revision = options.revision;
        if (revision === undefined) return NO_AUTHORING_COORDINATOR;
        const revisionId = requiredString(parsed.value, 'revisionId');
        if (!revisionId.ok) return revisionId.result;
        const expectedRevision =
          parsed.value.expectedAcceptedRevisionId === undefined
            ? { ok: true as const, value: null }
            : nullableStringField(parsed.value, 'expectedAcceptedRevisionId');
        const expectedSource =
          parsed.value.expectedSourceHash === undefined
            ? { ok: true as const, value: null }
            : nullableStringField(parsed.value, 'expectedSourceHash');
        if (!expectedRevision.ok) return expectedRevision.result;
        if (!expectedSource.ok) return expectedSource.result;
        return nativeRevisionResult(
          await revision.restore({
            projectId: session.projectId,
            revisionId: revisionId.value,
            expectedAcceptedRevisionId: expectedRevision.value,
            expectedSourceHash: expectedSource.value,
            operationId: `mcp-revision-restore-${randomUUID()}`,
            actorId: caller.userId,
          }),
          AUTHORING_CONTRACT_VERSION,
        );
      },
    },
    {
      ...toolMetadata('nova_review_list'),
      run: async (_caller, input) => {
        const parsed = parseReviewInput(input, [
          'version',
          'status',
          'severity',
          'targetType',
          'targetId',
          'eventId',
        ]);
        if (!parsed.ok) return parsed.result;
        const review = options.review;
        if (review === undefined) return NO_REVIEW_SERVICE;
        const status = reviewOptionalEnum(parsed.value, 'status', REVIEW_COMMENT_STATUSES);
        const severity = reviewOptionalEnum(parsed.value, 'severity', REVIEW_SEVERITIES);
        const targetType = reviewOptionalEnum(parsed.value, 'targetType', REVIEW_TARGET_TYPES);
        const targetId = reviewOptionalString(parsed.value, 'targetId', 4096);
        const eventId = reviewOptionalString(parsed.value, 'eventId', 4096);
        if (!status.ok) return status.result;
        if (!severity.ok) return severity.result;
        if (!targetType.ok) return targetType.result;
        if (!targetId.ok) return targetId.result;
        if (!eventId.ok) return eventId.result;
        const comments = await review.listComments({
          ...(status.value === undefined
            ? {}
            : { status: status.value as HostReviewCommentV1['status'] }),
          ...(severity.value === undefined
            ? {}
            : { severity: severity.value as HostReviewCommentV1['severity'] }),
          ...(targetType.value === undefined ? {} : { targetType: targetType.value }),
          ...(targetId.value === undefined ? {} : { targetId: targetId.value }),
          ...(eventId.value === undefined ? {} : { eventId: eventId.value }),
        });
        return mcpToolOk({ version: 1, items: comments.map(safeReviewComment) });
      },
    },
    {
      ...toolMetadata('nova_review_get'),
      run: async (_caller, input) => {
        const parsed = parseReviewInput(input, ['version', 'commentId']);
        if (!parsed.ok) return parsed.result;
        const review = options.review;
        if (review === undefined) return NO_REVIEW_SERVICE;
        const commentId = requiredString(parsed.value, 'commentId');
        if (!commentId.ok) return commentId.result;
        const comment = await review.getComment(commentId.value);
        return mcpToolOk({
          version: 1,
          comment: comment === null ? null : safeReviewComment(comment),
        });
      },
    },
    {
      ...toolMetadata('nova_review_add'),
      run: async (caller, input) => {
        const parsed = parseReviewInput(input, [
          'version',
          'target',
          'severity',
          'category',
          'content',
        ]);
        if (!parsed.ok) return parsed.result;
        const review = options.review;
        if (review === undefined) return NO_REVIEW_SERVICE;
        const target = parseReviewTarget(parsed.value);
        if (!target.ok) return target.result;
        const severity = reviewOptionalEnum(parsed.value, 'severity', REVIEW_SEVERITIES);
        const category = reviewOptionalEnum(parsed.value, 'category', REVIEW_CATEGORIES);
        if (!severity.ok) return severity.result;
        if (!category.ok) return category.result;
        if (severity.value === undefined || category.value === undefined) {
          return invalidInput('severity and category are required for a new comment.');
        }
        const content = requiredString(parsed.value, 'content');
        if (!content.ok) return content.result;
        if (content.value.length > 65536) {
          return invalidInput('content must be a string of at most 65536 characters.');
        }
        try {
          const comment = await review.addComment(
            {
              target: target.value,
              severity: severity.value as HostNewReviewCommentV1['severity'],
              category: category.value as HostNewReviewCommentV1['category'],
              content: content.value,
            },
            caller,
          );
          return mcpToolOk({ version: 1, comment: safeReviewComment(comment) });
        } catch (error) {
          return reviewErrorResult(error);
        }
      },
    },
    {
      ...toolMetadata('nova_review_update'),
      run: async (caller, input) => {
        const parsed = parseReviewInput(input, [
          'version',
          'commentId',
          'action',
          'target',
          'severity',
          'category',
          'content',
        ]);
        if (!parsed.ok) return parsed.result;
        const review = options.review;
        if (review === undefined) return NO_REVIEW_SERVICE;
        const commentId = requiredString(parsed.value, 'commentId');
        if (!commentId.ok) return commentId.result;
        const action = reviewOptionalEnum(parsed.value, 'action', REVIEW_UPDATE_ACTIONS);
        if (!action.ok) return action.result;
        if (action.value === undefined) {
          return invalidInput('action is required for a comment update.');
        }
        let update: McpReviewCommentUpdateV1;
        if (action.value === 'replace') {
          const target = parseReviewTarget(parsed.value);
          if (!target.ok) return target.result;
          const severity = reviewOptionalEnum(parsed.value, 'severity', REVIEW_SEVERITIES);
          const category = reviewOptionalEnum(parsed.value, 'category', REVIEW_CATEGORIES);
          if (!severity.ok) return severity.result;
          if (!category.ok) return category.result;
          if (severity.value === undefined || category.value === undefined) {
            return invalidInput('replace requires target, severity, category, and content.');
          }
          const content = requiredString(parsed.value, 'content');
          if (!content.ok) return content.result;
          if (content.value.length > 65536) {
            return invalidInput('content must be a string of at most 65536 characters.');
          }
          update = {
            action: 'replace',
            commentId: commentId.value,
            input: {
              target: target.value,
              severity: severity.value as HostNewReviewCommentV1['severity'],
              category: category.value as HostNewReviewCommentV1['category'],
              content: content.value,
            },
          };
        } else {
          update = {
            action: action.value as 'resolve' | 'wontfix' | 'reopen' | 'escalate',
            commentId: commentId.value,
          };
        }
        try {
          const comment = await review.updateComment(update, caller);
          return mcpToolOk({ version: 1, comment: safeReviewComment(comment) });
        } catch (error) {
          return reviewErrorResult(error);
        }
      },
    },
    {
      ...toolMetadata('nova_release_gate_list'),
      run: async (_caller, input) => {
        const parsed = parseReviewInput(input, ['version', 'eventId']);
        if (!parsed.ok) return parsed.result;
        const review = options.review;
        if (review === undefined) return NO_REVIEW_SERVICE;
        const eventId = reviewOptionalString(parsed.value, 'eventId', 4096);
        if (!eventId.ok) return eventId.result;
        const gates = await review.listGates(eventId.value);
        return mcpToolOk({ version: 1, items: gates.map(safeReviewGate) });
      },
    },
    {
      ...toolMetadata('nova_release_gate_decide'),
      run: async (caller, input) => {
        const parsed = parseReviewInput(input, [
          'version',
          'eventId',
          'candidateRevisionId',
          'decision',
          'reason',
        ]);
        if (!parsed.ok) return parsed.result;
        const review = options.review;
        if (review === undefined) return NO_REVIEW_SERVICE;
        const eventId = requiredString(parsed.value, 'eventId');
        if (!eventId.ok) return eventId.result;
        const candidateRevisionId = requiredString(parsed.value, 'candidateRevisionId');
        if (!candidateRevisionId.ok) return candidateRevisionId.result;
        const decision = reviewOptionalEnum(parsed.value, 'decision', ['accept', 'reject']);
        if (!decision.ok) return decision.result;
        if (decision.value === undefined) {
          return invalidInput('decision must be accept or reject.');
        }
        const reason = requiredString(parsed.value, 'reason');
        if (!reason.ok) return reason.result;
        if (reason.value.length > 4096) {
          return invalidInput('reason must be a string of at most 4096 characters.');
        }
        try {
          const resolution = await review.decideGate(
            {
              eventId: eventId.value,
              candidateRevisionId: candidateRevisionId.value,
              decision: decision.value as 'accept' | 'reject',
              reason: reason.value,
            },
            caller,
          );
          return mcpToolOk({ version: 1, resolution });
        } catch (error) {
          return reviewErrorResult(error);
        }
      },
    },
    {
      ...toolMetadata('nova_publish'),
      run: async (caller, input) => {
        const parsed = parsePublicationVersionedInput(input, [
          'version',
          'branchPath',
          'discourseBranch',
          'title',
        ]);
        if (!parsed.ok) return parsed.result;
        const publication = options.publication;
        if (publication === undefined) return NO_PUBLICATION_SERVICE;
        if (session.source === null) return NO_ACCEPTED_SOURCE;
        const request = parsePublishRequest(parsed.value);
        if (!request.ok) return request.result;
        try {
          const result = await publication.publish(request.value, caller);
          return mapOperationEnqueue(result.enqueue);
        } catch (error) {
          return publicationErrorResult(error);
        }
      },
    },
    {
      ...toolMetadata('nova_publication_get'),
      run: async (_caller, input) => {
        const parsed = parsePublicationVersionedInput(input, ['version', 'publicationId']);
        if (!parsed.ok) return parsed.result;
        const publication = options.publication;
        if (publication === undefined) return NO_PUBLICATION_SERVICE;
        const publicationId = parsePublicationId(parsed.value);
        if (!publicationId.ok) return publicationId.result;
        const record = await publication.get(publicationId.value);
        return mcpToolOk({
          version: 1,
          publication: record === null ? null : safePublicationRecord(record),
        });
      },
    },
    {
      ...toolMetadata('nova_publication_read'),
      run: async (_caller, input) => {
        const parsed = parsePublicationVersionedInput(input, [
          'version',
          'publicationId',
          'offset',
          'limit',
        ]);
        if (!parsed.ok) return parsed.result;
        const publication = options.publication;
        if (publication === undefined) return NO_PUBLICATION_SERVICE;
        const publicationId = parsePublicationId(parsed.value);
        if (!publicationId.ok) return publicationId.result;
        const offset = parsed.value.offset;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
          return invalidInput('offset must be a non-negative integer.');
        }
        const limit = parsed.value.limit;
        if (
          typeof limit !== 'number' ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > PUBLICATION_MAX_READ_BYTES
        ) {
          return invalidInput(
            `limit must be an integer between 1 and ${PUBLICATION_MAX_READ_BYTES}.`,
          );
        }
        try {
          const result = await publication.read(publicationId.value, offset, limit);
          return mcpToolOk({ version: 1, ...result });
        } catch (error) {
          return publicationErrorResult(error);
        }
      },
    },
    {
      ...toolMetadata('nova_admin_config_get'),
      run: async (_caller, input) => {
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const unknown = rejectUnknownKeys(parsed.value, []);
        if (unknown) return unknown;
        const admin = options.admin;
        if (admin?.get === undefined) return NO_ADMIN_CONFIGURATION;
        return mcpToolOk(await admin.get({ version: 1 }));
      },
    },
    {
      ...toolMetadata('nova_admin_project_list'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version']);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectList;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method({ version: 1 }));
      },
    },
    {
      ...toolMetadata('nova_admin_project_validate'),
      run: async (_caller, input) => {
        const parsed = parseAdminProjectSave(input);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectValidate;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method(parsed.value));
      },
    },
    {
      ...toolMetadata('nova_admin_project_create'),
      run: async (_caller, input) => {
        const parsed = parseAdminProjectSave(input);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectCreate;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method(parsed.value));
      },
    },
    {
      ...toolMetadata('nova_admin_project_update'),
      run: async (_caller, input) => {
        const parsed = parseAdminProjectSave(input);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectUpdate;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method(parsed.value));
      },
    },
    {
      ...toolMetadata('nova_admin_project_delete'),
      run: async (_caller, input) => {
        const parsed = parseAdminProjectId(input);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectDelete;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method(parsed.value));
      },
    },
    {
      ...toolMetadata('nova_admin_project_open'),
      run: async (_caller, input) => {
        const parsed = parseAdminProjectId(input);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectOpen;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method(parsed.value));
      },
    },
    {
      ...toolMetadata('nova_admin_project_close'),
      run: async (_caller, input) => {
        const parsed = parseAdminProjectId(input);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectClose;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method(parsed.value));
      },
    },
    {
      ...toolMetadata('nova_admin_project_recover'),
      run: async (_caller, input) => {
        const parsed = parseAdminProjectId(input);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.projectRecover;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method(parsed.value));
      },
    },
    {
      ...toolMetadata('nova_admin_membership_list'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'projectId']);
        if (!parsed.ok) return parsed.result;
        const projectId = adminOptionalString(parsed.value, 'projectId');
        if (!projectId.ok) return projectId.result;
        const method = options.admin?.membershipList;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(
          await method({
            version: 1,
            ...(projectId.value === undefined ? {} : { projectId: projectId.value }),
          }),
        );
      },
    },
    {
      ...toolMetadata('nova_admin_membership_upsert'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'userId', 'projectId', 'role']);
        if (!parsed.ok) return parsed.result;
        const userId = adminString(parsed.value, 'userId');
        const projectId = adminString(parsed.value, 'projectId');
        const role = adminRole(parsed.value);
        if (!userId.ok) return userId.result;
        if (!projectId.ok) return projectId.result;
        if (!role.ok) return role.result;
        const method = options.admin?.membershipUpsert;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(
          await method({
            version: 1,
            userId: userId.value,
            projectId: projectId.value,
            role: role.value,
          }),
        );
      },
    },
    {
      ...toolMetadata('nova_admin_membership_revoke'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'userId', 'projectId']);
        if (!parsed.ok) return parsed.result;
        const userId = adminString(parsed.value, 'userId');
        const projectId = adminString(parsed.value, 'projectId');
        if (!userId.ok) return userId.result;
        if (!projectId.ok) return projectId.result;
        const method = options.admin?.membershipRevoke;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(
          await method({ version: 1, userId: userId.value, projectId: projectId.value }),
        );
      },
    },
    {
      ...toolMetadata('nova_admin_invite_list'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'projectId']);
        if (!parsed.ok) return parsed.result;
        const projectId = adminOptionalString(parsed.value, 'projectId');
        if (!projectId.ok) return projectId.result;
        const method = options.admin?.inviteList;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(
          await method({
            version: 1,
            ...(projectId.value === undefined ? {} : { projectId: projectId.value }),
          }),
        );
      },
    },
    {
      ...toolMetadata('nova_admin_invite_create'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'projectId', 'role', 'ttlMs']);
        if (!parsed.ok) return parsed.result;
        const projectId = adminString(parsed.value, 'projectId');
        const role = adminRole(parsed.value);
        const ttlMs = adminInteger(parsed.value, 'ttlMs', 1, 30 * 24 * 60 * 60 * 1000);
        if (!projectId.ok) return projectId.result;
        if (!role.ok) return role.result;
        if (!ttlMs.ok || ttlMs.value === undefined)
          return ttlMs.ok ? invalidInput('ttlMs is required.') : ttlMs.result;
        const method = options.admin?.inviteCreate;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(
          await method({
            version: 1,
            projectId: projectId.value,
            role: role.value,
            ttlMs: ttlMs.value,
          }),
        );
      },
    },
    {
      ...toolMetadata('nova_admin_invite_revoke'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'inviteId']);
        if (!parsed.ok) return parsed.result;
        const inviteId = adminString(parsed.value, 'inviteId');
        if (!inviteId.ok) return inviteId.result;
        const method = options.admin?.inviteRevoke;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method({ version: 1, inviteId: inviteId.value }));
      },
    },
    {
      ...toolMetadata('nova_admin_device_list'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version']);
        if (!parsed.ok) return parsed.result;
        const method = options.admin?.deviceList;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method({ version: 1 }));
      },
    },
    {
      ...toolMetadata('nova_admin_device_pair_begin'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, [
          'version',
          'kind',
          'projectId',
          'role',
          'ttlMs',
        ]);
        if (!parsed.ok) return parsed.result;
        const kind = parsed.value.kind;
        if (kind !== undefined && kind !== 'project' && kind !== 'admin')
          return invalidInput('kind must be project or admin.');
        const projectId = adminOptionalString(parsed.value, 'projectId');
        const role = adminOptionalRole(parsed.value);
        const ttlMs = adminInteger(parsed.value, 'ttlMs', 1, 30 * 24 * 60 * 60 * 1000, false);
        if (!projectId.ok) return projectId.result;
        if (!role.ok) return role.result;
        if (!ttlMs.ok) return ttlMs.result;
        const resolvedKind = kind ?? (projectId.value === undefined ? 'admin' : 'project');
        if (
          resolvedKind === 'admin' &&
          (projectId.value !== undefined || role.value !== undefined)
        ) {
          return invalidInput('admin device pairing cannot carry projectId or role.');
        }
        if (resolvedKind === 'project' && projectId.value === undefined) {
          return invalidInput('project device pairing requires projectId.');
        }
        const method = options.admin?.devicePairBegin;
        if (method === undefined) return NO_ADMIN_SERVICE;
        const result = await method({
          version: 1,
          kind: resolvedKind,
          ...(projectId.value === undefined ? {} : { projectId: projectId.value }),
          ...(role.value === undefined ? {} : { role: role.value }),
          ...(ttlMs.value === undefined ? {} : { ttlMs: ttlMs.value }),
        });
        if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
          const safe = { ...(result as Record<string, unknown>) };
          delete safe.pairingCode;
          delete safe.credential;
          delete safe.token;
          delete safe.tokenHash;
          return mcpToolOk(safe);
        }
        return mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_admin_device_revoke'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'deviceId']);
        if (!parsed.ok) return parsed.result;
        const deviceId = adminString(parsed.value, 'deviceId');
        if (!deviceId.ok) return deviceId.result;
        const method = options.admin?.deviceRevoke;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method({ version: 1, deviceId: deviceId.value }));
      },
    },
    {
      ...toolMetadata('nova_admin_operation_list'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'limit']);
        if (!parsed.ok) return parsed.result;
        const limit = adminInteger(parsed.value, 'limit', 1, 100, false);
        if (!limit.ok) return limit.result;
        const method = options.admin?.operationList;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(
          await method({
            version: 1,
            ...(limit.value === undefined ? {} : { limit: limit.value }),
          }),
        );
      },
    },
    {
      ...toolMetadata('nova_admin_operation_get'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'operationHandle']);
        if (!parsed.ok) return parsed.result;
        const operationHandle = adminString(parsed.value, 'operationHandle');
        if (!operationHandle.ok) return operationHandle.result;
        const method = options.admin?.operationGet;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method({ version: 1, operationHandle: operationHandle.value }));
      },
    },
    {
      // Trusted-plugin discovery (plan 7.7): name/version/moduleHash triples
      // for the plugins the Host found under one configured project root, so
      // the owner admin can build a trusted allowlist from real identities
      // only. Discovery makes no trust decision; activation/trust stays with
      // `activateNodePlugins`.
      ...toolMetadata('nova_admin_plugins_discovered'),
      run: async (_caller, input) => {
        const parsed = parseAdminVersionedInput(input, ['version', 'projectId']);
        if (!parsed.ok) return parsed.result;
        const projectId = adminString(parsed.value, 'projectId');
        if (!projectId.ok) return projectId.result;
        const method = options.admin?.pluginsDiscovered;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method({ version: 1, projectId: projectId.value }));
      },
    },
    {
      ...toolMetadata('nova_admin_config_preview'),
      run: async (_caller, input) => {
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const request = parseConfigChangeRequest(parsed.value);
        if (!request.ok) return request.result;
        const admin = options.admin;
        if (admin === undefined) return NO_ADMIN_CONFIGURATION;
        return mcpToolOk(await admin.preview(request.value));
      },
    },
    {
      ...toolMetadata('nova_admin_config_apply'),
      run: async (_caller, input) => {
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        const request = parseConfigChangeRequest(parsed.value);
        if (!request.ok) return request.result;
        const admin = options.admin;
        if (admin === undefined) return NO_ADMIN_CONFIGURATION;
        return mcpToolOk(await admin.apply(request.value));
      },
    },
  ];

  const selectedDefinitions = definitions.filter((definition) => {
    if (options.family === 'admin') return definition.name.startsWith('nova_admin_');
    if (options.family === 'project' && definition.name.startsWith('nova_admin_')) return false;
    return options.reference !== undefined || !definition.name.startsWith('nova_reference_');
  });
  const byName = new Map(selectedDefinitions.map((definition) => [definition.name, definition]));

  return {
    projectId: session.projectId,
    session,
    availableScopes: [
      ...new Set(selectedDefinitions.flatMap((definition) => definition.requiredScopes)),
    ],
    list(permittedScopes) {
      return selectedDefinitions.filter((definition) =>
        definition.requiredScopes.every((scope) => permittedScopes.includes(scope)),
      );
    },
    definitions() {
      return selectedDefinitions;
    },
    get(name) {
      return byName.get(name) ?? null;
    },
    async run(name, caller, input) {
      const definition = byName.get(name);
      if (!definition) {
        return mcpToolError('TOOL_NOT_FOUND', `Unknown tool: ${name}`);
      }
      if (!definition.requiredScopes.every((scope) => caller.grant.scopes.includes(scope))) {
        return mcpToolError(
          'SCOPE_MISMATCH',
          `The caller grant does not cover the scopes required by ${name}: ${definition.requiredScopes.join(', ')}.`,
        );
      }
      try {
        return await definition.run(caller, input);
      } catch (error) {
        return mcpToolError('INTERNAL_ERROR', sanitizeError(error));
      }
    },
  };
}

/** Build the admin-only descriptor registry; project tools are never listed. */
export function createAdminMcpRegistry(
  session: ProjectSession,
  options: Omit<McpRegistryOptions, 'family'> = {},
): McpToolRegistry {
  return createProjectSessionMcpRegistry(session, { ...options, family: 'admin' });
}
