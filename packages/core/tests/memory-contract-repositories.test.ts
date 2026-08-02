import { describe, expect, it } from 'vitest';
import { acceptedSceneRecordSchema } from '../src/schemas/core-contracts.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../src/testing/memory-repositories.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

const scene = (sourceHash = HASH_A) => ({
  version: 1 as const,
  projectId: 'project',
  eventId: 'event',
  sourceHash,
  revisionId: 'revision',
  prose: 'A scene.',
  proseHash: HASH_B,
  sceneHash: HASH_C,
  value: { nested: ['json-safe'] },
});

describe('memory semantic repositories', () => {
  it('isolates JSON-safe execution records and enforces optimistic CAS', async () => {
    const repository = new MemoryExecutionRepository();
    const first = await repository.compareAndSwapAcceptedScene({ projectId: 'project', eventId: 'event', expectedVersion: null, value: scene() });
    expect(first).toMatchObject({ kind: 'committed', version: 1 });
    if (first.kind !== 'committed') throw new Error('expected commit');
    first.value.value = { changed: true };
    const isolated = await repository.readAcceptedScene({ projectId: 'project', eventId: 'event' });
    expect(isolated?.value.value).toEqual({ nested: ['json-safe'] });
    expect(isolated?.revision).toBe(1);
    expect(await repository.compareAndSwapAcceptedScene({ projectId: 'project', eventId: 'event', expectedVersion: null, value: scene() })).toEqual({ kind: 'conflict', expectedVersion: null, actualVersion: 1 });
    const second = await repository.compareAndSwapAcceptedScene({ projectId: 'project', eventId: 'event', expectedVersion: 1, value: { ...scene(), prose: 'Revised.' } });
    expect(second).toMatchObject({ kind: 'committed', version: 2 });
    const record = await repository.readAcceptedScene({ projectId: 'project', eventId: 'event' });
    expect(record?.revision).toBe(2);
    expect(record?.value.version).toBe(1);
    expect(record?.value.prose).toBe('Revised.');
    if (record) expect(acceptedSceneRecordSchema.safeParse(record.value).success).toBe(true);
  });

  it('never resolves an accepted artifact from the render cache', async () => {
    const execution = new MemoryExecutionRepository();
    const cache = new MemoryRenderCacheRepository();
    const key = { version: 1 as const, sourceHash: 'source-a', layers: { surface: 'surface-a' } };
    await cache.put({ key, record: { version: 1, key, recordHash: 'record', output: { prose: 'derived' } } });
    expect(await cache.get({ key })).not.toBeNull();
    expect(await execution.resolveAcceptedArtifact({ projectId: 'project', eventId: 'event' })).toBeNull();
    await execution.compareAndSwapAcceptedScene({ projectId: 'project', eventId: 'event', expectedVersion: null, value: scene() });
    const artifact = await execution.resolveAcceptedArtifact({ projectId: 'project', eventId: 'event' });
    expect(artifact?.prose).toBe('A scene.');
    expect(artifact?.revisionId).toBe('revision');
    expect(artifact).not.toHaveProperty('revision');
  });

  it('separates cache records by source hash and removes whole records', async () => {
    const cache = new MemoryRenderCacheRepository();
    const keyA = { version: 1 as const, sourceHash: 'a', layers: { render: 'same' } };
    const keyB = { ...keyA, sourceHash: 'b' };
    const record = { version: 1 as const, key: keyA, recordHash: 'hash', output: { complete: true } };
    await cache.put({ key: keyA, record });
    expect(await cache.get({ key: keyB })).toBeNull();
    const result = await cache.get({ key: keyA });
    expect(result).toEqual(record);
    if (result) result.output = { complete: false };
    expect((await cache.get({ key: keyA }))?.output).toEqual({ complete: true });
    await cache.remove({ key: keyA });
    expect(await cache.get({ key: keyA })).toBeNull();
  });

  it('appends ordered state events with version conflicts and sequence reads', async () => {
    const repository = new MemoryStateLogRepository();
    const key = { projectId: 'project', streamId: 'world', branchId: 'main' };
    const event = { eventId: 'e1', sequence: 1, type: 'fact', payload: { value: 1 } };
    expect(await repository.append({ key, expectedVersion: 0, events: [event] })).toMatchObject({ kind: 'appended', version: 1 });
    expect(await repository.append({ key, expectedVersion: 0, events: [{ ...event, eventId: 'e2', sequence: 2 }] })).toEqual({ kind: 'conflict', expectedVersion: 0, actualVersion: 1 });
    await repository.append({ key, expectedVersion: 1, events: [{ ...event, eventId: 'e2', sequence: 2 }] });
    expect((await repository.read({ key, fromSequence: 2 })).events.map(({ eventId }) => eventId)).toEqual(['e2']);
  });

  it('selects nearest matching valid snapshot and safely returns null when absent', async () => {
    const repository = new MemoryStateSnapshotRepository();
    const key = { projectId: 'project', streamId: 'world', branchId: 'main' };
    const base = { version: 1 as const, key, schema: 'world', schemaVersion: 1, snapshotHash: 'hash', state: { facts: [] } };
    await repository.save({ snapshot: { ...base, sequence: 2 }, expectedVersion: null });
    await repository.save({ snapshot: { ...base, sequence: 5, schema: 'other' }, expectedVersion: 1 });
    expect(await repository.readNearestValid({ key, atOrBeforeSequence: 4, schema: 'world', schemaVersion: 1 })).toMatchObject({ sequence: 2 });
    expect(await repository.readNearestValid({ key, atOrBeforeSequence: 1, schema: 'world', schemaVersion: 1 })).toBeNull();
  });
});
