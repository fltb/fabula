import { describe, expect, it } from 'vitest';
import type { SourceChangeV1 } from '../../src/contracts/source.ts';
import { analyzeSource } from '../../src/entity/source-analysis.ts';
import { createSourceSnapshot } from '../fixtures/source-snapshot.ts';

// ============================================================================
// Canonical Stage-1 authoring topology — source-analysis diagnostics
//
// analyzeSource must fail closed on missing required roots and on
// file/ID or catalog map-key mismatches, without host path APIs.
// ============================================================================

function canonicalDocuments(): Record<string, string> {
  return {
    'nova.yaml': 'project: canonical-test\ntitle: Canonical\nauthor: Tester\n',
    'definitions/state_initial.yaml': `
info:
  currentEra: era_1
  politicalSituation: calm
threads: []
knowledge:
  claims: []
  commonGround: []
worldFacts: []
`,
    'definitions/entity-types.yaml': 'types: {}\n',
    'definitions/thread-types.yaml': 'types: {}\n',
    'definitions/propositions.yaml': 'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'definitions/relationship-types.yaml': 'types: {}\n',
    'definitions/rule-types.yaml': 'types: {}\n',
    'definitions/relationships/rel_a.yaml': `
relationshipId: rel_a
typeId: mentor
initialEpoch:
  epochId: epoch_1
  lifecycle: active
  memberships: []
  dimensions: []
`,
    'definitions/rules/rule_a.yaml': `
ruleId: rule_a
name: Rule A
typeId: law
initialEpochId: epoch_1
initialSpecificationId: spec_1
initialActivation: dormant
initialEffectiveness: full
scopeBindings: {}
exceptions: []
specifications:
  spec_1:
    statement: A statement
    constraints: []
`,
  };
}

const noop = (): SourceChangeV1[] => [];

describe('canonical source topology analysis', () => {
  it('accepts a snapshot with all required roots and matching identities', () => {
    const result = analyzeSource(createSourceSnapshot(canonicalDocuments()), noop());
    expect(result.diagnostics).toEqual([]);
  });

  it('reports each missing required catalog root', () => {
    const documents = canonicalDocuments();
    delete documents['definitions/thread-types.yaml'];
    delete documents['definitions/propositions.yaml'];
    const result = analyzeSource(createSourceSnapshot(documents), noop());
    const missing = result.diagnostics.filter((d) => d.code === 'SOURCE_REQUIRED_FILE_MISSING');
    expect(missing.map((d) => d.logicalPath).sort()).toEqual([
      'definitions/propositions.yaml',
      'definitions/thread-types.yaml',
    ]);
  });

  it('reports file/ID mismatches in declaration directories', () => {
    const documents = canonicalDocuments();
    documents['definitions/relationships/rel_a.yaml'] = `
relationshipId: rel_b
typeId: mentor
initialEpoch:
  epochId: epoch_1
  lifecycle: active
  memberships: []
  dimensions: []
`;
    const result = analyzeSource(createSourceSnapshot(documents), noop());
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SOURCE_FILE_ID_MISMATCH',
        logicalPath: 'definitions/relationships/rel_a.yaml',
      }),
    );
  });

  it('reports catalog map-key mismatches in catalog roots', () => {
    const documents = canonicalDocuments();
    documents['definitions/thread-types.yaml'] = `
types:
  wrong-key:
    typeId: plot
    description: Main plot
    allowedPhases: [setup]
    lifecyclePolicy:
      reopenPolicy: forbidden
    timeDomain: story
    stableGoals: []
    stableMilestones: []
`;
    const result = analyzeSource(createSourceSnapshot(documents), noop());
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SOURCE_CATALOG_KEY_MISMATCH',
        logicalPath: 'definitions/thread-types.yaml',
      }),
    );
  });

  it('reports schema-invalid canonical documents', () => {
    const documents = canonicalDocuments();
    documents['definitions/rule-types.yaml'] = 'types:\n  law:\n    typeId: law\n    name: Law\n';
    const result = analyzeSource(createSourceSnapshot(documents), noop());
    expect(result.diagnostics.some((d) => d.code === 'SOURCE_SCHEMA_INVALID')).toBe(true);
  });
});
