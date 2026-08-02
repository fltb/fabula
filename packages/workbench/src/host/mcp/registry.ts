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
  MCP_AUTHOR_SCOPE,
  MCP_SUBMIT_SCOPE,
  MCP_TOOL_AUTHORING_APPLY,
  MCP_TOOL_AUTHORING_DOCUMENT_GET,
  MCP_TOOL_AUTHORING_STATUS,
  MCP_TOOL_AUTHORING_SUBMIT,
  MCP_TOOL_CONFLICT_RESOLVE,
  MCP_TOOL_OPERATION_GET,
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
} from '../../contracts/authoring.js';
import {
  MCP_ADMIN_SCOPE,
  MCP_TOOL_ADMIN_CONFIG_APPLY,
  MCP_TOOL_ADMIN_CONFIG_PREVIEW,
  type ConfigChangeRequestV1,
  type ConfigOperationReceiptV1,
  type WorkbenchConfigurationV1,
} from '../../contracts/configuration.js';
import type { ProjectSession, SessionOperationResult } from '../project-session.js';
import type { McpAuthorizedCaller } from './auth.js';

/** Exact capability scopes for MCP tools. */
export const MCP_READ_SCOPE = 'mcp:read' as const;
export const MCP_RENDER_SCOPE = 'mcp:render' as const;
// `mcp:author`, `mcp:submit`, and `mcp:admin` are imported from the
// contracts above and re-exported through this module so every MCP surface
// consumes one canonical scope vocabulary.
export { MCP_AUTHOR_SCOPE, MCP_SUBMIT_SCOPE } from '../../contracts/authoring.js';
export { MCP_ADMIN_SCOPE } from '../../contracts/configuration.js';
export {
  MCP_TOOL_AUTHORING_APPLY,
  MCP_TOOL_AUTHORING_DOCUMENT_GET,
  MCP_TOOL_AUTHORING_STATUS,
  MCP_TOOL_AUTHORING_SUBMIT,
  MCP_TOOL_CONFLICT_RESOLVE,
  MCP_TOOL_OPERATION_GET,
} from '../../contracts/authoring.js';
export {
  MCP_TOOL_ADMIN_CONFIG_APPLY,
  MCP_TOOL_ADMIN_CONFIG_PREVIEW,
} from '../../contracts/configuration.js';

// ─── Plain JSON input schemas (no zod) ───────────────────────────────────────

