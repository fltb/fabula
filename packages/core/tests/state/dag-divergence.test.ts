// ============================================================================
// dag-divergence.test.ts — Causal-order replay vs DAG-position state queries.
//
// Fixture (hero declared 'character', event-introduced by B):
//   T: system:introduction:B:hero  storyTime=day_0 → activates hero (name)
//   B: narrativeOrder=1, storyTime=day_9 → writes hero.status="first"
//   A: narrativeOrder=2, storyTime=day_1 → writes hero.status="second"
//   C: narrativeOrder=3, storyTime=day_5 → writes hero.location="end"
//
// Causal order (storyTime edges): T(day_0) → A(day_1) → C(day_5) → B(day_9)
// Narrative order:                 B(1) → A(2) → C(3)
//
// replay() applies events in causal order: T, A, C, B.
//   A writes status="second"; B is causally latest (day_9) and writes
//   "first" last → status="first". C writes location="end".
//
// getStateAt(position) applies the first `position` causally-ordered events:
//   position 0 = baseline (empty), 4 = after T+A+C+B (matches replay()).
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import { buildStoryOrderIndex } from '../../src/state/dag.ts';
import { ReplayEngine } from '../../src/state/replay.ts';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';
import type {
  EntityCatalogContext,
  EntityDeclarationCatalog,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
  Fact,
  NarrativeEvent,
} from '../../src/types/index.ts';

