import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  AcceptedSceneRecord,
  CommitResult,
  ReadResult,
  StateEvent,
  StateSnapshotRecord,
  StateStreamKey,
} from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import { FileRenderCacheRepository } from '../src/cache/file-render-cache-repository.js';
import { FileExecutionRepository } from '../src/execution/file-execution-repository.js';
import {
  FileStateLogRepository,
  FileStateSnapshotRepository,
} from '../src/state/file-state-repositories.js';
import { cacheKey, cacheRecord } from './cache-fixtures.js';
import {
  acceptedScene,
  executionFiles,
  operation,
  publication,
  review,
  sceneRevision,
  snapshot,
  stateEvent,
  stateKey,
  stateLogFile,
  stateSnapshotFile,
  trace,
  withTempProject,
} from './execution-fixtures.js';

/** Exercise the full CAS lifecycle contract shared by every record family. */
async function exerciseExecutionFamily<T>(
  read: () => Promise<ReadResult<T> | null>,
  commit: (expectedVersion: number | null, value: T) => Promise<CommitResult<T>>,
  initial: T,
  updated: T,
  label: string,
): Promise<void> {
  expect(await read(), `${label}: missing record reads null`).toBeNull();
  expect(await commit(1, initial), `${label}: stale first CAS conflicts with null`).toEqual({
    kind: 'conflict',
    expectedVersion: 1,
    actualVersion: null,
  });
  expect(await commit(null, initial), `${label}: first CAS commits`).toEqual({
    kind: 'committed',
    version: 1,
    value: initial,
  });
  expect(await read(), `${label}: read-back`).toEqual({ revision: 1, value: initial });
  expect(await commit(0, updated), `${label}: stale CAS conflicts with revision 1`).toEqual({
    kind: 'conflict',
    expectedVersion: 0,
    actualVersion: 1,
  });
  expect(await commit(1, updated), `${label}: revision CAS commits`).toEqual({
    kind: 'committed',
    version: 2,
    value: updated,
  });
  expect(await read(), `${label}: updated read-back`).toEqual({ revision: 2, value: updated });
}

/** Verify that neither caller nor reader mutation ever reaches the store. */
async function exerciseExecutionCloneIsolation<T extends { value: unknown }>(
  commit: (value: T) => Promise<CommitResult<T>>,
  read: () => Promise<ReadResult<T> | null>,
  initial: T,
  label: string,
): Promise<void> {
  const result = await commit(initial);
  if (result.kind !== 'committed') throw new Error(`${label}: expected committed`);
  const payload = (record: T): { marker: string } => {
    const value = record.value;
    if (
      value &&
      typeof value === 'object' &&
      'marker' in value &&
      typeof value.marker === 'string'
    ) {
      return { marker: value.marker };
    }
    throw new Error(`${label}: expected marker payload`);
  };
  const mutate = (record: T): void => {
    const value = record.value;
    if (value && typeof value === 'object' && 'marker' in value) value.marker = 'mutated';
    else throw new Error(`${label}: expected marker payload`);
  };

  mutate(initial);
  mutate(result.value);
  expect(payload((await read())!.value).marker, `${label}: store survives caller mutation`).toBe(
    'pristine',
  );

  const first = await read();
  if (first) mutate(first.value);
  expect(payload((await read())!.value).marker, `${label}: store survives reader mutation`).toBe(
    'pristine',
  );
}