export interface McpJsonSchemaProperty {
  readonly type?:
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'array'
    | 'null'
    | readonly ('string' | 'number' | 'boolean' | 'object' | 'array' | 'null')[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly items?: McpJsonSchemaProperty;
  readonly properties?: Readonly<Record<string, McpJsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  /** Standard JSON-Schema numeric bound; mirrors Core's positive-integer rule. */
  readonly minimum?: number;
  /** Standard JSON-Schema numeric bound; mirrors Core's integer rule. */
  readonly multipleOf?: number;
  /** Standard JSON-Schema array bound; mirrors Core's `.min(1)`. */
  readonly minItems?: number;
  /** Standard JSON-Schema string bound; mirrors Core's non-empty string rule. */
  readonly minLength?: number;
  /** Standard JSON-Schema array uniqueness; mirrors Core's uniqueness refinement. */
  readonly uniqueItems?: boolean;
}

export interface McpJsonInputSchema {
  readonly type: 'object';
  readonly description?: string;
  readonly properties: Readonly<Record<string, McpJsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

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

/**
 * Narrow per-project authoring surface the `mcp:author`/`mcp:submit` tools
 * consume. The integration wires a Phase-1 coordinator adapter
 * (`host/authoring/types.ts`) that performs typed stale-vector CAS — a stale
 * or conflicting digest is a typed failure, never last-writer-wins.
 */
export interface McpAuthoringCoordinatorPort {
  readonly projectId: string;
  getState(): AuthoringStateV1;
  getDocument(
    input: McpAuthoringDocumentGetInputV1,
  ): Promise<McpAuthoringDocumentGetOutputV1 | AuthoringFailureV1>;
  apply(input: McpAuthoringApplyInputV1): Promise<McpAuthoringApplyOutputV1>;
  submit(input: McpAuthoringSubmitInputV1): Promise<McpAuthoringSubmitOutputV1>;
  getOperation(input: McpOperationGetInputV1): Promise<McpOperationGetOutputV1>;
  resolveConflict(input: McpConflictResolveInputV1): Promise<McpConflictResolveOutputV1>;
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
  /** Owner configuration port; when absent the admin tools fail closed. */
  readonly admin?: McpAdminConfigurationPort;
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

/** The one accepted version for every scoped authoring/admin tool input. */
const SCOPED_CONTRACT_VERSION = 1;

const NO_AUTHORING_COORDINATOR = mcpToolError(
  'PROJECT_NOT_READY',
  'The authoring coordinator is not available for this project.',
);
const NO_ADMIN_CONFIGURATION = mcpToolError(
  'NO_ADMIN_CONFIGURATION',
  'The owner configuration service is not available for this Host.',
);

/**
 * Strict tool-input gate shared by the scoped authoring/admin tools: the
 * input must be an object with no unknown keys and `version` exactly 1.
 * Nothing else (no actor, path, token, Git head, or raw Yjs payload) is
 * accepted anywhere in a request.
 */
function parseToolInput(
  input: unknown,
  allowed: readonly string[],
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly result: McpToolResult } {
  const parsed = parseObject(input, 'Input must be an object.');
  if (!parsed.ok) return parsed;
  const unknown = rejectUnknownKeys(parsed.value, allowed);
  if (unknown) return { ok: false, result: unknown };
  if (parsed.value.version !== SCOPED_CONTRACT_VERSION) {
    return { ok: false, result: invalidInput(`version must be ${SCOPED_CONTRACT_VERSION}.`) };
  }
  return parsed;
}

/** The request project must be the open session project; never caller-chosen. */
function requireOpenProject(
  value: Record<string, unknown>,
  openProjectId: string,
): McpToolResult | null {
  const projectId = requiredString(value, 'projectId');
  if (!projectId.ok) return projectId.result;
  if (projectId.value !== openProjectId) {
    return mcpToolError(
      'PROJECT_NOT_FOUND',
      `No open authoring project with id "${projectId.value}".`,
    );
  }
  return null;
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
  if (value.version !== SCOPED_CONTRACT_VERSION) {
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
    value: { version: 1, expectedRevision, configuration: configuration.value },
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
  if (value.version !== SCOPED_CONTRACT_VERSION) {
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
      version: 1,
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

const NO_INPUT_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

// ─── Tool definitions ────────────────────────────────────────────────────────

const SCENE_SELECTOR_SCHEMA: McpJsonSchemaProperty = {
  type: 'object',
  description: 'Which scenes to render: all, one chapter, or explicit event ids.',
  properties: {
    type: { type: 'string', enum: ['all', 'chapter', 'events'], description: 'Selection mode.' },
    chapter: {
      type: 'number',
      description: 'Chapter number (positive integer); required when type is "chapter".',
      minimum: 1,
      multipleOf: 1,
    },
    eventIds: {
      type: 'array',
      items: { type: 'string', minLength: 1, description: 'Non-empty event id.' },
      minItems: 1,
      uniqueItems: true,
      description: 'Unique non-empty event ids; required when type is "events".',
    },
  },
  required: ['type'],
  additionalProperties: false,
};

const SOURCE_CHANGE_SCHEMA: McpJsonSchemaProperty = {
  type: 'object',
  description: 'One proposed source change; the analysis is preview-only.',
  properties: {
    logicalPath: { type: 'string', description: 'Logical POSIX path of the document.' },
    beforeContent: {
      type: ['string', 'null'],
      description: 'Current content; null for a new document.',
    },
    beforeHash: {
      type: ['string', 'null'],
      description: 'Current content hash; null for a new document.',
    },
    afterContent: {
      type: ['string', 'null'],
      description: 'Proposed content; null for a deletion.',
    },
    afterHash: {
      type: ['string', 'null'],
      description: 'Proposed content hash; null for a deletion.',
    },
  },
  required: ['logicalPath'],
  additionalProperties: false,
};

const CONTRACT_VERSION_PROPERTY: McpJsonSchemaProperty = {
  type: 'number',
  enum: [1],
  description: 'Authoring contract version; must be 1.',
};

const PROJECT_ID_PROPERTY: McpJsonSchemaProperty = {
  type: 'string',
  minLength: 1,
  description: 'Open project id (server-derived; must match the registry project).',
};

const AUTHORING_STATUS_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  description: 'Current authoring state of the open project.',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    projectId: PROJECT_ID_PROPERTY,
  },
  required: ['version', 'projectId'],
  additionalProperties: false,
};

const AUTHORING_DOCUMENT_GET_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  description: 'One working document identity and hashes (never document bytes).',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    projectId: PROJECT_ID_PROPERTY,
    documentId: { type: 'string', minLength: 1, description: 'Working document id.' },
  },
  required: ['version', 'projectId', 'documentId'],
  additionalProperties: false,
};

const AUTHORING_APPLY_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  description:
    'Full-replacement write to one working document, CAS-bound to the workspace digest; a stale digest is a typed failure.',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    projectId: PROJECT_ID_PROPERTY,
    documentId: { type: 'string', minLength: 1, description: 'Working document id.' },
    expectedWorkspaceDigest: {
      type: 'string',
      minLength: 1,
      description: 'Workspace digest the write must build on.',
    },
    expectedAcceptedSourceHash: {
      type: ['string', 'null'],
      description: 'Accepted source hash the write must build on; null before first accepted load.',
    },
    replacementText: { type: 'string', description: 'Full replacement text for the document.' },
  },
  required: [
    'version',
    'projectId',
    'documentId',
    'expectedWorkspaceDigest',
    'expectedAcceptedSourceHash',
    'replacementText',
  ],
  additionalProperties: false,
};

