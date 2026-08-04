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
      goalSet: [{ goalId: 'progress', status: 'active' }],
      provenance: 'E0',
    });

    expect(threads.T_story).toBeDefined();
    expect(threads.T_story?.status).toBe('active');
    expect(threads.T_story?.goalStates.progress).toBe('active');
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

describe('Backward compatibility — ThreadProgressEntry', () => {
  it('legacy scalar progress threads work through replay', () => {
    const threads: Record<string, ThreadRuntimeState> = {};

    // Simulate what convertLegacyThreadProgress produces
    applyThreadTransaction(threads, {
      thread: 'T_legacy',
      runId: 'legacy-T_legacy' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'progress', status: 'active' }],
      provenance: 'E0',
      advancement: 'Started the journey',
    });

    expect(threads.T_legacy?.status).toBe('active');
    expect(threads.T_legacy?.goalStates.progress).toBe('active');
    expect(threads.T_legacy?.currentRunId).toBe('legacy-T_legacy');
  });

  it('multiple legacy entries on the same thread accumulate', () => {
    const threads: Record<string, ThreadRuntimeState> = {};

    // First legacy entry
    applyThreadTransaction(threads, {
      thread: 'T_legacy',
      runId: 'legacy-T_legacy' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'progress', status: 'active' }],
      provenance: 'E1',
      advancement: 'First step',
    });

    // Second legacy entry (same thread, same status, same goal)
    applyThreadTransaction(threads, {
      thread: 'T_legacy',
      runId: 'legacy-T_legacy' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'progress', status: 'active' }],
      provenance: 'E2',
      advancement: 'Second step',
    });

    expect(threads.T_legacy?.status).toBe('active');
    expect(threads.T_legacy?.goalStates.progress).toBe('active');
  });

  it('legacy entry with complete progress creates completed state', () => {
    const threads: Record<string, ThreadRuntimeState> = {};

    applyThreadTransaction(threads, {
      thread: 'T_done',
      runId: 'legacy-T_done' as ThreadRunId,
      status: 'completed',
      goalSet: [{ goalId: 'progress', status: 'achieved' }],
      provenance: 'E_final',
      advancement: 'Thread complete',
    });

    expect(threads.T_done?.status).toBe('completed');
    expect(threads.T_done?.goalStates.progress).toBe('achieved');
  });
});

describe('No scalar progress storage', () => {
  it('ThreadRuntimeState uses absolute goal/milestone states, not progress numbers', () => {
    const threads: Record<string, ThreadRuntimeState> = {};

    applyThreadTransaction(threads, {
      thread: 'T_check',
      runId: 'run-1' as ThreadRunId,
      status: 'active',
      goalSet: [{ goalId: 'progress', status: 'active' }],
      provenance: 'E0',
    });

    const state = threads.T_check;
    expect(state).toBeDefined();
    if (!state) {
      throw new Error('Expected T_check thread state');
    }

    // There should be NO 'progress' or 'total' numeric fields on the state
    expect(state).not.toHaveProperty('progress');
    expect(state).not.toHaveProperty('total');

    // Instead, state has absolute goal/milestone states
    expect(state).toHaveProperty('goalStates');
    expect(state).toHaveProperty('milestoneStates');
    expect(state.goalStates.progress).toBe('active');
  });
});
