import { describe, expect, it } from 'vitest';
import {
  acceptedSceneRecordSchema,
  commitResultSchema,
  layeredCacheKeySchema,
  projectSourceSnapshotV1Schema,
  renderCacheRecordSchema,
  sourceAnalysisV1Schema,
  sourceChangeV1Schema,
  sourceDocumentV1Schema,
  sourceParseResultV1Schema,
  stateAppendSuccessSchema,
  stateLogReadResultSchema,
  stateSnapshotRecordSchema,
} from '../src/schema.ts';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);

const document = (logicalPath: string, content: string) => ({
  version: 1 as const,
  logicalPath,
  content,
  contentHash: hash,
  parseResult: { status: 'parsed' as const, value: { content } },
  diagnostics: [],
});

const snapshot = (
  documents = [document('definitions/a.yaml', 'a'), document('definitions/b.yaml', 'b')],
) => ({
  version: 1 as const,
  documents,
  sourceHash: hash,
});

const jsonRoundTrip = <T>(schema: { parse(value: unknown): T }, value: T): T =>
  schema.parse(JSON.parse(JSON.stringify(value)));

describe('pure Core contract schemas', () => {
  it('round-trips a source snapshot and preserves sorted logical documents', () => {
    const value = snapshot();
    expect(jsonRoundTrip(projectSourceSnapshotV1Schema, value)).toEqual(value);
    expect(jsonRoundTrip(sourceDocumentV1Schema, value.documents[0])).toEqual(value.documents[0]);
    expect(jsonRoundTrip(sourceParseResultV1Schema, value.documents[0].parseResult)).toEqual(
      value.documents[0].parseResult,
    );
  });

  it('round-trips source deletion changes and source analysis', () => {
    const deletion = {
      logicalPath: 'definitions/removed.yaml',
      beforeContent: 'old',
      beforeHash: hash,
      afterContent: null,
      afterHash: null,
    };
    expect(jsonRoundTrip(sourceChangeV1Schema, deletion)).toEqual(deletion);

    const analysis = {
      version: 1 as const,
      current: snapshot(),
      candidate: snapshot([
        document('definitions/a.yaml', 'changed'),
        document('definitions/b.yaml', 'b'),
      ]),
      changes: [deletion],
      affectedEventIds: ['event-1'],
      diagnostics: [
        { code: 'notice', severity: 'info' as const, message: 'checked', logicalPath: null },
      ],
    };
    expect(jsonRoundTrip(sourceAnalysisV1Schema, analysis)).toEqual(analysis);
  });

  it('round-trips an accepted execution record and commit result', () => {
    const scene = {
      version: 1 as const,
      projectId: 'project-1',
      eventId: 'event-1',
      sourceHash: hash,
      revisionId: 'revision-1',
      prose: 'A quiet room.',
      proseHash: otherHash,
      sceneHash: hash,
      value: { mood: 'quiet', beats: [1, true] },
    };
    expect(jsonRoundTrip(acceptedSceneRecordSchema, scene)).toEqual(scene);
    const result = { kind: 'committed' as const, version: 1, value: scene };
    expect(jsonRoundTrip(commitResultSchema, result)).toEqual(result);
  });

  it('round-trips a complete cache record and rejects a key-record version mismatch', () => {
    const key = {
      version: 1 as const,
      sourceHash: hash,
      layers: { graph: 'graph-v1', prompt: 'prompt-v1' },
    };
    expect(jsonRoundTrip(layeredCacheKeySchema, key)).toEqual(key);
    const analysis = {
      eventId: 'event-1',
      protocol: { proseHash: hash },
      observations: { quality: { disposition: 'produced', evidence: ['A quiet room.'] } },
      analysis: { quality: { proseScore: 4 } },
    };
    const record = {
      version: 1 as const,
      key,
      recordHash: otherHash,
      output: { prose: 'A quiet room.', analysis },
    };
    expect(jsonRoundTrip(renderCacheRecordSchema, record)).toEqual(record);
    expect(
      renderCacheRecordSchema.safeParse({
        ...record,
        output: { ...record.output, analysis: { eventId: 'event-1' } },
      }).success,
    ).toBe(false);
    expect(
      renderCacheRecordSchema.safeParse({ ...record, key: { ...key, version: 2 } }).success,
    ).toBe(false);
  });

  it('round-trips state event append and snapshot records', () => {
    const key = { projectId: 'project-1', streamId: 'world', branchId: 'main' };
    const events = [
      {
        eventId: 'event-1',
        sequence: 0,
        type: 'fact.set',
        payload: { entity: 'hero', attribute: 'mood', value: 'calm' },
      },
      {
        eventId: 'event-2',
        sequence: 1,
        type: 'fact.set',
        payload: { entity: 'hero', attribute: 'place', value: 'room' },
      },
    ];
    const append = { kind: 'appended' as const, version: 2, events };
    expect(jsonRoundTrip(stateAppendSuccessSchema, append)).toEqual(append);
    const read = { key, events, version: 2, firstSequence: 0, lastSequence: 1 };
    expect(jsonRoundTrip(stateLogReadResultSchema, read)).toEqual(read);
    const snapshotRecord = {
      version: 1 as const,
      key,
      schema: 'world-state',
      schemaVersion: 1,
      sequence: 1,
      state: { hero: { mood: 'calm' } },
      snapshotHash: hash,
    };
    expect(jsonRoundTrip(stateSnapshotRecordSchema, snapshotRecord)).toEqual(snapshotRecord);

    expect(
      stateAppendSuccessSchema.safeParse({ ...append, events: [events[1], events[0]] }).success,
    ).toBe(false);
    expect(
      stateAppendSuccessSchema.safeParse({
        ...append,
        events: [events[0], { ...events[1], eventId: events[0].eventId, sequence: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects unsafe paths, unordered documents, and invalid deletion pairings', () => {
    expect(
      projectSourceSnapshotV1Schema.safeParse({
        ...snapshot(),
        documents: [document('../escape.yaml', 'x'), document('definitions/b.yaml', 'b')],
      }).success,
    ).toBe(false);
    expect(
      projectSourceSnapshotV1Schema.safeParse({
        ...snapshot(),
        documents: [document('definitions/b.yaml', 'b'), document('definitions/a.yaml', 'a')],
      }).success,
    ).toBe(false);
    expect(
      sourceChangeV1Schema.safeParse({
        logicalPath: 'definitions/removed.yaml',
        beforeContent: 'old',
        beforeHash: null,
        afterContent: null,
        afterHash: null,
      }).success,
    ).toBe(false);
    expect(
      sourceChangeV1Schema.safeParse({
        logicalPath: 'definitions/new.yaml',
        beforeContent: null,
        beforeHash: null,
        afterContent: 'new',
        afterHash: null,
      }).success,
    ).toBe(false);
  });
});