const AUTHORING_SUBMIT_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  description: 'Explicit submit of the working layer; the workspace digest CAS is required.',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    projectId: PROJECT_ID_PROPERTY,
    expectedWorkspaceDigest: {
      type: 'string',
      minLength: 1,
      description: 'Workspace digest the submit must confirm against.',
    },
    message: { type: 'string', description: 'Optional submit message.' },
  },
  required: ['version', 'projectId', 'expectedWorkspaceDigest'],
  additionalProperties: false,
};

const OPERATION_GET_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  description: 'One authoring operation receipt by id.',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    operationId: { type: 'string', minLength: 1, description: 'Authoring operation id.' },
  },
  required: ['version', 'operationId'],
  additionalProperties: false,
};

const CONFLICT_RESOLVE_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  description: 'Resolve an external candidate / working-vs-external conflict with a predefined choice.',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    projectId: PROJECT_ID_PROPERTY,
    choice: {
      type: 'string',
      enum: ['keep-working', 'accept-external', 'apply-proposed-disjoint-merge'],
      description: 'Predefined resolution choice.',
    },
    candidateHash: {
      type: ['string', 'null'],
      description: 'External candidate hash; required for accept-external / disjoint-merge.',
    },
  },
  required: ['version', 'projectId', 'choice', 'candidateHash'],
  additionalProperties: false,
};

