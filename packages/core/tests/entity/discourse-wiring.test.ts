import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContextCompiler } from '../../src/context/compiler.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import { EntityMapper } from '../../src/entity/mapper.ts';
import { InMemoryEntityRegistry } from '../../src/entity/registry.ts';
import { compileDiscourseBoundaries } from '../../src/state/discourse-context.ts';
import type { WorldState } from '../../src/types/index.ts';

const EMPTY_STATE: WorldState = {
  entities: {},
  relationships: {},
  knowledge: {},
  threads: {},
  rules: {},
  facts: [],
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const source = (): ProjectSourceSnapshotV1 => {
  const entries: Record<string, string> = {
    'nova.yaml':
      'project: discourse-test\ntitle: Discourse Test\nauthor: Test\ndefaultLanguage: en\ndefaultModel: mock-pass2\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: [[active, inactive], [active, retired], [inactive, active], [inactive, retired]]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/state_initial.yaml':
      'info: { currentEra: contemporary, politicalSituation: stable }\ntimeAnchors: [{ id: day_1, at: day_1 }]\nthreads: []\nworldFacts: []\n',
    'definitions/discourse-ledger.yaml':
      'id: ledger\nchapters: [{ branch: main, chapter: 1, sceneIds: [E0] }]\nentries:\n  - { id: entry_0, sceneId: E0, branch: main, discoursePosition: 0, action: { type: reveal, assertionId: a1, discoursePosition: 0 } }\n',
    'definitions/narrators/narrator_wo.yaml':
      'id: narrator_wo\ntype: retrospective_entity\naccess: full\nassertion: full\ntruth: full_knowledge\nfidelity: reliable\nsincerity: sincere\nknowledgeBoundary: remembered_events\n',
    'definitions/assertions/a1.yaml':
      'id: a1\nnarrator: narrator_wo\nproposition: The narrator knows fate.\npolarity: affirmative\ntype: authoritative_reveal\nstatus: asserted\nnarrationBoundary:\n  narratorId: narrator_wo\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: narrator\ninitialState: {}\ntraits: []\n',
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: Chapter 1\nsummary: Test\nintent: Introduction\nplannedScenes: 1\n',
    'chapters/chapter_01/E0.yaml':
      'event: E0\nnarrativeOrder: 1\ntitle: Encounter\nstoryTime: day_1\npov: { character: narrator, type: first_person }\nnarratorProfileRef: narrator_wo\nsceneBrief: A test scene.\nbeats: [A test scene.]\npreconditions: []\nexpectedPostconditions: []\n',
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
    sourceHash: hash(documents.map((d) => `${d.logicalPath}\0${d.content}`).join('')),
  };
};

describe('discourse wiring — immutable source snapshot', () => {
  it('loads narrator profile, ledger and assertions through the mapper', () => {
    const data = new EntityMapper(source()).loadProject();
    expect(data.narratorProfiles.narrator_wo?.type).toBe('retrospective_entity');
    expect(data.discourseLedger?.entries).toHaveLength(1);
    expect(data.narratorAssertions.a1?.status).toBe('asserted');
  });
  it('compiles a discourse context for the authored event', () => {
    const data = new EntityMapper(source()).loadProject();
    const events = new EntityMapper(source()).loadAllEvents(data);
    const contexts = compileDiscourseBoundaries(
      events,
      data.discourseLedger,
      data.narratorAssertions,
      data.narratorProfiles,
      'main',
    );
    const event = events[0];
    const registry = new InMemoryEntityRegistry();
    registry.load(data);
    const pkg = new ContextCompiler().compile(event, EMPTY_STATE, registry, {
      narratorProfiles: data.narratorProfiles,
      discourseContext: contexts[event.id],
    });
    expect(pkg.narratorProfile?.id).toBe('narrator_wo');
    expect(pkg.discourseReplayError).toBeUndefined();
  });
});
