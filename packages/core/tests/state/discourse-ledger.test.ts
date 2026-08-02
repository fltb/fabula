import { describe, expect, it } from 'vitest';
import { readYamlFile } from '../../src/entity/yaml-loader.ts';
import { plannedDiscourseLedgerSourceSchema } from '../../src/schemas/discourse.ts';
import { eventFileSchema } from '../../src/schemas/event.ts';
import { compileDiscourseBoundaries } from '../../src/state/discourse-context.ts';
import { compilePlannedDiscourseLedger } from '../../src/state/discourse-ledger.ts';
import type { ProjectSourceSnapshotV1 } from '../../src/contracts/source.ts';
import type { PlannedDiscourseLedgerSource } from '../../src/types/discourse.ts';
import type { NarrativeEvent } from '../../src/types/event.ts';

function makeEvent(id: string): NarrativeEvent {
  return {
    id,
    event: id,
    narrativeOrder: Number(id.slice(1)) || 1,
    title: id,
    storyTime: { type: 'absolute', value: 'day_1' },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: id,
    beats: [id],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
  };
}

function makeSource(
  overrides: Partial<PlannedDiscourseLedgerSource> = {},
): PlannedDiscourseLedgerSource {
  return {
    id: 'ledger',
    chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1'] }],
    entries: [],
    ...overrides,
  };
}

describe('planned discourse ledger compilation', () => {
  it('derives a stable runtime hash and rejects an authored hash', () => {
    const source = plannedDiscourseLedgerSourceSchema.parse(makeSource());
    const compiled = compilePlannedDiscourseLedger(source);

    expect(compiled.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(compilePlannedDiscourseLedger(source).hash).toBe(compiled.hash);
    expect(
      plannedDiscourseLedgerSourceSchema.safeParse({ ...makeSource(), hash: 'author-supplied' })
        .success,
    ).toBe(false);
  });

  it('gives a conventional no-action scene the mandatory ledger path and cursor -1', () => {
    const ledger = compilePlannedDiscourseLedger(makeSource());
    const contexts = compileDiscourseBoundaries([makeEvent('E1')], ledger, {}, {}, 'main');

    expect(Object.keys(contexts)).toEqual(['E1']);
    expect(contexts.E1?.cursor).toBe(-1);
    expect(contexts.E1?.currentActionIds).toEqual([]);
  });

  it('derives a no-action cursor from the preceding action interval', () => {
    const ledger = compilePlannedDiscourseLedger(
      makeSource({
        chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E2'] }],
        entries: [
          {
            id: 'reveal-a1',
            sceneId: 'E1',
            branch: 'main',
            discoursePosition: 0,
            action: { type: 'reveal', assertionId: 'a1', discoursePosition: 0 },
          },
        ],
      }),
    );
    const assertions = {
      a1: {
        id: 'a1',
        narrator: 'narrator',
        proposition: 'The truth',
        polarity: 'affirmative' as const,
        type: 'authoritative_reveal' as const,
        status: 'asserted',
        narrationBoundary: { narratorId: 'narrator' },
      },
    };

    const contexts = compileDiscourseBoundaries(
      [makeEvent('E1'), makeEvent('E2')],
      ledger,
      assertions,
      {},
      'main',
    );

    expect(contexts.E2?.cursor).toBe(0);
    expect(contexts.E2?.stateBefore.reveals).toEqual(['a1']);
  });

  it.each([
    [
      'missing selected branch',
      makeSource(),
      'alternate',
      [makeEvent('E1')],
      /no chapter sequence/,
    ],
    [
      'duplicate scene coverage',
      makeSource({ chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E1'] }] }),
      'main',
      [makeEvent('E1')],
      /more than once/,
    ],
    [
      'missing scene coverage',
      makeSource({ chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1'] }] }),
      'main',
      [makeEvent('E1'), makeEvent('E2')],
      /omits reachable scene/,
    ],
    [
      'non-increasing chapters',
      makeSource({
        chapters: [
          { branch: 'main', chapter: 1, sceneIds: ['E1'] },
          { branch: 'main', chapter: 1, sceneIds: ['E2'] },
        ],
      }),
      'main',
      [makeEvent('E1'), makeEvent('E2')],
      /non-increasing chapter/,
    ],
    [
      'gapped action positions',
      makeSource({
        chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E2'] }],
        entries: [
          {
            id: 'hint-0',
            sceneId: 'E1',
            branch: 'main',
            discoursePosition: 0,
            action: {
              type: 'hint',
              hintId: 'h0',
              surfaceProposition: 'surface',
              targetProposition: 'target',
              discoursePosition: 0,
            },
          },
          {
            id: 'hint-2',
            sceneId: 'E2',
            branch: 'main',
            discoursePosition: 2,
            action: {
              type: 'hint',
              hintId: 'h2',
              surfaceProposition: 'surface',
              targetProposition: 'target',
              discoursePosition: 2,
            },
          },
        ],
      }),
      'main',
      [makeEvent('E1'), makeEvent('E2')],
      /gapped action position/,
    ],
    [
      'interleaved action scene order',
      makeSource({
        chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E2'] }],
        entries: [
          {
            id: 'hint-e2',
            sceneId: 'E2',
            branch: 'main',
            discoursePosition: 0,
            action: {
              type: 'hint',
              hintId: 'h2',
              surfaceProposition: 'surface',
              targetProposition: 'target',
              discoursePosition: 0,
            },
          },
          {
            id: 'hint-e1',
            sceneId: 'E1',
            branch: 'main',
            discoursePosition: 1,
            action: {
              type: 'hint',
              hintId: 'h1',
              surfaceProposition: 'surface',
              targetProposition: 'target',
              discoursePosition: 1,
            },
          },
        ],
      }),
      'main',
      [makeEvent('E1'), makeEvent('E2')],
      /outside the declared scene sequence/,
    ],
  ])('rejects %s before rendering', (_name, source, branch, events, error) => {
    const ledger = compilePlannedDiscourseLedger(source);
    expect(() => compileDiscourseBoundaries(events, ledger, {}, {}, branch)).toThrow(error);
  });

  it('rejects a removed event discourseCursor field at YAML parsing', () => {
    expect(
      eventFileSchema.safeParse({
        event: 'E1',
        narrativeOrder: 1,
        title: 'E1',
        storyTime: 'day_1',
        pov: { character: 'narrator', type: 'omniscient' },
        sceneBrief: 'E1',
        beats: ['E1'],
        preconditions: [],
        expectedPostconditions: [],
        discourseCursor: -1,
      }).success,
    ).toBe(false);
  });

  it('reports a missing ledger as a configuration error at the YAML boundary', () => {
    expect(() =>
      readYamlFile({
        logicalPath: 'definitions/discourse-ledger.yaml',
        schema: plannedDiscourseLedgerSourceSchema,
        snapshot: {
          version: 1,
          documents: [],
          sourceHash: 'a'.repeat(64),
        } satisfies ProjectSourceSnapshotV1,
      }),
    ).toThrow('Required YAML file is missing');
  });
});
