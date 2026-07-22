import { describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  CapabilityManifestEntry,
} from '../../src/types/index.ts';
import {
  CapabilityRegistry,
  CapabilityGateError,
} from '../../src/state/capability-manifest.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CapabilityManifestEntry> & { capabilityId: string }): CapabilityManifestEntry {
  return {
    status: 'S',
    schemaVersions: ['1.0'],
    normalizationVersions: ['1.0'],
    supportedInputForms: ['yaml', 'json'],
    referenceCaseIds: ['ref-1'],
    propertyCaseIds: ['prop-1'],
    rejectionCaseIds: ['rej-1'],
    snapshotCases: ['snap-1'],
    fixtureIds: ['fix-1'],
    provenanceRequirements: ['source'],
    stageGate: 1,
    evidenceArtifactHash: 'abc123',
    ...overrides,
  };
}

function makeManifest(entries: CapabilityManifestEntry[]): CapabilityManifest {
  return {
    version: '1.0.0',
    entries,
    registryHash: 'test-hash',
  };
}

// ─── Manifest Registration ───────────────────────────────────────────────────

describe('CapabilityRegistry — manifest registration', () => {
  it('registers entries from a manifest', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'state_replay', status: 'S' }),
    ]));

    expect(reg.manifestVersion).toBe('1.0.0');
    expect(reg.registryHash).toBe('test-hash');
    expect(reg.hasEntry('state_replay')).toBe(true);
    expect(reg.entries.size).toBe(1);
  });

  it('rejects duplicate capabilityId on load', () => {
    const reg = new CapabilityRegistry();
    expect(() =>
      reg.loadManifest(makeManifest([
        makeEntry({ capabilityId: 'state_replay' }),
        makeEntry({ capabilityId: 'state_replay' }),
      ]))
    ).toThrow(CapabilityGateError);
  });

  it('getEntry returns undefined for unknown capability', () => {
    const reg = new CapabilityRegistry();
    expect(reg.getEntry('unknown')).toBeUndefined();
  });

  it('hasEntry returns false for unknown capability', () => {
    const reg = new CapabilityRegistry();
    expect(reg.hasEntry('unknown')).toBe(false);
  });
});

// ─── Missing Entry Rejection ─────────────────────────────────────────────────

describe('CapabilityRegistry — missing entry rejection', () => {
  it('assertEntry throws for missing capabilityId', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'state_replay' }),
    ]));

    expect(() => reg.assertEntry('unknown_cap')).toThrow(CapabilityGateError);
    expect(() => reg.assertEntry('unknown_cap')).toThrow(/input REJECTED/);
  });

  it('assertEntry returns entry for known capabilityId', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'state_replay' }),
    ]));

    const entry = reg.assertEntry('state_replay');
    expect(entry.capabilityId).toBe('state_replay');
    expect(entry.status).toBe('S');
  });

  it('assertInputCovered throws for uncovered input form', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'state_replay', supportedInputForms: ['yaml'] }),
    ]));

    expect(() => reg.assertInputCovered('state_replay', 'json')).toThrow(CapabilityGateError);
    expect(() => reg.assertInputCovered('state_replay', 'json')).toThrow(/not covered/);
  });

  it('assertInputCovered passes for covered input form', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'state_replay', supportedInputForms: ['yaml', 'json'] }),
    ]));

    expect(() => reg.assertInputCovered('state_replay', 'json')).not.toThrow();
    expect(() => reg.assertInputCovered('state_replay', 'yaml')).not.toThrow();
  });
});

// ─── Stage 1 Gate ────────────────────────────────────────────────────────────

describe('CapabilityRegistry — stage 1 gate', () => {
  it('passes when S core capabilities are manifest-complete', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'state_replay', status: 'S', stageGate: 1 }),
    ]));
    expect(() => reg.validateStage1()).not.toThrow();
  });

  it('fails when S stage-1 entry has empty referenceCaseIds', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'state_replay', status: 'S', stageGate: 1, referenceCaseIds: [] }),
    ]));
    expect(() => reg.validateStage1()).toThrow(CapabilityGateError);
    expect(() => reg.validateStage1()).toThrow(/referenceCaseIds is empty/);
  });

  it('fails when S stage-1 entry has empty propertyCaseIds', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'core_test', status: 'S', stageGate: 1, propertyCaseIds: [] }),
    ]));
    expect(() => reg.validateStage1()).toThrow(/propertyCaseIds is empty/);
  });

  it('fails when S stage-1 entry has empty rejectionCaseIds', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'core_test', status: 'S', stageGate: 1, rejectionCaseIds: [] }),
    ]));
    expect(() => reg.validateStage1()).toThrow(/rejectionCaseIds/);
  });

  it('fails when S stage-1 entry has empty fixtureIds', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'core_test', status: 'S', stageGate: 1, fixtureIds: [] }),
    ]));
    expect(() => reg.validateStage1()).toThrow(/fixtureIds/);
  });

  it('fails when S stage-1 entry has empty snapshotCases', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'core_test', status: 'S', stageGate: 1, snapshotCases: [] }),
    ]));
    expect(() => reg.validateStage1()).toThrow(/snapshotCases/);
  });

  it('fails when S stage-1 entry has empty evidenceArtifactHash', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'core_test', status: 'S', stageGate: 1, evidenceArtifactHash: '' }),
    ]));
    expect(() => reg.validateStage1()).toThrow(/evidenceArtifactHash/);
  });

  it('skips validation for non-S and non-stage-1 entries', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'c_cap', status: 'C', stageGate: 2 }),
      makeEntry({ capabilityId: 'x_cap', status: 'X', stageGate: 3 }),
    ]));
    // Should not throw even though these are sparse, because they're not S+stage1
    expect(() => reg.validateStage1()).not.toThrow();
  });
});

