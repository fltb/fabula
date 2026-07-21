// ============================================================================
// Context Compiler Tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RelevanceEngine,
  ContextAssembler,
  ContextCompiler,
  InMemoryEntityRegistry,
} from '../src/index.js';
import type {
  NarrativeEvent,
  WorldState,
  Entity,
  RelevanceContext,
  ThreadId,
  ThreadRunId,
} from '../src/types/index.js';

function makeEntity(id: string, kind: string, state: Record<string, unknown>): Entity {
  return {
    id,
    kind: kind as any,
    name: id,
    definitionFile: `definitions/${kind}s/${id}.yaml`,
    lifecycle: 'active',
    typeRef: { typeId: kind, schemaVersion: 1 },
    state,
  };
}

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id: 'E1',
    event: 'E1',
    narrativeOrder: 1,
    title: 'Test Event',
    storyTime: { type: 'absolute', value: 'day_1' },
    sceneType: 'linear',
    pov: { character: 'alice', type: 'third_person_limited' },
    sceneBrief: 'Alice enters the room.',
    preconditions: [
      {
        id: 'alice.location',
        entityId: 'alice',
        attribute: 'location',
        value: 'entrance',
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      },
    ],
    postconditions: [
      {
        id: 'alice.location',
        entityId: 'alice',
        attribute: 'location',
        value: 'room',
        validity: { temporal: { start: { type: 'absolute', value: 'day_1' }, end: null }, branches: { type: 'all' } },
      },
    ],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: ['alice', 'bob'] },
    ...overrides,
  };
}

function makeState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    entities: {
      alice: { location: 'entrance', status: 'alive' },
      bob: { location: 'room', status: 'alive' },
      room: { atmosphere: 'tense' },
    },
    relationships: {
      alice_bob: {
        relationshipId: 'alice_bob',
        typeId: 'friendship',
        epochs: {
          epoch_1: {
            epochId: 'epoch_1',
            lifecycle: 'active',
            memberships: {
              mem_alice: { membershipId: 'mem_alice', entityId: 'alice' },
              mem_bob: { membershipId: 'mem_bob', entityId: 'bob' },
            },
            dimensions: {
              'global::intensity': { value: 0.5, scope: 'global', lastUpdatedEffectId: 'evt_1' },
              'global::type': { value: 'friend', scope: 'global', lastUpdatedEffectId: 'evt_1' },
            },
          },
        },
        activeEpochId: 'epoch_1',
      },
    },
    knowledge: {
      alice: { knownFacts: ['alice.location', 'bob.location'] },
    },
    threads: {
      T1: {
        threadId: 'T1' as ThreadId,
        status: 'active',
        currentRunId: 'legacy-T1' as ThreadRunId,
        phase: '',
        bindings: {},
        goalStates: { progress: 'active' },
        milestoneStates: {},
        semanticStateHash: 'h0',
      },
    },
    rules: {},
    facts: [
      {
        id: 'alice.location',
        entityId: 'alice',
        attribute: 'location',
        value: 'entrance',
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      },
    ],
    ...overrides,
  };
}

