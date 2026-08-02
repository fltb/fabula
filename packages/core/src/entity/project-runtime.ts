// ============================================================================
// Novalistically — Canonical Project Compilation Kernel (package-private)
//
// The canonical immutable source-snapshot → NovelIR → runtime path in Core.
// `loadCanonicalProject` maps each authored source snapshot once and returns
// fresh arrays, registries, catalogs, and runtime inputs. No Host path,
// filesystem adapter, or mutable runtime object is retained between calls.
// The mapper pass is memoized per canonical `sourceHash`; every call returns
// fresh clones, never the cached internals.
//
// `compileCanonicalRuntime` resolves the branch/discourse route and calls
// `compileNarrativeRuntime` exactly once per invocation.
//
// This module is package-private: it is NOT exported from entity/index.ts,
// the core root, or public-api.manifest.json.
// ============================================================================

import type { CompiledGameDialogueTree } from '../branch/game-dialogue-tree.ts';
import { compileGameDialogueTree } from '../branch/game-dialogue-tree.ts';
import { branchPathsEqual, createEmptyBranchPath } from '../branch/index.js';
import type { ProjectSourceSnapshotV1 } from '../contracts/source.js';
import { ConfigError } from '../errors.ts';
import { parseIntroductionTransition } from '../state/event-application.ts';
import type { CompiledNarrativeRuntime } from '../state/narrative-runtime.ts';
import { compileNarrativeRuntime } from '../state/narrative-runtime.ts';
import type { RuntimeEntityTypeCatalog } from '../types/entity-catalog.js';
import type {
  BranchPath,
  EntityCatalogContext,
  EntityDeclaration,
  EntityDeclarationCatalog,
  EntityKind,
  Fact,
  NarrativeEvent,
} from '../types/index.js';
import { compileEntityTypeCatalog } from './entity-catalog-compiler.js';
import {
  type CanonicalFactValue,
  canonicalDeepEqual,
  canonicalizeFactValue,
} from './fact-value.js';
import { EntityMapper } from './mapper.js';
import { InMemoryEntityRegistry } from './registry.js';
import { factIdFrom, resolveTemporalContext } from './timestamp.js';
import type { ProjectData } from './types.js';

/** Internal declaration catalog version — cache identity only, not author-facing. */
const RUNTIME_DECLARATION_CATALOG_VERSION = 1;
/** Internal runtime type schema version — cache identity only, not author-facing. */
const RUNTIME_TYPE_SCHEMA_VERSION = 1;
/** Baseline story coordinate for authored initial facts. */
const INITIAL_FACT_STORY_TIME = { type: 'absolute' as const, value: 'day_0' };

// ============================================================================
// Bounded content-only memoization. The cache is keyed exclusively by the
// canonical `ProjectSourceSnapshotV1.sourceHash` — never by object identity,
// host path, or Git/persistence provenance. Each entry owns the outputs of
// exactly one successful mapper pass; failed mappings are never stored and
// entries are only handed out as fresh structured clones per call.
interface ProjectSourceCacheEntry {
  readonly data: ProjectData;
  readonly events: NarrativeEvent[];
}
const projectCache = new Map<string, ProjectSourceCacheEntry>();
const PROJECT_CACHE_LIMIT = 8;

/** Resolve the cached mapper outputs for a source hash, mapping on a miss. */
function cacheSource(hash: string, snapshot: ProjectSourceSnapshotV1): ProjectSourceCacheEntry {
  const cached = projectCache.get(hash);
  if (cached) return cached;
  const mapper = new EntityMapper(snapshot);
  const data = mapper.loadProject();
  const events = mapper.loadAllEvents(data);
  const entry: ProjectSourceCacheEntry = { data, events };
  projectCache.set(hash, entry);
  if (projectCache.size > PROJECT_CACHE_LIMIT) {
    const oldest = projectCache.keys().next().value;
    if (oldest !== undefined) projectCache.delete(oldest);
  }
  return entry;
}

// ============================================================================
// CanonicalProjectIR — one compiled internal representation per project
// ============================================================================

export interface CanonicalProjectIR {
  readonly sourceHash: string;
  readonly data: ProjectData;
  /** Renderable event-file events only (scoped; no synthetic transitions). */
  readonly authoredEvents: readonly NarrativeEvent[];
  /** Authored + system:introduction:* + system:branch-choice:* transitions. */
  readonly runtimeEvents: readonly NarrativeEvent[];
  readonly initialFacts: readonly Fact[];
  readonly initialThreads: readonly { id: string }[];
  readonly registry: InMemoryEntityRegistry;
  readonly entityDeclarations: EntityDeclarationCatalog;
  readonly entityTypes: RuntimeEntityTypeCatalog;
  /** The one shared catalog pair threaded to StateManager and compileNarrativeRuntime. */
  readonly catalogContext: EntityCatalogContext;
  readonly gameDialogueTree: CompiledGameDialogueTree | null;
  readonly chapterByEventId: Readonly<Record<string, number>>;
}

