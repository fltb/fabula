import { describe, expect, it } from 'vitest';
import {
  applyThreadTransaction,
  assertClockCompatibility,
  getThreadTimeDomain,
} from '../../src/state/thread-replay.js';
import type { ThreadRunId, ThreadRuntimeState, TimeDomain } from '../../src/types/index.js';

describe('Clock Isolation — TimeDomain', () => {
  it('getThreadTimeDomain defaults to story when no catalog', () => {
    const domain = getThreadTimeDomain('T1');
    expect(domain).toBe('story');
  });

  it('getThreadTimeDomain reads from type catalog', () => {
    const catalog = {
      character_arc: { timeDomain: 'story' as TimeDomain },
      mystery: { timeDomain: 'discourse' as TimeDomain },
    };
    const declarations = {
      T1: { typeId: 'character_arc' },
      T2: { typeId: 'mystery' },
    };

    expect(getThreadTimeDomain('T1', catalog, declarations)).toBe('story');
    expect(getThreadTimeDomain('T2', catalog, declarations)).toBe('discourse');
  });

  it('getThreadTimeDomain falls back to story for unknown thread', () => {
    const catalog = { character_arc: { timeDomain: 'story' as TimeDomain } };
    const declarations = { T1: { typeId: 'character_arc' } };

    expect(getThreadTimeDomain('UNKNOWN', catalog, declarations)).toBe('story');
  });

  it('assertClockCompatibility is a no-op (hook for future checks)', () => {
    // Should not throw
    expect(() =>
      assertClockCompatibility('story', {
        thread: 'T1',
        runId: 'run-1' as ThreadRunId,
        provenance: 'E0',
      }),
    ).not.toThrow();
    expect(() =>
      assertClockCompatibility('discourse', {
        thread: 'T2',
        runId: 'run-1' as ThreadRunId,
        provenance: 'E0',
      }),
    ).not.toThrow();
  });
});

describe('Story-domain thread behavior', () => {
  it('story threads are created and updated normally', () => {
    // Story threads follow branch-resolved storyTime ordering
    const threads: Record<string, ThreadRuntimeState> = {};

    applyThreadTransaction(threads, {
      thread: 'T_story',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'story_arc', status: 'active' }],
      provenance: 'E0',
    });

    expect(threads.T_story).toBeDefined();
    expect(threads.T_story?.status).toBe('active');
    expect(threads.T_story?.goalStates.story_arc).toBe('active');
  });

  it('multiple story transactions accumulate state', () => {
    const threads: Record<string, ThreadRuntimeState> = {};

    applyThreadTransaction(threads, {
      thread: 'T_arc',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'setup', status: 'active' }],
      provenance: 'E1',
    });

    applyThreadTransaction(threads, {
      thread: 'T_arc',
      runId: 'run-1' as ThreadRunId,
      goalSet: [
        { goalId: 'setup', status: 'achieved' },
        { goalId: 'conflict', status: 'active' },
      ],
      provenance: 'E2',
    });

    expect(threads.T_arc?.goalStates.setup).toBe('achieved');
    expect(threads.T_arc?.goalStates.conflict).toBe('active');
  });
});

describe('Discourse-domain thread behavior', () => {
  it('discourse threads track narrative disclosure order', () => {
    // Discourse threads follow assembled narrative/disclosure order,
    // not story-time linearity. The same transaction mechanism applies.
    const threads: Record<string, ThreadRuntimeState> = {};

    applyThreadTransaction(threads, {
      thread: 'T_mystery',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'reveal', status: 'active' }],
      provenance: 'E5',
    });

    applyThreadTransaction(threads, {
      thread: 'T_mystery',
      runId: 'run-1' as ThreadRunId,
      goalSet: [{ goalId: 'reveal', status: 'achieved' }],
      provenance: 'E10',
    });

    expect(threads.T_mystery?.goalStates.reveal).toBe('achieved');
  });

  it('discourse threads can be completed before story events', () => {
    // In discourse order, a flash-forward may complete a thread
    // before the story-time events that would "naturally" complete it.
    const threads: Record<string, ThreadRuntimeState> = {};

    // Discourse event E10 (flash-forward) completes the thread
    applyThreadTransaction(threads, {
      thread: 'T_flashback',
      runId: 'run-1' as ThreadRunId,
      status: 'completed',
      goalSet: [{ goalId: 'resolution', status: 'achieved' }],
      provenance: 'E10',
    });

    expect(threads.T_flashback?.status).toBe('completed');

    // Story-time event E5 from earlier can still add bindings
    applyThreadTransaction(threads, {
      thread: 'T_flashback',
      runId: 'run-1' as ThreadRunId,
      bindingsAfter: { key_witness: 'old_man' },
      provenance: 'E5',
    });

    // Completed status preserved (no transition attempted since it's the same status)
    expect(threads.T_flashback?.status).toBe('completed');
    expect(threads.T_flashback?.bindings.key_witness).toBe('old_man');
  });
});

describe('Canonical transaction behavior across clocks', () => {
  it('keeps explicit run IDs and provenance for story and discourse transactions', () => {
    const threads: Record<string, ThreadRuntimeState> = {};
    const transactions = [
      {
        thread: 'T_story',
        runId: 'story-run-1' as ThreadRunId,
        status: 'active' as const,
        phase: 'setup',
        goalSet: [{ goalId: 'setup', status: 'active' as const }],
        provenance: 'E1',
      },
      {
        thread: 'T_mystery',
        runId: 'discourse-run-1' as ThreadRunId,
        status: 'active' as const,
        phase: 'reveal',
        goalSet: [{ goalId: 'reveal', status: 'active' as const }],
        provenance: 'E5',
      },
    ];

    for (const tx of transactions) {
      applyThreadTransaction(threads, tx);
    }

    expect(threads.T_story?.currentRunId).toBe('story-run-1');
    expect(threads.T_story?.goalStates.setup).toBe('active');
    expect(threads.T_mystery?.currentRunId).toBe('discourse-run-1');
    expect(threads.T_mystery?.goalStates.reveal).toBe('active');
  });
});

describe('Absolute thread state storage', () => {
  it('uses goal and milestone states rather than numeric counters', () => {
    const threads: Record<string, ThreadRuntimeState> = {};

    applyThreadTransaction(threads, {
      thread: 'T_check',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'investigation', status: 'active' }],
      provenance: 'E0',
    });

    const state = threads.T_check;
    expect(state).toBeDefined();
    if (!state) {
      throw new Error('Expected T_check thread state');
    }

    expect(state).not.toHaveProperty('progress');
    expect(state).not.toHaveProperty('total');
    expect(state).toHaveProperty('goalStates');
    expect(state).toHaveProperty('milestoneStates');
    expect(state.goalStates.investigation).toBe('active');
  });
});
