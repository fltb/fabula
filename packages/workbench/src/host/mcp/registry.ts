/**
 * Host-only MCP tool registry bound to one open ProjectSession.
 *
 * Every tool derives its inputs exclusively from the session's accepted
 * `session.source` (never client-supplied paths) and, for effects, from the
 * session's serialized operation queue. Read tools (`mcp:read`) are pure
 * reads of the accepted source/projection; render (`mcp:render`) runs through
 * `session.enqueueOperation` with a server-derived operation id and actor id,
 * so no request field can impersonate an actor or reuse an operation id.
 *
 * Tool input schemas are plain JSON Schema objects — this module has no zod
 * dependency; the transport converts them at registration if needed.
 * Business errors are always returned as typed {@link McpToolResult} failures
 * (nonsecret), never thrown.
 */

import { randomUUID } from 'node:crypto';
import {
  getProjectStatus,
  type JsonValue,
  listEntities,
  type ProjectSourceSnapshotV1,
  sanitizeError,
  showEntity,
  validateNovel,
} from '@novalistically/core';
import {
  AUTHORING_DOCUMENT_LIMITS_V1,
  REFERENCE_MCP_LIMITS_V1,
  type McpJsonSchemaProperty,
  type McpJsonSchemaV1,
  MCP_TOOL_CATALOG_V1,
  type McpReferenceChunkGetInputV1,
  type McpReferenceContentReadInputV1,
  type McpReferenceDeleteInputV1,
  type McpReferenceGetInputV1,
  type McpReferenceImportBeginInputV1,
  type McpReferenceImportChunkInputV1,
  type McpReferenceImportCommitInputV1,
  type McpReferenceJobGetInputV1,
  type McpReferenceListInputV1,
  type McpReferencePort,
  type McpReferenceRetryInputV1,
  type McpReferenceSearchInputV1,
  type McpToolDescriptorV1,
  type ReferenceChunkV1,
  type ReferenceContentV1,
  type ReferenceItemV1,
  type ReferenceJobV1,
  type ReferenceRangeV1,
} from '@novalistically/workbench-protocol';
import {
  type EditorialRenderRequestV1,
  type EditorialRuntime,
  getSourceDocument,
  listSourceDocuments,
  previewSourceChange,
  type RenderNovelResult,
  renderNovel,
  type SceneSelector,
  type SourceChangeV1,
} from '@novalistically/core/editorial';
import {
  AUTHORING_CONTRACT_VERSION,
  type AuthoringStateV1,
  type AuthoringFailureV1,
  type McpAuthoringApplyInputV1,
  type McpAuthoringApplyOutputV1,
  type McpAuthoringDocumentGetInputV1,
  type McpAuthoringDocumentGetOutputV1,
  type McpAuthoringStatusInputV1,
  type McpAuthoringStatusOutputV1,
  type McpAuthoringSubmitInputV1,
  type McpAuthoringSubmitOutputV1,
  type McpConflictResolveInputV1,
  type McpConflictResolveOutputV1,
  type McpOperationGetInputV1,
  type McpOperationGetOutputV1,
  type McpAuthoringDocumentListInputV1,
  type McpAuthoringDocumentListOutputV1,
  type McpAuthoringDocumentReadInputV1,
  type McpAuthoringDocumentReadOutputV1,
  type McpAuthoringDocumentEditInputV1,
  type McpAuthoringDocumentCreateInputV1,
  type McpAuthoringDocumentMoveInputV1,
  type McpAuthoringDocumentDeleteInputV1,
  type McpAuthoringDocumentMutationOutputV1,
  type McpAuthoringConflictReadOutputV1,
} from '../../contracts/authoring.js';
import {
  PROJECT_ACCESS_ROLES,

  type ConfigChangeRequestV1,
  type ConfigOperationReceiptV1,
  type ProjectAccessRole,
  type WorkbenchConfigurationV1,
} from '../../contracts/configuration.js';

function coreProjectId(source: ProjectSourceSnapshotV1): string {
  const document = source.documents.find((entry) => entry.logicalPath === 'nova.yaml');
  const value =
    document?.parseResult.status === 'parsed' ? document.parseResult.value : undefined;
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'project' in value &&
    typeof value.project === 'string' &&
    value.project.length > 0
  ) {
    return value.project;
  }
  return 'default-project';
}
import type { AuthoringRevisionPort } from '../authoring/types.js';
import type { ProjectSession, SessionOperationResult } from '../project-session.js';
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
  if (scope === undefined) throw new Error(`MCP tool has no scope in the protocol catalog: ${name}`);
  return scope;
}

function toolMetadata(name: string): Pick<
  McpToolDefinition,
  'name' | 'description' | 'requiredScopes' | 'inputSchema'
> {
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
}

