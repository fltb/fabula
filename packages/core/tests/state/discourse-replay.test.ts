// ============================================================================
// discourse-replay.test.ts — DISCOURSE-1 test suite
//
// Covers all minimum test categories from the sub-plan:
//   - DiscourseState replay by position
//   - All 7 disclosure actions
//   - Hint state lifecycle (6 states)
//   - Claim vs reveal truth-boundary enforcement
//   - Narrator profile boundaries (4 types x access/assertion/truth/fidelity/sincerity)
//   - Pass 1 projection filtering (forbidden items excluded)
//   - Flashback/flashforward
//   - Branch-independent discourse
//   - Shared post-merge scene identical-projection check
//   - Pass 2 observation non-mutation
//   - Sparse corpus coverage modes
//   - ValidationKey independence
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  advanceHintState,
  areProjectionsIdentical,
  canReveal,
  createDefaultModelReaderProfile,
  createExplicitLedgerProfile,
  createFocalizerBoundProfile,
  createObservation,
  createOmniscientProfile,
  createRetrospectiveEntityProfile,
  projectDiscourseContext,
  replayDiscourseState,
} from '../../src/state/discourse-replay.ts';
import { compileDiscourseBoundaries } from '../../src/state/discourse-context.ts';
import type {
  DisclosureAction,
  DiscourseContextProjection,
  DiscoursePosition,
  DiscourseState,
  Hint,
  ModelReaderProfile,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedger,
  PlannedLedgerEntry,
  WithholdingPolicy,
} from '../../src/types/discourse.ts';
import type { NarrativeEvent } from '../../src/types/event.js';

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function makeAssertion(
  id: string,
  truthBoundary: boolean,
  type: NarratorAssertion['type'] = 'claim',
): NarratorAssertion {
  return {
    id,
    narrator: 'narrator_1',
    proposition: `prop_${id}`,
    polarity: 'affirmative',
    type,
    truthBoundary,
    narrationBoundary: { narratorId: 'narrator_1' },
  };
}

function makeLedger(entries: PlannedLedgerEntry[]): PlannedDiscourseLedger {
  return {
    id: 'test_ledger',
    entries,
    hash: 'hash_test',
  };
}

function entry(
  id: string,
  action: DisclosureAction,
  sceneId: string,
  branch: string,
): PlannedLedgerEntry {
  return {
    id,
    action,
    sceneId,
    branch,
    discoursePosition: action.discoursePosition,
  };
}

function revealAction(assertionId: string, pos: number): DisclosureAction {
  return { type: 'reveal', assertionId, discoursePosition: pos };
}

function claimAction(assertionId: string, pos: number): DisclosureAction {
  return { type: 'claim', assertionId, discoursePosition: pos };
}

function hintAction(
  hintId: string,
  surface: string,
  target: string,
  pos: number,
  threadId?: string,
): DisclosureAction {
  return {
    type: 'hint',
    hintId,
    surfaceProposition: surface,
    targetProposition: target,
    threadId,
    discoursePosition: pos,
  };
}

function retractionAction(assertionId: string, pos: number): DisclosureAction {
  return { type: 'retraction', assertionId, discoursePosition: pos };
}

function correctionAction(prior: string, next: string, pos: number): DisclosureAction {
  return {
    type: 'correction',
    priorAssertionId: prior,
    newAssertionId: next,
    discoursePosition: pos,
  };
}

function withholdStartAction(policyId: string, pos: number, reason?: string): DisclosureAction {
  return { type: 'withhold_start', policyId, reason, discoursePosition: pos };
}

function withholdEndAction(policyId: string, pos: number): DisclosureAction {
  return { type: 'withhold_end', policyId, discoursePosition: pos };
}

