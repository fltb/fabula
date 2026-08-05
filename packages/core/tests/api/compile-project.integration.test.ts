import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileProject } from '../../src/api.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const source = (): ProjectSourceSnapshotV1 => {
  const entries: Record<string, string> = {
    'nova.yaml':
      'project: zhu-fu\ntitle: Zhu Fu\nauthor: Test\ndefaultLanguage: en\ndefaultModel: mock-pass2\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: [[active, inactive], [active, retired], [inactive, active], [inactive, retired]]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/state_initial.yaml':
      'info: { currentEra: contemporary, politicalSituation: stable }\ntimeAnchors: [{ id: day_1, at: day_1 }]\nthreads: []\nworldFacts: []\nknowledge: { claims: [], commonGround: [] }\n',
    'definitions/thread-types.yaml':
      'types:\n  primary:\n    typeId: primary\n    description: Primary narrative thread type\n    allowedPhases: [opening, development, resolution]\n    lifecyclePolicy: { reopenPolicy: forbidden }\n    timeDomain: story\n    stableGoals: []\n    stableMilestones: []\n',
    'definitions/propositions.yaml': 'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'definitions/relationship-types.yaml': 'types: {}\n',
    'definitions/rule-types.yaml': 'types: {}\n',
    'definitions/discourse-ledger.yaml':
      'id: ledger\nchapters: [{ branch: main, chapter: 1, sceneIds: [E0] }]\nentries: []\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: narrator\ninitialState: {}\ntraits: []\n',
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: Chapter 1\nsummary: Test\nintent: Introduction\nplannedScenes: 1\n',
    'chapters/chapter_01/E0.yaml':
      'event: E0\nnarrativeOrder: 1\ntitle: Encounter\nstoryTime: day_1\npov: { character: narrator, type: first_person }\nsceneBrief: A test scene.\nbeats: [A test scene.]\npreconditions: []\nexpectedPostconditions: []\n',
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

describe('compileProject (snapshot integration)', () => {
  const compilation = compileProject(source());
  it('compiles graph-driven story boundaries over every authored event', () => {
    expect(compilation.boundaries.stateBeforeByEventId.size).toBeGreaterThanOrEqual(
      compilation.events.length,
    );
    for (const event of compilation.events)
      expect(compilation.boundaries.stateBeforeByEventId.has(event.id)).toBe(true);
    for (const eventId of compilation.boundaries.orderedEventIds) {
      expect(compilation.boundaries.stateBeforeByEventId.has(eventId)).toBe(true);
      expect(compilation.boundaries.stateAfterByEventId.has(eventId)).toBe(true);
    }
    expect(compilation.boundaries.finalState).toBeDefined();
  });
  it('resolves an authored entity through the detached lookup', () => {
    const firstEvent = compilation.events[0];
    const targetId = firstEvent.pov?.character;
    expect(targetId).toBeTruthy();
    if (!targetId) throw new Error('Expected an authored POV character');
    const entity = compilation.entities.resolve(targetId);
    expect(entity).not.toBeNull();
    expect(entity?.id).toBe(targetId);
    expect(entity?.name.length).toBeGreaterThan(0);
  });
  it('includes runtime events at least as broad as authored events', () => {
    expect(compilation.runtimeEvents.length).toBeGreaterThanOrEqual(compilation.events.length);
    for (const event of compilation.events)
      expect(compilation.runtimeEvents.some((runtime) => runtime.id === event.id)).toBe(true);
  });
  it('loads chapter data as a map with at least one entry', () => {
    expect(compilation.data.chapters).toBeInstanceOf(Map);
    expect(compilation.data.chapters.size).toBeGreaterThanOrEqual(1);
  });
});