/** Injected render implementation; defaults to Core `renderNovel` over session services. */
export type McpRenderFunction = (
  request: EditorialRenderRequestV1,
  runtime: EditorialRuntime,
) => Promise<RenderNovelResult>;

export interface McpRegistryOptions {
  /** Render implementation seam; tests inject a recording stub. */
  /** Project-scoped reference catalog; absent tools fail closed. */
  readonly reference?: McpReferencePort;
  readonly render?: McpRenderFunction;
  /** Author/submit coordinator port; when absent the authoring tools fail closed. */
  readonly coordinator?: McpAuthoringCoordinatorPort;
  /** Native immutable revision service for this project; absent fails closed. */
  readonly revision?: AuthoringRevisionPort;
  /** Owner admin service ports; missing individual methods fail closed. */
  readonly admin?: McpAdminPort;
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

function boundedString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly result: McpToolResult } {
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
async function serializeValidation(snapshot: ProjectSourceSnapshotV1): Promise<McpToolResult> {
  const validation = await validateNovel(snapshot);
  // Object.fromEntries defines own data properties (CreateDataProperty), so an
  // event id like "__proto__" becomes real JSON data instead of a prototype
  // mutation; never copy into a plain `{}` with `results[key] = value`.
  const results = Object.fromEntries(validation.results);
  return mcpToolOk({ passed: validation.passed, iss: validation.iss, results });
}

// ─── Session operation outcome mapping ───────────────────────────────────────

function mapOperationResult<T>(result: SessionOperationResult<T>): McpToolResult {
  switch (result.status) {
    case 'completed':
      return mcpToolOk(result.result);
    case 'denied':
      return mcpToolError(
        `DENIED:${result.reason}`,
        `The session capability gate denied the render: ${result.reason}.`,
      );
    case 'failed':
      return mcpToolError(result.errorCode, result.message);
  }
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

function parseAdminVersionedInput(
  input: unknown,
  allowed: readonly string[],
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly result: McpToolResult } {
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
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly result: McpToolResult } {
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
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined) return { ok: true, value: undefined };
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maxLength) {
    return { ok: false, result: invalidInput(`${key} must be a bounded non-empty string when present.`) };
  }
  return { ok: true, value: candidate };
}

function adminRole(
  value: Record<string, unknown>,
  key = 'role',
): { readonly ok: true; readonly value: ProjectAccessRole } | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (typeof candidate !== 'string' || !(PROJECT_ACCESS_ROLES as readonly string[]).includes(candidate)) {
    return { ok: false, result: invalidInput(`${key} must be reader, author, or maintainer.`) };
  }
  return { ok: true, value: candidate as ProjectAccessRole };
}

function adminOptionalRole(
  value: Record<string, unknown>,
): { readonly ok: true; readonly value: ProjectAccessRole | undefined } | { readonly ok: false; readonly result: McpToolResult } {
  if (value.role === undefined) return { ok: true, value: undefined };
  return adminRole(value);
}

function adminInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  required = true,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly result: McpToolResult } {
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
): { readonly ok: true; readonly value: McpAdminProjectSaveInput } | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseAdminVersionedInput(input, ['version', 'projectId', 'displayName', 'root']);
  if (!parsed.ok) return parsed;
  const projectId = adminString(parsed.value, 'projectId');
  const displayName = adminString(parsed.value, 'displayName');
  const root = adminString(parsed.value, 'root');
  if (!projectId.ok) return projectId;
  if (!displayName.ok) return displayName;
  if (!root.ok) return root;
  return { ok: true, value: { version: 1, projectId: projectId.value, displayName: displayName.value, root: root.value } };
}

function parseAdminProjectId(
  input: unknown,
): { readonly ok: true; readonly value: McpAdminProjectIdInput } | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseAdminVersionedInput(input, ['version', 'projectId']);
  if (!parsed.ok) return parsed;
  const projectId = adminString(parsed.value, 'projectId');
  if (!projectId.ok) return projectId;
  return { ok: true, value: { version: 1, projectId: projectId.value } };
}
function parseToolInput(
  input: unknown,
  allowed: readonly string[],
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== AUTHORING_MCP_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput(`version must be ${AUTHORING_MCP_CONTRACT_VERSION}.`) };
  }
  return parsed;
}

function parseReferenceInput(
  input: unknown,
  allowed: readonly string[],
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== REFERENCE_MCP_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput(`version must be ${REFERENCE_MCP_CONTRACT_VERSION}.`) };
  }
  return parsed;
}

function referenceString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  required = true,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined && !required) return { ok: true, value: undefined };
  if (typeof candidate !== 'string' || (required && candidate.length === 0) || candidate.length > maxLength) {
    return { ok: false, result: invalidInput(`${key} must be ${required ? 'a non-empty ' : 'a '}string of at most ${maxLength} characters.`) };
  }
  return { ok: true, value: candidate };
}

function referenceInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  required = true,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined && !required) return { ok: true, value: undefined };
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    return { ok: false, result: invalidInput(`${key} must be an integer between ${minimum} and ${maximum}.`) };
  }
  return { ok: true, value: candidate };
}

function referenceStringList(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  maxCount: number,
): { readonly ok: true; readonly value: string[] | undefined } | { readonly ok: false; readonly result: McpToolResult } {
  const candidate = value[key];
  if (candidate === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(candidate) || candidate.length > maxCount) {
    return { ok: false, result: invalidInput(`${key} must be an array of at most ${maxCount} strings.`) };
  }
  if (!candidate.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= maxLength)) {
    return { ok: false, result: invalidInput(`${key} entries must be non-empty strings of at most ${maxLength} characters.`) };
  }
  return { ok: true, value: candidate as string[] };
}

function safeObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function safeText(value: unknown, label: string, allowNull = false): string | null {
  if ((value === null || value === undefined) && allowNull) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function safeHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeReferenceItem(value: unknown): ReferenceItemV1 {
  const item = safeObject(value, 'Reference item');
  const authors = item.authors;
  const tags = item.tags;
  if (!Array.isArray(authors) || !authors.every((entry) => typeof entry === 'string')) throw new Error('Reference authors are invalid');
  if (!Array.isArray(tags) || !tags.every((entry) => typeof entry === 'string')) throw new Error('Reference tags are invalid');
  const byteLength = item.byteLength;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > REFERENCE_MCP_LIMITS_V1.maxReferenceBytes) {
    throw new Error('Reference byteLength is invalid');
  }
  return {
    version: 1,
    referenceId: safeText(item.referenceId, 'referenceId')!,
    displayName: safeText(item.displayName, 'displayName')!,
    originalName: safeText(item.originalName, 'originalName')!,
    mediaType: safeText(item.mediaType, 'mediaType')!,
    contentHash: safeHash(item.contentHash, 'contentHash'),
    byteLength,
    title: safeText(item.title, 'title', true),
    authors: [...authors],
    sourceUrl: safeText(item.sourceUrl, 'sourceUrl', true),
    license: safeText(item.license, 'license', true),
    tags: [...tags],
    createdAt: safeText(item.createdAt, 'createdAt')!,
    updatedAt: safeText(item.updatedAt, 'updatedAt')!,
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
    jobId: safeText(job.jobId, 'jobId')!,
    operation: job.operation as ReferenceJobV1['operation'],
    status: job.status as ReferenceJobV1['status'],
    referenceId: safeText(job.referenceId, 'referenceId', true),
    bytesReceived: job.bytesReceived as number,
    totalBytes: job.totalBytes as number | null,
    contentHash: job.contentHash === null ? null : safeHash(job.contentHash, 'contentHash'),
    errorCode: safeText(job.errorCode, 'errorCode', true),
    errorMessage: redactPath(message),
    createdAt: safeText(job.createdAt, 'createdAt')!,
    updatedAt: safeText(job.updatedAt, 'updatedAt')!,
  };
}

function safeReferenceRange(value: unknown): ReferenceRangeV1 {
  const range = safeObject(value, 'Reference range');
  if (typeof range.offset !== 'number' || typeof range.length !== 'number') throw new Error('Reference range is invalid');
  return { version: 1, offset: range.offset, length: range.length };
}

function safeReferenceContent(value: unknown): ReferenceContentV1 {
  const content = safeObject(value, 'Reference content');
  const dataBase64 = safeText(content.dataBase64, 'dataBase64')!;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) || dataBase64.length > REFERENCE_MCP_LIMITS_V1.maxChunkBase64Length) {
    throw new Error('Reference content encoding is invalid');
  }
  return {
    version: 1,
    referenceId: safeText(content.referenceId, 'referenceId')!,
    mediaType: safeText(content.mediaType, 'mediaType')!,
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
  const locator = safeText(chunk.locator, 'locator')!;
  if (locator.includes('/') || locator.includes('\\')) throw new Error('Reference locator contains a path');
  return {
    version: 1,
    referenceId: safeText(chunk.referenceId, 'referenceId')!,
    chunkId: safeText(chunk.chunkId, 'chunkId')!,
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
): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly result: McpToolResult } {
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
  outcome:
    | McpAuthoringSubmitOutputV1
    | McpConflictResolveOutputV1,
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
): { readonly ok: true; readonly value: string[] } | { readonly ok: false; readonly result: McpToolResult } {
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
): { readonly ok: true; readonly value: ConfigChangeRequestV1 } | { readonly ok: false; readonly result: McpToolResult } {
  const unknown = rejectUnknownKeys(value, ['version', 'expectedRevision', 'configuration']);
  if (unknown) return { ok: false, result: unknown };
  if (value.version !== CONFIG_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput('configuration request version must be 1.') };
  }
  const expectedRevision = value.expectedRevision;
  if (typeof expectedRevision !== 'string' && expectedRevision !== null) {
    return { ok: false, result: invalidInput('expectedRevision must be a string or null.') };
  }
  if (typeof value.configuration !== 'object' || value.configuration === null || Array.isArray(value.configuration)) {
    return { ok: false, result: invalidInput('configuration must be an object.') };
  }
  const configuration = parseConfiguration(value.configuration as Record<string, unknown>);
  if (!configuration.ok) return configuration;
  return {
    ok: true,
    value: { version: CONFIG_CONTRACT_VERSION, expectedRevision, configuration: configuration.value },
  };
}

