import { branchPathToString } from './branch/index.ts';
import type { ProjectSourceSnapshotV1 } from './contracts/source.js';
import {
  EditorialOperationError,
  previewEditorialRun as editorialPreviewRun,
  executeEditorialRender,
  executeEditorialTreeRender,
} from './editorial/index.ts';
import type { PreviewResult } from './editorial/render-service.ts';
import { toPublicEntityTypeCatalog } from './entity/entity-catalog-compiler.js';
import { compileCanonicalRuntime, loadCanonicalProject } from './entity/project-runtime.ts';
import type { CompileProjectOptions, ProjectCompilation } from './entity/types.ts';
import { sanitizeError } from './errors.ts';
import { calculateISS } from './iss/score.ts';
import type { RenderSceneResult } from './pipeline/render.ts';
import { canonicalJson } from './render/scene-contract.ts';
import {
  editorialPreviewRequestV1Schema,
  editorialRenderRequestV1Schema,
  renderGameDialogueTreeRequestV1Schema,
} from './schemas/editorial.ts';
import type { AdjacencyList } from './state/dag.ts';
import { resolveDiscourseBranch } from './state/discourse-sequence.ts';
import type {
  EditorialRenderRequestV1,
  EditorialRuntime,
  RenderGameDialogueTreeRequestV1,
  RenderGameDialogueTreeResult,
  RenderNovelResult,
} from './types/editorial.ts';
import type { EntityLookup } from './types/entity.ts';
import type { CanonicalGraphRuntimeSnapshot } from './types/graph.ts';
import type {
  EntityId,
  EntityKind,
  NarrativeEvent,
  NovelValidationResult,
  ValidationIssue,
  ValidationResult,
} from './types/index.ts';
import { ResultAggregator } from './validator/aggregator.ts';
import { createBuiltInValidators } from './validator/builtins.ts';

export interface ProjectStatusResult {
  events: Array<{
    id: string;
    narrativeOrder: number;
    status: 'rendered' | 'pending' | 'blocked';
    chapter: number;
    wordCount?: number;
  }>;
  threads: Array<{ id: string; progress: number; total: number }>;
  summary: { totalEvents: number; renderedCount: number; blockedCount: number };
}
export interface EntitySummary {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly name: string;
}
export interface EntityDetail extends EntitySummary {
  readonly definitionFile: string;
  readonly state: Readonly<Record<string, unknown>>;
}
export interface DiffResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: string[];
}
export type ImpactLevel = 'green' | 'yellow' | 'red';
export interface ImpactAnalysisResult {
  events: Record<string, ImpactLevel>;
  downstream: Record<string, string[]>;
}

export function compileProject(
  snapshot: ProjectSourceSnapshotV1,
  options?: CompileProjectOptions,
): ProjectCompilation {
  const ir = loadCanonicalProject(snapshot);
  const runtime = compileCanonicalRuntime(ir, options);
  const entitySnapshot = structuredClone(ir.registry.getAll());
  const entities: EntityLookup = Object.freeze({
    resolve: (id: EntityId) => {
      const entity = entitySnapshot.find((candidate) => candidate.id === id);
      return entity ? structuredClone(entity) : null;
    },
    findByKind: (kind: EntityKind) =>
      entitySnapshot
        .filter((entity) => entity.kind === kind)
        .map((entity) => structuredClone(entity)),
    getAll: () => entitySnapshot.map((entity) => structuredClone(entity)),
  });
  return {
    data: structuredClone(ir.data),
    events: structuredClone(ir.authoredEvents),
    runtimeEvents: structuredClone(ir.runtimeEvents),
    initialFacts: structuredClone(ir.initialFacts),
    entityTypes: structuredClone(toPublicEntityTypeCatalog(ir.entityTypes)),
    entityDeclarations: structuredClone(ir.entityDeclarations),
    entities,
    boundaries: structuredClone(runtime.boundaries),
  };
}
export interface ProjectGraphSnapshot {
  readonly adjacency: AdjacencyList;
  readonly events: readonly NarrativeEvent[];
}
export function inspectProjectGraph(
  snapshot: ProjectSourceSnapshotV1,
  options?: CompileProjectOptions,
): ProjectGraphSnapshot {
  const ir = loadCanonicalProject(snapshot);
  const runtime = compileCanonicalRuntime(ir, options);
  return {
    adjacency: structuredClone(runtime.graphs.storyAdjacency),
    events: structuredClone(ir.authoredEvents),
  };
}

