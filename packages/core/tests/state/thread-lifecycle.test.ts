import { describe, expect, it } from 'vitest';
import {
  applyThreadTransaction,
  initializeThreadRuntimeState,
  mergeThreadStates,
} from '../../src/state/thread-replay.js';
import type {
  ThreadId,
  ThreadRunId,
  ThreadRuntimeState,
  ThreadTransaction,
} from '../../src/types/index.js';

describe('Thread Lifecycle Transitions', () => {
  it('planned → active is valid', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    const tx1: ThreadTransaction = {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'planned',
      provenance: 'E0',
    };
    applyThreadTransaction(threads, tx1);
    expect(threads.T1?.status).toBe('planned');

    const tx2: ThreadTransaction = {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E1',
    };
    applyThreadTransaction(threads, tx2);
    expect(threads.T1?.status).toBe('active');
  });

  it('active → blocked is valid', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E0',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'blocked',
      provenance: 'E1',
    });
    expect(threads.T1?.status).toBe('blocked');
  });

  it('blocked → active is valid (unblock)', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E0',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'blocked',
      provenance: 'E1',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E2',
    });
    expect(threads.T1?.status).toBe('active');
  });

  it('active → completed is valid', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E0',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'completed',
      provenance: 'E1',
    });
    expect(threads.T1?.status).toBe('completed');
  });

  it('active → abandoned is valid', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E0',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'abandoned',
      provenance: 'E1',
    });
    expect(threads.T1?.status).toBe('abandoned');
  });

  it('completed → planned (reopen) is valid', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E0',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'completed',
      provenance: 'E1',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-2' as ThreadRunId,
      status: 'planned',
      provenance: 'E2',
    });
    expect(threads.T1?.status).toBe('planned');
    expect(threads.T1?.currentRunId).toBe('run-2');
  });

  it('retired is terminal — no transitions out', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E0',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'retired',
      provenance: 'E1',
    });
    expect(threads.T1?.status).toBe('retired');

    // Attempting any transition from retired should throw
    expect(() => {
      applyThreadTransaction(threads, {
        thread: 'T1',
        runId: 'run-1' as ThreadRunId,
        status: 'active',
        provenance: 'E2',
      });
    }).toThrow(/retired/);
  });

  it('invalid transition throws', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'planned',
      provenance: 'E0',
    });
    // Cannot go from planned to completed
    expect(() => {
      applyThreadTransaction(threads, {
        thread: 'T1',
        runId: 'run-1' as ThreadRunId,
        status: 'completed',
        provenance: 'E1',
      });
    }).toThrow(/Invalid thread lifecycle transition/);
  });

  it('goal state updates are tracked', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'find_clue', status: 'active' }],
      provenance: 'E0',
    });
    expect(threads.T1?.goalStates.find_clue).toBe('active');

    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      goalSet: [{ goalId: 'find_clue', status: 'achieved' }],
      provenance: 'E1',
    });
    expect(threads.T1?.goalStates.find_clue).toBe('achieved');
  });

  it('milestone state updates are tracked', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      milestoneSet: [{ milestoneId: 'first_breakthrough', status: 'achieved' }],
      provenance: 'E0',
    });
    expect(threads.T1?.milestoneStates.first_breakthrough).toBe('achieved');
  });

  it('binding updates accumulate', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      bindingsAfter: { protagonist: 'xianglins_wife' },
      provenance: 'E0',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      bindingsAfter: { antagonist: 'fourth_uncle' },
      provenance: 'E1',
    });
    expect(threads.T1?.bindings.protagonist).toBe('xianglins_wife');
    expect(threads.T1?.bindings.antagonist).toBe('fourth_uncle');
  });

  it('semantic state hash changes on state update', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E0',
    });
    const hash1 = threads.T1?.semanticStateHash;

    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      goalSet: [{ goalId: 'investigation', status: 'active' }],
      provenance: 'E1',
    });
    const hash2 = threads.T1?.semanticStateHash;
    expect(hash2).not.toBe(hash1);
  });
});

describe('Canonical ThreadTransaction replay', () => {
  it('applies explicit lifecycle, phase, goal, milestone, and binding fields', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    const tx: ThreadTransaction = {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      phase: 'investigation',
      goalSet: [{ goalId: 'find_clue', status: 'active' }],
      milestoneSet: [{ milestoneId: 'first_breakthrough', status: 'achieved' }],
      bindingsAfter: { investigator: 'hero' },
      advancement: 'Found the first clue',
      provenance: 'E1',
    };

    applyThreadTransaction(threads, tx);

    expect(threads.T1).toMatchObject({
      status: 'active',
      currentRunId: 'run-1',
      phase: 'investigation',
      bindings: { investigator: 'hero' },
      goalStates: { find_clue: 'active' },
      milestoneStates: { first_breakthrough: 'achieved' },
    });
  });

  it('applies a canonical completion transaction on the active run', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      provenance: 'E1',
    });
    applyThreadTransaction(threads, {
      thread: 'T1',
      runId: 'run-1' as ThreadRunId,
      status: 'completed',
      goalSet: [{ goalId: 'find_clue', status: 'achieved' }],
      advancement: 'Resolved the investigation',
      provenance: 'E2',
    });

    expect(threads.T1?.status).toBe('completed');
    expect(threads.T1?.goalStates.find_clue).toBe('achieved');
  });
});