// ============================================================================
// Authored introduction (event activation boundary) collection
// ============================================================================

interface IntroductionSource {
  entityId: string;
  kind: 'character' | 'location' | 'item' | 'concept';
  hostEventId: string;
  initialState: Record<string, unknown>;
}

interface DefinitionEntry {
  kind: EntityKind;
  initialState: Record<string, unknown> | undefined;
}

function buildDefinitionIndex(data: ProjectData): Map<string, DefinitionEntry> {
  const index = new Map<string, DefinitionEntry>();
  for (const char of data.characters) {
    index.set(char.id, { kind: 'character', initialState: char.initialState });
  }
  for (const loc of data.locations) {
    index.set(loc.id, { kind: 'location', initialState: loc.initialState });
  }
  for (const item of data.items) {
    index.set(item.id, { kind: 'item', initialState: item.initialState });
  }
  for (const fac of data.factions) {
    index.set(fac.id, { kind: 'faction', initialState: fac.initialState });
  }
  return index;
}

/**
 * Event id → authored YAML logical path.
 */
function buildEventFilePathIndex(data: ProjectData): Map<string, string> {
  const index = new Map<string, string>();
  for (const chapter of data.chapters.values())
    for (const event of chapter.events)
      if (event.logicalPath) index.set(event.event, event.logicalPath);
  return index;
}

function collectIntroductions(
  authoredEvents: readonly NarrativeEvent[],
): Map<string, IntroductionSource> {
  const introductions = new Map<string, IntroductionSource>();
  for (const event of authoredEvents) {
    for (const intro of event.introduces ?? []) {
      const existing = introductions.get(intro.id);
      if (existing) {
        throw new ConfigError(
          `Entity "${intro.id}" is introduced by both event "${existing.hostEventId}" and event "${event.id}" — ` +
            `each entity may be introduced by exactly one event`,
          { path: `event:${event.id}.introduces.${intro.id}`, phase: 'introductions' },
        );
      }
      introductions.set(intro.id, {
        entityId: intro.id,
        kind: intro.type,
        hostEventId: event.id,
        initialState: { ...intro.initialState },
      });
    }
  }
  return introductions;
}

// ============================================================================
// Declaration catalog — every entity declared before any activation
// ============================================================================

function buildDeclarationCatalog(
  data: ProjectData,
  introductions: ReadonlyMap<string, IntroductionSource>,
): EntityDeclarationCatalog {
  const declarations: Record<string, EntityDeclaration> = {};
  const eventFilePath = buildEventFilePathIndex(data);
  const definitionFileOf = (hostEventId: string, entityId: string): string => {
    const logicalPath = eventFilePath.get(hostEventId);
    if (!logicalPath)
      throw new ConfigError(`Introduction of "${entityId}" cannot be located`, {
        eventId: hostEventId,
        phase: 'introductions',
      });
    return logicalPath;
  };
  const add = (entityId: string, kind: EntityKind, name: string, definitionFile: string): void => {
    if (declarations[entityId] !== undefined) return;
    const intro = introductions.get(entityId);
    declarations[entityId] = {
      entityId,
      typeRef: { typeId: kind, schemaVersion: RUNTIME_TYPE_SCHEMA_VERSION },
      immutableMetadata: { name, definitionFile },
      introduction: intro ? { type: 'event', eventId: intro.hostEventId } : { type: 'initial' },
    };
  };
  for (const char of data.characters)
    add(char.id, 'character', char.name, `definitions/characters/${char.id}.yaml`);
  for (const loc of data.locations)
    add(loc.id, 'location', loc.name, `definitions/locations/${loc.id}.yaml`);
  for (const item of data.items)
    add(item.id, 'item', item.name, `definitions/items/${item.id}.yaml`);
  for (const fac of data.factions)
    add(fac.id, 'faction', fac.name, `definitions/factions/${fac.id}.yaml`);
  for (const rule of data.rules)
    add(
      rule.ruleId,
      'rule',
      rule.name,
      `definitions/rules/${rule.ruleId.split('.').pop() ?? rule.ruleId}.yaml`,
    );
  for (const wf of data.worldInitialState?.worldFacts ?? [])
    add(wf.id, 'concept', wf.id, 'definitions/state_initial.yaml');
  for (const intro of introductions.values())
    if (declarations[intro.entityId] === undefined)
      add(
        intro.entityId,
        intro.kind,
        intro.entityId,
        definitionFileOf(intro.hostEventId, intro.entityId),
      );
  return { declarations, version: RUNTIME_DECLARATION_CATALOG_VERSION };
}