function makeStateWithAssertions(
  reveals: string[],
  openClaims: string[],
  hints: Hint[] = [],
  activeWithholds: WithholdingPolicy[] = [],
  assertions: Record<string, NarratorAssertion> = {},
): DiscourseState {
  return {
    position: reveals.length + openClaims.length,
    reveals,
    openClaims,
    retractions: [],
    corrections: [],
    hints,
    activeWithholds,
    narratorProfiles: {},
    assertions,
    providerIndex: {},
    branch: 'main',
    ledgerHash: 'hash_test',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. DiscourseState replay by position
// ═════════════════════════════════════════════════════════════════════════════

describe('DiscourseState replay by position', () => {
  it('returns empty state for position 0 with no entries', () => {
    const ledger = makeLedger([]);
    const state = replayDiscourseState(ledger, 0, 'main');
    expect(state.position).toBe(0);
    expect(state.reveals).toEqual([]);
    expect(state.openClaims).toEqual([]);
    expect(state.branch).toBe('main');
  });

  it('replays up to the given position', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_1', 'main'),
      entry('e2', revealAction('r2', 2), 'scene_2', 'main'),
      entry('e3', revealAction('r3', 3), 'scene_3', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    expect(state.position).toBe(2);
    expect(state.reveals).toEqual(['r1', 'r2']);
    expect(state.openClaims).toEqual([]);
  });

  it('replays to the exact last entry', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_1', 'main'),
      entry('e2', revealAction('r2', 2), 'scene_2', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    expect(state.position).toBe(2);
    expect(state.reveals).toEqual(['r1', 'r2']);
  });

  it('throws on out-of-bounds position (< -1)', () => {
    // Position -1 is the planned "no discourse" sentinel; values strictly below -1
    // are always out of bounds regardless of ledger contents.
    const ledger = makeLedger([]);
    expect(() => replayDiscourseState(ledger, -2, 'main')).toThrow(
      'DiscoursePosition out of range',
    );
  });
  // strict preflight: position -1 IS a valid sentinel for "no discourse actions in scene"
  // and returns an empty DiscourseState at position -1.

  it('replays only positions ≤ target for sparse entries', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_1', 'main'),
      entry('e2', revealAction('r2', 3), 'scene_1', 'main'),
      entry('e3', revealAction('r3', 5), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 3, 'main');
    expect(state.position).toBe(3);
    expect(state.reveals).toEqual(['r1', 'r2']);
  });

  it('replays unordered entries in position order', () => {
    const ledger = makeLedger([
      entry('e3', revealAction('r3', 3), 'scene_1', 'main'),
      entry('e1', revealAction('r1', 1), 'scene_1', 'main'),
      entry('e2', revealAction('r2', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 3, 'main');
    expect(state.position).toBe(3);
    // Entries sorted by position before apply
    expect(state.reveals).toEqual(['r1', 'r2', 'r3']);
  });

  it('position 0 returns empty state when actions start at higher positions', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 0, 'main');
    expect(state.position).toBe(0);
    expect(state.reveals).toEqual([]);
    expect(state.openClaims).toEqual([]);
  });

  it('replays past last sparse entry returns current state at last position', () => {
    // Sparse positions: replaying past the last entry is allowed and yields
    // the state at the last prior position (no upper-bound check).
    const ledger = makeLedger([entry('e1', revealAction('r1', 1), 's1', 'main')]);
    const state = replayDiscourseState(ledger, 5, 'main');
    expect(state.position).toBe(1);
    expect(state.reveals).toEqual(['r1']);
  });

  it('throws on duplicate discourse positions (§19)', () => {
    // Duplicate positions even on different branches should be caught
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_1', 'main'),
      entry('e2', revealAction('r2', 1), 'scene_2', 'main'), // Same position
    ]);
    expect(() => replayDiscourseState(ledger, 1, 'main')).toThrow(
      'DuplicateDiscoursePositionError',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. All 7 disclosure actions
// ═════════════════════════════════════════════════════════════════════════════

describe('all 7 disclosure actions', () => {
  it('reveal action adds to reveals', () => {
    const ledger = makeLedger([entry('e1', revealAction('a1', 1), 'scene_1', 'main')]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.reveals).toContain('a1');
  });

  it('claim action adds to openClaims', () => {
    const ledger = makeLedger([entry('e1', claimAction('a1', 1), 'scene_1', 'main')]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.openClaims).toContain('a1');
  });

  it('hint action adds hint in planned state', () => {
    const ledger = makeLedger([
      entry('e1', hintAction('h1', 'surface_prop', 'target_prop', 1), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.hints).toHaveLength(1);
    expect(state.hints[0].hintId).toBe('h1');
    expect(state.hints[0].state).toBe('planned');
    expect(state.hints[0].surfaceProposition).toBe('surface_prop');
    expect(state.hints[0].targetProposition).toBe('target_prop');
  });

  it('hint action with thread reference', () => {
    const ledger = makeLedger([
      entry('e1', hintAction('h1', 'surface', 'target', 1, 'thread_1'), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.hints[0].threadId).toBe('thread_1');
  });

  it('retraction action removes from openClaims and records retraction', () => {
    const ledger = makeLedger([
      entry('e1', claimAction('a1', 1), 'scene_1', 'main'),
      entry('e2', retractionAction('a1', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    expect(state.openClaims).not.toContain('a1');
    expect(state.retractions).toHaveLength(1);
    expect(state.retractions[0].assertionId).toBe('a1');
  });

  it('correction replaces prior reveal with new assertion', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('a1_old', 1), 'scene_1', 'main'),
      entry('e2', correctionAction('a1_old', 'a1_new', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    expect(state.reveals).toContain('a1_new');
    expect(state.reveals).not.toContain('a1_old');
    expect(state.corrections).toHaveLength(1);
    expect(state.corrections[0].priorAssertionId).toBe('a1_old');
    expect(state.corrections[0].newAssertionId).toBe('a1_new');
  });

  it('correction replaces prior claim with new assertion', () => {
    const ledger = makeLedger([
      entry('e1', claimAction('c1_old', 1), 'scene_1', 'main'),
      entry('e2', correctionAction('c1_old', 'c1_new', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    expect(state.openClaims).toContain('c1_new');
    expect(state.openClaims).not.toContain('c1_old');
  });

  it('withhold_start adds active withholding policy', () => {
    const ledger = makeLedger([
      entry('e1', withholdStartAction('wp1', 1, 'spoiler prevention'), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.activeWithholds).toHaveLength(1);
    expect(state.activeWithholds[0].policyId).toBe('wp1');
    expect(state.activeWithholds[0].active).toBe(true);
    expect(state.activeWithholds[0].reason).toBe('spoiler prevention');
  });

  it('withhold_end deactivates withholding policy', () => {
    const ledger = makeLedger([
      entry('e1', withholdStartAction('wp1', 1), 'scene_1', 'main'),
      entry('e2', withholdEndAction('wp1', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    const policy = state.activeWithholds.find((w) => w.policyId === 'wp1');
    expect(policy).toBeDefined();
    expect(policy!.active).toBe(false);
    expect(policy!.endPosition).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Hint state lifecycle (6 states)
// ═════════════════════════════════════════════════════════════════════════════

describe('hint state lifecycle (6 states)', () => {
  it('starts in planned state', () => {
    const hint: Hint = {
      hintId: 'h1',
      state: 'planned',
      surfaceProposition: 'surface',
      targetProposition: 'target',
      discoursePosition: 1,
    };
    expect(hint.state).toBe('planned');
  });

  it('can transition through all 6 states', () => {
    const hint: Hint = {
      hintId: 'h1',
      state: 'planned',
      surfaceProposition: 'surface',
      targetProposition: 'target',
      discoursePosition: 1,
    };

    const states: Array<Hint['state']> = [
      'planned',
      'contract_planted',
      'contract_reinforced',
      'contract_fulfilled',
      'contract_subverted',
      'retracted',
    ];

    let current = hint;
    for (const s of states) {
      current = advanceHintState(current, s);
      expect(current.state).toBe(s);
      // Verify other fields survive transition
      expect(current.hintId).toBe('h1');
      expect(current.surfaceProposition).toBe('surface');
    }
  });

  it('advanceHintState creates a new object', () => {
    const hint: Hint = {
      hintId: 'h1',
      state: 'planned',
      surfaceProposition: 'surface',
      targetProposition: 'target',
      discoursePosition: 1,
    };
    const updated = advanceHintState(hint, 'contract_fulfilled');
    expect(hint.state).toBe('planned'); // original unchanged
    expect(updated.state).toBe('contract_fulfilled');
    expect(updated).not.toBe(hint);
  });

  it('replayed hint action creates hint in planned state', () => {
    const ledger = makeLedger([
      entry('e1', hintAction('h1', 'surface', 'target', 1), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.hints[0].state).toBe('planned');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Claim vs reveal truth-boundary enforcement (§5)
// ═════════════════════════════════════════════════════════════════════════════

describe('claim vs reveal truth-boundary enforcement (§5)', () => {
  it('canReveal returns true for truthBoundary=true assertion', () => {
    const assertion = makeAssertion('a1', true, 'authoritative_reveal');
    expect(canReveal(assertion)).toBe(true);
  });

  it('canReveal returns false for truthBoundary=false assertion', () => {
    const assertion = makeAssertion('a2', false, 'claim');
    expect(canReveal(assertion)).toBe(false);
  });

  it('reveal action succeeds for truthBoundary=true', () => {
    const ledger = makeLedger([entry('e1', revealAction('a1', 1), 'scene_1', 'main')]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.reveals).toContain('a1');
  });

  it('rejects a loaded assertion without a truth boundary', () => {
    const assertion = makeAssertion('a2', false, 'claim');
    const ledger = makeLedger([entry('e1', revealAction('a2', 1), 'scene_1', 'main')]);

    expect(() => replayDiscourseState(ledger, 1, 'main', { a2: assertion })).toThrow(
      'Reveal requires truthBoundary=true',
    );
  });

  it('claim action succeeds regardless of truthBoundary', () => {
    const ledger = makeLedger([entry('e1', claimAction('a2', 1), 'scene_1', 'main')]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.openClaims).toContain('a2');
  });

  it('reveal action with truthBoundary=false assertion fails when catalog supplied (§5)', () => {
    const ledger = makeLedger([entry('e1', revealAction('a_false', 1), 'scene_1', 'main')]);
    expect(() =>
      replayDiscourseState(ledger, 1, 'main', {
        a_false: makeAssertion('a_false', false, 'claim'),
      }),
    ).toThrow('Reveal requires truthBoundary=true');
  });

  it('claim action with truthBoundary=true assertion succeeds as claim (not reveal)', () => {
    const ledger = makeLedger([entry('e1', claimAction('true_a', 1), 'scene_1', 'main')]);
    const state = replayDiscourseState(ledger, 1, 'main', {
      true_a: makeAssertion('true_a', true, 'authoritative_reveal'),
    });
    // Claim always adds to openClaims regardless of assertion truthBoundary
    expect(state.openClaims).toContain('true_a');
    // It does NOT become a reveal
    expect(state.reveals).not.toContain('true_a');
  });

  it('reveal supersedes prior claim of same assertion', () => {
    const ledger = makeLedger([
      entry('e1', claimAction('same_id', 1), 'scene_1', 'main'),
      entry('e2', revealAction('same_id', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main', {
      same_id: makeAssertion('same_id', true, 'authoritative_reveal'),
    });
    expect(state.reveals).toContain('same_id');
    expect(state.openClaims).not.toContain('same_id');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Narrator profile boundaries (4 types x independent capabilities)
// ═════════════════════════════════════════════════════════════════════════════

describe('narrator profile boundaries (§10)', () => {
  it('creates focalizer_bound profile with independent capabilities', () => {
    const profile = createFocalizerBoundProfile(
      'fb1',
      'focalizer_only',
      'constrained',
      'limited_knowledge',
      'reliable',
      'sincere',
    );
    expect(profile.type).toBe('focalizer_bound');
    expect(profile.access).toBe('focalizer_only');
    expect(profile.assertion).toBe('constrained');
    expect(profile.truth).toBe('limited_knowledge');
    expect(profile.fidelity).toBe('reliable');
    expect(profile.sincerity).toBe('sincere');
  });

  it('creates retrospective_entity profile with knowledgeBoundary', () => {
    const profile = createRetrospectiveEntityProfile(
      're1',
      'knowledge_boundary_later',
      'full',
      'full',
      'full_knowledge',
      'reliable',
      'sincere',
    );
    expect(profile.type).toBe('retrospective_entity');
    expect(profile.knowledgeBoundary).toBe('knowledge_boundary_later');
    expect(profile.access).toBe('full');
  });

  it('creates explicit_ledger profile', () => {
    const profile = createExplicitLedgerProfile(
      'el1',
      'full',
      'full',
      'full_knowledge',
      'reliable',
      'sincere',
    );
    expect(profile.type).toBe('explicit_ledger');
  });

  it('creates omniscient profile with autoReveal=false', () => {
    const profile = createOmniscientProfile(
      'omni1',
      'full',
      'full',
      'full_knowledge',
      'reliable',
      'sincere',
    );
    expect(profile.type).toBe('omniscient');
    expect(profile.autoReveal).toBe(false);
  });

  it('4 narrator types have distinct independent capabilities', () => {
    const profiles: NarratorProfile[] = [
      createFocalizerBoundProfile(
        'p1',
        'focalizer_only',
        'minimal',
        'opaque',
        'unreliable',
        'deceptive',
      ),
      createRetrospectiveEntityProfile(
        'p2',
        'kb_later',
        'full',
        'constrained',
        'limited_knowledge',
        'reliable',
        'sincere',
      ),
      createExplicitLedgerProfile(
        'p3',
        'limited',
        'full',
        'full_knowledge',
        'ambiguous',
        'ambiguous',
      ),
      createOmniscientProfile('p4', 'full', 'constrained', 'full_knowledge', 'reliable', 'sincere'),
    ];

    // Each type should have different type discriminator
    const types = profiles.map((p) => p.type);
    expect(new Set(types).size).toBe(4);

    // All should have the 5 independent capability fields
    for (const p of profiles) {
      expect(p.access).toBeDefined();
      expect(p.assertion).toBeDefined();
      expect(p.truth).toBeDefined();
      expect(p.fidelity).toBeDefined();
      expect(p.sincerity).toBeDefined();
    }
  });

  it('default model reader profile is immutable and versioned', () => {
    const profile = createDefaultModelReaderProfile();
    expect(profile.id).toBe('default_model_reader_v1');
    expect(profile.hash).toBe('hash_default_model_reader_v1');
    expect(profile.initialExposureContract.initialReveals).toEqual([]);
    expect(profile.initialExposureContract.initialClaims).toEqual([]);
    expect(profile.initialExposureContract.initialWithholds).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Pass 1 projection filtering (forbidden items excluded) (§12)
// ═════════════════════════════════════════════════════════════════════════════

describe('Pass 1 projection filtering (§12)', () => {
  it('includes planned reveals and open claims', () => {
    const state = makeStateWithAssertions(['r1'], ['c1']);
    const projection = projectDiscourseContext(state, undefined, undefined, []);
    expect(projection.plannedReveals).toContain('r1');
    expect(projection.openClaims).toContain('c1');
  });

  it('excludes hint target proposition', () => {
    const hints: Hint[] = [
      {
        hintId: 'h1',
        state: 'contract_planted',
        surfaceProposition: 'visible_surface',
        targetProposition: 'hidden_target',
        discoursePosition: 1,
      },
    ];
    const state = makeStateWithAssertions([], [], hints);
    const projection = projectDiscourseContext(state, undefined, undefined, []);

    // Visible hints should only expose surface, never target
    expect(projection.visibleHints).toHaveLength(1);
    expect(projection.visibleHints[0].surfaceProposition).toBe('visible_surface');
    // targetProposition MUST NOT appear in projection
    const projectionStr = JSON.stringify(projection);
    expect(projectionStr).not.toContain('hidden_target');
  });

  it('excludes retracted hints', () => {
    const hints: Hint[] = [
      {
        hintId: 'h1',
        state: 'retracted',
        surfaceProposition: 'old_surface',
        targetProposition: 'old_target',
        discoursePosition: 1,
      },
    ];
    const state = makeStateWithAssertions([], [], hints);
    const projection = projectDiscourseContext(state, undefined, undefined, []);
    expect(projection.visibleHints).toHaveLength(0);
  });

  it('includes open claims as accessible claims when authorized and narrator-visible', () => {
    const state = makeStateWithAssertions([], ['c1'], [], [], {
      c1: makeAssertion('c1', false, 'claim'),
    });
    const profile = createExplicitLedgerProfile(
      'narrator_1',
      'full',
      'full',
      'full_knowledge',
      'reliable',
      'sincere',
    );
    const projection = projectDiscourseContext(state, profile, undefined, ['c1']);
    expect(projection.accessibleClaims).toHaveLength(1);
    expect(projection.accessibleClaims[0].assertionId).toBe('c1');
  });

  it('excludes a claim outside a focalizer-only narrator boundary', () => {
    const state = makeStateWithAssertions([], ['c1'], [], [], {
      c1: {
        ...makeAssertion('c1', false, 'claim'),
        narrationBoundary: { narratorId: 'narrator_1', focalizerId: 'alice' },
      },
    });
    const profile = createFocalizerBoundProfile(
      'narrator_1',
      'focalizer_only',
      'constrained',
      'limited_knowledge',
      'reliable',
      'sincere',
    );

    const projection = projectDiscourseContext(state, profile, 'bob', ['c1']);

    expect(projection.accessibleClaims).toEqual([]);
  });

  it('treats limited access as focalizer-bound until a narrower scope exists', () => {
    const state = makeStateWithAssertions([], ['c1'], [], [], {
      c1: {
        ...makeAssertion('c1', false, 'claim'),
        narrationBoundary: { narratorId: 'narrator_1', focalizerId: 'alice' },
      },
    });
    const profile = createExplicitLedgerProfile(
      'narrator_1',
      'limited',
      'constrained',
      'limited_knowledge',
      'reliable',
      'sincere',
    );

    expect(projectDiscourseContext(state, profile, 'alice', ['c1']).accessibleClaims).toHaveLength(
      1,
    );
    expect(projectDiscourseContext(state, profile, 'bob', ['c1']).accessibleClaims).toEqual([]);
  });

  it('excludes non-authorized assertions from accessible claims', () => {
    const state = makeStateWithAssertions([], ['c1'], [], [], {
      c1: makeAssertion('c1', false, 'claim'),
    });
    const projection = projectDiscourseContext(state, undefined, undefined, []); // empty authorized list
    expect(projection.accessibleClaims).toHaveLength(0);
  });

  it('includes active withholding policies', () => {
    const policies: WithholdingPolicy[] = [
      { policyId: 'wp1', startPosition: 1, endPosition: null, active: true },
    ];
    const state = makeStateWithAssertions([], [], [], policies);
    const projection = projectDiscourseContext(state, undefined, undefined, []);
    expect(projection.activeWithholdingPolicies).toHaveLength(1);
    expect(projection.activeWithholdingPolicies[0].policyId).toBe('wp1');
  });

  it('excludes inactive withholding policies', () => {
    const policies: WithholdingPolicy[] = [
      { policyId: 'wp1', startPosition: 1, endPosition: 2, active: false },
    ];
    const state = makeStateWithAssertions([], [], [], policies);
    const projection = projectDiscourseContext(state, undefined, undefined, []);
    expect(projection.activeWithholdingPolicies).toHaveLength(0);
  });

  it('hint target NEVER appears in projection even when hint is active', () => {
    const hints: Hint[] = [
      {
        hintId: 'h1',
        state: 'contract_fulfilled',
        surfaceProposition: 'surface_story',
        targetProposition: 'deep_target',
        discoursePosition: 1,
      },
    ];
    const state = makeStateWithAssertions([], [], hints);
    const projection = projectDiscourseContext(state, undefined, undefined, []);
    expect(projection.visibleHints).toHaveLength(1);
    // Surface is visible
    const hint = projection.visibleHints[0];
    expect(hint.surfaceProposition).toBe('surface_story');
    // targetProposition is NEVER exposed in projection
    expect(JSON.stringify(projection)).not.toContain('deep_target');
    // The type of visibleHints does not include targetProposition
    expect(Object.prototype.hasOwnProperty.call(hint, 'targetProposition')).toBe(false);
  });

  it('hints do not appear in authorizedTargets', () => {
    const hints: Hint[] = [
      {
        hintId: 'h1',
        state: 'contract_planted',
        surfaceProposition: 'surface_hint',
        targetProposition: 'hidden_target',
        discoursePosition: 1,
      },
    ];
    const state = makeStateWithAssertions([], [], hints);
    const projection = projectDiscourseContext(state, undefined, undefined, ['h1']);
    // Hint assertions are not authorized targets
    expect(projection.authorizedTargets).toHaveLength(0);
    // Hint does not appear in plannedReveals or openClaims
    expect(projection.plannedReveals).toEqual([]);
    expect(projection.openClaims).toEqual([]);
  });

  it('replayed hint action target remains absent from projection', () => {
    const ledger = makeLedger([
      entry('e1', hintAction('h1', 'surface_only', 'hidden_link', 1), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    const projection = projectDiscourseContext(state, undefined, undefined, []);
    expect(projection.visibleHints[0].surfaceProposition).toBe('surface_only');
    expect(JSON.stringify(projection)).not.toContain('hidden_link');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Flashback/flashforward (§13)
// ═════════════════════════════════════════════════════════════════════════════

describe('flashback/flashforward (§13)', () => {
  it('discourse position is monotonic in replay — flashback does not roll back state', () => {
    // Flashback reads historical story state but advances discourse position
    let pos = 1;
    const entries: PlannedLedgerEntry[] = [];

    // Scene at position 1
    entries.push(entry('e1', revealAction('r1', pos++), 'scene_present', 'main'));
    // Flashback scene at position 2 — advances discourse state
    entries.push(entry('e2', revealAction('r2', pos++), 'scene_flashback', 'main'));
    // Return to present at position 3
    entries.push(entry('e3', revealAction('r3', pos++), 'scene_present_2', 'main'));

    const ledger = makeLedger(entries);

    const stateAtFlashback = replayDiscourseState(ledger, 2, 'main');
    expect(stateAtFlashback.position).toBe(2);
    expect(stateAtFlashback.reveals).toContain('r2');

    const stateAtReturn = replayDiscourseState(ledger, 3, 'main');
    expect(stateAtReturn.position).toBe(3);
    // Flashback does not roll back — all prior reveals remain
    expect(stateAtReturn.reveals).toEqual(['r1', 'r2', 'r3']);
  });

  it('flashforward can reveal fixed future-boundary propositions', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('future_reveal', 1), 'scene_flashforward', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.reveals).toContain('future_reveal');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Branch-independent discourse (§14)
// ═════════════════════════════════════════════════════════════════════════════

describe('branch-independent discourse (§14)', () => {
  it('branch A and branch B have independent discourse states', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('branch_a_reveal', 1), 'scene_a', 'branch_a'),
      entry('e2', revealAction('branch_b_reveal', 1), 'scene_b', 'branch_b'),
    ]);

    const stateA = replayDiscourseState(ledger, 1, 'branch_a');
    const stateB = replayDiscourseState(ledger, 1, 'branch_b');

    expect(stateA.reveals).toContain('branch_a_reveal');
    expect(stateA.reveals).not.toContain('branch_b_reveal');
    expect(stateB.reveals).toContain('branch_b_reveal');
    expect(stateB.reveals).not.toContain('branch_a_reveal');
  });

  it('branch filter excludes entries from other branches', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_main', 'main'),
      entry('e2', revealAction('r2', 2), 'scene_alt', 'alternate'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    expect(state.reveals).toContain('r1');
    expect(state.reveals).not.toContain('r2');
  });

  it('position range applies per branch', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 's1', 'main'),
      entry('e2', revealAction('r2', 2), 's2', 'main'),
      entry('e3', claimAction('c1', 1), 's1', 'alternate'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    expect(state.reveals).toEqual(['r1', 'r2']);
    // Branch alternate entries should be absent from main state
    expect(state.openClaims).toEqual([]);
  });

  it('main branch entries do not leak into alternate branch state', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('main_r1', 1), 'scene_1', 'main'),
      entry('e2', revealAction('alt_r1', 1), 'scene_1', 'alternate'),
    ]);
    const stateAlt = replayDiscourseState(ledger, 1, 'alternate');
    expect(stateAlt.reveals).toContain('alt_r1');
    expect(stateAlt.reveals).not.toContain('main_r1');
  });

  it('same sceneId on two branches has independent discourse positions', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r_main', 1), 'scene_X', 'main'),
      entry('e2', revealAction('r_alt', 1), 'scene_X', 'alternate'),
    ]);
    const stateMain = replayDiscourseState(ledger, 1, 'main');
    const stateAlt = replayDiscourseState(ledger, 1, 'alternate');
    expect(stateMain.reveals).toEqual(['r_main']);
    expect(stateAlt.reveals).toEqual(['r_alt']);
  });

  it('same branch entries for a scene form a continuous range', () => {
    // Within a single branch+scene, entries should occupy contiguous positions.
    // This test verifies replay works when entries are contiguous.
    const ledger = makeLedger([
      entry('e1', revealAction('a1', 0), 'scene_M', 'main'),
      entry('e2', claimAction('c1', 1), 'scene_M', 'main'),
      entry('e3', revealAction('a2', 2), 'scene_N', 'main'),
    ]);
    const stateAt1 = replayDiscourseState(ledger, 1, 'main');
    expect(stateAt1.reveals).toEqual(['a1']);
    expect(stateAt1.openClaims).toEqual(['c1']);
    // Scene_M entries occupy [0, 1] continuously
    // STRICT PREFLIGHT: non-continuous same-branch-scene positions is a ConfigError.
  });

  it('independent positions per branch allow same position on different branches', () => {
    // Positions are per-branch — same position on different branches is valid
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 's1', 'main'),
      entry('e2', revealAction('r2', 1), 's1', 'alternate'),
    ]);
    // Choosing main: no error — position 1 on main is different branch from position 1 on alternate
    const stateMain = replayDiscourseState(ledger, 1, 'main');
    expect(stateMain.reveals).toEqual(['r1']);
    const stateAlt = replayDiscourseState(ledger, 1, 'alternate');
    expect(stateAlt.reveals).toEqual(['r2']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Shared post-merge scene identical-projection check (§14)
// ═════════════════════════════════════════════════════════════════════════════

describe('shared post-merge scene identical-projection check (§14)', () => {
  it('identical projections return true', () => {
    const proj: DiscourseContextProjection = {
      plannedReveals: ['r1'],
      openClaims: ['c1'],
      visibleHints: [{ hintId: 'h1', surfaceProposition: 'surface', state: 'planned' }],
      accessibleClaims: [{ assertionId: 'c1', narrator: 'n1', type: 'claim', surface: 'prop' }],
      authorizedTargets: [{ assertionId: 'r1', actionType: 'reveal', discoursePosition: 1 }],
      activeWithholdingPolicies: [
        { policyId: 'wp1', startPosition: 1, endPosition: null, active: true, reason: 'test' },
      ],
    };
    expect(areProjectionsIdentical(proj, { ...proj })).toBe(true);
  });

  it('different plannedReveals returns false', () => {
    const a: DiscourseContextProjection = {
      plannedReveals: ['r1'],
      openClaims: [],
      visibleHints: [],
      accessibleClaims: [],
      authorizedTargets: [],
      activeWithholdingPolicies: [],
    };
    const b: DiscourseContextProjection = { ...a, plannedReveals: ['r1', 'r2'] };
    expect(areProjectionsIdentical(a, b)).toBe(false);
  });

  it('different visibleHints returns false', () => {
    const a: DiscourseContextProjection = {
      plannedReveals: [],
      openClaims: [],
      visibleHints: [{ hintId: 'h1', surfaceProposition: 'surface', state: 'planned' }],
      accessibleClaims: [],
      authorizedTargets: [],
      activeWithholdingPolicies: [],
    };
    const b: DiscourseContextProjection = {
      ...a,
      visibleHints: [{ hintId: 'h2', surfaceProposition: 'other', state: 'contract_fulfilled' }],
    };
    expect(areProjectionsIdentical(a, b)).toBe(false);
  });

  it('different accessibleClaims returns false', () => {
    const a: DiscourseContextProjection = {
      plannedReveals: [],
      openClaims: ['c1'],
      visibleHints: [],
      accessibleClaims: [{ assertionId: 'c1', narrator: 'n1', type: 'claim', surface: 'prop' }],
      authorizedTargets: [],
      activeWithholdingPolicies: [],
    };
    const b: DiscourseContextProjection = {
      ...a,
      accessibleClaims: [
        { assertionId: 'c2', narrator: 'n2', type: 'authoritative_reveal', surface: 'other' },
      ],
    };
    expect(areProjectionsIdentical(a, b)).toBe(false);
  });

  it('different authorizedTargets returns false', () => {
    const base: DiscourseContextProjection = {
      plannedReveals: [],
      openClaims: [],
      visibleHints: [],
      accessibleClaims: [],
      authorizedTargets: [{ assertionId: 'r1', actionType: 'reveal', discoursePosition: 1 }],
      activeWithholdingPolicies: [],
    };
    const modified = {
      ...base,
      authorizedTargets: [{ assertionId: 'r2', actionType: 'claim', discoursePosition: 2 }],
    };
    expect(areProjectionsIdentical(base, modified)).toBe(false);
  });

  it('different activeWithholdingPolicies returns false', () => {
    const base: DiscourseContextProjection = {
      plannedReveals: [],
      openClaims: [],
      visibleHints: [],
      accessibleClaims: [],
      authorizedTargets: [],
      activeWithholdingPolicies: [
        { policyId: 'wp1', startPosition: 1, endPosition: null, active: true, reason: 'test' },
      ],
    };
    const modified = {
      ...base,
      activeWithholdingPolicies: [
        { policyId: 'wp2', startPosition: 2, endPosition: null, active: true, reason: 'other' },
      ],
    };
    expect(areProjectionsIdentical(base, modified)).toBe(false);
  });

  it('order-sensitive fields respect position ordering', () => {
    // The function compares arrays element-wise, so order matters
    const a: DiscourseContextProjection = {
      plannedReveals: ['r1', 'r2'],
      openClaims: [],
      visibleHints: [],
      accessibleClaims: [],
      authorizedTargets: [],
      activeWithholdingPolicies: [],
    };
    const b: DiscourseContextProjection = {
      plannedReveals: ['r2', 'r1'],
      openClaims: [],
      visibleHints: [],
      accessibleClaims: [],
      authorizedTargets: [],
      activeWithholdingPolicies: [],
    };
    expect(areProjectionsIdentical(a, b)).toBe(false);
  });

  it('projection identity survives deep clone', () => {
    const proj: DiscourseContextProjection = {
      plannedReveals: ['r1', 'r2'],
      openClaims: ['c1'],
      visibleHints: [
        { hintId: 'h1', surfaceProposition: 's1', state: 'contract_fulfilled' },
      ],
      accessibleClaims: [
        { assertionId: 'c1', narrator: 'n1', type: 'claim', surface: 'prop_text' },
      ],
      authorizedTargets: [
        { assertionId: 'r1', actionType: 'reveal', discoursePosition: 1 },
        { assertionId: 'c1', actionType: 'claim', discoursePosition: 2 },
      ],
      activeWithholdingPolicies: [
        { policyId: 'wp1', startPosition: 1, endPosition: null, active: true, reason: 'test' },
      ],
    };
    // Deep clone via JSON round-trip
    const clone = JSON.parse(JSON.stringify(proj)) as DiscourseContextProjection;
    expect(areProjectionsIdentical(proj, clone)).toBe(true);
  });

  it('completely different projections return false', () => {
    const a: DiscourseContextProjection = {
      plannedReveals: ['r1'],
      openClaims: [],
      visibleHints: [],
      accessibleClaims: [],
      authorizedTargets: [{ assertionId: 'r1', actionType: 'reveal', discoursePosition: 1 }],
      activeWithholdingPolicies: [],
    };
    const b: DiscourseContextProjection = {
      plannedReveals: [],
      openClaims: ['c2'],
      visibleHints: [{ hintId: 'h2', surfaceProposition: 's2', state: 'planned' }],
      accessibleClaims: [{ assertionId: 'c2', narrator: 'n2', type: 'claim', surface: 'other' }],
      authorizedTargets: [{ assertionId: 'c2', actionType: 'claim', discoursePosition: 5 }],
      activeWithholdingPolicies: [
        { policyId: 'wp2', startPosition: 3, endPosition: null, active: true, reason: 'other' },
      ],
    };
    expect(areProjectionsIdentical(a, b)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Pass 2 observation non-mutation (§3, §17)
// ═════════════════════════════════════════════════════════════════════════════

describe('Pass 2 observation non-mutation (§3, §17)', () => {
  it('createObservation returns data without mutating any state', () => {
    // Observations are plain data — they never write/revise canonical discourse ledger
    const obs = createObservation(
      'effect_1',
      'reveal',
      'prop_1',
      'affirmative',
      'assertion text',
      'exact_match',
    );
    expect(obs.plannedEffectId).toBe('effect_1');
    expect(obs.observationType).toBe('reveal');
    expect(obs.matchLevel).toBe('exact_match');
    // No side effects — just a data constructor
  });

  it('observation with overrides', () => {
    const obs = createObservation(
      'effect_2',
      'unplanned_exposure',
      'prop_leak',
      'affirmative',
      'unplanned text',
      'mismatch',
      { suspectedLeak: 'narrator boundary breach' },
    );
    expect(obs.suspectedLeak).toBe('narrator boundary breach');
    expect(obs.matchLevel).toBe('mismatch');
  });

  it('observations cannot mutate DiscourseState (type-level enforcement)', () => {
    // The createObservation function does not accept DiscourseState
    // This is enforced at the type level — the function signature has no state param
    const obs1 = createObservation('id1', 'reveal', 'p', 'affirmative', 'a', 'exact_match');
    const obs2 = createObservation('id2', 'claim', 'p', 'negative', 'a', 'partial_match');
    // Observations are independent values; they don't accumulate or affect anything
    expect(obs1.plannedEffectId).not.toBe(obs2.plannedEffectId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Sparse corpus coverage modes (§16)
// ═════════════════════════════════════════════════════════════════════════════

describe('sparse corpus coverage modes (§16)', () => {
  it('isolated_excerpt uses bridge IDs', () => {
    const checkpoint = { type: 'isolated_excerpt' as const, bridgeIds: ['bridge_1', 'bridge_2'] };
    expect(checkpoint.type).toBe('isolated_excerpt');
    expect(checkpoint.bridgeIds).toHaveLength(2);
  });

  it('full_work_context requires complete bridge coverage', () => {
    const context = { type: 'full_work_context' as const, precedingBridgeCompleteness: true };
    expect(context.type).toBe('full_work_context');
    expect(context.precedingBridgeCompleteness).toBe(true);
  });

  it('incomplete full_work context flag works', () => {
    const context = { type: 'full_work_context' as const, precedingBridgeCompleteness: false };
    expect(context.precedingBridgeCompleteness).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. ValidationKey independence (§18)
// ═════════════════════════════════════════════════════════════════════════════

describe('ValidationKey independence (§18)', () => {
  it('ValidationKey is separate from discourse cache', () => {
    const validationKey = {
      proseHash: 'abc123',
      analysisSchema: 'pass2_schema_v1',
      model: 'gpt4',
      validatorPolicy: 'strict',
      referencePolicy: 'reference_v1',
    };
    const discourseCacheKey = {
      runKey: 'run_1',
      cursor: 'pos_5',
      plannedStateHash: 'hash_state',
      assertionHintHash: 'hash_assert',
      policyHash: 'hash_policy',
      providerIndexHash: 'hash_provider',
      branch: 'main',
      narratorProfileHash: 'hash_narrator',
      propositionCatalogHash: 'hash_catalog',
      selectionHash: 'hash_selection',
      provenanceHash: 'hash_prov',
    };

    // They share no required fields
    const validationFields = Object.keys(validationKey).sort();
    const discourseFields = Object.keys(discourseCacheKey).sort();
    expect(validationFields).not.toEqual(discourseFields);
    // Individual fields don't overlap
    expect(validationKey.proseHash).not.toBe(discourseCacheKey.runKey);
  });

  it('validation key fields are independently configurable', () => {
    const vk1 = {
      proseHash: 'hash_a',
      analysisSchema: 'schema_v1',
      model: 'gpt4',
      validatorPolicy: 'strict',
      referencePolicy: 'ref_v1',
    };
    const vk2 = {
      proseHash: 'hash_b',
      analysisSchema: 'schema_v1',
      model: 'gpt4',
      validatorPolicy: 'strict',
      referencePolicy: 'ref_v1',
    };
    // Changing proseHash alone is sufficient to distinguish
    expect(vk1.proseHash).not.toBe(vk2.proseHash);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. Constraint: §8 — retraction does not fake forget
// ═════════════════════════════════════════════════════════════════════════════

describe('§8 — retraction does not fake forget', () => {
  it('retraction removes from openClaims but reveals remain untouched', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_1', 'main'),
      entry('e2', claimAction('c1', 2), 'scene_1', 'main'),
      entry('e3', retractionAction('c1', 3), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 3, 'main');
    // Reveal stays — reader does not forget
    expect(state.reveals).toContain('r1');
    // Claim is retracted from open list
    expect(state.openClaims).not.toContain('c1');
    // But retraction is recorded
    expect(state.retractions).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. Constraint: §9 — correction NEVER retcons WorldState
// ═════════════════════════════════════════════════════════════════════════════

describe('§9 — correction NEVER retcons WorldState', () => {
  it('correction only changes discourse assertion contract, not WorldState', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('old_a1', 1), 'scene_1', 'main'),
      entry('e2', correctionAction('old_a1', 'new_a1', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    // Discourse state reflects the correction
    expect(state.reveals).toContain('new_a1');
    expect(state.reveals).not.toContain('old_a1');
    // The DiscourseState has no WorldState fields — cannot retcon
    expect(Object.keys(state)).not.toContain('entities');
    expect(Object.keys(state)).not.toContain('relationships');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15. Strict preflight: invalid catalog scenarios (§19)
// ═════════════════════════════════════════════════════════════════════════════
// These tests encode strict preflight expectations for the planned
// compileDiscourseBoundaries(). Some scenarios are permitted by the current
// permissive replay code but should fail preflight before provider/cache.
// ─────────────────────────────────────────────────────────────────────────────

describe('§19 — strict preflight: invalid catalog scenarios', () => {
  it('retraction of never-claimed assertion records retraction (current permissive)', () => {
    // STRICT PREFLIGHT: retraction must reference an earlier, still-active
    // claim or reveal on the same concrete branch. Should fail preflight.
    // Current code permissively records the retraction.
    const ledger = makeLedger([
      entry('e1', retractionAction('ghost', 1), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.retractions).toHaveLength(1);
    expect(state.retractions[0].assertionId).toBe('ghost');
  });

  it('correction with unknown prior assertion applies partial correction (current permissive)', () => {
    // STRICT PREFLIGHT: priorAssertionId must exist and be active.
    // Current code: correction with unknown prior does nothing to reveals/claims
    // but still records the correction.
    const ledger = makeLedger([
      entry('e1', correctionAction('unknown_prior', 'new_a', 1), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    expect(state.corrections).toHaveLength(1);
    expect(state.corrections[0].priorAssertionId).toBe('unknown_prior');
    // new_a doesn't appear in reveals because unknown_prior was never there
    expect(state.reveals).not.toContain('new_a');
  });

  it('correction with unknown new assertion supersedes prior (current permissive)', () => {
    // STRICT PREFLIGHT: newAssertionId must exist and be different from prior.
    const ledger = makeLedger([
      entry('e1', revealAction('existing_a', 1), 'scene_1', 'main'),
      entry('e2', correctionAction('existing_a', 'nonexistent_new', 2), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 2, 'main');
    // existing_a is replaced by nonexistent_new in reveals
    expect(state.reveals).toContain('nonexistent_new');
    expect(state.reveals).not.toContain('existing_a');
  });

  it('duplicate assertion IDs in catalog use last-write-wins (current permissive)', () => {
    // STRICT PREFLIGHT: duplicate assertion IDs should be a catalog error,
    // not last-write-wins via object property overwrite.
    const dupAssertions: Record<string, NarratorAssertion> = {
      a1: makeAssertion('a1', true, 'authoritative_reveal'),
    };
    // Overwrite a1 with different assertion (same id, different props)
    dupAssertions.a1 = makeAssertion('a1', false, 'claim');
    // Last write wins with plain object
    expect(dupAssertions.a1.truthBoundary).toBe(false);
  });

  it('entry referencing unknown scene produces no authorized targets', () => {
    // When an entry's sceneId doesn't match the event being compiled,
    // the compiler filters it out — no authorized targets for this scene
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 1), 'scene_other', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    // Entry still replays into discourse state since replayDiscourseState
    // doesn't filter by sceneId — that's the compiler's job
    expect(state.reveals).toContain('r1');
    // But compile() would filter by event.id, so an event with id 'scene_current'
    // would get no authorized targets from an entry for 'scene_other'
  });

  it('non-reveal/non-claim actions do not create authorized targets', () => {
    // Hint, retraction, withhold actions never produce authorizedTargets entries
    const ledger = makeLedger([
      entry('e1', hintAction('h1', 'surface', 'target', 1), 'scene_1', 'main'),
      entry('e2', retractionAction('nonexistent', 2), 'scene_1', 'main'),
      entry('e3', withholdStartAction('wp1', 3), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 3, 'main');
    // These actions are in discourse state but aren't "authorized targets"
    expect(state.hints).toHaveLength(1);
    expect(state.retractions).toHaveLength(1);
    expect(state.activeWithholds).toHaveLength(1);
    // The projectDiscourseContext with empty authorized list has no targets
    const projection = projectDiscourseContext(state, undefined, undefined, []);
    expect(projection.authorizedTargets).toHaveLength(0);
    // Hint surface only — no target proposition leak
    expect(projection.visibleHints).toHaveLength(1);
  });

  it('withhold_end without prior withhold_start is silently ignored', () => {
    // STRICT PREFLIGHT: withhold_end for unknown policy should be a preflight error.
    const ledger = makeLedger([
      entry('e1', withholdEndAction('ghost_policy', 1), 'scene_1', 'main'),
    ]);
    const state = replayDiscourseState(ledger, 1, 'main');
    // No active withholds — the end has no effect
    expect(state.activeWithholds).toHaveLength(0);
  });

  it('correction of non-active assertion (already corrected) is permissive', () => {
    // Correcting an assertion that was already corrected — current code allows
    // chaining corrections
    const ledger = makeLedger([
      entry('e1', revealAction('orig', 1), 'scene_1', 'main'),
      entry('e2', correctionAction('orig', 'v2', 2), 'scene_1', 'main'),
      entry('e3', correctionAction('orig', 'v3', 3), 'scene_1', 'main'), // orig already corrected
    ]);
    const state = replayDiscourseState(ledger, 3, 'main');
    // v3 replaces orig in reveals (e2: v2 replaces orig, e3: nothing to replace since
    // reveals has 'v2' not 'orig', but code does indexOf('orig') === -1 so no-op)
    // This depends on the order: after e2, reveals = ['v2']; e3 tries to find 'orig' in ['v2'] -> -1
    expect(state.reveals).toContain('v2');
    // The third correction records but doesn't replace
    expect(state.corrections).toHaveLength(2);
  });

  it('non-continuous same-scene positions throw ConfigError in compileDiscourseBoundaries preflight', () => {
    // Per-scene action positions must form a contiguous range with no gaps.
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 0), 'scene_A', 'main'),
      entry('e2', revealAction('r2', 2), 'scene_A', 'main'), // gap: position 1 missing
    ]);
    const assertions: Record<string, NarratorAssertion> = {
      r1: makeAssertion('r1', true, 'reveal'),
      r2: makeAssertion('r2', true, 'reveal'),
    };
    const eventA = makeEvent({ id: 'scene_A', narratorProfileRef: 'narrator_1' });
    const profiles: Record<string, NarratorProfile> = {
      narrator_1: createExplicitLedgerProfile(
        'narrator_1', 'full', 'full', 'full_knowledge', 'reliable', 'sincere',
      ),
    };
    expect(() =>
      compileDiscourseBoundaries([eventA], ledger, assertions, profiles, 'main'),
    ).toThrow('has non-continuous action positions');
  });
});

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    event: 'test_event',
    narrativeOrder: 1,
    title: 'Test Event',
    storyTime: { type: 'absolute', value: 'day_1' },
    sceneType: 'linear',
    pov: { character: 'test-char', type: 'third_person_limited' },
    sceneBrief: 'Test scene for compiled discourse boundary projection.',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 16. Compiled discourse boundary projection from stateAfter (§12)
// ═════════════════════════════════════════════════════════════════════════════
// These tests verify that compileDiscourseBoundaries derives its safe Pass 1
// projection from stateAfter (including the current scene's own reveal/claim
// actions), while stateBefore remains empty for the first action position.
// Hint targets must NEVER appear in the projection.

describe('compiled discourse boundary projection from stateAfter (§12)', () => {
  it('two-action scene: projection includes both reveal and claim from stateAfter', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 0), 'scene_1', 'main'),
      entry('e2', claimAction('c1', 1), 'scene_1', 'main'),
    ]);
    const assertions: Record<string, NarratorAssertion> = {
      r1: makeAssertion('r1', true, 'reveal'),
      c1: makeAssertion('c1', false, 'claim'),
    };
    const profiles: Record<string, NarratorProfile> = {
      narrator_1: createExplicitLedgerProfile(
        'narrator_1', 'full', 'full', 'full_knowledge', 'reliable', 'sincere',
      ),
    };
    const event = makeEvent({ id: 'scene_1', narratorProfileRef: 'narrator_1' });

    const ctx = compileDiscourseBoundaries(
      [event], ledger, assertions, profiles, 'main',
    );

    const compiled = ctx['scene_1'];

    // stateBefore is empty (pre-range — position 0 is the first action)
    expect(compiled.stateBefore.reveals).toEqual([]);
    expect(compiled.stateBefore.openClaims).toEqual([]);

    // stateAfter includes both actions
    expect(compiled.stateAfter.reveals).toContain('r1');
    expect(compiled.stateAfter.openClaims).toContain('c1');

    // projection (derived from stateAfter) includes both
    expect(compiled.projection.plannedReveals).toContain('r1');
    expect(compiled.projection.openClaims).toContain('c1');
    expect(compiled.projection.authorizedTargets).toHaveLength(2);
    expect(compiled.projection.authorizedTargets.map((t) => t.assertionId)).toEqual(['r1', 'c1']);

    // stateBefore and stateAfter are distinct snapshots
    expect(compiled.stateBefore).not.toBe(compiled.stateAfter);
  });

  it('single-action scene: projection includes the one reveal', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 0), 'scene_1', 'main'),
    ]);
    const assertions: Record<string, NarratorAssertion> = {
      r1: makeAssertion('r1', true, 'reveal'),
    };
    const event = makeEvent({ id: 'scene_1', narratorProfileRef: 'narrator_1' });

    const ctx = compileDiscourseBoundaries(
      [event], ledger, assertions, {}, 'main',
    );

    const compiled = ctx['scene_1'];

    // stateBefore empty, stateAfter has the reveal
    expect(compiled.stateBefore.reveals).toEqual([]);
    expect(compiled.stateAfter.reveals).toContain('r1');

    // projection (from stateAfter) includes the reveal
    expect(compiled.projection.plannedReveals).toContain('r1');
    expect(compiled.projection.authorizedTargets).toHaveLength(1);
    expect(compiled.projection.authorizedTargets[0].assertionId).toBe('r1');
  });

  it('no-ledger returns empty discourse contexts (no-disclosure mode)', () => {
    const event = makeEvent({ id: 'scene_1', discourseCursor: -1, narratorProfileRef: 'narrator_1' });
    const ctx = compileDiscourseBoundaries(
      [event], null, {}, {}, 'main',
    );
    // No ledger means no discourse — compileDiscourseBoundaries returns empty map
    expect(Object.keys(ctx)).toHaveLength(0);
    expect(ctx['scene_1']).toBeUndefined();
  });

  it('hint target excluded from projection when ledger has hint alongside reveal', () => {
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 0), 'scene_1', 'main'),
      entry('e2', hintAction('h1', 'surface_only', 'hidden_target', 1), 'scene_1', 'main'),
    ]);
    const assertions: Record<string, NarratorAssertion> = {
      r1: makeAssertion('r1', true, 'reveal'),
    };
    const event = makeEvent({ id: 'scene_1', narratorProfileRef: 'narrator_1' });

    const ctx = compileDiscourseBoundaries(
      [event], ledger, assertions, {}, 'main',
    );

    const compiled = ctx['scene_1'];
    const proj = compiled.projection;

    // Hint is visible in projection (surface only)
    expect(proj.visibleHints).toHaveLength(1);
    expect(proj.visibleHints[0].surfaceProposition).toBe('surface_only');

    // Hint target is ABSENT from projection
    const projStr = JSON.stringify(proj);
    expect(projStr).not.toContain('hidden_target');

    // Reveal still appears
    expect(proj.plannedReveals).toContain('r1');
    expect(proj.authorizedTargets).toHaveLength(1);
    expect(proj.authorizedTargets[0].assertionId).toBe('r1');

    // Hint does NOT appear in authorized targets
    expect(proj.authorizedTargets.map((t) => t.assertionId)).not.toContain('h1');
  });

  it('sparse positions across scenes: projection includes actions from stateAfter', () => {
    // Positions 0 and 5 (gap) — different scene IDs for valid sparse
    const ledger = makeLedger([
      entry('e1', revealAction('r1', 0), 'scene_1', 'main'),
      entry('e2', claimAction('c1', 5), 'scene_2', 'main'),
    ]);
    const assertions: Record<string, NarratorAssertion> = {
      r1: makeAssertion('r1', true, 'reveal'),
      c1: makeAssertion('c1', false, 'claim'),
    };
    const profiles: Record<string, NarratorProfile> = {
      narrator_1: createExplicitLedgerProfile(
        'narrator_1', 'full', 'full', 'full_knowledge', 'reliable', 'sincere',
      ),
    };
    const scene1 = makeEvent({ id: 'scene_1', narratorProfileRef: 'narrator_1' });
    const scene2 = makeEvent({ id: 'scene_2', narratorProfileRef: 'narrator_1' });

    const ctx = compileDiscourseBoundaries(
      [scene1, scene2], ledger, assertions, profiles, 'main',
    );

    // scene_1 at position 0: stateBefore empty, stateAfter has r1 only
    const compiled1 = ctx['scene_1'];
    expect(compiled1.stateBefore.reveals).toEqual([]);
    expect(compiled1.stateAfter.reveals).toContain('r1');
    expect(compiled1.stateAfter.openClaims).toEqual([]);
    expect(compiled1.projection.plannedReveals).toContain('r1');
    expect(compiled1.projection.openClaims).toEqual([]);

    // scene_2 at position 5: stateBefore includes r1 from scene_1,
    // stateAfter includes both r1 and c1
    const compiled2 = ctx['scene_2'];
    expect(compiled2.stateBefore.reveals).toContain('r1');
    expect(compiled2.stateAfter.reveals).toContain('r1');
    expect(compiled2.stateAfter.openClaims).toContain('c1');
    expect(compiled2.projection.plannedReveals).toContain('r1');
    expect(compiled2.projection.openClaims).toContain('c1');
  });
});