describe('initializeThreadRuntimeState', () => {
  it('creates initial state from declaration and type definition', () => {
    const state = initializeThreadRuntimeState(
      'T1',
      { initialPhase: 'setup' },
      {
        allowedPhases: ['setup', 'conflict', 'resolution'],
        stableGoals: [{ goalId: 'goal_a', status: 'pending' }],
        stableMilestones: [],
      },
      'planned',
    );

    expect(state.threadId).toBe('T1' as ThreadId);
    expect(state.status).toBe('planned');
    expect(state.phase).toBe('setup');
    expect(state.goalStates.goal_a).toBe('pending');
    expect(state.bindings).toEqual({});
  });

  it('overrides with declaration-specific initial states', () => {
    const state = initializeThreadRuntimeState(
      'T1',
      {
        initialGoalStates: [{ goalId: 'goal_a', status: 'active' }],
        initialBindings: { hero: 'xiao_ming' },
      },
      {
        allowedPhases: ['phase1'],
        stableGoals: [{ goalId: 'goal_a', status: 'pending' }],
        stableMilestones: [],
      },
      'active',
    );

    expect(state.status).toBe('active');
    expect(state.goalStates.goal_a).toBe('active');
    expect(state.bindings.hero).toBe('xiao_ming');
  });
});

describe('mergeThreadStates', () => {
  it('requireEqual auto-converges when hashes match', () => {
    const state: ThreadRuntimeState = {
      threadId: 'T1' as ThreadId,
      status: 'active',
      currentRunId: 'run-1' as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: { investigation: 'active' },
      milestoneStates: {},
      semanticStateHash: 'h0',
    };

    const result = mergeThreadStates(state, { ...state });
    expect(result.strategy).toBe('requireEqual');
    expect(result.mergedState.status).toBe('active');
  });

  it('requireEqual throws when hashes differ', () => {
    const left: ThreadRuntimeState = {
      threadId: 'T1' as ThreadId,
      status: 'active',
      currentRunId: 'run-1' as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: { investigation: 'active' },
      milestoneStates: {},
      semanticStateHash: 'h0',
    };
    const right: ThreadRuntimeState = {
      ...left,
      goalStates: { investigation: 'achieved' },
      semanticStateHash: 'h1',
    };

    expect(() => mergeThreadStates(left, right)).toThrow(/hashes differ/);
  });

  it('selectBranch picks right state', () => {
    const left: ThreadRuntimeState = {
      threadId: 'T1' as ThreadId,
      status: 'blocked',
      currentRunId: 'run-1' as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: {},
      milestoneStates: {},
      semanticStateHash: 'h0',
    };
    const right: ThreadRuntimeState = {
      ...left,
      status: 'active',
      semanticStateHash: 'h1',
    };

    const result = mergeThreadStates(left, right, 'selectBranch');
    expect(result.mergedState.status).toBe('active');
  });

  it('literal merge unions goal/milestone states', () => {
    const left: ThreadRuntimeState = {
      threadId: 'T1' as ThreadId,
      status: 'active',
      currentRunId: 'run-1' as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: { g1: 'active' },
      milestoneStates: { m1: 'achieved' },
      semanticStateHash: 'h0',
    };
    const right: ThreadRuntimeState = {
      ...left,
      goalStates: { g2: 'pending' },
      milestoneStates: { m2: 'pending' },
      semanticStateHash: 'h1',
    };

    const result = mergeThreadStates(left, right, 'literal');
    expect(result.mergedState.goalStates.g1).toBe('active');
    expect(result.mergedState.goalStates.g2).toBe('pending');
    expect(result.mergedState.milestoneStates.m1).toBe('achieved');
    expect(result.mergedState.milestoneStates.m2).toBe('pending');
  });

  it('newRun creates merge run with new ID', () => {
    const left: ThreadRuntimeState = {
      threadId: 'T1' as ThreadId,
      status: 'active',
      currentRunId: 'run-A' as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: {},
      milestoneStates: {},
      semanticStateHash: 'h0',
    };
    const right: ThreadRuntimeState = {
      ...left,
      currentRunId: 'run-B' as ThreadRunId,
      semanticStateHash: 'h1',
    };

    const result = mergeThreadStates(left, right, 'newRun');
    expect(result.strategy).toBe('newRun');
    expect(result.newRunId).toContain('merge');
    expect(result.mergedState.currentRunId).toContain('merge');
  });
});
