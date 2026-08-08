// ============================================================================
// Novalistically — Minimal Project Skeleton
// ============================================================================
// The single authority for "what a fresh, compile-able project looks like".
// Every field below was verified against the core Zod schemas (zod/v3) and
// the compile pipeline; adding a required field to a schema must fail the
// skeleton test in tests/project-skeleton.test.ts, not silently break the
// create-project flow.
//
// A minimal project needs ten documents:
//   nova.yaml                          (projectConfigSchema)
//   definitions/state_initial.yaml     (worldInitialStateSchema)
//   definitions/entity-types.yaml      (entityTypeCatalogSourceSchema)
//   definitions/thread-types.yaml      (threadTypeCatalogSourceSchema)
//   definitions/propositions.yaml      (propositionsSchema)
//   definitions/relationship-types.yaml(relationshipTypeCatalogSourceSchema)
//   definitions/rule-types.yaml        (ruleTypeCatalogSourceSchema)
//   definitions/discourse-ledger.yaml  (plannedDiscourseLedgerSourceSchema)
//   definitions/narrators/narrator.yaml(narratorProfileSchema)
//   chapters/chapter_01/E001.yaml      (eventFileSchema)
//
// The scaffold event E001 references the narrator as its POV; the narrator
// becomes live through an `expectedPostconditions` write on the same event
// (live references require activation before participation).

import YAML from 'yaml';

/** One generated project file: relative path inside the managed root. */
export interface ProjectSkeletonFile {
  readonly path: string;
  readonly content: string;
}

function yaml(value: unknown): string {
  return YAML.stringify(value);
}

/**
 * Build the minimal compile-able project source documents for a fresh
 * managed project. Callers write each entry under the project root.
 */
export function createMinimalProjectSource(
  projectId: string,
  title: string,
  author: string,
): readonly ProjectSkeletonFile[] {
  return [
    {
      path: 'nova.yaml',
      content: yaml({
        project: projectId,
        title,
        author,
        defaultModel: 'mock',
        defaultLanguage: 'zh',
        genre: 'literary',
        synopsis: '待补充',
        tense: 'past',
        ideaIR: {
          thematicIntent: { primaryTheme: '待设定', subThemes: [] },
          emotionalArc: { arcType: '待设定', emotionalBeats: [] },
        },
      }),
    },
    {
      path: 'definitions/entity-types.yaml',
      content: yaml({
        types: {
          character: {
            typeId: 'character',
            kind: 'character',
            attributes: {
              lifecycle: {
                attributeId: 'lifecycle',
                valueType: 'string',
                requiredAt: 'introduction',
                writePolicy: 'lifecycle_managed',
                allowedLifecycleStates: ['active', 'inactive', 'retired'],
                unsetAllowed: false,
                semanticRole: 'lifecycle',
              },
            },
            lifecyclePolicy: {
              allowedTransitions: [
                ['active', 'inactive'],
                ['active', 'retired'],
                ['inactive', 'active'],
                ['inactive', 'retired'],
              ],
            },
            referenceCapabilities: { defaultEligibility: 'live' },
            typedInvariants: [],
          },
        },
      }),
    },
    {
      path: 'definitions/state_initial.yaml',
      content: yaml({
        info: { currentEra: '待设定', politicalSituation: '待设定' },
        timeAnchors: [],
        threads: [],
        worldFacts: [],
        knowledge: { claims: [], commonGround: [] },
      }),
    },
    { path: 'definitions/thread-types.yaml', content: yaml({ types: {} }) },
    {
      path: 'definitions/propositions.yaml',
      content: yaml({ version: 1, propositions: {}, dependencyGraph: {} }),
    },
    { path: 'definitions/relationship-types.yaml', content: yaml({ types: {} }) },
    { path: 'definitions/rule-types.yaml', content: yaml({ types: {} }) },
    {
      path: 'definitions/discourse-ledger.yaml',
      content: yaml({
        id: `${projectId}_ledger`,
        chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E001'] }],
        entries: [],
      }),
    },
    {
      path: 'definitions/characters/narrator.yaml',
      content: yaml({
        id: 'narrator',
        name: '叙述者',
        type: 'character',
        description: '待补充',
        traits: [],
      }),
    },
    {
      path: 'definitions/narrators/narrator.yaml',
      content: yaml({
        id: 'narrator',
        type: 'retrospective_entity',
        access: 'full',
        assertion: 'constrained',
        truth: 'limited_knowledge',
        fidelity: 'reliable',
        sincerity: 'sincere',
        knowledgeBoundary: 'narrator_knowledge',
      }),
    },
    {
      path: 'chapters/chapter_01/E001.yaml',
      content: yaml({
        event: 'E001',
        title: '开场',
        narrativeOrder: 1,
        sceneType: 'linear',
        storyTime: 'day_0',
        tense: 'past',
        arcPosition: 'opening',
        pov: { character: 'narrator', type: 'first_person' },
        sceneBrief: '待补充',
        beats: ['待补充'],
        preconditions: [],
        // Introduces the narrator (declared in definitions/characters) with
        // its required lifecycle attribute; live references demand the
        // introduction before participation (validateParticipants).
        introduces: [{ type: 'character', id: 'narrator', initialState: {} }],
        expectedPostconditions: [],
      }),
    },
  ];
}
