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
  type McpJsonSchemaProperty,
  type McpJsonSchemaV1,
  MCP_TOOL_CATALOG_V1,
  type McpToolDescriptorV1,
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
  type ConfigChangeRequestV1,
  type ConfigOperationReceiptV1,
  type WorkbenchConfigurationV1,
} from '../../contracts/configuration.js';
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
export const MCP_RENDER_SCOPE = toolScope('nova_render');
export const MCP_AUTHOR_SCOPE = toolScope('nova_authoring_status');
export const MCP_SUBMIT_SCOPE = toolScope('nova_authoring_submit');
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
  preview(input: ConfigChangeRequestV1): Promise<ConfigOperationReceiptV1>;
  apply(input: ConfigChangeRequestV1): Promise<ConfigOperationReceiptV1>;
}

/** Injected render implementation; defaults to Core `renderNovel` over session services. */
export type McpRenderFunction = (
  request: EditorialRenderRequestV1,
  runtime: EditorialRuntime,
) => Promise<RenderNovelResult>;

export interface McpRegistryOptions {
  /** Render implementation seam; tests inject a recording stub. */
  readonly render?: McpRenderFunction;
  /** Author/submit coordinator port; when absent the authoring tools fail closed. */
  readonly coordinator?: McpAuthoringCoordinatorPort;
  /** Native immutable revision service for this project; absent fails closed. */
  readonly revision?: AuthoringRevisionPort;
  /** Owner configuration port; when absent the admin tools fail closed. */
  readonly admin?: McpAdminConfigurationPort;
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

/**
 * Strict authoring MCP input gate: the input must be an object with no
 * unknown keys and `version` exactly 2. Nothing else (no actor, path, token,
 * Git head, or raw Yjs payload) is accepted anywhere in a request.
 */
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


/** Strict `string | null` field; null only when explicitly allowed. */
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
        const unknown = rejectUnknownKeys(parsed.value, ['sceneSelector', 'model']);
        if (unknown) return unknown;
        let selector: SceneSelector;
        let model: string | undefined;
        try {
          selector = parseSceneSelector(parsed.value.sceneSelector);
          model = optionalString(parsed.value, 'model');
        } catch (error) {
          return mcpToolError('INVALID_INPUT', (error as Error).message);
        }
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;

        const operation = await session.enqueueOperation({
          kind: 'render',
          capabilityId: caller.grant.capabilityId,
          scope: [MCP_RENDER_SCOPE],
          expectedVersion: caller.grant.version,
          payload: {
            selector,
            ...(model !== undefined ? { model } : {}),
          },
          run: async (context) =>
            render(
              {
                version: 1,
                source,
                selector,
                mutation: { operationId: context.operationId, actorId: context.actorId },
                ...(model !== undefined ? { model } : {}),
              },
              { services: session.runtime.services },
            ),
        });
        return mapOperationResult(operation);
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

  const selectedDefinitions =
    options.family === 'admin'
      ? definitions.filter((definition) => definition.name.startsWith('nova_admin_'))
      : options.family === 'project'
        ? definitions.filter((definition) => !definition.name.startsWith('nova_admin_'))
        : definitions;
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