// ============================================================================
// system:introduction transitions — one per event activation, placed
// immediately before its authored target event (same story coordinate,
// same branch scope; never relocated by story/narrative order).
// ============================================================================

function makeIntroductionTransition(
  target: NarrativeEvent,
  intro: IntroductionSource,
): NarrativeEvent {
  const scope = target.branchExistence;
  const postconditions: Fact[] = [
    {
      id: factIdFrom(intro.entityId, 'lifecycle'),
      entityId: intro.entityId,
      attribute: 'lifecycle',
      value: 'active',
      operation: 'set',
      confidence: 1.0,
      validity: { temporal: { start: target.storyTime, end: null }, branches: scope },
    },
    ...Object.entries(intro.initialState).map(([attribute, value]) => ({
      id: factIdFrom(intro.entityId, attribute),
      entityId: intro.entityId,
      attribute,
      value,
      operation: 'set' as const,
      confidence: 1.0,
      validity: { temporal: { start: target.storyTime, end: null }, branches: scope },
    })),
  ];
  const id = `system:introduction:${target.id}:${intro.entityId}`;
  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder: target.narrativeOrder - 0.5,
    title: `Introduce ${intro.entityId} before ${target.id}`,
    storyTime: target.storyTime,
    sceneType: 'linear',
    pov: { character: 'system', type: 'omniscient' },
    sceneBrief: `Activate entity ${intro.entityId} before event ${target.id}.`,
    beats: [`Activate entity ${intro.entityId}.`],
    preconditions: [],
    postconditions,
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'system',
    branchExistence: scope,
    participants: { entities: [intro.entityId] },
    causalPredecessors: target.causalPredecessors ? [...target.causalPredecessors] : undefined,
  };
}

// ============================================================================
// Initial facts — only initial-activation declarations + state_initial concepts
// ============================================================================

