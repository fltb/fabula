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
import type { ProjectSession, SessionOperationResult } from '../project-session.js';
import type { McpAuthorizedCaller } from './auth.js';

/** Exact capability scopes for MCP tools. */
export const MCP_READ_SCOPE = 'mcp:read' as const;
export const MCP_RENDER_SCOPE = 'mcp:render' as const;

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

/** Injected render implementation; defaults to Core `renderNovel` over session services. */
export type McpRenderFunction = (
  request: EditorialRenderRequestV1,
  runtime: EditorialRuntime,
) => Promise<RenderNovelResult>;

export interface McpRegistryOptions {
  /** Render implementation seam; tests inject a recording stub. */
  readonly render?: McpRenderFunction;
}

// ─── Input parsing (strict, fail closed, no zod) ─────────────────────────────

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

/** Reject unknown keys so client payloads can never smuggle server-only fields. */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): McpToolResult | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return invalidInput(`Unknown field "${key}"; this tool accepts only: ${allowed.join(', ')}.`);
    }
  }
  return null;
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
  ];

  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    projectId: session.projectId,
    session,
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