// ─── Synthetic catalog (explicit; no default catalog) ───────────────────────

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    location: {
      attributeId: 'location',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: [] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const SYNTHETIC_SOURCE: EntityTypeCatalogSource = {
  types: { character: CHARACTER_SOURCE },
};

const TYPE_CATALOG: EntityTypeCatalog = compileEntityTypeCatalog(SYNTHETIC_SOURCE);

function makeDeclarationCatalog(): EntityDeclarationCatalog {
  return {
    declarations: {
      hero: {
        entityId: 'hero',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
        introduction: { type: 'event', eventId: 'B' },
      },
    },
    version: 1,
  };
}

const CATALOG_CONTEXT: EntityCatalogContext = {
  entityDeclarationCatalog: makeDeclarationCatalog(),
  entityTypeCatalog: TYPE_CATALOG,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function fact(entityId: string, attribute: string, value: unknown): Fact {
  return {
    id: `${entityId}.${attribute}`,
    entityId,
    attribute,
    value,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  };
}

function event(
  id: string,
  day: number,
  narrativeOrder: number,
  preconditions: Fact[] = [],
  postconditions: Fact[] = [],
): NarrativeEvent {
  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder,
    title: id,
    storyTime: { type: 'absolute', value: `day_${day}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'first_person' },
    sceneBrief: id,
    beats: [id],
    preconditions,
    postconditions,
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
  };
}

/** Canonical introduction transition: activates hero at day_0, before A(day_1). */
function heroIntroduction(): NarrativeEvent {
  const transition = event(
    'system:introduction:B:hero',
    0,
    0.5,
    [],
    [fact('hero', 'name', 'Hero')],
  );
  return { ...transition, participants: { entities: ['hero'] } };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DAG ordering: causal-order replay vs DAG-position state queries', () => {
  it('replay() produces causally-correct state (B is latest at day_9)', () => {
    const engine = new ReplayEngine(CATALOG_CONTEXT);
    const T = heroIntroduction();
    // B is causally latest (day_9) and applies last → status="first"
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const A = event('A', 1, 2, [], [fact('hero', 'status', 'second')]);
    const C = event('C', 5, 3, [], [fact('hero', 'location', 'end')]);

    const state = engine.replay([T, B, A, C]);
    // Causal order: T(day_0) → A(day_1) → C(day_5) → B(day_9);
    // B applies last → status="first" overrides A's "second"
    expect(state.entities.hero?.status).toBe('first');
    expect(state.entities.hero?.location).toBe('end');
  });

  it('getStateAt with position produces consistent state', () => {
    const engine = new ReplayEngine(CATALOG_CONTEXT);
    const T = heroIntroduction();
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const A = event('A', 1, 2, [], [fact('hero', 'status', 'second')]);
    const C = event('C', 5, 3, [], [fact('hero', 'location', 'end')]);

    // Causal order: T(0) → A(1) → C(5) → B(9)
    // Position 0 = baseline, 1 = after T (hero live), 2 = after T+A,
    // 3 = after T+A+C, 4 = after T+A+C+B
    const state0 = engine.getStateAt([T, B, A, C], 0);
    expect(state0.entities).toEqual({});

    // Live activation: the introduction transition makes hero live at day_0
    const state1 = engine.getStateAt([T, B, A, C], 1);
    expect(state1.entities.hero?.name).toBe('Hero');

    const state4 = engine.getStateAt([T, B, A, C], 4);
    expect(state4.entities.hero?.status).toBe('first');
    expect(state4.entities.hero?.location).toBe('end');

    // getStateAt matches replay() for full position
    const fullReplay = engine.replay([T, B, A, C]);
    expect(state4.entities.hero?.status).toBe(fullReplay.entities.hero?.status);
  });
});

// ============================================================================
// Determinism — identical inputs produce identical semantic outputs
// regardless of wall-clock time. DAG ordering and story-boundary
// compilation are pure (no Date.now()/new Date() in the production path),
// so varying the injected clock must not change any result.
// ============================================================================

describe('DAG determinism: identical inputs produce equal outputs independent of wall-clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buildStoryOrderIndex returns the same order and reachability at different clock times', () => {
    const ids = ['E_beta', 'E_alpha', 'E_gamma'];
    const adjacency = new Map<string, string[]>([
      ['E_alpha', ['E_beta']],
      ['E_beta', ['E_gamma']],
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first = buildStoryOrderIndex(null, ids, adjacency, new Map());

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const second = buildStoryOrderIndex(null, ids, adjacency, new Map());

    expect(second).toEqual(first);
    expect(first.topologicalOrder).toEqual(['E_alpha', 'E_beta', 'E_gamma']);
    expect(first.ancestorsByEventId.get('E_gamma')).toEqual(new Set(['E_alpha', 'E_beta']));
    expect(first.initialRootId).toBeNull();
  });

  it('compileStoryBoundaries produces identical boundary states at different clock times', () => {
    const T = heroIntroduction();
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const A = event('A', 1, 2, [], [fact('hero', 'status', 'second')]);
    const C = event('C', 5, 3, [], [fact('hero', 'location', 'end')]);
    const events = [T, B, A, C];
    // Causal order: T(day_0) → A(day_1) → C(day_5) → B(day_9)
    const adjacency = new Map<string, string[]>([
      [T.id, ['A']],
      ['A', ['C']],
      ['C', ['B']],
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first = compileStoryBoundaries(events, [], adjacency, CATALOG_CONTEXT);

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const second = compileStoryBoundaries(events, [], adjacency, CATALOG_CONTEXT);

    // Deep equality across all semantic outputs, including every boundary map.
    expect(second).toEqual(first);
    expect(second.orderedEventIds).toEqual(first.orderedEventIds);
    expect(second.stateBeforeByEventId).toEqual(first.stateBeforeByEventId);
    expect(second.stateAfterByEventId).toEqual(first.stateAfterByEventId);
    expect(second.finalState).toEqual(first.finalState);

    // Topological causal ordering preserved: T → A → C → B, with B (day_9)
    // causally latest so its status="first" overrides A's "second".
    expect(first.orderedEventIds).toEqual([T.id, 'A', 'C', 'B']);
    expect(first.stateAfterByEventId.get('B')?.entities.hero?.status).toBe('first');
    expect(first.finalState.entities.hero?.status).toBe('first');
    expect(first.finalState.entities.hero?.location).toBe('end');
    expect(first.finalState.entities.hero?.name).toBe('Hero');
  });
  it('replays legacy rule effects to identical WorldState at different clock times', () => {
    const T = heroIntroduction();
    const A: NarrativeEvent = {
      ...event('A', 1, 2),
      ruleEffects: [{ rule: 'magic_conservation', effect: 'reinforce', evidence: 'A casts' }],
    };
    const C: NarrativeEvent = {
      ...event('C', 5, 3),
      ruleEffects: [
        { rule: 'magic_conservation', effect: 'introduce_exception', evidence: 'C is exempt' },
      ],
    };
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const events = [T, A, C, B];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first = new ReplayEngine(CATALOG_CONTEXT).replay(events);

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const second = new ReplayEngine(CATALOG_CONTEXT).replay(events);

    // Full WorldState equality across clocks, including the rules ledger.
    expect(second).toEqual(first);

    // Legacy-derived epoch/exception identities are stable (rule + event ID).
    const magic = first.rules.magic_conservation;
    expect(magic?.currentEpoch).toBe('magic_conservation-epoch-A');
    expect(magic?.activation).toBe('enabled');
    expect(magic?.exceptions[0]?.exceptionId).toBe('magic_conservation-exc-C');
    expect(magic?.exceptions[0]?.status).toBe('active');
  });
});