function buildInitialFacts(
  entityDeclarations: EntityDeclarationCatalog,
  registry: InMemoryEntityRegistry,
): Fact[] {
  const facts: Fact[] = [];
  const byKey = new Map<string, CanonicalFactValue>();
  const addFact = (entityId: string, attribute: string, value: unknown): void => {
    // STATE-1: only canonical values may enter the fact store — normalize the
    // authored (unknown) value before any comparison or storage.
    const canonicalValue = canonicalizeFactValue(value);
    const key = `${entityId}.${attribute}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      if (canonicalDeepEqual(existing, canonicalValue)) return; // dedupe equal facts
      throw new ConfigError(
        `Conflicting initial facts for "${key}": both set but with different values`,
        { path: `initial:${key}`, phase: 'introductions' },
      );
    }
    const fact: Fact = {
      id: factIdFrom(entityId, attribute),
      entityId,
      attribute,
      value: canonicalValue,
      validity: {
        temporal: { start: INITIAL_FACT_STORY_TIME, end: null },
        branches: { type: 'all' as const },
      },
    };
    byKey.set(key, canonicalValue);
    facts.push(fact);
  };

  for (const declaration of Object.values(entityDeclarations.declarations)) {
    if (declaration.introduction.type !== 'initial') continue;
    const entity = registry.resolve(declaration.entityId);
    if (!entity) continue;
    // Pure deterministic derivation: every baseline entity is active —
    // unless the authored state already declares a lifecycle (author wins).
    if (!('lifecycle' in entity.state)) {
      addFact(declaration.entityId, 'lifecycle', 'active');
    }
    for (const [attribute, value] of Object.entries(entity.state)) {
      addFact(declaration.entityId, attribute, value);
    }
  }
  return facts;
}

function buildChapterIndex(data: ProjectData): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [chapterNum, chapter] of data.chapters) {
    for (const event of chapter.events) {
      result[event.event] = chapterNum;
    }
  }
  return result;
}

// ============================================================================
// Public package-private kernel surface
// ============================================================================

export function loadCanonicalProject(snapshot: ProjectSourceSnapshotV1): CanonicalProjectIR {
  const hash = snapshot.sourceHash;
  const source = cacheSource(hash, snapshot);
  const data = structuredClone(source.data);
  const authoredEvents = structuredClone(source.events);
  const introductions = collectIntroductions(authoredEvents);
  const definitionIndex = buildDefinitionIndex(data);
  for (const [entityId, intro] of introductions) {
    const definition = definitionIndex.get(entityId);
    if (definition && Object.keys(definition.initialState ?? {}).length > 0) {
      throw new ConfigError(
        `Entity "${entityId}" is introduced by event "${intro.hostEventId}" but its definition still declares initialState`,
        { path: `definitions:${entityId}`, phase: 'introductions' },
      );
    }
  }
  const registry = new InMemoryEntityRegistry();
  registry.load(data, [...introductions.keys()]);

  // Register definition-less introduced entities — the registry never
  // creates placeholders for deferred ids, so these are registered here
  const eventFilePath = buildEventFilePathIndex(data);
  for (const intro of introductions.values()) {
    if (registry.resolve(intro.entityId) !== null) continue;
    const logicalPath = eventFilePath.get(intro.hostEventId);
    if (!logicalPath)
      throw new ConfigError(`Introduction host event "${intro.hostEventId}" not found`, {
        eventId: intro.hostEventId,
        phase: 'introductions',
      });
    registry.register({
      id: intro.entityId,
      kind: intro.kind,
      name: intro.entityId,
      definitionFile: logicalPath,
      lifecycle: 'active',
      typeRef: { typeId: intro.kind, schemaVersion: RUNTIME_TYPE_SCHEMA_VERSION },
      state: { ...intro.initialState },
    });
  }
  const entityTypes = compileEntityTypeCatalog(data.entityTypeCatalogSource);
  const entityDeclarations = buildDeclarationCatalog(data, introductions);
  const catalogContext: EntityCatalogContext = {
    entityDeclarationCatalog: entityDeclarations,
    entityTypeCatalog: entityTypes,
  };
  const gameDialogueTree = compileGameDialogueTree(
    authoredEvents,
    resolveTemporalContext(authoredEvents, data.timeAnchors),
  );
  const introductionTransitions: NarrativeEvent[] = [];
  for (const intro of introductions.values()) {
    const host = authoredEvents.find((event) => event.id === intro.hostEventId);
    if (!host)
      throw new ConfigError(`Introduction host event "${intro.hostEventId}" not found`, {
        eventId: intro.hostEventId,
        phase: 'introductions',
      });
    const transition = makeIntroductionTransition(host, intro);
    introductionTransitions.push(transition);
    const predecessors = host.causalPredecessors ?? [];
    if (!predecessors.includes(transition.id)) {
      predecessors.push(transition.id);
      host.causalPredecessors = predecessors;
    }
  }
  const transitionsByHost = new Map<string, NarrativeEvent[]>();
  for (const transition of introductionTransitions) {
    const targetId = parseIntroductionTransition(transition.id)?.targetEventId;
    if (targetId)
      transitionsByHost.set(targetId, [...(transitionsByHost.get(targetId) ?? []), transition]);
  }
  const orderedBaseEvents = [...authoredEvents, ...(gameDialogueTree?.transitionEvents ?? [])].sort(
    (a, b) => a.narrativeOrder - b.narrativeOrder,
  );
  const runtimeEvents: NarrativeEvent[] = [];
  for (const event of orderedBaseEvents) {
    if (event.source === 'event_file')
      runtimeEvents.push(...(transitionsByHost.get(event.id) ?? []));
    runtimeEvents.push(event);
  }
  return {
    sourceHash: hash,
    data,
    authoredEvents,
    runtimeEvents,
    initialFacts: buildInitialFacts(entityDeclarations, registry),
    initialThreads: (data.worldInitialState?.threads ?? []).map((thread) => ({ id: thread.id })),
    registry,
    entityDeclarations,
    entityTypes,
    catalogContext,
    gameDialogueTree,
    chapterByEventId: buildChapterIndex(data),
  };
}

/**
 * Compile the canonical narrative runtime for one branch/discourse route.
 *
 * The route check intentionally happens before graph/discourse compilation:
 * game-dialogue projects must receive one complete leaf when a branch path is
 * supplied, while an omitted path keeps the existing no-route behavior.
 */
export function compileCanonicalRuntime(
  ir: CanonicalProjectIR,
  options?: { branchPath?: BranchPath; discourseBranch?: string },
): CompiledNarrativeRuntime {
  const branchPath = options?.branchPath ?? createEmptyBranchPath();
  if (ir.gameDialogueTree && options?.branchPath) {
    if (!ir.gameDialogueTree.leafPaths.some((leafPath) => branchPathsEqual(leafPath, branchPath))) {
      throw new ConfigError(
        'Game dialogue assembly requires one complete, ordered leaf --branch-path',
        { phase: 'game_dialogue_tree' },
      );
    }
  }
  return compileNarrativeRuntime({
    events: ir.runtimeEvents,
    initialFacts: ir.initialFacts,
    timeAnchors: ir.data.timeAnchors,
    branchPath,
    discourseBranch: options?.discourseBranch ?? 'main',
    ledger: ir.data.discourseLedger,
    assertions: ir.data.narratorAssertions,
    narratorProfiles: ir.data.narratorProfiles,
    initialThreads: ir.initialThreads,
    catalogs: ir.catalogContext,
  });
}
