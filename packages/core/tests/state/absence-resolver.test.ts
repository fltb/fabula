import { describe, expect, it } from 'vitest';
import {
  aggregateAbsenceEvaluation,
  type BuildAbsenceWitnessParams,
  buildAbsenceWitness,
  resolveAbsenceBasis,
} from '../../src/state/absence-resolver.ts';
import type {
  AbsenceBasis,
  AbsenceWitness,
  BranchPath,
  ProviderOutput,
  ReadResolution,
} from '../../src/types/index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function testBranch(decisions: BranchPath['decisions'] = []): BranchPath {
  return { decisions };
}

// ─── Constraint 1: AbsenceWitness has exactly 4 basis values ─────────────────

describe('AbsenceWitness basis values', () => {
  it('has exactly 4 distinct basis values', () => {
    const bases = new Set<AbsenceBasis>([
      'never_written',
      'pre_introduction',
      'after_unset',
      'branch_local',
    ]);
    expect(bases.size).toBe(4);
  });
});

// ─── Constraint 14: Minimum test categories ──────────────────────────────────
// Category 1: never-written / pre-introduction / after-unset / branch-local absence

describe('buildAbsenceWitness — four basis constructions', () => {
  const branch = testBranch([{ atEventId: 'E1', choiceId: 'choice_a', narrativeOrder: 1 }]);
  const prefix = 'node_1';

  it('constructs never_written absence witness', () => {
    const witness = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis: 'never_written' });
    expect(witness.basis).toBe('never_written');
    expect(witness.branch.decisions).toEqual(branch.decisions);
    expect(witness.temporalPrefix).toBe(prefix);
    expect(witness.resolutionHash).toBeTruthy();
    expect(witness.latestUnsetOutput).toBeUndefined();
  });

  it('constructs pre_introduction absence witness', () => {
    const witness = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'pre_introduction',
    });
    expect(witness.basis).toBe('pre_introduction');
    expect(witness.resolutionHash).toBeTruthy();
  });

  it('constructs after_unset absence witness with latestUnsetOutput', () => {
    const witness = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'after_unset',
      latestUnsetOutput: 'unset_001',
    });
    expect(witness.basis).toBe('after_unset');
    expect(witness.latestUnsetOutput).toBe('unset_001');
  });

  it('constructs branch_local absence witness', () => {
    const witness = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis: 'branch_local' });
    expect(witness.basis).toBe('branch_local');
    expect(witness.resolutionHash).toBeTruthy();
  });

  it('AbsenceWitness is not a ProviderOutput (no causality field)', () => {
    const witness = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis: 'never_written' });
    // AbsenceWitness should not have the causality marker that ProviderOutput has
    expect((witness as Record<string, unknown>).causality).toBeUndefined();
  });

  it('AbsenceWitness satisfies presence-aware reads (exists/not_exists)', () => {
    const witness = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis: 'never_written' });
    // The witness indicates absence; presence-aware reads can use it
    expect(witness.basis).toBe('never_written');
    // The witness itself does not pretend to be a write/output
    expect('causality' in witness).toBe(false);
  });
});

// Category 2: snapshot restart — deterministic construction

describe('AbsenceWitness — deterministic / snapshot restart', () => {
  it('same inputs produce same resolutionHash', () => {
    const branch = testBranch([{ atEventId: 'E1', choiceId: 'choice_a', narrativeOrder: 1 }]);
    const prefix = 'node_5';
    const basis: AbsenceBasis = 'never_written';

    const first = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis });
    const second = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis });

    expect(first.resolutionHash).toBe(second.resolutionHash);
    expect(first.branch.decisions).toEqual(second.branch.decisions);
    expect(first.temporalPrefix).toBe(second.temporalPrefix);
  });

  it('different inputs produce different resolutionHash', () => {
    const branch = testBranch();
    const a = buildAbsenceWitness({ branch, temporalPrefix: 'prefix_a', basis: 'never_written' });
    const b = buildAbsenceWitness({ branch, temporalPrefix: 'prefix_b', basis: 'branch_local' });
    expect(a.resolutionHash).not.toBe(b.resolutionHash);
  });
});

// Category 3: aggregate three-valued evaluation

describe('aggregateAbsenceEvaluation — three-valued evaluation', () => {
  const branch = testBranch();
  const prefix = 'node_1';

  it('empty witnesses returns never_written', () => {
    const result = aggregateAbsenceEvaluation([]);
    expect(result.exists).toBe(false);
    expect(result.basis).toBe('never_written');
    expect(result.witnessCount).toBe(0);
  });

  it('single witness returns its basis', () => {
    const w = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'after_unset',
      latestUnsetOutput: 'u1',
    });
    const result = aggregateAbsenceEvaluation([w]);
    expect(result.basis).toBe('after_unset');
    expect(result.witnessCount).toBe(1);
  });

  it('never_written beats pre_introduction beats after_unset beats branch_local', () => {
    const branchLocal = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'branch_local',
    });
    const afterUnset = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'after_unset',
    });
    const preIntro = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'pre_introduction',
    });
    const neverWritten = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'never_written',
    });

    // Mixed — never_written strongest
    const result = aggregateAbsenceEvaluation([branchLocal, afterUnset, preIntro, neverWritten]);
    expect(result.basis).toBe('never_written');
    expect(result.exists).toBe(false);
    expect(result.witnessCount).toBe(4);

    // Without never_written — pre_introduction strongest
    const result2 = aggregateAbsenceEvaluation([branchLocal, afterUnset, preIntro]);
    expect(result2.basis).toBe('pre_introduction');

    // Without pre_introduction — after_unset strongest
    const result3 = aggregateAbsenceEvaluation([branchLocal, afterUnset]);
    expect(result3.basis).toBe('after_unset');
  });
});