/**
 * Return the detached, compiler-owned graph and route artifact for one
 * selected branch/discourse route. Tooling and hosts must render this exact
 * data rather than rebuilding graph nodes, reader order, or branch semantics.
 */
export function inspectCanonicalGraphRuntime(
  snapshot: ProjectSourceSnapshotV1,
  options?: CompileProjectOptions,
): CanonicalGraphRuntimeSnapshot {
  const ir = loadCanonicalProject(snapshot);
  const runtime = compileCanonicalRuntime(ir, options);
  const branchPath = options?.branchPath ?? { decisions: [] };
  const discourseBranch = options?.discourseBranch ?? 'main';
  const gameDialogueTree = ir.gameDialogueTree;
  const route = {
    branchPath,
    branchScope: branchPathToString(branchPath),
    discourseBranch,
    selectedEventIds: runtime.graphs.selectedEvents.map((event) => event.id),
    leafPaths: gameDialogueTree?.leafPaths ?? [branchPath],
    eventScopes: ir.authoredEvents.map((event) => ({
      eventId: event.id,
      branchExistence: gameDialogueTree?.eventScopes.get(event.id) ?? event.branchExistence,
    })),
    choices: ir.authoredEvents.flatMap((event) =>
      (event.choices ?? []).map((choice) => ({
        eventId: event.id,
        choiceId: choice.id,
        label: choice.label,
        description: choice.description,
        targetEventId: choice.targetEvent,
        narrativeOrder: event.narrativeOrder,
      })),
    ),
  };
  return structuredClone({
    story: {
      graph: runtime.graphs.storyGraph,
      nodes: runtime.graphs.storyNodes,
    },
    discourse: {
      graph: runtime.graphs.discourseGraph,
      nodes: runtime.graphs.discourseNodes,
    },
    route,
  });
}
export function buildReleaseDiagnostic(result: RenderSceneResult): string {
  const reason = result.validation?.errors.length
    ? result.validation.errors.map((issue: ValidationIssue) => issue.message).join(' | ')
    : result.errors.length
      ? result.errors.join(' | ')
      : result.analysis === null
        ? 'missing analysis output'
        : result.prose.trim().length === 0
          ? 'empty prose'
          : result.needsReview
            ? 'exhausted retries — needs review'
            : 'release requirements unmet';
  return `${result.eventId}: ${sanitizeError(reason)}`;
}
function validateRuntime(runtime: EditorialRuntime): void {
  if (runtime.provider && runtime.providerFactory)
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'Cannot provide both runtime.provider and runtime.providerFactory. Provide at most one.',
    );
}
export async function renderNovel(
  request: EditorialRenderRequestV1,
  runtime?: EditorialRuntime,
): Promise<RenderNovelResult> {
  const parsed: EditorialRenderRequestV1 = editorialRenderRequestV1Schema.parse(request);
  const rt = runtime ?? {};
  validateRuntime(rt);
  return executeEditorialRender(parsed, rt);
}
export async function renderGameDialogueTree(
  request: RenderGameDialogueTreeRequestV1,
  runtime?: EditorialRuntime,
): Promise<RenderGameDialogueTreeResult> {
  const parsed: RenderGameDialogueTreeRequestV1 =
    renderGameDialogueTreeRequestV1Schema.parse(request);
  const rt = runtime ?? {};
  validateRuntime(rt);
  return executeEditorialTreeRender(parsed, rt);
}
export async function previewEditorialRun(
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  runtime?: EditorialRuntime,
): Promise<PreviewResult> {
  const parsed: Omit<EditorialRenderRequestV1, 'mutation'> =
    editorialPreviewRequestV1Schema.parse(request);
  const rt = runtime ?? {};
  validateRuntime(rt);
  return editorialPreviewRun(parsed, rt);
}