const CONFIGURATION_SCHEMA: McpJsonSchemaProperty = {
  type: 'object',
  description: 'Versioned, secret-free Host configuration.',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    projects: {
      type: 'array',
      description: 'Registered projects.',
      items: {
        type: 'object',
        properties: {
          projectId: { type: 'string', minLength: 1, description: 'Project id.' },
          displayName: { type: 'string', minLength: 1, description: 'Display label.' },
          root: {
            type: 'string',
            minLength: 1,
            description: 'Absolute project root; Host-only input, never echoed.',
          },
        },
        required: ['projectId', 'displayName', 'root'],
        additionalProperties: false,
      },
    },
    defaultProjectId: { type: ['string', 'null'], description: 'Default project id or null.' },
    provider: {
      type: ['object', 'null'],
      description: 'AI provider endpoint/model; never an API key.',
      properties: {
        kind: { type: 'string', enum: ['ai-sdk'], description: 'Provider kind.' },
        baseUrl: { type: ['string', 'null'], description: 'Provider base URL or null.' },
        model: { type: ['string', 'null'], description: 'Model profile or null.' },
      },
      required: ['kind', 'baseUrl', 'model'],
      additionalProperties: false,
    },
    network: {
      type: 'object',
      description: 'HTTP listener policy.',
      properties: {
        mode: { type: 'string', enum: ['loopback', 'lan', 'unix'], description: 'Listener mode.' },
        port: { type: 'number', minimum: 1, multipleOf: 1, description: 'Listener port.' },
        allowedHosts: { type: 'array', items: { type: 'string' }, description: 'Allowed Host headers.' },
        allowedOrigins: { type: 'array', items: { type: 'string' }, description: 'Allowed origins.' },
        unixSocket: { type: ['string', 'null'], description: 'Unix socket path; Host-only.' },
      },
      required: ['mode', 'port', 'allowedHosts', 'allowedOrigins', 'unixSocket'],
      additionalProperties: false,
    },
  },
  required: ['version', 'projects', 'defaultProjectId', 'provider', 'network'],
  additionalProperties: false,
};

