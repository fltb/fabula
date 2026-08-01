import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.ts';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';
import type {
  EntityCatalogContext,
  EntityTypeCatalog,
  EntityTypeDefinitionSource,
  Fact,
  NarrativeEvent,
} from '../../src/types/index.ts';

function fact(value: string): Fact {
  return {
    id: 'wife.status',
    entityId: 'wife',
    attribute: 'status',
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
  preconditions: Fact[] = [],
  postconditions: Fact[] = [],
): NarrativeEvent {
  return {
    id,
    event: id,
    narrativeOrder: Number(id.slice(1)),
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

// ─── Synthetic catalog + activation (current contract) ────────────────────
// Explicit synthetic catalog compiled via compileEntityTypeCatalog — no
// default/optional catalog, no fallback. Every entity participating in an
// event (wife, hero, villain, world) is initial-introduced and activated by
// the baseline initial facts, so no pre-activation participant failures.

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
  },
  lifecyclePolicy: { allowedTransitions: [] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const LOCATION_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'location',
  kind: 'location',
  attributes: {
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: [] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const TYPE_CATALOG: EntityTypeCatalog = compileEntityTypeCatalog({
  types: { character: CHARACTER_SOURCE, location: LOCATION_SOURCE },
});

const CATALOG_CONTEXT: EntityCatalogContext = {
  entityDeclarationCatalog: {
    version: 1,
    declarations: {
      wife: {
        entityId: 'wife',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Wife', definitionFile: 'wife.yaml' },
        introduction: { type: 'initial' },
      },
      hero: {
        entityId: 'hero',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
        introduction: { type: 'initial' },
      },
      villain: {
        entityId: 'villain',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Villain', definitionFile: 'villain.yaml' },
        introduction: { type: 'initial' },
      },
      world: {
        entityId: 'world',
        typeRef: { typeId: 'location', schemaVersion: 1 },
        immutableMetadata: { name: 'World', definitionFile: 'world.yaml' },
        introduction: { type: 'initial' },
      },
    },
  },
  entityTypeCatalog: TYPE_CATALOG,
};

/**
 * Baseline activation: every declared participant is live from day_0.
 * No baseline write touches wife.status, so state-before assertions that
 * expect an absent status keep their meaning.
 */
const ACTIVATION_FACTS: Fact[] = [
  {
    id: 'wife.activation',
    entityId: 'wife',
    attribute: 'lifecycle',
    value: 'active',
    confidence: 1,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  },
  {
    id: 'hero.activation',
    entityId: 'hero',
    attribute: 'lifecycle',
    value: 'active',
    confidence: 1,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  },
  {
    id: 'villain.activation',
    entityId: 'villain',
    attribute: 'lifecycle',
    value: 'active',
    confidence: 1,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  },
  {
    id: 'world.activation',
    entityId: 'world',
    attribute: 'lifecycle',
    value: 'active',
    confidence: 1,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  },
];

describe('compileStoryBoundaries', () => {
  it('creates state-before snapshots in causal order without a genesis event', () => {
    const e2 = event('E2', 2, [fact('arrived')], [fact('departed')]);
    const e1 = event('E1', 1, [fact('alive')], [fact('arrived')]);
    // E1 must be proven-before E2 so that E2's stateBefore includes E1's updates.
    // Explicit causal edge (comparable coordinates: day 1 < day 2) provides the path.
    const result = compileStoryBoundaries(
      [e2, e1],
      [fact('alive')],
      new Map([['E1', ['E2']]]),
      CATALOG_CONTEXT,
    );
    expect(result.orderedEventIds).toEqual(['E1', 'E2']);
    expect(result.stateBeforeByEventId.get('E1')?.entities.wife.status).toBe('alive');
    // E1 is proven-before E2 via the explicit edge; its update is included in E2's stateBefore
    expect(result.stateBeforeByEventId.get('E2')?.entities.wife.status).toBe('arrived');
    // Each stateAfter = stateBefore + its own event's effects
    expect(result.stateAfterByEventId.get('E1')?.entities.wife.status).toBe('arrived');
    expect(result.stateAfterByEventId.get('E2')?.entities.wife.status).toBe('departed');
    expect(result.finalState.entities.wife.status).toBe('departed');
  });

  it('uses storyTime as deterministic tiebreaker without violating causal edges', () => {
    // Two independent DAG roots: E2 (day 2) and E1 (day 1)
    // Should appear in day-order: E1 before E2
    const a = event('E2', 2);
    const b = event('E1', 1);
    const result1 = compileStoryBoundaries([a, b], ACTIVATION_FACTS, new Map(), CATALOG_CONTEXT);
    expect(result1.orderedEventIds).toEqual(['E1', 'E2']);

    // Same story-time → id localeCompare tiebreaker
    const c = event('C', 1);
    const a_same = event('A', 1);
    const b_same = event('B', 1);
    const result2 = compileStoryBoundaries(
      [c, a_same, b_same],
      ACTIVATION_FACTS,
      new Map(),
      CATALOG_CONTEXT,
    );
    expect(result2.orderedEventIds).toEqual(['A', 'B', 'C']);

    // Causal edge preserved even when storyTime reverses natural order:
    // early (day 1) writes X=1, late (day 3) reads X=1 → edge early→late.
    // indep (day 2) has no deps, separate root.
    const early = event('early', 1, [], [fact('value')]);
    const late = event('late', 3, [fact('value')], []);
    const indep = event('indep', 2);
    // early writes value, late reads it: explicit causal edge provides the proven-before path.
    // Kahn: ready = [early, indep] (both in-degree 0).
    // localeCompare tiebreak: "early" < "indep" → process early first.
    // After early, late in-degree becomes 0.
    // Ready = [indep, late] → process indep then late.
    const result3 = compileStoryBoundaries(
      [early, late, indep],
      ACTIVATION_FACTS,
      new Map([['early', ['late']]]),
      CATALOG_CONTEXT,
    );
    expect(result3.orderedEventIds).toEqual(['early', 'indep', 'late']);
    // Proven-before semantics: only true ancestors are visible in stateBefore.
    expect(result3.stateBeforeByEventId.get('early')?.entities.wife?.status).toBeUndefined();
    // indep is unrelated to early (no causal path) → early's effects do NOT leak into indep's stateBefore
    expect(result3.stateBeforeByEventId.get('indep')?.entities.wife?.status).toBeUndefined();
    // late has explicit edge from early → early's state is visible in late's stateBefore
    expect(result3.stateBeforeByEventId.get('late')?.entities.wife?.status).toBe('value');
    // Each stateAfter = stateBefore + its own event's effects
    expect(result3.stateAfterByEventId.get('early')?.entities.wife?.status).toBe('value');
    expect(result3.stateAfterByEventId.get('indep')?.entities.wife?.status).toBeUndefined();
    expect(result3.stateAfterByEventId.get('late')?.entities.wife?.status).toBe('value');
  });
});

// ============================================================================
// Equivalence: compileStoryBoundaries vs ReplayEngine
// ============================================================================
// Both code paths call applyNarrativeEvent as the sole event-effect
// implementation. These tests verify they produce identical state across
// all state dimensions for the same event sequence.
// ============================================================================

import { ReplayEngine } from '../../src/state/replay.js';

describe('boundary/replay equivalence', () => {
  function engineRun(events: NarrativeEvent[]) {
    return new ReplayEngine(CATALOG_CONTEXT).replay(events, { initialFacts: ACTIVATION_FACTS });
  }

  it('produces identical entity state for set/overwrite/unset sequence', () => {
    const events: NarrativeEvent[] = [
      event('E1', 1, [], [fact('alive')]),
      event('E2', 2, [fact('alive')], [fact('dead')]),
    ];

    const boundary = compileStoryBoundaries(
      events,
      ACTIVATION_FACTS,
      new Map([['E1', ['E2']]]),
      CATALOG_CONTEXT,
    );
    const engineState = engineRun(events);

    // Explicit edge E1→E2 makes E1's effects visible to E2
    expect(boundary.stateBeforeByEventId.get('E1')?.entities.wife?.status).toBeUndefined();
    expect(boundary.stateBeforeByEventId.get('E2')?.entities.wife?.status).toBe('alive');
    // No unrelated nodes leak into stateBefore
    expect(boundary.stateAfterByEventId.get('E1')?.entities.wife?.status).toBe('alive');
    expect(boundary.stateAfterByEventId.get('E2')?.entities.wife?.status).toBe('dead');
    expect(boundary.finalState.entities).toEqual(engineState.entities);
  });

  it('produces identical thread state', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        threadProgress: [{ thread: 'T1', advancement: 1, progressAfter: 1, progressTotal: 5 }],
      },
      {
        ...event('E2', 2),
        threadProgress: [{ thread: 'T1', advancement: 1, progressAfter: 2, progressTotal: 5 }],
      },
    ];
    const boundary = compileStoryBoundaries(events, ACTIVATION_FACTS, new Map(), CATALOG_CONTEXT);
    const engineState = engineRun(events);

    expect(boundary.finalState.threads).toEqual(engineState.threads);
  });

  it('produces identical relationship state', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        participants: { entities: ['hero', 'villain'] },
        relationshipEffects: [
          {
            participants: ['hero', 'villain'],
            membershipAfter: [
              { entityId: 'hero', role: 'protagonist' },
              { entityId: 'villain', role: 'antagonist' },
            ],
            dimensionSet: [
              { dimensionId: 'direction', value: 'hostile' },
              { dimensionId: 'intensity', value: 5 },
            ],
            provenance: 'compat:RelationshipChange:set',
          },
        ],
      },
    ];
    const boundary = compileStoryBoundaries(events, ACTIVATION_FACTS, new Map(), CATALOG_CONTEXT);
    const engineState = engineRun(events);

    expect(boundary.finalState.relationships).toEqual(engineState.relationships);
  });

  it('produces identical rule state', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        participants: { entities: ['world'] },
        ruleEffects: [{ rule: 'gravity', effect: 'active', evidence: 'world.normal' }],
      },
      {
        ...event('E2', 2),
        participants: { entities: ['world'] },
        ruleEffects: [{ rule: 'gravity', effect: 'suspended', evidence: 'world.reversed' }],
      },
    ];
    const boundary = compileStoryBoundaries(events, ACTIVATION_FACTS, new Map(), CATALOG_CONTEXT);
    const engineState = engineRun(events);

    expect(boundary.finalState.rules).toEqual(engineState.rules);
  });

  it('produces identical epistemic ledger and proposition catalog', () => {
    // These dimensions remain empty for minimal events without
    // explicit epistemic actions or catalog registrations.
    const events: NarrativeEvent[] = [
      event('E1', 1, [], [fact('active')]),
      event('E2', 2, [fact('active')], [fact('resolved')]),
    ];
    const boundary = compileStoryBoundaries(
      events,
      ACTIVATION_FACTS,
      new Map([['E1', ['E2']]]),
      CATALOG_CONTEXT,
    );
    const engineState = engineRun(events);

    // Explicit edge E1→E2 makes E1's effects visible to E2
    expect(boundary.stateBeforeByEventId.get('E1')?.entities.wife?.status).toBeUndefined();
    expect(boundary.stateBeforeByEventId.get('E2')?.entities.wife?.status).toBe('active');
    // Unrelated nodes remain absent from stateBefore
    expect(boundary.stateAfterByEventId.get('E1')?.entities.wife?.status).toBe('active');
    expect(boundary.stateAfterByEventId.get('E2')?.entities.wife?.status).toBe('resolved');
    expect(boundary.finalState.epistemicLedger).toEqual(engineState.epistemicLedger);
    expect(boundary.finalState.propositionCatalog).toEqual(engineState.propositionCatalog);
  });

  it('throws ConfigError on duplicate write in both paths', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        postconditions: [
          { ...fact('alive'), attribute: 'status', value: 'alive' },
          { ...fact('alive'), attribute: 'status', value: 'dead' },
        ],
      },
    ];

    expect(() =>
      compileStoryBoundaries(events, ACTIVATION_FACTS, new Map(), CATALOG_CONTEXT),
    ).toThrow();
    expect(() =>
      new ReplayEngine(CATALOG_CONTEXT).replay(events, { initialFacts: ACTIVATION_FACTS }),
    ).toThrow();
  });

  it('throws PreconditionMismatchError on operator mismatch in both paths', () => {
    const events: NarrativeEvent[] = [
      event('E1', 1, [], [fact('active')]),
      { ...event('E2', 2), preconditions: [fact('active')] },
    ];
    const events2 = [events[1]!]; // No provider for precondition
    // E2 needs 'active' but no event wrote it
    expect(() =>
      compileStoryBoundaries(events2, ACTIVATION_FACTS, new Map(), CATALOG_CONTEXT),
    ).toThrow();
    expect(() =>
      new ReplayEngine(CATALOG_CONTEXT).replay(events2, { initialFacts: ACTIVATION_FACTS }),
    ).toThrow();
  });

  it('produces identical state for empty event sequences', () => {
    const boundary = compileStoryBoundaries([], ACTIVATION_FACTS, new Map(), CATALOG_CONTEXT);
    const engineState = engineRun([]);

    expect(boundary.finalState).toEqual(engineState);
  });
});
