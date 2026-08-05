import { describe, expect, it } from 'vitest';
import { EntityMapper } from '../../src/entity/mapper.ts';
import { ConfigError } from '../../src/errors.ts';
import type {
  EventFile,
  KnowledgeTransaction,
  RelationshipEffect,
  RuleTransaction,
  ThreadProgressEntry,
} from '../../src/types/index.ts';
import { createSourceSnapshot } from '../fixtures/source-snapshot.ts';

// ============================================================================
// Canonical Stage-1 authoring contracts — mapper behavior
//
// The mapper must load the four required catalog roots and the canonical
// declaration directories through strict schemas, fail with ConfigError on
// missing/malformed documents and file/ID mismatches, normalize scalar
// EventFile threadProgress once into catalog-checked ThreadTransactions, and
// pass canonical relationship/rule/knowledge effects through directly (no
// converters, no legacy shapes).
// ============================================================================

function baseDocuments(): Record<string, string> {
  return {
    'nova.yaml': 'project: canonical-test\ntitle: Canonical\nauthor: Tester\n',
    'definitions/state_initial.yaml': `
info:
  currentEra: era_1
  politicalSituation: calm
threads:
  - threadId: T1
    name: Main plot
    description: The main plot thread
    typeId: plot
    targetRevealChapter: 5
    initialProgress: started
knowledge:
  claims: []
  commonGround: []
worldFacts: []
`,
    'definitions/entity-types.yaml': 'types: {}\n',
    'definitions/thread-types.yaml': `
types:
  plot:
    typeId: plot
    description: Main plot
    allowedPhases: [setup, climax, resolution]
    lifecyclePolicy:
      reopenPolicy: forbidden
    timeDomain: story
    stableGoals:
      - goalId: goal_1
        status: pending
    stableMilestones: []
`,
    'definitions/propositions.yaml': 'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'definitions/relationship-types.yaml': `
types:
  mentor:
    typeId: mentor
    label: Mentor
    roles: []
    continuityImpact: preserve
`,
    'definitions/rule-types.yaml': `
types:
  law:
    typeId: law
    name: Law
    category: legal
    defaultConstraints: []
`,
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

const makeEventFile = (overrides: Partial<EventFile> = {}): EventFile => ({
  event: 'E1',
  narrativeOrder: 1,
  title: 'Event One',
  pov: { character: 'camille', type: 'third_person_limited' },
  sceneBrief: 'A scene.',
  beats: ['beat one'],
  preconditions: [],
  expectedPostconditions: [],
  ...overrides,
});

describe('EntityMapper canonical catalog loading', () => {
  it('loads the four catalog roots and declaration directories into ProjectData', () => {
    const data = new EntityMapper(createSourceSnapshot(baseDocuments())).loadProject();
    expect(data.threadTypeCatalog.types.plot.typeId).toBe('plot');
    expect(data.propositionCatalog.version).toBe(1);
    expect(data.relationshipTypeCatalog.types.mentor.typeId).toBe('mentor');
    expect(data.ruleTypeCatalog.types.law.typeId).toBe('law');
    expect(data.relationshipDeclarations.map((d) => d.relationshipId)).toEqual(['rel_a']);
    expect(data.ruleDeclarations.map((d) => d.ruleId)).toEqual(['rule_a']);
    expect(data.worldInitialState.threads[0]?.threadId).toBe('T1');
    expect(data.worldInitialState.knowledge).toEqual({ claims: [], commonGround: [] });
  });

  it('throws ConfigError when a required catalog root is missing', () => {
    const documents = baseDocuments();
    delete documents['definitions/thread-types.yaml'];
    expect(() => new EntityMapper(createSourceSnapshot(documents)).loadProject()).toThrow(
      ConfigError,
    );
  });

  it('throws ConfigError on malformed catalog content (map-key/typeId mismatch)', () => {
    const documents = baseDocuments();
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
    expect(() => new EntityMapper(createSourceSnapshot(documents)).loadProject()).toThrow(
      ConfigError,
    );
  });

  it('throws ConfigError when a declaration file name does not match its id', () => {
    const documents = baseDocuments();
    documents['definitions/relationships/rel_a.yaml'] = `
relationshipId: rel_b
typeId: mentor
initialEpoch:
  epochId: epoch_1
  lifecycle: active
  memberships: []
  dimensions: []
`;
    expect(() => new EntityMapper(createSourceSnapshot(documents)).loadProject()).toThrow(
      /does not match relationshipId/,
    );
  });

  it('throws ConfigError for a malformed rule declaration', () => {
    const documents = baseDocuments();
    documents['definitions/rules/rule_a.yaml'] = 'ruleId: rule_a\nname: Broken\n';
    expect(() => new EntityMapper(createSourceSnapshot(documents)).loadProject()).toThrow(
      ConfigError,
    );
  });
});

describe('EntityMapper canonical catalog invariants', () => {
  it('rejects cyclic proposition dependencies before runtime compilation', () => {
    const documents = baseDocuments();
    documents['definitions/propositions.yaml'] = `
version: 1
propositions:
  p1:
    kind: intensional
    id: p1
    content: first
    domain: plan
  p2:
    kind: intensional
    id: p2
    content: second
    domain: plan
dependencyGraph:
  p1: [p2]
  p2: [p1]
`;
    expect(() => new EntityMapper(createSourceSnapshot(documents)).loadProject()).toThrow(
      /Cycle detected in proposition dependency graph/,
    );
  });

  it('rejects initial knowledge with unknown subjects or propositions', () => {
    const documents = baseDocuments();
    documents['definitions/state_initial.yaml'] =
      documents['definitions/state_initial.yaml']?.replace(
        'claims: []',
        'claims:\n  - subject: unknown_subject\n    propositionId: unknown_proposition\n    assessment: { type: settled, grade: know, polarity: affirmative }\n    evidence: []',
      ) ?? '';
    expect(() => new EntityMapper(createSourceSnapshot(documents)).loadProject()).toThrow(
      /Unknown entity "unknown_subject"/,
    );

    const unknownProposition = baseDocuments();
    unknownProposition['definitions/state_initial.yaml'] =
      unknownProposition['definitions/state_initial.yaml']
        ?.replace(
          'worldFacts: []',
          'worldFacts:\n  - id: known_subject\n    value: known\n    description: Known subject',
        )
        .replace(
          'claims: []',
          'claims:\n  - subject: known_subject\n    propositionId: unknown_proposition\n    assessment: { type: settled, grade: know, polarity: affirmative }\n    evidence: []',
        ) ?? '';
    expect(() => new EntityMapper(createSourceSnapshot(unknownProposition)).loadProject()).toThrow(
      /Unknown proposition "unknown_proposition"/,
    );
  });

  it('rejects an initial relationship epoch that violates its role cardinality', () => {
    const documents = baseDocuments();
    documents['definitions/relationship-types.yaml'] = `
types:
  mentor:
    typeId: mentor
    label: Mentor
    roles:
      - roleId: mentor
        label: Mentor
        minCardinality: 1
        maxCardinality: 1
        allowedEntityKinds: [character]
    continuityImpact: preserve
`;
    expect(() => new EntityMapper(createSourceSnapshot(documents)).loadProject()).toThrow(
      /Invalid cardinality for relationship role "mentor"/,
    );
  });

  it('rejects a rule whose initial specification or scope binding is invalid', () => {
    const missingSpecification = baseDocuments();
    missingSpecification['definitions/rules/rule_a.yaml'] =
      missingSpecification['definitions/rules/rule_a.yaml']?.replace(
        'initialSpecificationId: spec_1',
        'initialSpecificationId: missing',
      ) ?? '';
    expect(() =>
      new EntityMapper(createSourceSnapshot(missingSpecification)).loadProject(),
    ).toThrow(/Unknown initial specification "missing"/);

    const unknownBinding = baseDocuments();
    unknownBinding['definitions/rules/rule_a.yaml'] =
      unknownBinding['definitions/rules/rule_a.yaml']?.replace(
        'scopeBindings: {}',
        'scopeBindings: { actor: unknown_entity }',
      ) ?? '';
    expect(() => new EntityMapper(createSourceSnapshot(unknownBinding)).loadProject()).toThrow(
      /Unknown entity "unknown_entity"/,
    );
  });
});

describe('EntityMapper canonical event mapping', () => {
  it('carries greyLines through mapping', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    const event = mapper.mapToNarrativeEvent(
      makeEventFile({
        greyLines: [
          {
            id: 'gl_rain',
            imagery: 'rain',
            nodes: [{ eventId: 'E1', semanticAccumulation: 'gloom', narrativeOrder: 1 }],
          },
        ],
      }),
    );
    expect(event.greyLines).toEqual([
      {
        id: 'gl_rain',
        imagery: 'rain',
        nodes: [{ eventId: 'E1', semanticAccumulation: 'gloom', narrativeOrder: 1 }],
      },
    ]);
  });

  it('normalizes scalar threadProgress once into catalog-checked transactions', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    const progress: ThreadProgressEntry[] = [
      { thread: 'T1', advancement: 'reaching the midpoint', progressAfter: 5, progressTotal: 5 },
    ];
    const event = mapper.mapToNarrativeEvent(makeEventFile({ threadProgress: progress }));
    expect(event.threadProgress).toHaveLength(1);
    expect(event.threadProgress[0]).toMatchObject({
      thread: 'T1',
      status: 'completed',
      provenance: 'E1',
      advancement: 'reaching the midpoint',
    });
    expect(event.threadProgress[0]?.goalSet).toEqual([{ goalId: 'goal_1', status: 'achieved' }]);
  });

  it('rejects thread progress for an undeclared thread', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    expect(() =>
      mapper.mapToNarrativeEvent(
        makeEventFile({
          threadProgress: [
            { thread: 'unknown', advancement: 'x', progressAfter: 1, progressTotal: 2 },
          ],
        }),
      ),
    ).toThrow(/Unknown thread "unknown"/);
  });

  it('rejects duplicate thread writes within one event', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    expect(() =>
      mapper.mapToNarrativeEvent(
        makeEventFile({
          threadProgress: [
            { thread: 'T1', advancement: 'first', progressAfter: 1, progressTotal: 2 },
            { thread: 'T1', advancement: 'second', progressAfter: 2, progressTotal: 2 },
          ],
        }),
      ),
    ).toThrow(/Duplicate thread write for "T1"/);
  });

  it('passes canonical relationship effects through without conversion', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    const effects: RelationshipEffect[] = [
      {
        type: 'relationship_transaction',
        effectId: 'rel_a_1',
        relationshipId: 'rel_a',
        epochId: 'epoch_1',
        lifecycleAfter: 'active',
        membershipAfter: [
          { membershipId: 'm1', entityId: 'camille', role: 'member' },
          { membershipId: 'm2', entityId: 'seraphine', role: 'member' },
        ],
        dimensionSet: [{ dimensionId: 'direction', scope: 'global', value: 'toward' }],
      },
      {
        type: 'identity_transition',
        oldEpochClosures: [{ relationshipId: 'rel_a', epochId: 'epoch_1' }],
        newTransactions: [
          {
            type: 'relationship_transaction',
            effectId: 'rel_a_2',
            relationshipId: 'rel_a',
            membershipAfter: [{ membershipId: 'm3', entityId: 'camille' }],
          },
        ],
      },
    ];
    const event = mapper.mapToNarrativeEvent(makeEventFile({ relationshipEffects: effects }));
    expect(event.relationshipEffects).toEqual(effects);
    expect(event.participants.entities).toContain('camille');
    expect(event.participants.entities).toContain('seraphine');
  });

  it('passes rule effects through as RuleTransaction[]', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    const ruleEffects: RuleTransaction[] = [
      {
        type: 'rule_transaction',
        ruleId: 'rule_a',
        operation: 'enable',
        evidence: 'E1 activates the rule',
      },
    ];
    const event = mapper.mapToNarrativeEvent(makeEventFile({ ruleEffects }));
    expect(event.ruleEffects).toEqual(ruleEffects);
  });

  it('normalizes knowledge transactions (timestamps parsed, eventId stamped)', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    const transactions: KnowledgeTransaction[] = [
      {
        type: 'information_act',
        actType: 'testimony',
        actor: 'camille',
        recipients: ['seraphine'],
        contentPropositions: ['prop_1'],
        timestamp: { at: 'day_1' },
      },
      {
        type: 'common_ground',
        propositionId: 'prop_1',
        participants: ['camille', 'seraphine'],
        establishedAt: { at: 'day_2' },
      },
    ];
    const event = mapper.mapToNarrativeEvent(
      makeEventFile({ knowledgeTransactions: transactions }),
    );
    expect(event.knowledgeTransactions).toEqual([
      {
        type: 'information_act',
        actType: 'testimony',
        actor: 'camille',
        recipients: ['seraphine'],
        contentPropositions: ['prop_1'],
        timestamp: { type: 'absolute', value: 'day_1' },
        eventId: 'E1',
      },
      {
        type: 'common_ground',
        propositionId: 'prop_1',
        participants: ['camille', 'seraphine'],
        establishedAt: { type: 'absolute', value: 'day_2' },
        provenance: 'E1',
      },
    ]);
  });

  it('omits knowledgeTransactions when the event authors none', () => {
    const mapper = new EntityMapper(createSourceSnapshot(baseDocuments()));
    mapper.loadProject();
    const event = mapper.mapToNarrativeEvent(makeEventFile());
    expect(event.knowledgeTransactions).toBeUndefined();
  });
});