describe('RelevanceEngine', () => {
  let engine: RelevanceEngine;
  let registry: InMemoryEntityRegistry;

  beforeEach(() => {
    engine = new RelevanceEngine();
    registry = new InMemoryEntityRegistry();

    registry.register(makeEntity('alice', 'character', {
      location: 'entrance',
      status: 'alive',
      traits: ['brave', 'curious'],
      voice_notes: 'Speaks softly.',
    }));
    registry.register(makeEntity('bob', 'character', {
      location: 'room',
      status: 'alive',
      traits: ['cautious'],
      voice_notes: 'Loud and direct.',
    }));
    registry.register(makeEntity('room', 'location', {
      atmosphere: 'tense',
    }));
  });

  it('should score scene participants highest', () => {
    const event = makeEvent();
    const state = makeState();

    const context: RelevanceContext = {
      currentEvent: event,
      worldState: state,
      entityRegistry: registry,
      recentEntities: [],
      activeThreads: [],
    };

    const scores = engine.scoreEntities(context);

    const aliceScore = scores.find((s) => s.entity === 'alice');
    const bobScore = scores.find((s) => s.entity === 'bob');

    expect(aliceScore).toBeDefined();
    expect(bobScore).toBeDefined();
    expect(aliceScore!.basis.participation).toBeGreaterThan(0);
    expect(bobScore!.basis.participation).toBeGreaterThan(0);
  });

  it('should sort by score descending', () => {
    const event = makeEvent();
    const state = makeState();

    const context: RelevanceContext = {
      currentEvent: event,
      worldState: state,
      entityRegistry: registry,
      recentEntities: [],
      activeThreads: [],
    };

    const scores = engine.scoreEntities(context);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].score).toBeGreaterThanOrEqual(scores[i].score);
    }
  });

  it('should apply recency penalty to recently seen entities', () => {
    const event = makeEvent();
    const state = makeState();

    const context: RelevanceContext = {
      currentEvent: event,
      worldState: state,
      entityRegistry: registry,
      recentEntities: ['alice'],
      activeThreads: [],
    };

    const scores = engine.scoreEntities(context);
    const aliceScore = scores.find((s) => s.entity === 'alice')!;
    expect(aliceScore.basis.recencyPenalty).toBeGreaterThan(0);
  });

  it('should give specificity bonus for entities with many preconditions', () => {
    const event = makeEvent({
      preconditions: [
        {
          id: 'alice.location', entityId: 'alice', attribute: 'location', value: 'entrance',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
        {
          id: 'alice.status', entityId: 'alice', attribute: 'status', value: 'alive',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
        {
          id: 'alice.mood', entityId: 'alice', attribute: 'mood', value: 'curious',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const state = makeState();

    const context: RelevanceContext = {
      currentEvent: event,
      worldState: state,
      entityRegistry: registry,
      recentEntities: [],
      activeThreads: [],
    };

    const scores = engine.scoreEntities(context);
    const aliceScore = scores.find((s) => s.entity === 'alice')!;
    expect(aliceScore.basis.specificityBonus).toBeGreaterThan(0);
  });
});

describe('ContextAssembler', () => {
  let assembler: ContextAssembler;
  let registry: InMemoryEntityRegistry;

  beforeEach(() => {
    assembler = new ContextAssembler(8000);
    registry = new InMemoryEntityRegistry();

    registry.register(makeEntity('alice', 'character', {
      location: 'entrance',
      status: 'alive',
      traits: ['brave', 'curious', 'determined'],
      voice_notes: 'Speaks softly but firmly.',
    }));
    registry.register(makeEntity('bob', 'character', {
      location: 'room',
      status: 'alive',
      traits: ['cautious'],
      voice_notes: 'Loud, direct, sometimes abrasive.',
    }));
  });

  it('should produce a complete context package', () => {
    const event = makeEvent();
    const state = makeState();

    const pkg = assembler.assemble(event, state, registry, 'Previous scene summary...');

    expect(pkg.eventId).toBe('E1');
    expect(pkg.systemContext).toBeDefined();
    expect(pkg.sceneSpec).toBeDefined();
    expect(pkg.sceneSpec.povCharacter).toBe('alice');
    expect(pkg.characterSnapshots.length).toBeGreaterThan(0);
    expect(pkg.markdown).toBeTruthy();
  });

  it('should include POV character first in character snapshots', () => {
    const event = makeEvent();
    const state = makeState();

    const pkg = assembler.assemble(event, state, registry);

    expect(pkg.characterSnapshots[0].id).toBe('alice');
  });

  it('should include relationship context when relevant', () => {
    const event = makeEvent();
    const state = makeState();

    const pkg = assembler.assemble(event, state, registry);

    expect(pkg.relationshipContext.length).toBeGreaterThan(0);
  });

  it('should render markdown with all sections', () => {
    const event = makeEvent();
    const state = makeState();

    const pkg = assembler.assemble(event, state, registry, 'Previous summary...');

    expect(pkg.markdown).toContain('System Context');
    expect(pkg.markdown).toContain('Scene Specification');
    expect(pkg.markdown).toContain('Characters');
    expect(pkg.markdown).toContain('Relationships');
    expect(pkg.markdown).toContain('POV Knowledge Boundary');
    expect(pkg.markdown).toContain('Previous Scene Summary');
  });
});

describe('ContextCompiler', () => {
  let compiler: ContextCompiler;
  let registry: InMemoryEntityRegistry;

  beforeEach(() => {
    compiler = new ContextCompiler();
    registry = new InMemoryEntityRegistry();
    registry.register(makeEntity('alice', 'character', {
      location: 'entrance',
      status: 'alive',
      traits: ['brave'],
      voice_notes: 'Soft spoken.',
    }));
  });

  it('should compile a context package', () => {
    const event = makeEvent();
    const state = makeState();

    const pkg = compiler.compile(event, state, registry);

    expect(pkg.eventId).toBe('E1');
    expect(pkg.characterSnapshots.length).toBeGreaterThan(0);
    expect(pkg.markdown).toBeTruthy();
  });

  it('should accept options', () => {
    const event = makeEvent();
    const state = makeState();

    const pkg = compiler.compile(event, state, registry, {
      previousSceneSummary: 'Custom summary',
      systemContext: { genre: 'noir', style: 'literary', narrativeRules: ['Rule 1'] },
    });

    expect(pkg.previousSceneSummary).toBe('Custom summary');
    expect(pkg.systemContext.genre).toBe('noir');
  });

  it('should produce inspector JSON', () => {
    const event = makeEvent();
    const state = makeState();

    const pkg = compiler.compile(event, state, registry);
    const inspection = compiler.inspect(pkg);

    expect(() => JSON.parse(inspection)).not.toThrow();
    const parsed = JSON.parse(inspection);
    expect(parsed.eventId).toBe('E1');
    expect(typeof parsed.characterCount).toBe('number');
  });
});