// ─── Stage 2 Gate ────────────────────────────────────────────────────────────

describe('CapabilityRegistry — stage 2 gate', () => {
  it('passes when C capabilities have provenanceRequirements', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({
        capabilityId: 'surface_prose_continuity_outcome',
        status: 'C',
        stageGate: 2,
        provenanceRequirements: ['annotation', 'corpus'],
        evidenceArtifactHash: 'def456',
      }),
    ]));
    expect(() => reg.validateStage2()).not.toThrow();
  });

  it('fails when C capability has empty provenanceRequirements', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({
        capabilityId: 'prose_outcome',
        status: 'C',
        stageGate: 2,
        provenanceRequirements: [],
        evidenceArtifactHash: 'hash',
      }),
    ]));
    expect(() => reg.validateStage2()).toThrow(CapabilityGateError);
    expect(() => reg.validateStage2()).toThrow(/provenanceRequirements/);
  });

  it('fails when stage-2 entry has empty evidenceArtifactHash', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({
        capabilityId: 'some_cap',
        status: 'S',
        stageGate: 2,
        evidenceArtifactHash: '',
      }),
    ]));
    expect(() => reg.validateStage2()).toThrow(/evidenceArtifactHash/);
  });

  it('passes for entries with stageGate > 2 even without evidenceArtifactHash', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({
        capabilityId: 'stage3_cap',
        status: 'X',
        stageGate: 3,
        evidenceArtifactHash: '',
      }),
    ]));
    // stageGate=3, so stage2 skips
    expect(() => reg.validateStage2()).not.toThrow();
  });
});

// ─── Stage 3 Gate + RENDER-SURFACE Constraint ────────────────────────────────

describe('CapabilityRegistry — stage 3 gate', () => {
  it('passes when all entries have valid schema/normalization versions', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1 }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2 }),
    ]));
    expect(() => reg.validateStage3()).not.toThrow();
  });

  it('fails when an entry has empty schemaVersions', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1 }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2 }),
      makeEntry({ capabilityId: 'bad_cap', status: 'X', stageGate: 3, schemaVersions: [] }),
    ]));
    expect(() => reg.validateStage3()).toThrow(/schemaVersions/);
  });

  it('fails when an entry has empty normalizationVersions', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1 }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2 }),
      makeEntry({ capabilityId: 'bad_cap', status: 'X', stageGate: 3, normalizationVersions: [] }),
    ]));
    expect(() => reg.validateStage3()).toThrow(/normalizationVersions/);
  });
});

// ─── RENDER-SURFACE Constraint 5 ─────────────────────────────────────────────

describe('CapabilityRegistry — RENDER-SURFACE constraint', () => {
  it('passes with surface_scheduler_contract (S) and surface_prose_continuity_outcome (C)', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1 }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2 }),
    ]));
    expect(() => reg.validateStage3()).not.toThrow();
  });

  it('fails when surface_scheduler_contract is missing', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2 }),
    ]));
    expect(() => reg.validateStage3()).toThrow(CapabilityGateError);
    expect(() => reg.validateStage3()).toThrow(/missing required capabilities/);
  });

  it('fails when surface_prose_continuity_outcome is missing', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1 }),
    ]));
    expect(() => reg.validateStage3()).toThrow(/missing required capabilities/);
  });

  it('fails when surface_scheduler_contract is not S status', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'C', stageGate: 1 }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2 }),
    ]));
    expect(() => reg.validateStage3()).toThrow(/must have S status/);
  });

  it('fails when surface_prose_continuity_outcome is not C status', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1 }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'S', stageGate: 2 }),
    ]));
    expect(() => reg.validateStage3()).toThrow(/must have C status/);
  });
});

// ─── All Stages ──────────────────────────────────────────────────────────────

describe('CapabilityRegistry — validateAllStages', () => {
  it('passes for a fully compliant manifest', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1 }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2, provenanceRequirements: ['annotation'], evidenceArtifactHash: 'hash' }),
      makeEntry({ capabilityId: 'stage3_x', status: 'X', stageGate: 3 }),
    ]));
    expect(() => reg.validateAllStages()).not.toThrow();
  });

  it('fails on stage 1 when S capability is incomplete', () => {
    const reg = new CapabilityRegistry();
    reg.loadManifest(makeManifest([
      makeEntry({ capabilityId: 'surface_scheduler_contract', status: 'S', stageGate: 1, referenceCaseIds: [] }),
      makeEntry({ capabilityId: 'surface_prose_continuity_outcome', status: 'C', stageGate: 2 }),
    ]));
    expect(() => reg.validateAllStages()).toThrow(CapabilityGateError);
  });
});