export async function validateNovel(
  snapshot: ProjectSourceSnapshotV1,
  overrides?: Record<string, 'off' | 'warning' | 'error'>,
): Promise<NovelValidationResult> {
  const ir = loadCanonicalProject(snapshot);
  const events = [...ir.authoredEvents];
  const discourseBranch = resolveDiscourseBranch({
    selectedEventIds: new Set(events.map((event) => event.id)),
    branchPath: { decisions: [] },
    ledger: ir.data.discourseLedger,
  });
  const boundaries = compileCanonicalRuntime(ir, { discourseBranch }).boundaries;
  const results = new ResultAggregator(createBuiltInValidators(), ir.entityTypes).validateAll(
    events,
    boundaries.finalState,
    ir.registry,
    {
      overrides: overrides ?? ir.data.config?.validatorOverrides,
      stateBeforeByEventId: boundaries.stateBeforeByEventId,
    },
  );
  const threads = ir.data.worldInitialState?.threads ?? [];
  return {
    passed: [...results.values()].every((result) => result.passed),
    results,
    iss: calculateISS({
      entities: ir.registry,
      events,
      threads: threads.map((thread) => ({ id: thread.id, name: thread.name })),
      rules: ir.data.rules,
    }),
  };
}
function runtimeFor(snapshot: ProjectSourceSnapshotV1) {
  const ir = loadCanonicalProject(snapshot);
  const events = [...ir.authoredEvents];
  const discourseBranch = resolveDiscourseBranch({
    selectedEventIds: new Set(events.map((event) => event.id)),
    branchPath: { decisions: [] },
    ledger: ir.data.discourseLedger,
  });
  return { ir, events, boundaries: compileCanonicalRuntime(ir, { discourseBranch }).boundaries };
}
export function getProjectStatus(
  snapshot: ProjectSourceSnapshotV1,
  validationResults?: Map<string, ValidationResult>,
): ProjectStatusResult {
  const { ir, events, boundaries } = runtimeFor(snapshot);
  const rendered = new Set(
    snapshot.documents.flatMap((document) => {
      const match = /^scenes\/[^/]+\/([^/]+)\.md$/.exec(document.logicalPath);
      return match ? [match[1]] : [];
    }),
  );
  const results =
    validationResults ??
    new ResultAggregator(createBuiltInValidators(), ir.entityTypes).validateAll(
      events,
      boundaries.finalState,
      ir.registry,
      {
        overrides: ir.data.config?.validatorOverrides,
        stateBeforeByEventId: boundaries.stateBeforeByEventId,
      },
    );
  const statuses = events.map((event) => ({
    id: event.id,
    narrativeOrder: event.narrativeOrder,
    status: rendered.has(event.id)
      ? ('rendered' as const)
      : results.get(event.id)?.passed === false
        ? ('blocked' as const)
        : ('pending' as const),
    chapter: ir.chapterByEventId[event.id] ?? 1,
  }));
  const threads = Object.entries(boundaries.finalState.threads).map(([id, data]) => {
    const goals = Object.values(data.goalStates);
    return {
      id,
      progress: goals.filter((state) => state === 'achieved').length,
      total: goals.length,
    };
  });
  return {
    events: statuses,
    threads,
    summary: {
      totalEvents: statuses.length,
      renderedCount: statuses.filter((event) => event.status === 'rendered').length,
      blockedCount: statuses.filter((event) => event.status === 'blocked').length,
    },
  };
}
export function diffEvent(snapshot: ProjectSourceSnapshotV1, eventId: string): DiffResult | null {
  const { boundaries } = runtimeFor(snapshot);
  if (!boundaries.stateBeforeByEventId.has(eventId) && !boundaries.stateAfterByEventId.has(eventId))
    return null;
  const beforeState = boundaries.stateBeforeByEventId.get(eventId) ?? boundaries.finalState;
  const afterState = boundaries.stateAfterByEventId.get(eventId) ?? boundaries.finalState;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const changed: string[] = [];
  const compare = (
    prefix: string,
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ) => {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
        const name = `${prefix}:${key}`;
        before[name] = left[key] ?? null;
        after[name] = right[key] ?? null;
        changed.push(name);
      }
    }
  };
  compare('entity', beforeState.entities, afterState.entities);
  compare('thread', beforeState.threads, afterState.threads);
  compare(
    'relationship',
    beforeState.relationships as Record<string, unknown>,
    afterState.relationships as Record<string, unknown>,
  );
  return { before, after, changed };
}
export function listEntities(snapshot: ProjectSourceSnapshotV1, kind?: string): EntitySummary[] {
  const ir = loadCanonicalProject(snapshot);
  return (kind ? ir.registry.findByKind(kind as EntityKind) : ir.registry.getAll()).map(
    (entity) => ({ id: entity.id, kind: entity.kind, name: entity.name }),
  );
}
export function showEntity(
  snapshot: ProjectSourceSnapshotV1,
  entityId: string,
): EntityDetail | null {
  const entity = loadCanonicalProject(snapshot).registry.resolve(entityId);
  return entity
    ? {
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        definitionFile: entity.definitionFile,
        state: entity.state,
      }
    : null;
}
function conditionKey(fact: {
  entityId: string;
  attribute: string;
  value?: unknown;
  operation?: string;
  narrativeHint?: string;
}): string {
  return `${fact.entityId}:${fact.attribute}:${canonicalJson({ value: fact.value, operation: fact.operation, narrativeHint: fact.narrativeHint })}`;
}
function pairKey(fact: { entityId: string; attribute: string }): string {
  return `${fact.entityId}:${fact.attribute}`;
}
export function analyzeProjectImpact(
  oldSnapshot: ProjectSourceSnapshotV1,
  newSnapshot: ProjectSourceSnapshotV1,
): ImpactAnalysisResult {
  const oldEvents = new Map(
    loadCanonicalProject(oldSnapshot).authoredEvents.map((event) => [event.id, event]),
  );
  const newEvents = new Map(
    loadCanonicalProject(newSnapshot).authoredEvents.map((event) => [event.id, event]),
  );
  const events: Record<string, ImpactLevel> = {};
  const downstream: Record<string, string[]> = {};
  const postconditionPairs = new Map<string, Set<string>>();
  const preconditionPairs = new Map<string, Set<string>>();
  for (const [id, event] of newEvents) {
    postconditionPairs.set(id, new Set(event.postconditions.map(pairKey)));
    preconditionPairs.set(id, new Set(event.preconditions.map(pairKey)));
  }
  const red = new Set<string>();
  for (const id of new Set([...oldEvents.keys(), ...newEvents.keys()])) {
    const oldEvent = oldEvents.get(id);
    const newEvent = newEvents.get(id);
    if (!oldEvent || !newEvent) {
      events[id] = 'red';
      red.add(id);
      continue;
    }
    const preChanged =
      JSON.stringify(oldEvent.preconditions.map(conditionKey).sort()) !==
      JSON.stringify(newEvent.preconditions.map(conditionKey).sort());
    const postChanged =
      JSON.stringify(oldEvent.postconditions.map(conditionKey).sort()) !==
      JSON.stringify(newEvent.postconditions.map(conditionKey).sort());
    if (preChanged || postChanged) {
      events[id] = 'red';
      red.add(id);
      continue;
    }
    const { narrativeOrder: oldNarrativeOrder, ...oldComparable } = oldEvent;
    const { narrativeOrder: newNarrativeOrder, ...newComparable } = newEvent;
    if (canonicalJson(oldComparable) !== canonicalJson(newComparable)) events[id] = 'yellow';
    else if (oldNarrativeOrder !== newNarrativeOrder) events[id] = 'green';
  }
  for (const id of red) {
    const pairs = postconditionPairs.get(id);
    if (!pairs) continue;
    const affected = [...preconditionPairs.entries()]
      .filter(
        ([otherId, preconditions]) =>
          otherId !== id && [...preconditions].some((pair) => pairs.has(pair)),
      )
      .map(([otherId]) => otherId)
      .sort();
    if (affected.length) downstream[id] = affected;
  }
  return { events, downstream };
}