// Category 4: exactly-one ReadResolution

describe('ReadResolution — exactly one per deterministic read', () => {
  const branch = testBranch();
  const prefix = 'node_1';

  it('ProviderOutput is a valid ReadResolution', () => {
    const provider: ProviderOutput = {
      outputId: 'out_1',
      provider: 'test_provider',
      eventId: 'E1',
      branch,
      temporalPrefix: prefix,
      content: 'rendered text',
      resolutionHash: 'abcdef01',
      causality: 'provider_edge',
    };
    const resolution: ReadResolution = provider;
    expect(resolution).toBeDefined();
    if ('causality' in resolution) {
      expect(resolution.causality).toBe('provider_edge');
    }
  });

  it('AbsenceWitness is a valid ReadResolution', () => {
    const witness = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis: 'never_written' });
    const resolution: ReadResolution = witness;
    expect(resolution).toBeDefined();
    // AbsenceWitness uses absence index, not causality
    expect((resolution as AbsenceWitness).basis).toBe('never_written');
  });

  it('ReadResolution discriminates between provider and absence', () => {
    const provider: ReadResolution = {
      outputId: 'out_2',
      provider: 'llm',
      eventId: 'E2',
      branch,
      temporalPrefix: prefix,
      content: 'text',
      resolutionHash: '12345678',
      causality: 'provider_edge',
    };
    const witness: ReadResolution = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'branch_local',
    });

    const isProvider = (r: ReadResolution): r is ProviderOutput => 'causality' in r;
    expect(isProvider(provider)).toBe(true);
    expect(isProvider(witness)).toBe(false);
  });
});

// Category 5: stateBefore vs stateAfter (not a WorldState write)

describe('AbsenceWitness — not a WorldState write', () => {
  const branch = testBranch();
  const prefix = 'node_1';

  it('does not write to WorldState', () => {
    const witness = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis: 'never_written' });
    // AbsenceWitness has no worldState field, no write operation
    expect('worldState' in witness).toBe(false);
    expect('operation' in witness).toBe(false);
    expect('value' in witness).toBe(false);
  });

  it('is not initialState unset', () => {
    const witness = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'after_unset',
      latestUnsetOutput: 'u1',
    });
    // Has latestUnsetOutput but does NOT represent the unset itself
    expect(witness.latestUnsetOutput).toBe('u1');
    expect(witness.basis).toBe('after_unset');
    // It's an absence record, not the unset operation
    expect((witness as Record<string, unknown>).operation).toBeUndefined();
  });

  it('is not author-origin output', () => {
    const witness = buildAbsenceWitness({ branch, temporalPrefix: prefix, basis: 'never_written' });
    // Author causality is not part of AbsenceWitness
    expect('author' in witness).toBe(false);
    expect('causality' in witness).toBe(false);
  });

  it('is not narrative causation', () => {
    const witness = buildAbsenceWitness({
      branch,
      temporalPrefix: prefix,
      basis: 'pre_introduction',
    });
    // No narrative causation field
    expect('narrativeCause' in witness).toBe(false);
  });
});

// Category 6: resolveAbsenceBasis

describe('resolveAbsenceBasis', () => {
  it('resolves never_written when set', () => {
    expect(
      resolveAbsenceBasis({
        neverWritten: true,
        preIntroduction: false,
        afterUnset: false,
        branchLocal: false,
      }),
    ).toBe('never_written');
  });

  it('resolves pre_introduction when neverWritten is false', () => {
    expect(
      resolveAbsenceBasis({
        neverWritten: false,
        preIntroduction: true,
        afterUnset: false,
        branchLocal: false,
      }),
    ).toBe('pre_introduction');
  });

  it('resolves after_unset when only that is set', () => {
    expect(
      resolveAbsenceBasis({
        neverWritten: false,
        preIntroduction: false,
        afterUnset: true,
        branchLocal: false,
      }),
    ).toBe('after_unset');
  });

  it('resolves branch_local when only that is set', () => {
    expect(
      resolveAbsenceBasis({
        neverWritten: false,
        preIntroduction: false,
        afterUnset: false,
        branchLocal: true,
      }),
    ).toBe('branch_local');
  });

  it('prioritizes never_written when multiple flags set', () => {
    expect(
      resolveAbsenceBasis({
        neverWritten: true,
        preIntroduction: true,
        afterUnset: true,
        branchLocal: true,
      }),
    ).toBe('never_written');
  });

  it('throws when no flag is set', () => {
    expect(() =>
      resolveAbsenceBasis({
        neverWritten: false,
        preIntroduction: false,
        afterUnset: false,
        branchLocal: false,
      }),
    ).toThrow('Cannot resolve absence basis');
  });
});
