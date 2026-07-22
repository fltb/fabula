// ============================================================================
// epistemic-replay.test.ts — EpistemicLedger initialized during replay,
// legacy knowledge shim removed, replay works without KnowledgeState types.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { ReplayEngine } from '../../src/state/replay.js';
import type { NarrativeEvent, Fact } from '../../src/types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let counter = 0;
function makeFact(overrides: Partial<Fact> & { entityId: string; attribute: string }): Fact {
  return {
    id: `fact_${++counter}`,
    value: 'default',
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_1' }, end: null },
      branches: { type: 'all' },
    },
    ...overrides,
  };
}

function makeEvent(
  narrativeOrder: number,
  daySuffix: number | string,
  overrides: Partial<NarrativeEvent> = {},
): NarrativeEvent {
  return {
    id: `E_${narrativeOrder}_${daySuffix}`,
    narrativeOrder,
    title: 'Test Event',
    storyTime: { type: 'absolute', value: `day_${daySuffix}` },
    pov: { character: 'narrator', type: 'first_person' },
    sceneBrief: 'Test scene',
    branchExistence: { type: 'all' },
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    relationshipEffects: [],
    ruleEffects: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EpistemicLedger wiring during replay', () => {
  it('initializes epistemicLedger after replay of empty events', () => {
    const engine = new ReplayEngine();
    const state = engine.replay([]);

    expect(state.epistemicLedger).toBeDefined();
    expect(state.epistemicLedger!.claims).toEqual({});
    expect(state.epistemicLedger!.bySubject).toEqual({});
    expect(state.epistemicLedger!.byProposition).toEqual({});
    expect(state.epistemicLedger!.actLog).toEqual([]);
  });

  it('initializes propositionCatalog after replay of empty events', () => {
    const engine = new ReplayEngine();
    const state = engine.replay([]);

    expect(state.propositionCatalog).toBeDefined();
    expect(state.propositionCatalog!.version).toBe(0);
    expect(state.propositionCatalog!.propositions).toEqual({});
    expect(state.propositionCatalog!.dependencyGraph).toEqual({});
  });

  it('replay works end-to-end without the legacy knowledge shim', () => {
    const engine = new ReplayEngine();

    // An event with a "knows" postcondition — the old shim used to populate
    // state.knowledge[entityId].knownFacts for this; now the epistemic ledger
    // handles it and replay should not crash.
    const knowsPostcondition = makeFact({
      entityId: 'hero',
      attribute: 'knows',
      value: 'fact_secret',
    });

    const event = makeEvent(1, 1, {
      postconditions: [knowsPostcondition],
    });

    const state = engine.replay([event]);

    // Base state fields should be intact
    expect(state.entities).toBeDefined();
    expect(state.entities.hero).toBeDefined();
    // The "knows" attribute was written as an entity attribute (standard set path)
    expect(state.entities.hero.knows).toBe('fact_secret');
    // The epistemic ledger was initialized (not undefined)
    expect(state.epistemicLedger).toBeDefined();
    // The proposition catalog was initialized
    expect(state.propositionCatalog).toBeDefined();
    // No crash from missing state.knowledge shim
    expect(state.facts).toHaveLength(1);
  });

  it('replay with "knowledge" postcondition attribute does not crash', () => {
    const engine = new ReplayEngine();
    const knowledgePostcondition = makeFact({
      entityId: 'hero',
      attribute: 'knowledge',
      value: 'secret_origin',
    });

    const event = makeEvent(2, 1, {
      postconditions: [knowledgePostcondition],
    });

    const state = engine.replay([event]);
    expect(state.entities.hero.knowledge).toBe('secret_origin');
    expect(state.epistemicLedger).toBeDefined();
    expect(state.propositionCatalog).toBeDefined();
  });

  it('replay with narrativeHint-only postcondition does not crash', () => {
    const engine = new ReplayEngine();
    const hintFact = makeFact({
      entityId: 'hero',
      attribute: 'status',
      value: undefined,
      narrativeHint: 'Hero should appear mysterious',
    });

    const event = makeEvent(3, 1, {
      postconditions: [hintFact],
    });

    const state = engine.replay([event]);
    expect(state.epistemicLedger).toBeDefined();
    expect(state.propositionCatalog).toBeDefined();
    expect(state.facts).toHaveLength(1);
  });

  it('both epistemicLedger and propositionCatalog are available after multi-event replay', () => {
    const engine = new ReplayEngine();
    const e1 = makeEvent(1, 1, {
      postconditions: [makeFact({ entityId: 'king', attribute: 'status', value: 'alive' })],
    });
    const e2 = makeEvent(2, 2, {
      preconditions: [makeFact({ entityId: 'king', attribute: 'status', value: 'alive' })],
      postconditions: [makeFact({ entityId: 'king', attribute: 'status', value: 'dead' })],
    });

    const state = engine.replay([e1, e2]);
    expect(state.epistemicLedger).toBeDefined();
    expect(state.propositionCatalog).toBeDefined();
    expect(state.entities.king.status).toBe('dead');
  });
});
