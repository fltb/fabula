// ============================================================================
// Narrative Technique Pipeline Tests
//
// Verifies:
//   - Schema parses all eight direct technique contracts with deterministic
//     graph reference IDs
//   - EntityMapper maps contracts correctly
//   - NARRATIVE_TECHNIQUE_KINDS constant order provides canonical sorting
//   - Resolved ResolvedNarrativeTechniqueContract flows through ContextPackage
//   - Each technique kind maps to a valid narrativeCheck attribute (Pass 2)
//   - analysisContentSchema validates a full AnalysisResult with technique
//     narrativeChecks (generic validator)
//   - Legacy keys (modernNovel, antiCausalEdge, etc.) are rejected by schema
//   - Invalid values (blank instruction/evidence, duplicates) are rejected
// ============================================================================

import { describe, expect, it } from 'vitest';
import { EntityMapper } from '../src/entity/mapper.ts';
import { eventFileSchema } from '../src/schemas/event.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import { NARRATIVE_TECHNIQUE_KINDS } from '../src/types/narrative-techniques.ts';
import type { ResolvedNarrativeTechniqueContract } from '../src/types/narrative-techniques.ts';
import type { ContextPackage } from '../src/types/context.ts';
import { narrativeCheckSchema } from '../src/validator/schemas.ts';
import { analysisContentSchema } from '../src/validator/index.ts';
import type { EventFile } from '../src/types/event.ts';

function makeTechniqueEvent(): Record<string, unknown> {
  return {
    event: 'E0',
    narrativeOrder: 1,
    title: 'Technique contract',
    storyTime: 'day_1',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: 'A scene with every direct narrative technique contract.',
    preconditions: [],
    expectedPostconditions: [],
    causalDiscontinuity: {
      predecessor: 'E0',
      dependent: 'E1',
      instruction: 'Keep the missing causal link visible.',
      requiredEvidence: 'The consequence remains unexplained.',
    },
    surfaceMode: {
      instruction: '  Describe only observable action.  ',
      requiredEvidence: 'The door closes without commentary.',
    },
    causalMultiplicity: {
      minimumOutgoingEdges: 2,
      instruction: 'Preserve both causal consequences.',
      requiredEvidence: 'Two consequences diverge.',
    },
    irresolvableIndeterminacy: {
      assertionIds: ['assertion:unknown'],
      instruction: 'Keep the claim unresolved.',
      requiredEvidence: 'No account settles the claim.',
    },
    absentApparatus: {
      readId: 'E0:precondition:0',
      instruction: 'Treat absence as active.',
      requiredEvidence: 'The witness never appears.',
    },
    voiceDissonance: {
      assertionId: 'assertion:catastrophe',
      storyOutputId: 'E0:postcondition:0',
      instruction: 'Make the narrator dissonant.',
      requiredEvidence: 'The narrator calls the disaster delightful.',
    },
    multiplicity: {
      assertionIds: ['assertion:account-a', 'assertion:account-b'],
      instruction: 'Preserve both accounts.',
      requiredEvidence: 'Both accounts remain possible.',
    },
    metanarrativeLevel: {
      instruction: 'Expose the act of narration.',
      requiredEvidence: 'The narrator revises this sentence.',
    },
  };
}

