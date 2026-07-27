import { describe, expect, it } from 'vitest';
import type {
  GoalState,
  MilestoneState,
  ThreadDeclaration,
  ThreadDeclarationCatalog,
  ThreadId,
  ThreadRunId,
  ThreadRuntimeState,
  ThreadTransaction,
  ThreadTypeCatalog,
  ThreadTypeDefinition,
} from '../../src/types/index.js';

describe('Thread Identity', () => {
  it('ThreadTypeDefinition has all required fields', () => {
    const typeDef: ThreadTypeDefinition = {
      typeId: 'character_arc',
      description: 'Character development arc',
      allowedPhases: ['setup', 'conflict', 'resolution'],
      lifecyclePolicy: { reopenPolicy: 'allowed' },
      timeDomain: 'story',
      stableGoals: [
        { goalId: 'introduce', status: 'pending' },
        { goalId: 'develop', status: 'pending' },
        { goalId: 'resolve', status: 'pending' },
      ],
      stableMilestones: [
        { milestoneId: 'first_appearance', status: 'pending' },
        { milestoneId: 'turning_point', status: 'pending' },
        { milestoneId: 'climax', status: 'pending' },
      ],
    };

    expect(typeDef.typeId).toBe('character_arc');
    expect(typeDef.allowedPhases).toHaveLength(3);
    expect(typeDef.lifecyclePolicy.reopenPolicy).toBe('allowed');
    expect(typeDef.timeDomain).toBe('story');
    expect(typeDef.stableGoals).toHaveLength(3);
    expect(typeDef.stableMilestones).toHaveLength(3);
  });

  it('ThreadTypeCatalog holds multiple type definitions', () => {
    const catalog: ThreadTypeCatalog = {
      types: {
        character_arc: {
          typeId: 'character_arc',
          description: 'Character development arc',
          allowedPhases: ['setup', 'conflict', 'resolution'],
          lifecyclePolicy: { reopenPolicy: 'allowed' },
          timeDomain: 'story',
          stableGoals: [],
          stableMilestones: [],
        },
        mystery: {
          typeId: 'mystery',
          description: 'Mystery / revelation thread',
          allowedPhases: ['setup', 'investigation', 'reveal'],
          lifecyclePolicy: { reopenPolicy: 'requiresExplicitReason' },
          timeDomain: 'discourse',
          stableGoals: [],
          stableMilestones: [],
        },
      },
    };

    expect(Object.keys(catalog.types)).toHaveLength(2);
    expect(catalog.types.mystery.timeDomain).toBe('discourse');
  });

  it('ThreadDeclaration can override initial states', () => {
    const decl: ThreadDeclaration = {
      threadId: 'T1',
      name: "Xianglin Sao's Fate",
      description: 'Her tragic life arc',
      typeId: 'character_arc',
      initialPhase: 'setup',
      initialBindings: { protagonist: 'xianglins_wife' },
      initialGoalStates: [{ goalId: 'introduce', status: 'active' }],
    };

    expect(decl.threadId).toBe('T1');
    expect(decl.initialBindings!.protagonist).toBe('xianglins_wife');
    expect(decl.initialGoalStates![0].status).toBe('active');
  });

  it('ThreadDeclarationCatalog indexes by threadId', () => {
    const catalog: ThreadDeclarationCatalog = {
      declarations: {
        T1: {
          threadId: 'T1',
          name: 'Mystery Thread',
          description: 'The central mystery',
          typeId: 'mystery',
        },
        T2: {
          threadId: 'T2',
          name: 'Romance Thread',
          description: 'The love story',
          typeId: 'character_arc',
        },
      },
    };

    expect(catalog.declarations.T1).toBeDefined();
    expect(catalog.declarations.T2).toBeDefined();
    expect(catalog.declarations.T1.name).toBe('Mystery Thread');
  });

  it('ThreadId is a branded string type', () => {
    const id = 'T1' as ThreadId;
    expect(typeof id).toBe('string');
    expect(id).toBe('T1');
  });

  it('ThreadRunId is a branded string type', () => {
    const runId = 'run-abc123' as ThreadRunId;
    expect(typeof runId).toBe('string');
    expect(runId).toBe('run-abc123');
  });

  it('GoalState and MilestoneState accept all valid statuses', () => {
    const goalStates: GoalState[] = [
      { goalId: 'g1', status: 'pending' },
      { goalId: 'g2', status: 'active' },
      { goalId: 'g3', status: 'achieved' },
      { goalId: 'g4', status: 'failed' },
      { goalId: 'g5', status: 'waived' },
    ];
    expect(goalStates).toHaveLength(5);
    expect(goalStates.map((g) => g.status)).toEqual([
      'pending',
      'active',
      'achieved',
      'failed',
      'waived',
    ]);

    const milestoneStates: MilestoneState[] = [
      { milestoneId: 'm1', status: 'pending' },
      { milestoneId: 'm2', status: 'achieved' },
      { milestoneId: 'm3', status: 'failed' },
      { milestoneId: 'm4', status: 'waived' },
      { milestoneId: 'm5', status: 'invalidated' },
    ];
    expect(milestoneStates).toHaveLength(5);
    expect(milestoneStates.map((m) => m.status)).toEqual([
      'pending',
      'achieved',
      'failed',
      'waived',
      'invalidated',
    ]);
  });

  it('ThreadRuntimeState stores structured state', () => {
    const state: ThreadRuntimeState = {
      threadId: 'T1' as ThreadId,
      status: 'active',
      currentRunId: 'run-1' as ThreadRunId,
      phase: 'investigation',
      bindings: { detective: 'sherlock' },
      goalStates: { find_clue: 'active', solve_case: 'pending' },
      milestoneStates: { first_breakthrough: 'achieved' },
      semanticStateHash: 'h1a2b3c',
    };

    expect(state.threadId).toBe('T1');
    expect(state.status).toBe('active');
    expect(state.phase).toBe('investigation');
    expect(state.bindings.detective).toBe('sherlock');
    expect(state.goalStates.find_clue).toBe('active');
    expect(state.milestoneStates.first_breakthrough).toBe('achieved');
  });

  it('ThreadTransaction carries all optional fields', () => {
    const tx: ThreadTransaction = {
      thread: 'T1',
      runId: 'run-2' as ThreadRunId,
      status: 'completed',
      phase: 'resolution',
      bindingsAfter: { detective: 'sherlock' },
      goalSet: [{ goalId: 'solve_case', status: 'achieved' }],
      milestoneSet: [{ milestoneId: 'final_reveal', status: 'achieved' }],
      provenance: 'E5',
      advancement: 'Sherlock solved the case',
    };

    expect(tx.thread).toBe('T1');
    expect(tx.status).toBe('completed');
    expect(tx.goalSet).toHaveLength(1);
    expect(tx.goalSet![0].goalId).toBe('solve_case');
    expect(tx.provenance).toBe('E5');
    expect(tx.advancement).toContain('Sherlock');
  });

  it('ThreadTransaction can be minimal (provenance only)', () => {
    const tx: ThreadTransaction = {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      provenance: 'E0',
    };

    expect(tx.status).toBeUndefined();
    expect(tx.phase).toBeUndefined();
    expect(tx.goalSet).toBeUndefined();
    expect(tx.provenance).toBe('E0');
  });
});
