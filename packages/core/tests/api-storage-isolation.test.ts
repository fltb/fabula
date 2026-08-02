import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileProject } from '../src/api.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../src/contracts/source.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const docs = (title = 'Test Novel'): Record<string, string> => ({
  'nova.yaml': `project: test-project\ntitle: ${title}\nauthor: Test Author\ndefaultModel: mock-pass2\ndefaultLanguage: en\n`,
  'definitions/discourse-ledger.yaml':
    'id: test-ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [E1]\nentries: []\n',
  'definitions/entity-types.yaml':
    'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions: [[active, inactive], [active, retired], [inactive, active], [inactive, retired]]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
  'definitions/state_initial.yaml':
    'info:\n  currentEra: contemporary\n  politicalSituation: stable\ntimeAnchors:\n  - { id: day_1, at: day_1, description: Day 1 }\nthreads: []\nworldFacts: []\n',
  'definitions/characters/narrator.yaml':
    'id: narrator\nname: Narrator\ntype: person\ndescription: The story narrator\ninitialState: {}\ntraits: []\n',
  'chapters/chapter_01/_chapter.yaml':
    'chapter: 1\ntitle: Chapter 1\nsummary: First chapter\nintent: Introduction\nplannedScenes: 1\n',
  'chapters/chapter_01/E1.yaml':
    'event: E1\nnarrativeOrder: 1\ntitle: First Event\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: A test scene.\nbeats: [A test scene.]\npreconditions: []\nexpectedPostconditions: []\n',
});
function snapshot(entries: Record<string, string>): ProjectSourceSnapshotV1 {
  const documents: SourceDocumentV1[] = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
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
}

describe('compileProject detached snapshot', () => {
  it('returns the compiled public projection without implementation objects', () => {
    const c = compileProject(snapshot(docs()));
    expect(c.events.map((event) => event.id)).toEqual(['E1']);
    expect(c.runtimeEvents.length).toBeGreaterThanOrEqual(c.events.length);
    expect(c.entities.getAll().length).toBeGreaterThan(0);
    expect(c.boundaries.stateBeforeByEventId).toBeInstanceOf(Map);
    expect(c.boundaries.orderedEventIds).toContain('E1');
    expect(c.entityTypes).toBeDefined();
    expect(c.entityDeclarations).toBeDefined();
    expect(c.data.config?.project).toBe('test-project');
    expect(c.data.config?.title).toBe('Test Novel');
    for (const key of ['mapper', 'registry', 'stateManager', 'state', 'runtime', 'graphs'])
      expect(key in c).toBe(false);
    expect(Object.keys(c.entities).sort()).toEqual(['findByKind', 'getAll', 'resolve']);
  });
  it('mutating returned events or entity state never affects lookups or recompiles', () => {
    const source = snapshot(docs());
    const c = compileProject(source);
    const eventId = c.events[0].id;
    const entityId = c.entities.getAll()[0].id;
    c.events[0].sceneBrief = 'MUTATED';
    const firstEntity = c.entities.getAll()[0];
    firstEntity.state.mutatedMarker = 'MUTATED';
    expect(c.entities.resolve(entityId)?.state.mutatedMarker).toBeUndefined();
    const c2 = compileProject(source);
    expect(c2.events.find((event) => event.id === eventId)?.sceneBrief).toBe('A test scene.');
    expect(c2.entities.resolve(entityId)?.state.mutatedMarker).toBeUndefined();
    expect(firstEntity.state.mutatedMarker).toBe('MUTATED');
  });
  it('separate immutable snapshots produce independent projections', () => {
    const resultA = compileProject(snapshot(docs()));
    const resultB = compileProject(snapshot(docs()));
    expect(resultA.entities).not.toBe(resultB.entities);
    expect(resultA.events).not.toBe(resultB.events);
    expect(resultA.data).not.toBe(resultB.data);
    expect(resultA.runtimeEvents).not.toBe(resultB.runtimeEvents);
    expect(resultA.boundaries).not.toBe(resultB.boundaries);
    expect(resultA.events.map((event) => event.id)).toEqual(
      resultB.events.map((event) => event.id),
    );
  });
  it('repeated compileProject produces fresh snapshots from the same source hash', () => {
    const source = snapshot(docs());
    const first = compileProject(source);
    const second = compileProject(source);
    expect(first.entities).not.toBe(second.entities);
    expect(first.events).not.toBe(second.events);
    expect(first.data).not.toBe(second.data);
    expect(first.runtimeEvents).not.toBe(second.runtimeEvents);
    expect(first.boundaries).not.toBe(second.boundaries);
    expect(first.events.map((event) => event.id)).toEqual(['E1']);
    expect(second.events.map((event) => event.id)).toEqual(['E1']);
    expect(first.entities.resolve('narrator')).not.toBe(second.entities.resolve('narrator'));
  });
  it('modified source hash produces a fresh cache entry', () => {
    const first = compileProject(snapshot(docs()));
    const second = compileProject(snapshot(docs('Modified Novel Title')));
    expect(first.data.config?.title).toBe('Test Novel');
    expect(second.data.config?.title).toBe('Modified Novel Title');
    expect(second.data).not.toBe(first.data);
    expect(second.events).not.toBe(first.events);
    expect(second.runtimeEvents).not.toBe(first.runtimeEvents);
  });
});