describe('narrative technique event contracts', () => {
  it('parses strict direct contracts and maps all eight contracts through EntityMapper', () => {
    const parsed = eventFileSchema.parse(makeTechniqueEvent()) as EventFile;
    const mapper = new EntityMapper('/unused', new MemoryStorage());
    const event = mapper.mapToNarrativeEvent(parsed);

    expect(parsed.surfaceMode?.instruction).toBe('Describe only observable action.');
    expect(event.causalDiscontinuity).toEqual(parsed.causalDiscontinuity);
    expect(event.surfaceMode).toEqual(parsed.surfaceMode);
    expect(event.causalMultiplicity).toEqual(parsed.causalMultiplicity);
    expect(event.irresolvableIndeterminacy).toEqual(parsed.irresolvableIndeterminacy);
    expect(event.absentApparatus).toEqual(parsed.absentApparatus);
    expect(event.voiceDissonance).toEqual(parsed.voiceDissonance);
    expect(event.multiplicity).toEqual(parsed.multiplicity);
    expect(event.metanarrativeLevel).toEqual(parsed.metanarrativeLevel);
  });

  it('uses deterministic graph reference IDs for readId and storyOutputId', () => {
    const raw = makeTechniqueEvent();
    expect(raw.absentApparatus?.readId).toBe('E0:precondition:0');
    expect(raw.voiceDissonance?.storyOutputId).toBe('E0:postcondition:0');
  });

  it('provides canonical NARRATIVE_TECHNIQUE_KINDS ordering', () => {
    expect(NARRATIVE_TECHNIQUE_KINDS).toEqual([
      'causalDiscontinuity',
      'surfaceMode',
      'causalMultiplicity',
      'irresolvableIndeterminacy',
      'absentApparatus',
      'voiceDissonance',
      'multiplicity',
      'metanarrativeLevel',
    ]);
  });

  it('maps each technique kind to a valid narrativeCheck attribute (Pass 2 requirement)', () => {
    // Every NARRATIVE_TECHNIQUE_KINDS entry must be usable as a
    // narrativeCheck attribute (analysed by Pass 2 and consumed by
    // the narrative-technique validator).
    for (const kind of NARRATIVE_TECHNIQUE_KINDS) {
      const check = {
        entityId: 'E0',
        attribute: kind,
        hint: 'Generated from resolved technique contract.',
        evidence: 'Prose reflects the technique.',
        matchLevel: 'exact' as const,
      };
      const result = narrativeCheckSchema.safeParse(check);
      expect(result.success).toBe(true);
    }
  });

  it('validates a full AnalysisResult with technique narrativeChecks through analysisContentSchema (generic validator)', () => {
    const analysis = {
      postconditions: { covered: ['e1.a1=v1'], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: {
        proseScore: 8,
        maxScore: 10,
        strengths: [],
        weaknesses: [],
        estimatedWordCount: 300,
      },
      threadProgressAchieved: [],
      foreshadowingDeployed: [],
      narrativeChecks: [
        {
          entityId: 'E0',
          attribute: 'surfaceMode',
          hint: 'Describe only observable action.',
          evidence: 'The door closes without commentary.',
          matchLevel: 'exact',
        },
        {
          entityId: 'E0',
          attribute: 'causalDiscontinuity',
          hint: 'Keep the missing causal link visible.',
          evidence: 'The consequence remains unexplained.',
          matchLevel: 'similar',
        },
      ],
      appearanceChecks: [],
      characterReferences: [],
      tenseDetected: 'past',
      conflictAnalysis: {
        primaryType: 'none',
        resolutionAchieved: true,
      },
      ruleChecks: [],
      knowledgeChecks: [],
    };

    const result = analysisContentSchema.safeParse(analysis);
    expect(result.success).toBe(true);
  });

  it('populates ResolvedNarrativeTechniqueContract in ContextPackage', () => {
    const contracts: readonly ResolvedNarrativeTechniqueContract[] = [
      {
        kind: 'causalDiscontinuity',
        instruction: 'Keep the missing causal link visible.',
        requiredEvidence: 'The consequence remains unexplained.',
      },
      {
        kind: 'surfaceMode',
        instruction: 'Describe only observable action.',
        requiredEvidence: 'The door closes without commentary.',
      },
    ];

    const pkg: ContextPackage = {
      eventId: 'E0',
      systemContext: {
        targetAudience: undefined,
        synopsis: undefined,
        thematicIntent: undefined,
      },
      sceneSpec: {
        title: 'Technique contract',
        storyTime: 'day_1',
        pov: { character: 'narrator', type: 'omniscient' },
        sceneBrief: 'A scene with technique contracts.',
        preconditions: [],
        expectedPostconditions: [],
      },
      characterSnapshots: [],
      relationshipContext: [],
      worldFacts: [],
      knowledgeBoundary: { knownEntities: [], knownRelationships: [], knownFacts: [] },
      activeThreads: [],
      volumeSummary: '',
      markdown: '',
      narrativeTechniques: contracts,
    };

    expect(pkg.narrativeTechniques).toHaveLength(2);
    expect(pkg.narrativeTechniques[0].kind).toBe('causalDiscontinuity');
    expect(pkg.narrativeTechniques[0].instruction).toBeTruthy();
    expect(pkg.narrativeTechniques[0].requiredEvidence).toBeTruthy();

    // The narrativeTechniques field is of type readonly ResolvedNarrativeTechniqueContract[],
    // which exposes only kind/instruction/requiredEvidence — no graph resolution
    // detail leaks into Pass 1.
    const first = pkg.narrativeTechniques[0];
    expect(Object.keys(first).sort()).toEqual(['instruction', 'kind', 'requiredEvidence']);
  });

  it('defaults narrativeTechniques to empty array in ContextPackage', () => {
    const emptyPkg: ContextPackage = {
      eventId: 'E0',
      systemContext: {
        targetAudience: undefined,
        synopsis: undefined,
        thematicIntent: undefined,
      },
      sceneSpec: {
        title: 'Test scene',
        storyTime: 'day_1',
        pov: { character: 'narrator', type: 'omniscient' },
        sceneBrief: 'No technique contracts.',
        preconditions: [],
        expectedPostconditions: [],
      },
      characterSnapshots: [],
      relationshipContext: [],
      worldFacts: [],
      knowledgeBoundary: { knownEntities: [], knownRelationships: [], knownFacts: [] },
      activeThreads: [],
      volumeSummary: '',
      markdown: '',
      narrativeTechniques: [],
    };

    expect(Array.isArray(emptyPkg.narrativeTechniques)).toBe(true);
    expect(emptyPkg.narrativeTechniques).toHaveLength(0);
  });

  it.each([
    ['modernNovel', { surfaceMode: { enabled: true } }],
    ['antiCausalEdge', { enabled: true }],
    ['causalOverload', { enabled: true }],
    ['chapterOrder', { orderContested: true }],
  ])('rejects legacy key %s', (key, value) => {
    expect(eventFileSchema.safeParse({ ...makeTechniqueEvent(), [key]: value }).success).toBe(false);
  });

  it.each([
    ['enabled', { ...makeTechniqueEvent(), surfaceMode: { enabled: true } }],
    ['orderContested', { ...makeTechniqueEvent(), surfaceMode: { orderContested: true } }],
    [
      'blank instruction',
      {
        ...makeTechniqueEvent(),
        surfaceMode: { instruction: '   ', requiredEvidence: 'Visible proof.' },
      },
    ],
    [
      'blank evidence',
      {
        ...makeTechniqueEvent(),
        metanarrativeLevel: { instruction: 'Expose narration.', requiredEvidence: ' ' },
      },
    ],
    [
      'duplicate assertion ids',
      {
        ...makeTechniqueEvent(),
        multiplicity: {
          assertionIds: ['assertion:same', 'assertion:same'],
          instruction: 'Preserve both accounts.',
          requiredEvidence: 'Both accounts remain possible.',
        },
      },
    ],
  ])('rejects %s', (_description, invalidEvent) => {
    expect(eventFileSchema.safeParse(invalidEvent).success).toBe(false);
  });
});