function parseConfiguration(
  value: Record<string, unknown>,
): { readonly ok: true; readonly value: WorkbenchConfigurationV1 } | { readonly ok: false; readonly result: McpToolResult } {
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
      return { ok: false, result: invalidInput('each configuration.projects entry must be an object.') };
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
    projects.push({ projectId: projectId.value, displayName: displayName.value, root: root.value });
  }
  const defaultProjectId = value.defaultProjectId;
  if (typeof defaultProjectId !== 'string' && defaultProjectId !== null) {
    return { ok: false, result: invalidInput('configuration.defaultProjectId must be a string or null.') };
  }
  const provider = value.provider;
  let parsedProvider: WorkbenchConfigurationV1['provider'] = null;
  if (provider !== null) {
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
      return { ok: false, result: invalidInput('configuration.provider must be an object or null.') };
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
    return { ok: false, result: invalidInput('configuration.network.mode must be loopback, lan, or unix.') };
  }
  if (typeof networkRecord.port !== 'number' || !Number.isInteger(networkRecord.port) || networkRecord.port < 1) {
    return { ok: false, result: invalidInput('configuration.network.port must be a positive integer.') };
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
      provider: parsedProvider,
      network: {
        mode,
        port: networkRecord.port,
        allowedHosts: allowedHosts.value,
        allowedOrigins: allowedOrigins.value,
        unixSocket: unixSocket.value,
      },
    },
  };
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
  const render: McpRenderFunction =
    options.render ?? ((request, runtime) => renderNovel(request, runtime));
  const definitions: readonly McpToolDefinition[] = [
    {
      ...toolMetadata('nova_status'),
      run: async () => {
        const source = session.source;
        return mcpToolOk({
          projection: session.projection,
          status: source === null ? null : getProjectStatus(source),
        });
      },
    },
    {
      ...toolMetadata('nova_validate'),
      run: async () => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        return serializeValidation(source);
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
      ...toolMetadata('nova_render'),
      run: async (caller, input) => {
        const parsed = parseObject(input, 'Input must be an object.');
        if (!parsed.ok) return parsed.result;
        // Fail closed: no actorId/operationId (or any other server field) may reach the queue.
        const unknown = rejectUnknownKeys(parsed.value, ['sceneSelector', 'model', 'referenceChunks']);
        if (unknown) return unknown;
        let selector: SceneSelector;
        let model: string | undefined;
        try {
          selector = parseSceneSelector(parsed.value.sceneSelector);
          model = optionalString(parsed.value, 'model');
        } catch (error) {
          return mcpToolError('INVALID_INPUT', (error as Error).message);
        }
        const references: Array<{ readonly referenceId: string; readonly chunkId: string }> = [];
        if (parsed.value.referenceChunks !== undefined) {
          if (
            !Array.isArray(parsed.value.referenceChunks) ||
            parsed.value.referenceChunks.length > REFERENCE_MCP_LIMITS_V1.maxCitations
          ) {
            return invalidInput('referenceChunks must be a bounded array.');
          }
          if (!caller.grant.scopes.includes(MCP_REFERENCE_READ_SCOPE)) {
            return mcpToolError('SCOPE_MISMATCH', 'Reference-backed renders require mcp:reference:read.');
          }
          for (const value of parsed.value.referenceChunks) {
            const candidate = parseObject(value, 'Each reference chunk must be an object.');
            if (!candidate.ok) return candidate.result;
            const chunkUnknown = rejectUnknownKeys(candidate.value, ['referenceId', 'chunkId']);
            if (chunkUnknown) return chunkUnknown;
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
            if (!referenceId.ok) return referenceId.result;
            if (!chunkId.ok) return chunkId.result;
            references.push({ referenceId: referenceId.value!, chunkId: chunkId.value! });
          }
        }
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        const referencePacket =
          references.length === 0
            ? undefined
            : (() => {
                const reference = options.reference;
                if (reference === undefined) return null;
                return reference;
              })();
        if (referencePacket === null) return NO_REFERENCE_PORT;

        if (
          new Set(references.map((value) => `${value.referenceId}\u0000${value.chunkId}`)).size !==
          references.length
        ) {
          return invalidInput('referenceChunks must not contain duplicates.');
        }
        const operation = await session.enqueueOperation({
          kind: 'render',
          capabilityId: caller.grant.capabilityId,
          scope:
            references.length === 0
              ? [MCP_RENDER_SCOPE]
              : [MCP_RENDER_SCOPE, MCP_REFERENCE_READ_SCOPE],
          expectedVersion: caller.grant.version,
          payload: {
            selector,
            ...(model !== undefined ? { model } : {}),
            ...(references.length === 0 ? {} : { referenceChunks: references }),
          },
          run: async (context) => {
            const resolvedReferencePacket =
              referencePacket === undefined
                ? undefined
                : {
                    version: 1 as const,
                    projectId: coreProjectId(source),
                    citations: await Promise.all(
                      references.map(async ({ referenceId, chunkId }, index) => {
                        const result = await referencePacket.getChunk({ version: 1, referenceId, chunkId });
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
            return render(
              {
                version: 1,
                source,
                selector,
                mutation: { operationId: context.operationId, actorId: context.actorId },
                ...(model !== undefined ? { model } : {}),
                ...(resolvedReferencePacket === undefined ? {} : { referencePacket: resolvedReferencePacket }),
              },
              { services: session.runtime.services },
            );
          },
        });
        return mapOperationResult(operation);
      },
    },
    {
      ...toolMetadata('nova_reference_list'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'pageSize', 'cursor']);
        if (!parsed.ok) return parsed.result;
        const pageSize = referenceInteger(parsed.value, 'pageSize', 1, REFERENCE_MCP_LIMITS_V1.maxPageSize, false);
        const cursor = referenceString(parsed.value, 'cursor', REFERENCE_MCP_LIMITS_V1.maxCursorLength, false);
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
        const referenceId = referenceString(parsed.value, 'referenceId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        if (!referenceId.ok) return referenceId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.get({ version: 1, referenceId: referenceId.value! });
        return result === null
          ? mcpToolError('REFERENCE_NOT_FOUND', 'The requested reference does not exist.')
          : mcpToolOk({ version: 1, item: safeReferenceItem(result.item) });
      },
    },
    {
      ...toolMetadata('nova_reference_search'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'query', 'pageSize', 'cursor', 'filters']);
        if (!parsed.ok) return parsed.result;
        const query = referenceString(parsed.value, 'query', REFERENCE_MCP_LIMITS_V1.maxQueryLength);
        const pageSize = referenceInteger(parsed.value, 'pageSize', 1, REFERENCE_MCP_LIMITS_V1.maxPageSize, false);
        const cursor = referenceString(parsed.value, 'cursor', REFERENCE_MCP_LIMITS_V1.maxCursorLength, false);
        if (!query.ok) return query.result;
        if (!pageSize.ok) return pageSize.result;
        if (!cursor.ok) return cursor.result;
        let filters: McpReferenceSearchInputV1['filters'];
        if (parsed.value.filters !== undefined) {
          const filterRecord = parseObject(parsed.value.filters, 'filters must be an object.');
          if (!filterRecord.ok) return filterRecord.result;
          const unknown = rejectUnknownKeys(filterRecord.value, ['referenceId', 'mediaType', 'tag']);
          if (unknown) return unknown;
          const referenceId = referenceString(filterRecord.value, 'referenceId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength, false);
          const mediaType = referenceString(filterRecord.value, 'mediaType', REFERENCE_MCP_LIMITS_V1.maxMediaTypeLength, false);
          const tag = referenceString(filterRecord.value, 'tag', REFERENCE_MCP_LIMITS_V1.maxTagLength, false);
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
          query: query.value!,
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
        const referenceId = referenceString(parsed.value, 'referenceId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        const chunkId = referenceString(parsed.value, 'chunkId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        if (!referenceId.ok) return referenceId.result;
        if (!chunkId.ok) return chunkId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.getChunk({ version: 1, referenceId: referenceId.value!, chunkId: chunkId.value! });
        return result === null
          ? mcpToolError('REFERENCE_CHUNK_NOT_FOUND', 'The requested reference chunk does not exist.')
          : mcpToolOk({ version: 1, chunk: safeReferenceChunk(result.chunk) });
      },
    },
    {
      ...toolMetadata('nova_reference_content_read'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'referenceId', 'offset', 'limit']);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(parsed.value, 'referenceId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        const offset = referenceInteger(parsed.value, 'offset', 0, REFERENCE_MCP_LIMITS_V1.maxOffset);
        const limit = referenceInteger(parsed.value, 'limit', 1, REFERENCE_MCP_LIMITS_V1.maxRangeBytes);
        if (!referenceId.ok) return referenceId.result;
        if (!offset.ok) return offset.result;
        if (!limit.ok) return limit.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.readContent({ version: 1, referenceId: referenceId.value!, offset: offset.value!, limit: limit.value! });
        return mcpToolOk({ version: 1, content: safeReferenceContent(result.content) });
      },
    },
    {
      ...toolMetadata('nova_reference_import_begin'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, [
          'version', 'referenceId', 'originalName', 'displayName', 'mediaType', 'byteLength', 'contentHash',
          'title', 'authors', 'sourceUrl', 'license', 'tags', 'idempotencyKey',
        ]);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(parsed.value, 'referenceId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        const originalName = referenceString(parsed.value, 'originalName', REFERENCE_MCP_LIMITS_V1.maxNameLength);
        const displayName = referenceString(parsed.value, 'displayName', REFERENCE_MCP_LIMITS_V1.maxNameLength, false);
        const mediaType = referenceString(parsed.value, 'mediaType', REFERENCE_MCP_LIMITS_V1.maxMediaTypeLength);
        const contentHash = referenceString(parsed.value, 'contentHash', 64);
        const idempotencyKey = referenceString(parsed.value, 'idempotencyKey', REFERENCE_MCP_LIMITS_V1.maxIdempotencyKeyLength);
        const byteLength = referenceInteger(parsed.value, 'byteLength', 0, REFERENCE_MCP_LIMITS_V1.maxReferenceBytes);
        const title = referenceString(parsed.value, 'title', REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength, false);
        const sourceUrl = referenceString(parsed.value, 'sourceUrl', REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength, false);
        const license = referenceString(parsed.value, 'license', REFERENCE_MCP_LIMITS_V1.maxMetadataTextLength, false);
        const authors = referenceStringList(parsed.value, 'authors', REFERENCE_MCP_LIMITS_V1.maxAuthorLength, REFERENCE_MCP_LIMITS_V1.maxAuthorCount);
        const tags = referenceStringList(parsed.value, 'tags', REFERENCE_MCP_LIMITS_V1.maxTagLength, REFERENCE_MCP_LIMITS_V1.maxTagCount);
        if (!referenceId.ok) return referenceId.result; if (!originalName.ok) return originalName.result;
        if (!displayName.ok) return displayName.result; if (!mediaType.ok) return mediaType.result;
        if (!contentHash.ok) return contentHash.result; if (!idempotencyKey.ok) return idempotencyKey.result;
        if (!byteLength.ok) return byteLength.result;
        if (!title.ok) return title.result; if (!sourceUrl.ok) return sourceUrl.result; if (!license.ok) return license.result;
        if (!authors.ok) return authors.result; if (!tags.ok) return tags.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.importBegin({
          version: 1,
          referenceId: referenceId.value!,
          originalName: originalName.value!,
          ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
          mediaType: mediaType.value!,
          byteLength: byteLength.value!,
          contentHash: contentHash.value!,
          ...(title.value === undefined ? {} : { title: title.value }),
          ...(authors.value === undefined ? {} : { authors: authors.value }),
          ...(sourceUrl.value === undefined ? {} : { sourceUrl: sourceUrl.value }),
          ...(license.value === undefined ? {} : { license: license.value }),
          ...(tags.value === undefined ? {} : { tags: tags.value }),
          idempotencyKey: idempotencyKey.value!,
        });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_import_chunk'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'jobId', 'offset', 'byteLength', 'chunkHash', 'dataBase64']);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(parsed.value, 'jobId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        const chunkHash = referenceString(parsed.value, 'chunkHash', 64);
        const dataBase64 = referenceString(parsed.value, 'dataBase64', REFERENCE_MCP_LIMITS_V1.maxChunkBase64Length);
        const offset = referenceInteger(parsed.value, 'offset', 0, REFERENCE_MCP_LIMITS_V1.maxOffset);
        const byteLength = referenceInteger(parsed.value, 'byteLength', 1, REFERENCE_MCP_LIMITS_V1.maxChunkBytes);
        if (!jobId.ok) return jobId.result; if (!chunkHash.ok) return chunkHash.result;
        if (!dataBase64.ok) return dataBase64.result; if (!offset.ok) return offset.result;
        if (!byteLength.ok) return byteLength.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.importChunk({
          version: 1, jobId: jobId.value!, offset: offset.value!, byteLength: byteLength.value!,
          chunkHash: chunkHash.value!, dataBase64: dataBase64.value!,
        });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_import_commit'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'jobId', 'contentHash']);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(parsed.value, 'jobId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        const contentHash = referenceString(parsed.value, 'contentHash', 64);
        if (!jobId.ok) return jobId.result; if (!contentHash.ok) return contentHash.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.importCommit({ version: 1, jobId: jobId.value!, contentHash: contentHash.value! });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_job_get'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'jobId']);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(parsed.value, 'jobId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        if (!jobId.ok) return jobId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.jobGet({ version: 1, jobId: jobId.value! });
        return result === null ? mcpToolError('REFERENCE_JOB_NOT_FOUND', 'The requested reference job does not exist.') : mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_retry'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'jobId']);
        if (!parsed.ok) return parsed.result;
        const jobId = referenceString(parsed.value, 'jobId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        if (!jobId.ok) return jobId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.retry({ version: 1, jobId: jobId.value! });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job) });
      },
    },
    {
      ...toolMetadata('nova_reference_delete'),
      run: async (_caller, input) => {
        const parsed = parseReferenceInput(input, ['version', 'referenceId']);
        if (!parsed.ok) return parsed.result;
        const referenceId = referenceString(parsed.value, 'referenceId', REFERENCE_MCP_LIMITS_V1.maxReferenceIdLength);
        if (!referenceId.ok) return referenceId.result;
        const reference = options.reference;
        if (reference === undefined) return NO_REFERENCE_PORT;
        const result = await reference.delete({ version: 1, referenceId: referenceId.value! });
        return mcpToolOk({ version: 1, job: safeReferenceJob(result.job), deletedReferenceId: result.deletedReferenceId });
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
        if (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 0)) return invalidInput('offset must be a non-negative integer.');
        if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > AUTHORING_DOCUMENT_LIMITS_V1.maxReadCharacters)) return invalidInput('limit is outside the bounded read range.');
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
        const parsed = parseToolInput(input, ['version', 'documentId', 'expectedWorkspaceDigest', 'expectedAcceptedSourceHash', 'expectedStateVectorHash', 'replacementText', 'edits']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.editDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const documentId = requiredString(parsed.value, 'documentId');
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        const vector = requiredString(parsed.value, 'expectedStateVectorHash');
        if (!documentId.ok) return documentId.result; if (!digest.ok) return digest.result; if (!vector.ok) return vector.result;
        const expectedAccepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!expectedAccepted.ok) return expectedAccepted.result;
        const replacement = parsed.value.replacementText;
        const editsValue = parsed.value.edits;
        if ((replacement === undefined) === (editsValue === undefined)) return invalidInput('Provide exactly one of replacementText or edits.');
        if (replacement !== undefined && (typeof replacement !== 'string' || new TextEncoder().encode(replacement).byteLength > AUTHORING_DOCUMENT_LIMITS_V1.maxEditBytes)) return invalidInput('replacementText exceeds the edit limit.');
        let edits: Array<{ readonly start: number; readonly end: number; readonly replacementText: string }> | undefined;
        if (editsValue !== undefined) {
          if (!Array.isArray(editsValue) || editsValue.length === 0) return invalidInput('edits must be a non-empty array.');
          let previousEnd = 0; let bytes = 0; edits = [];
          for (const raw of editsValue) {
            const item = parseObject(raw, 'each edit must be an object.');
            if (!item.ok) return item.result;
            const unknown = rejectUnknownKeys(item.value, ['start', 'end', 'replacementText']);
            if (unknown) return unknown;
            const start = item.value.start; const end = item.value.end; const text = item.value.replacementText;
            if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < previousEnd || (end as number) < (start as number) || typeof text !== 'string') return invalidInput('edits must be sorted, non-overlapping spans.');
            bytes += new TextEncoder().encode(text).byteLength;
            if (bytes > AUTHORING_DOCUMENT_LIMITS_V1.maxEditBytes) return invalidInput('edits exceed the edit limit.');
            previousEnd = end as number;
            edits.push({ start: start as number, end: end as number, replacementText: text });
          }
        }
        const result = await coordinator.editDocument({
          version: AUTHORING_CONTRACT_VERSION,
          documentId: documentId.value,
          expectedWorkspaceDigest: digest.value,
          expectedAcceptedSourceHash: expectedAccepted.value,
          expectedStateVectorHash: vector.value,
          ...(replacement === undefined ? {} : { replacementText: replacement as string }),
          ...(edits === undefined ? {} : { edits }),
        }, caller);
        return authoringApplyResult(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_create'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, ['version', 'logicalPath', 'kind', 'expectedWorkspaceDigest', 'expectedAcceptedSourceHash']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.createDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const path = requiredString(parsed.value, 'logicalPath'); const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!path.ok) return path.result; if (!digest.ok) return digest.result;
        const accepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!accepted.ok) return accepted.result;
        const kind = parsed.value.kind;
        if (kind !== undefined && kind !== 'prose' && kind !== 'raw-yaml') return invalidInput('kind must be prose or raw-yaml.');
        const result = await coordinator.createDocument({ version: AUTHORING_CONTRACT_VERSION, logicalPath: path.value, expectedWorkspaceDigest: digest.value, expectedAcceptedSourceHash: accepted.value, ...(kind === undefined ? {} : { kind }) }, caller);
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_move'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, ['version', 'documentId', 'logicalPath', 'expectedWorkspaceDigest', 'expectedAcceptedSourceHash']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.moveDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const id = requiredString(parsed.value, 'documentId'); const path = requiredString(parsed.value, 'logicalPath'); const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!id.ok) return id.result; if (!path.ok) return path.result; if (!digest.ok) return digest.result;
        const accepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!accepted.ok) return accepted.result;
        const result = await coordinator.moveDocument({ version: AUTHORING_CONTRACT_VERSION, documentId: id.value, logicalPath: path.value, expectedWorkspaceDigest: digest.value, expectedAcceptedSourceHash: accepted.value }, caller);
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_document_delete'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, ['version', 'documentId', 'expectedWorkspaceDigest', 'expectedAcceptedSourceHash']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator?.deleteDocument === undefined) return NO_AUTHORING_COORDINATOR;
        const id = requiredString(parsed.value, 'documentId'); const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!id.ok) return id.result; if (!digest.ok) return digest.result;
        const accepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!accepted.ok) return accepted.result;
        const result = await coordinator.deleteDocument({ version: AUTHORING_CONTRACT_VERSION, documentId: id.value, expectedWorkspaceDigest: digest.value, expectedAcceptedSourceHash: accepted.value }, caller);
        return 'code' in result ? mcpToolError(result.code, result.message) : mcpToolOk(result);
      },
    },
    {
      ...toolMetadata('nova_authoring_submit'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'expectedWorkspaceDigest',
          'message',
        ]);
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
        if (
          message !== undefined &&
          message.length > 4096
        ) {
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
      ...toolMetadata('nova_authoring_conflict_read'),
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined || coordinator.readConflict === undefined) {
          return NO_AUTHORING_COORDINATOR;
        }
        return mcpToolOk(
          await coordinator.readConflict({ version: AUTHORING_CONTRACT_VERSION }),
        );
      },
    },
    {
      ...toolMetadata('nova_conflict_resolve'),
      run: async (caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'choice',
          'candidateHash',
        ]);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const choice = parsed.value.choice;
        if (
          choice !== 'keep-working' &&
          choice !== 'accept-external' &&
          choice !== 'apply-proposed-disjoint-merge'
        ) {
          return invalidInput('choice must be keep-working, accept-external, or apply-proposed-disjoint-merge.');
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
        return mcpToolOk(await method({ version: 1, ...(projectId.value === undefined ? {} : { projectId: projectId.value }) }));
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
        return mcpToolOk(await method({ version: 1, userId: userId.value, projectId: projectId.value, role: role.value }));
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
        return mcpToolOk(await method({ version: 1, userId: userId.value, projectId: projectId.value }));
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
        return mcpToolOk(await method({ version: 1, ...(projectId.value === undefined ? {} : { projectId: projectId.value }) }));
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
        if (!ttlMs.ok || ttlMs.value === undefined) return ttlMs.ok ? invalidInput('ttlMs is required.') : ttlMs.result;
        const method = options.admin?.inviteCreate;
        if (method === undefined) return NO_ADMIN_SERVICE;
        return mcpToolOk(await method({ version: 1, projectId: projectId.value, role: role.value, ttlMs: ttlMs.value }));
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
        const parsed = parseAdminVersionedInput(input, ['version', 'kind', 'projectId', 'role', 'ttlMs']);
        if (!parsed.ok) return parsed.result;
        const kind = parsed.value.kind;
        if (kind !== undefined && kind !== 'project' && kind !== 'admin') return invalidInput('kind must be project or admin.');
        const projectId = adminOptionalString(parsed.value, 'projectId');
        const role = adminOptionalRole(parsed.value);
        const ttlMs = adminInteger(parsed.value, 'ttlMs', 1, 30 * 24 * 60 * 60 * 1000, false);
        if (!projectId.ok) return projectId.result;
        if (!role.ok) return role.result;
        if (!ttlMs.ok) return ttlMs.result;
        const resolvedKind = kind ?? (projectId.value === undefined ? 'admin' : 'project');
        if (resolvedKind === 'admin' && (projectId.value !== undefined || role.value !== undefined)) {
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
        return mcpToolOk(await method({ version: 1, ...(limit.value === undefined ? {} : { limit: limit.value }) }));
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
    availableScopes: [...new Set(selectedDefinitions.flatMap((definition) => definition.requiredScopes))],
    list(permittedScopes) {
      return selectedDefinitions.filter((definition) =>
        definition.requiredScopes.every((scope) => permittedScopes.includes(scope)),
      );
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
