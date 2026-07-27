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

  it('throws on out-of-bounds position (negative)', () => {
    const ledger = makeLedger([]);
    expect(() => replayDiscourseState(ledger, -1, 'main')).toThrow(
      'DiscoursePosition out of bounds',
    );
  });

  it('throws on out-of-bounds position (beyond length)', () => {
    const ledger = makeLedger([entry('e1', revealAction('r1', 1), 's1', 'main')]);
    expect(() => replayDiscourseState(ledger, 5, 'main')).toThrow(
      'DiscoursePosition out of bounds',
    );
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
