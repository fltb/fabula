import {
  getProjectStatus,
  listEntities,
  type ProjectSourceSnapshotV1,
  showEntity,
  validateNovel,
} from '@novalistically/core';
import {
  type EditorialRuntime,
  getSourceDocument,
  listSourceDocuments,
  previewSourceChange,
  renderNovel,
  type SceneSelector,
  type SourceChangeV1,
} from '@novalistically/core/editorial';

/**
 * CLI's optional MCP registry is host-bound: callers supply an already-open
 * source projection, an explicit semantic runtime, and the local mutation
 * identity (actor + operation-ID allocator) sourced from the injected
 * runtime/host. It owns no path, storage, credentials, or transport.
 * Workbench supplies the authenticated transport.
 */
export interface HostBoundMcpContext {
  readonly currentSource: () => ProjectSourceSnapshotV1;
  readonly runtime: EditorialRuntime;
  /** Host-supplied local actor identity for mutation attribution; never client-supplied. */
  readonly actorId: string;
  /** Host-supplied operation-ID allocator, sourced from the injected runtime/host; never client-supplied. */
  readonly allocateOperationId: () => string;
  /** Optional host-level render seam; production uses Core renderNovel. */
  readonly render?: typeof renderNovel;
}

export interface HostBoundMcpTool {
  readonly name: string;
  readonly run: (input: unknown) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MCP input must be an object');
  }
  return value as Record<string, unknown>;
}

function selector(value: unknown): SceneSelector {
  const input = asRecord(value);
  if (input.type === 'all') return { type: 'all' };
  if (input.type === 'chapter' && typeof input.chapter === 'number') {
    return { type: 'chapter', chapter: input.chapter };
  }
  if (
    input.type === 'events' &&
    Array.isArray(input.eventIds) &&
    input.eventIds.every((id) => typeof id === 'string')
  ) {
    return { type: 'events', eventIds: input.eventIds };
  }
  throw new Error('Invalid scene selector');
}

/** Return explicit tool definitions suitable for an authenticated Host transport. */
export function createHostBoundMcpTools(context: HostBoundMcpContext): readonly HostBoundMcpTool[] {
  const render = context.render ?? renderNovel;
  return [
    {
      name: 'nova_status',
      run: async () => {
        const source = context.currentSource();
        const validation = await validateNovel(source);
        return {
          status: getProjectStatus(source, new Map(validation.results)),
          iss: validation.iss,
        };
      },
    },
    {
      name: 'nova_validate',
      run: async () => validateNovel(context.currentSource()),
    },
    {
      name: 'nova_source_list',
      run: async () => listSourceDocuments(context.currentSource()),
    },
    {
      name: 'nova_source_get',
      run: async (input) => {
        const { logicalPath } = asRecord(input);
        if (typeof logicalPath !== 'string') throw new Error('logicalPath must be a string');
        return getSourceDocument(context.currentSource(), logicalPath);
      },
    },
    {
      name: 'nova_source_preview',
      run: async (input) => {
        const { changes } = asRecord(input);
        if (!Array.isArray(changes)) throw new Error('changes must be an array');
        return previewSourceChange(context.currentSource(), changes as SourceChangeV1[]);
      },
    },
    {
      name: 'nova_entity_get',
      run: async (input) => {
        const { entityId } = asRecord(input);
        if (typeof entityId !== 'string') throw new Error('entityId must be a string');
        return showEntity(context.currentSource(), entityId);
      },
    },
    {
      name: 'nova_entity_list',
      run: async (input) => {
        const { kind } = asRecord(input);
        if (kind !== undefined && typeof kind !== 'string')
          throw new Error('kind must be a string');
        return listEntities(context.currentSource(), kind as string | undefined);
      },
    },
    {
      name: 'nova_render',
      run: async (input) => {
        const request = asRecord(input);
        // Fail closed: mutation identity is host-derived. Client-supplied
        // actorId/operationId (or any other field) are rejected as unknown.
        const unknown = Object.keys(request).find(
          (key) => key !== 'sceneSelector' && key !== 'model',
        );
        if (unknown !== undefined) {
          throw new Error(
            `Unknown field "${unknown}"; this tool accepts only: sceneSelector, model.`,
          );
        }
        if (request.model !== undefined && typeof request.model !== 'string')
          throw new Error('model must be a string');
        return render(
          {
            version: 1,
            source: context.currentSource(),
            selector: selector(request.sceneSelector),
            mutation: { operationId: context.allocateOperationId(), actorId: context.actorId },
            ...(typeof request.model === 'string' ? { model: request.model } : {}),
          },
          context.runtime,
        );
      },
    },
  ];
}