describe('filesystem semantic execution/state repositories', () => {
  it('enforces compare-and-swap and accepted artifact separation', async () =>
    withTempProject(async (root) => {
      const repository = new FileExecutionRepository(root);
      expect(
        (
          await repository.compareAndSwapAcceptedScene({
            projectId: 'project',
            eventId: 'event-1',
            expectedVersion: 1,
            value: acceptedScene(),
          })
        ).kind,
      ).toBe('conflict');
      expect(
        (
          await repository.compareAndSwapAcceptedScene({
            projectId: 'project',
            eventId: 'event-1',
            expectedVersion: null,
            value: acceptedScene(),
          })
        ).kind,
      ).toBe('committed');
      expect(
        await repository.resolveAcceptedArtifact({ projectId: 'project', eventId: 'event-1' }),
      ).toMatchObject({ prose: 'accepted' });
      expect(
        await repository.resolveAcceptedArtifact({ projectId: 'project', eventId: 'missing' }),
      ).toBeNull();
    }));

  it('never resolves accepted artifacts from render cache records', async () =>
    withTempProject(async (root) => {
      const execution = new FileExecutionRepository(root);
      const cache = new FileRenderCacheRepository(root);
      const eventId = 'cache-event';
      const key = cacheKey();
      await cache.put({ key, record: cacheRecord(key) });

      // A cache record alone must not surface as an accepted artifact or scene:
      // the cache is derived output and never an accepted-artifact source.
      expect(await execution.resolveAcceptedArtifact({ projectId: 'project', eventId })).toBeNull();
      expect(await execution.readAcceptedScene({ projectId: 'project', eventId })).toBeNull();

      // Committing an accepted scene must not leak into the cache, and the
      // accepted artifact resolves exclusively from the execution record.
      expect(
        (
          await execution.compareAndSwapAcceptedScene({
            projectId: 'project',
            eventId,
            expectedVersion: null,
            value: acceptedScene(eventId),
          })
        ).kind,
      ).toBe('committed');
      expect(await cache.get({ key })).toEqual(cacheRecord(key));
      expect(
        (await execution.resolveAcceptedArtifact({ projectId: 'project', eventId }))?.prose,
      ).toBe('accepted');
    }));
  it('exercises every execution record family with CAS append, read, conflict, and missing-null reads', async () =>
    withTempProject(async (root) => {
      const repository = new FileExecutionRepository(root);
      await exerciseExecutionFamily(
        () =>
          repository.readSceneRevision({
            projectId: 'project',
            eventId: 'event-1',
            revisionId: 'revision-1',
          }),
        (expectedVersion, value) =>
          repository.compareAndSwapSceneRevision({
            projectId: 'project',
            eventId: 'event-1',
            revisionId: 'revision-1',
            expectedVersion,
            value,
          }),
        sceneRevision(),
        { ...sceneRevision(), value: { prose: 'draft v2' } },
        'scene revision',
      );
      await exerciseExecutionFamily(
        () => repository.readReview({ projectId: 'project', reviewId: 'review-1' }),
        (expectedVersion, value) =>
          repository.compareAndSwapReview({
            projectId: 'project',
            reviewId: 'review-1',
            expectedVersion,
            value,
          }),
        review(),
        { ...review(), value: { comments: ['keep'] } },
        'review',
      );
      await exerciseExecutionFamily(
        () => repository.readPublication({ projectId: 'project' }),
        (expectedVersion, value) =>
          repository.compareAndSwapPublication({ projectId: 'project', expectedVersion, value }),
        publication(),
        { ...publication(), value: { manifest: 'published' } },
        'publication',
      );
      await exerciseExecutionFamily(
        () => repository.readOperation({ projectId: 'project', operationId: 'operation-1' }),
        (expectedVersion, value) =>
          repository.compareAndSwapOperation({
            projectId: 'project',
            operationId: 'operation-1',
            expectedVersion,
            value,
          }),
        operation(),
        { ...operation(), value: { kind: 'publish' } },
        'operation',
      );
      await exerciseExecutionFamily(
        () => repository.readTrace({ projectId: 'project', operationId: 'operation-1' }),
        (expectedVersion, value) =>
          repository.compareAndSwapTrace({
            projectId: 'project',
            operationId: 'operation-1',
            expectedVersion,
            value,
          }),
        trace(),
        { ...trace(), value: { spans: ['render'] } },
        'trace',
      );
    }));

  it('isolates stored records from caller and reader mutation for every execution record family', async () =>
    withTempProject(async (root) => {
      const repository = new FileExecutionRepository(root);
      await exerciseExecutionCloneIsolation(
        (value) =>
          repository.compareAndSwapSceneRevision({
            projectId: 'project',
            eventId: 'event-1',
            revisionId: 'revision-1',
            expectedVersion: null,
            value,
          }),
        () =>
          repository.readSceneRevision({
            projectId: 'project',
            eventId: 'event-1',
            revisionId: 'revision-1',
          }),
        { ...sceneRevision(), value: { marker: 'pristine' } },
        'scene revision',
      );
      await exerciseExecutionCloneIsolation(
        (value) =>
          repository.compareAndSwapReview({
            projectId: 'project',
            reviewId: 'review-1',
            expectedVersion: null,
            value,
          }),
        () => repository.readReview({ projectId: 'project', reviewId: 'review-1' }),
        { ...review(), value: { marker: 'pristine' } },
        'review',
      );
      await exerciseExecutionCloneIsolation(
        (value) =>
          repository.compareAndSwapPublication({
            projectId: 'project',
            expectedVersion: null,
            value,
          }),
        () => repository.readPublication({ projectId: 'project' }),
        { ...publication(), value: { marker: 'pristine' } },
        'publication',
      );
      await exerciseExecutionCloneIsolation(
        (value) =>
          repository.compareAndSwapOperation({
            projectId: 'project',
            operationId: 'operation-1',
            expectedVersion: null,
            value,
          }),
        () => repository.readOperation({ projectId: 'project', operationId: 'operation-1' }),
        { ...operation(), value: { marker: 'pristine' } },
        'operation',
      );
      await exerciseExecutionCloneIsolation(
        (value) =>
          repository.compareAndSwapTrace({
            projectId: 'project',
            operationId: 'operation-1',
            expectedVersion: null,
            value,
          }),
        () => repository.readTrace({ projectId: 'project', operationId: 'operation-1' }),
        { ...trace(), value: { marker: 'pristine' } },
        'trace',
      );
    }));
  it('serializes concurrent execution compare-and-swap writers', async () =>
    withTempProject(async (root) => {
      const first = new FileExecutionRepository(root);
      const second = new FileExecutionRepository(root);
      const results = await Promise.all([
        first.compareAndSwapAcceptedScene({
          projectId: 'project',
          eventId: 'event-1',
          expectedVersion: null,
          value: acceptedScene(),
        }),
        second.compareAndSwapAcceptedScene({
          projectId: 'project',
          eventId: 'event-1',
          expectedVersion: null,
          value: acceptedScene(),
        }),
      ]);

      expect(results.map((result) => result.kind).sort()).toEqual(['committed', 'conflict']);
      expect(
        (await first.readAcceptedScene({ projectId: 'project', eventId: 'event-1' }))?.revision,
      ).toBe(1);
    }));
  it('quarantines a stale execution lock before completing a new mutation', async () =>
    withTempProject(async (root) => {
      const directory = path.join(root, '.nova', 'execution');
      await fs.mkdir(directory, { recursive: true });
      const lock = path.join(directory, '.write.lock');
      await fs.writeFile(lock, JSON.stringify({ version: 1, token: 'abandoned', acquiredAt: 0 }));
      await fs.utimes(lock, new Date(0), new Date(0));

      const result = await new FileExecutionRepository(root).compareAndSwapAcceptedScene({
        projectId: 'project',
        eventId: 'event-1',
        expectedVersion: null,
        value: acceptedScene(),
      });

      expect(result.kind).toBe('committed');
      expect(
        (await fs.readdir(directory)).some(
          (name) => name.includes('.write.lock.abandoned.') && name.endsWith('.stale'),
        ),
      ).toBe(true);
    }));
  it('preserves ordered state log and nearest valid snapshots', async () =>
    withTempProject(async (root) => {
      const log = new FileStateLogRepository(root);
      expect(
        (
          await log.append({
            key: stateKey,
            expectedVersion: 0,
            events: [stateEvent(1), stateEvent(2)],
          })
        ).kind,
      ).toBe('appended');
      expect(
        (await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(3)] })).kind,
      ).toBe('conflict');
      expect((await log.read({ key: stateKey })).lastSequence).toBe(2);
      const snapshots = new FileStateSnapshotRepository(root);
      await snapshots.save({ snapshot: snapshot(1), expectedVersion: null });
      await snapshots.save({ snapshot: snapshot(2), expectedVersion: 1 });
      expect(
        (
          await snapshots.readNearestValid({
            key: stateKey,
            atOrBeforeSequence: 2,
            schema: 'state',
            schemaVersion: 1,
          })
        )?.sequence,
      ).toBe(2);
      expect(
        await snapshots.readNearestValid({
          key: stateKey,
          atOrBeforeSequence: 2,
          schema: 'other',
          schemaVersion: 1,
        }),
      ).toBeNull();
    }));
  it('rejects corrupt state logs without overwriting their prior events', async () =>
    withTempProject(async (root) => {
      const log = new FileStateLogRepository(root);
      await log.append({
        key: stateKey,
        expectedVersion: 0,
        events: [stateEvent(1), stateEvent(2)],
      });
      const target = await stateLogFile(root);
      const corrupted = JSON.stringify({
        version: 1,
        key: stateKey,
        events: [stateEvent(1), { ...stateEvent(2), sequence: 4 }],
      });
      await fs.writeFile(target, corrupted);

      await expect(
        log.append({ key: stateKey, expectedVersion: 2, events: [stateEvent(3)] }),
      ).rejects.toMatchObject({
        name: 'StateLogCorruptionError',
      });
      await expect(log.read({ key: stateKey })).rejects.toMatchObject({
        name: 'StateLogCorruptionError',
      });
      expect(await fs.readFile(target, 'utf8')).toBe(corrupted);
    }));
  it('rejects malformed state log bytes without touching them', async () =>
    withTempProject(async (root) => {
      const log = new FileStateLogRepository(root);
      await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] });
      const target = await stateLogFile(root);
      const truncated = (await fs.readFile(target, 'utf8')).slice(0, 40);
      await fs.writeFile(target, truncated);

      await expect(
        log.append({ key: stateKey, expectedVersion: 1, events: [stateEvent(2)] }),
      ).rejects.toMatchObject({
        name: 'StateLogCorruptionError',
      });
      expect(await fs.readFile(target, 'utf8')).toBe(truncated);
      await expect(log.read({ key: stateKey })).rejects.toMatchObject({
        name: 'StateLogCorruptionError',
      });
    }));
  it('reports typed expected-version conflicts for log and snapshot CAS', async () =>
    withTempProject(async (root) => {
      const log = new FileStateLogRepository(root);
      expect(
        await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] }),
      ).toEqual({ kind: 'appended', version: 1, events: [stateEvent(1)] });
      expect(
        await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(2)] }),
      ).toEqual({ kind: 'conflict', expectedVersion: 0, actualVersion: 1 });

      const snapshots = new FileStateSnapshotRepository(root);
      expect(await snapshots.save({ snapshot: snapshot(1), expectedVersion: null })).toEqual({
        kind: 'saved',
        sequence: 1,
        version: 1,
      });
      expect(await snapshots.save({ snapshot: snapshot(2), expectedVersion: 0 })).toEqual({
        kind: 'conflict',
        expectedVersion: 0,
        actualVersion: 1,
      });
      expect(await snapshots.save({ snapshot: snapshot(2), expectedVersion: 1 })).toEqual({
        kind: 'saved',
        sequence: 2,
        version: 2,
      });
    }));
  it('rejects noncontiguous state appends without persisting anything', async () =>
    withTempProject(async (root) => {
      const log = new FileStateLogRepository(root);
      await expect(
        log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(2)] }),
      ).rejects.toThrow('contiguous');
      await expect(
        log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1), stateEvent(3)] }),
      ).rejects.toThrow(RangeError);
      await expect(
        log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(2), stateEvent(1)] }),
      ).rejects.toThrow(RangeError);
      expect(await log.read({ key: stateKey })).toEqual({
        key: stateKey,
        events: [],
        version: 0,
        firstSequence: null,
        lastSequence: null,
      });
    }));
  it('filters state log reads by fromSequence while keeping full-log version metadata', async () =>
    withTempProject(async (root) => {
      const log = new FileStateLogRepository(root);
      await log.append({
        key: stateKey,
        expectedVersion: 0,
        events: [stateEvent(1), stateEvent(2), stateEvent(3)],
      });

      const filtered = await log.read({ key: stateKey, fromSequence: 2 });
      expect(filtered.events).toEqual([stateEvent(2), stateEvent(3)]);
      expect(filtered.version).toBe(3);
      expect(filtered.firstSequence).toBe(1);
      expect(filtered.lastSequence).toBe(3);

      const beyond = await log.read({ key: stateKey, fromSequence: 4 });
      expect(beyond.events).toEqual([]);
      expect(beyond.version).toBe(3);
      expect(beyond.firstSequence).toBe(1);
      expect(beyond.lastSequence).toBe(3);

      const missing = await log.read({ key: { ...stateKey, streamId: 'other' }, fromSequence: 1 });
      expect(missing).toEqual({
        key: { ...stateKey, streamId: 'other' },
        events: [],
        version: 0,
        firstSequence: null,
        lastSequence: null,
      });
    }));
  it('preserves the full event log when snapshots are missing, stale, or corrupt', async () =>
    withTempProject(async (root) => {
      const log = new FileStateLogRepository(root);
      await log.append({
        key: stateKey,
        expectedVersion: 0,
        events: [stateEvent(1), stateEvent(2), stateEvent(3)],
      });
      const snapshots = new FileStateSnapshotRepository(root);

      expect(
        await snapshots.readNearestValid({
          key: stateKey,
          atOrBeforeSequence: 3,
          schema: 'state',
          schemaVersion: 1,
        }),
      ).toBeNull();
      await snapshots.save({ snapshot: snapshot(1), expectedVersion: null });
      await snapshots.save({ snapshot: snapshot(2), expectedVersion: 1 });
      expect(
        (
          await snapshots.readNearestValid({
            key: stateKey,
            atOrBeforeSequence: 3,
            schema: 'state',
            schemaVersion: 1,
          })
        )?.sequence,
      ).toBe(2);
      expect(
        (
          await snapshots.readNearestValid({
            key: stateKey,
            atOrBeforeSequence: 1,
            schema: 'state',
            schemaVersion: 1,
          })
        )?.sequence,
      ).toBe(1);

      await fs.writeFile(await stateSnapshotFile(root), '{ truncated snapshot bytes');
      expect(
        await snapshots.readNearestValid({
          key: stateKey,
          atOrBeforeSequence: 3,
          schema: 'state',
          schemaVersion: 1,
        }),
      ).toBeNull();

      const afterCorruption = await log.read({ key: stateKey });
      expect(afterCorruption.version).toBe(3);
      expect(afterCorruption.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(afterCorruption.lastSequence).toBe(3);

      expect(await snapshots.save({ snapshot: snapshot(3), expectedVersion: null })).toEqual({
        kind: 'saved',
        sequence: 3,
        version: 1,
      });
      expect(
        (
          await snapshots.readNearestValid({
            key: stateKey,
            atOrBeforeSequence: 3,
            schema: 'state',
            schemaVersion: 1,
          })
        )?.sequence,
      ).toBe(3);
    }));
  it('rejects a symlinked state-log lock with a typed error', async () =>
    withTempProject(async (root) => {
      const directory = path.join(root, '.nova', 'state-log');
      await fs.mkdir(directory, { recursive: true });
      await fs.symlink(path.join(root, 'lock-target'), path.join(directory, '.write.lock'));

      const log = new FileStateLogRepository(root);
      await expect(
        log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] }),
      ).rejects.toMatchObject({
        name: 'RepositoryLockViolationError',
      });
      expect(await fs.readdir(directory)).toEqual(['.write.lock']);
    }));
  it('quarantines a stale state-log lock before appending', async () =>
    withTempProject(async (root) => {
      const directory = path.join(root, '.nova', 'state-log');
      await fs.mkdir(directory, { recursive: true });
      const lock = path.join(directory, '.write.lock');
      await fs.writeFile(lock, JSON.stringify({ version: 1, token: 'abandoned', acquiredAt: 0 }));
      await fs.utimes(lock, new Date(0), new Date(0));

      const log = new FileStateLogRepository(root);
      expect(
        (await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] })).kind,
      ).toBe('appended');
      expect(
        (await fs.readdir(directory)).some(
          (name) => name.includes('.write.lock.abandoned.') && name.endsWith('.stale'),
        ),
      ).toBe(true);
    }));
  it('recovers interrupted journal and rejects symlinked storage', async () =>
    withTempProject(async (root) => {
      const repository = new FileExecutionRepository(root);
      await repository.compareAndSwapAcceptedScene({
        projectId: 'project',
        eventId: 'event-1',
        expectedVersion: null,
        value: acceptedScene(),
      });
      const directory = path.join(root, '.nova', 'execution');
      const file = (await executionFiles(root))[0];
      await fs.writeFile(
        path.join(directory, '.journal.json'),
        JSON.stringify({
          version: 1,
          target: file,
          content: JSON.stringify({ version: 1, revision: 2, value: acceptedScene('event-1') }),
        }),
      );
      expect(
        (await repository.readAcceptedScene({ projectId: 'project', eventId: 'event-1' }))?.value
          .eventId,
      ).toBe('event-1');
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      await fs.rm(directory, { recursive: true });
      await fs.symlink(outside, directory, 'dir');
      await expect(
        repository.readAcceptedScene({ projectId: 'project', eventId: 'event-1' }),
      ).resolves.toBeNull();
    }));
});