const ADMIN_CONFIG_REQUEST_SCHEMA: McpJsonInputSchema = {
  type: 'object',
  description: 'Versioned configuration change with revision CAS; no secrets, no tokens.',
  properties: {
    version: CONTRACT_VERSION_PROPERTY,
    expectedRevision: {
      type: ['string', 'null'],
      description: 'Current content-hash revision; null only for first setup/import.',
    },
    configuration: CONFIGURATION_SCHEMA,
  },
  required: ['version', 'expectedRevision', 'configuration'],
  additionalProperties: false,
};

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
      name: 'nova_status',
      description:
        'Project status over the accepted session source: per-event render state and the session projection.',
      requiredScopes: [MCP_READ_SCOPE],
      inputSchema: NO_INPUT_SCHEMA,
      run: async () => {
        const source = session.source;
        return mcpToolOk({
          projection: session.projection,
          status: source === null ? null : getProjectStatus(source),
        });
      },
    },
    {
      name: 'nova_validate',
      description:
        'Validate the accepted session source: built-in validation results and ISS score.',
      requiredScopes: [MCP_READ_SCOPE],
      inputSchema: NO_INPUT_SCHEMA,
      run: async () => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        return serializeValidation(source);
      },
    },
    {
      name: 'nova_source_list',
      description: 'List the canonical source documents of the accepted session source.',
      requiredScopes: [MCP_READ_SCOPE],
      inputSchema: NO_INPUT_SCHEMA,
      run: async () => {
        const source = session.source;
        if (source === null) return NO_ACCEPTED_SOURCE;
        return mcpToolOk(listSourceDocuments(source));
      },
    },
    {
      name: 'nova_source_get',
      description:
        'Read one canonical source document from the accepted session source by logical path.',
      requiredScopes: [MCP_READ_SCOPE],
      inputSchema: {
        type: 'object',
        description: 'Resolve one document of the accepted source.',
        properties: {
          logicalPath: {
            type: 'string',
            description:
              'Logical POSIX path of the document, e.g. chapters/chapter_01/_chapter.yaml.',
          },
        },
        required: ['logicalPath'],
        additionalProperties: false,
      },
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
      name: 'nova_source_preview',
      description:
        'Preview the analysis of proposed source changes against the accepted session source; nothing is persisted.',
      requiredScopes: [MCP_READ_SCOPE],
      inputSchema: {
        type: 'object',
        description: 'Analyze candidate source changes.',
        properties: {
          changes: {
            type: 'array',
            description: 'Proposed changes; preview-only analysis.',
            items: SOURCE_CHANGE_SCHEMA,
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
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
      name: 'nova_entity_get',
      description: 'Read one entity definition and runtime state from the accepted session source.',
      requiredScopes: [MCP_READ_SCOPE],
      inputSchema: {
        type: 'object',
        description: 'Resolve one entity by id.',
        properties: {
          entityId: {
            type: 'string',
            description: 'Entity id, e.g. the protagonist character id.',
          },
        },
        required: ['entityId'],
        additionalProperties: false,
      },
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
      name: 'nova_entity_list',
      description: 'List entities from the accepted session source, optionally filtered by kind.',
      requiredScopes: [MCP_READ_SCOPE],
      inputSchema: {
        type: 'object',
        description: 'List entities of the accepted source.',
        properties: {
          kind: { type: 'string', description: 'Optional entity kind filter.' },
        },
        additionalProperties: false,
      },
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
      name: 'nova_render',
      description:
        'Render scenes through the session operation queue. The operation actor and id are server-derived; client-supplied actorId/operationId are rejected.',
      requiredScopes: [MCP_RENDER_SCOPE],
      inputSchema: {
        type: 'object',
        description: 'Render request; identity fields are never accepted from the client.',
        properties: {
          sceneSelector: {
            ...SCENE_SELECTOR_SCHEMA,
            description: 'Which scenes to render.',
          },
          model: { type: 'string', description: 'Optional model profile override.' },
        },
        required: ['sceneSelector'],
        additionalProperties: false,
      },
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
      name: MCP_TOOL_AUTHORING_STATUS,
      description:
        'Current authoring state of the open project: phase, accepted/working hashes, conflicts, submit gating.',
      requiredScopes: [MCP_AUTHOR_SCOPE],
      inputSchema: AUTHORING_STATUS_SCHEMA,
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'projectId']);
        if (!parsed.ok) return parsed.result;
        const project = requireOpenProject(parsed.value, session.projectId);
        if (project !== null) return project;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const state = coordinator.getState();
        const output: McpAuthoringStatusOutputV1 = {
          version: 1,
          projectId: session.projectId,
          state,
          generatedAt: state.generatedAt,
        };
        return mcpToolOk(output);
      },
    },
    {
      name: MCP_TOOL_AUTHORING_DOCUMENT_GET,
      description:
        'One working document identity and hashes from the coordinator; never document bytes.',
      requiredScopes: [MCP_AUTHOR_SCOPE],
      inputSchema: AUTHORING_DOCUMENT_GET_SCHEMA,
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'projectId', 'documentId']);
        if (!parsed.ok) return parsed.result;
        const project = requireOpenProject(parsed.value, session.projectId);
        if (project !== null) return project;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const documentId = requiredString(parsed.value, 'documentId');
        if (!documentId.ok) return documentId.result;
        const request: McpAuthoringDocumentGetInputV1 = {
          version: 1,
          projectId: session.projectId,
          documentId: documentId.value,
        };
        const result = await coordinator.getDocument(request);
        if ('code' in result) return mcpToolError(result.code, result.message);
        return mcpToolOk(result);
      },
    },
    {
      name: MCP_TOOL_AUTHORING_APPLY,
      description:
        'Full-replacement write to one working document, CAS-bound to the workspace digest and accepted source hash; a stale/conflicting digest is a typed failure, never last-writer-wins.',
      requiredScopes: [MCP_AUTHOR_SCOPE],
      inputSchema: AUTHORING_APPLY_SCHEMA,
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'projectId',
          'documentId',
          'expectedWorkspaceDigest',
          'expectedAcceptedSourceHash',
          'replacementText',
        ]);
        if (!parsed.ok) return parsed.result;
        const project = requireOpenProject(parsed.value, session.projectId);
        if (project !== null) return project;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const documentId = requiredString(parsed.value, 'documentId');
        if (!documentId.ok) return documentId.result;
        const digest = requiredString(parsed.value, 'expectedWorkspaceDigest');
        if (!digest.ok) return digest.result;
        const expectedAccepted = nullableStringField(parsed.value, 'expectedAcceptedSourceHash');
        if (!expectedAccepted.ok) return expectedAccepted.result;
        const replacement = requiredString(parsed.value, 'replacementText');
        if (!replacement.ok) return replacement.result;
        const request: McpAuthoringApplyInputV1 = {
          version: 1,
          projectId: session.projectId,
          documentId: documentId.value,
          expectedWorkspaceDigest: digest.value,
          expectedAcceptedSourceHash: expectedAccepted.value,
          replacementText: replacement.value,
        };
        return authoringApplyResult(await coordinator.apply(request));
      },
    },
    {
      name: MCP_TOOL_AUTHORING_SUBMIT,
      description:
        'Explicit submit of the working layer through the coordinator; the workspace digest CAS is required.',
      requiredScopes: [MCP_SUBMIT_SCOPE],
      inputSchema: AUTHORING_SUBMIT_SCHEMA,
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'projectId',
          'expectedWorkspaceDigest',
          'message',
        ]);
        if (!parsed.ok) return parsed.result;
        const project = requireOpenProject(parsed.value, session.projectId);
        if (project !== null) return project;
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
        const request: McpAuthoringSubmitInputV1 = {
          version: 1,
          projectId: session.projectId,
          expectedWorkspaceDigest: digest.value,
          ...(message !== undefined ? { message } : {}),
        };
        return authoringAsyncResult(await coordinator.submit(request));
      },
    },
    {
      name: MCP_TOOL_OPERATION_GET,
      description: 'One authoring operation receipt by id; never executes anything.',
      requiredScopes: [MCP_SUBMIT_SCOPE],
      inputSchema: OPERATION_GET_SCHEMA,
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, ['version', 'operationId']);
        if (!parsed.ok) return parsed.result;
        const coordinator = options.coordinator;
        if (coordinator === undefined) return NO_AUTHORING_COORDINATOR;
        const operationId = requiredString(parsed.value, 'operationId');
        if (!operationId.ok) return operationId.result;
        const request: McpOperationGetInputV1 = {
          version: 1,
          operationId: operationId.value,
        };
        return mcpToolOk(await coordinator.getOperation(request));
      },
    },
    {
      name: MCP_TOOL_CONFLICT_RESOLVE,
      description:
        'Resolve an external candidate or working-vs-external conflict with a predefined choice.',
      requiredScopes: [MCP_SUBMIT_SCOPE],
      inputSchema: CONFLICT_RESOLVE_SCHEMA,
      run: async (_caller, input) => {
        const parsed = parseToolInput(input, [
          'version',
          'projectId',
          'choice',
          'candidateHash',
        ]);
        if (!parsed.ok) return parsed.result;
        const project = requireOpenProject(parsed.value, session.projectId);
        if (project !== null) return project;
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
          version: 1,
          projectId: session.projectId,
          choice,
          candidateHash: candidateHash.value,
        };
        return authoringAsyncResult(await coordinator.resolveConflict(request));
      },
    },
    {
      name: MCP_TOOL_ADMIN_CONFIG_PREVIEW,
      description:
        'Owner-only: preview a versioned configuration change (revision CAS). No secrets, no tokens, no paths in the result.',
      requiredScopes: [MCP_ADMIN_SCOPE],
      inputSchema: ADMIN_CONFIG_REQUEST_SCHEMA,
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
      name: MCP_TOOL_ADMIN_CONFIG_APPLY,
      description:
        'Owner-only: apply a versioned configuration change under a revision CAS; stale revisions are typed failures.',
      requiredScopes: [MCP_ADMIN_SCOPE],
      inputSchema: ADMIN_CONFIG_REQUEST_SCHEMA,
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

  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    projectId: session.projectId,
    session,
    availableScopes: [...new Set(definitions.flatMap((definition) => definition.requiredScopes))],
    list(permittedScopes) {
      return definitions.filter((definition) =>
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
