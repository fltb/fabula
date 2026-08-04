import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { renderNovel } from '../../src/api.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import type { AnalysisResult } from '../../src/types/analysis.ts';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';
import { createRuntimeServices } from '../fixtures/runtime-services.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const source = (): ProjectSourceSnapshotV1 => {
  const entries: Record<string, string> = {
    'nova.yaml':
      'project: release-assembly-debug\ntitle: Debug Test\nauthor: Tester\ndefaultModel: mock-pass2\n',
    'definitions/state_initial.yaml':
      'info:\n  currentEra: modern\n  politicalSituation: stable\nthreads: []\nworldFacts: []\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: []\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/characters/alice.yaml':
      'id: alice\nname: Alice\ntype: human\ndescription: Protagonist\ninitialState: {}\ntraits: []\n',
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: Opening\nsummary: Alice begins.\nintent: Setup\nplannedScenes: 1\n',
    'chapters/chapter_01/E001.yaml':
      'event: E001\nnarrativeOrder: 1\ntitle: Opening\nintroduces: []\nstoryTime: day 1\nsceneBrief: Alice begins.\nbeats:\n  - Alice begins.\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n',
    'definitions/discourse-ledger.yaml':
      'id: debug-test\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [E001]\nentries: []\n',
  };
  const documents: SourceDocumentV1[] = Object.entries(entries)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1,
      logicalPath,
      content,
      contentHash: hash(content),
      parseResult: { status: 'parsed', value: { value: content } },
      diagnostics: [],
    }));
  return {
    version: 1,
    documents,
    sourceHash: hash(
      documents.map((document) => `${document.logicalPath}\0${document.content}`).join(''),
    ),
  };
};

function analysis(): AnalysisResult {
  const payload: Record<string, unknown> = {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 8,
      maxScore: 10,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 80,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past',
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [],
    knowledgeChecks: [],
    checklistResults: [],
  };
  return {
    eventId: 'E001',
    protocol: makeProtocol('Alice entered quietly.'),
    observations: makeObservations(payload, 'Alice entered quietly.'),
    analysis: payload,
  };
}

it('debug renderNovel with explicit semantic runtime', async () => {
  const provider = new MockPass2Provider({
    entries: { E001: { prose: 'Alice entered quietly.', analysis: analysis() } },
  });
  const result = await renderNovel(
    {
      version: 1,
      source: source(),
      selector: { type: 'all' },
      mutation: { operationId: randomUUID(), actorId: 'renderer' },
      model: 'mock-pass2',
    },
    {
      provider,
      services: createRuntimeServices({ provider }).services,
    },
  );
  expect(result.results).toHaveLength(1);
});
