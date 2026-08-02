import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileExecutionRepository } from '../src/execution/file-execution-repository.js';
import { FileStateLogRepository, FileStateSnapshotRepository } from '../src/state/file-state-repositories.js';
import { acceptedScene, executionFiles, snapshot, stateEvent, stateKey, stateLogFile, stateSnapshotFile, withTempProject } from './execution-fixtures.js';

describe('filesystem semantic execution/state repositories', () => {
  it('enforces compare-and-swap and accepted artifact separation', async () => withTempProject(async (root) => {
    const repository = new FileExecutionRepository(root);
    expect((await repository.compareAndSwapAcceptedScene({ projectId: 'project', eventId: 'event-1', expectedVersion: 1, value: acceptedScene() })).kind).toBe('conflict');
    expect((await repository.compareAndSwapAcceptedScene({ projectId: 'project', eventId: 'event-1', expectedVersion: null, value: acceptedScene() })).kind).toBe('committed');
    expect(await repository.resolveAcceptedArtifact({ projectId: 'project', eventId: 'event-1' })).toMatchObject({ prose: 'accepted' });
    expect(await repository.resolveAcceptedArtifact({ projectId: 'project', eventId: 'missing' })).toBeNull();
  }));
  it('serializes concurrent execution compare-and-swap writers', async () => withTempProject(async (root) => {
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
    expect((await first.readAcceptedScene({ projectId: 'project', eventId: 'event-1' }))?.revision).toBe(1);
  }));
  it('quarantines a stale execution lock before completing a new mutation', async () => withTempProject(async (root) => {
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
    expect((await fs.readdir(directory)).some((name) => name.includes('.write.lock.abandoned.') && name.endsWith('.stale'))).toBe(true);
  }));
  it('preserves ordered state log and nearest valid snapshots', async () => withTempProject(async (root) => {
    const log = new FileStateLogRepository(root);
    expect((await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1), stateEvent(2)] })).kind).toBe('appended');
    expect((await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(3)] })).kind).toBe('conflict');
    expect((await log.read({ key: stateKey })).lastSequence).toBe(2);
    const snapshots = new FileStateSnapshotRepository(root);
    await snapshots.save({ snapshot: snapshot(1), expectedVersion: null });
    await snapshots.save({ snapshot: snapshot(2), expectedVersion: 1 });
    expect((await snapshots.readNearestValid({ key: stateKey, atOrBeforeSequence: 2, schema: 'state', schemaVersion: 1 }))?.sequence).toBe(2);
    expect(await snapshots.readNearestValid({ key: stateKey, atOrBeforeSequence: 2, schema: 'other', schemaVersion: 1 })).toBeNull();
  }));
  it('rejects corrupt state logs without overwriting their prior events', async () => withTempProject(async (root) => {
    const log = new FileStateLogRepository(root);
    await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1), stateEvent(2)] });
    const target = await stateLogFile(root);
    const corrupted = JSON.stringify({
      version: 1,
      key: stateKey,
      events: [stateEvent(1), { ...stateEvent(2), sequence: 4 }],
    });
    await fs.writeFile(target, corrupted);

    await expect(log.append({ key: stateKey, expectedVersion: 2, events: [stateEvent(3)] })).rejects.toMatchObject({
      name: 'StateLogCorruptionError',
    });
    await expect(log.read({ key: stateKey })).rejects.toMatchObject({
      name: 'StateLogCorruptionError',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(corrupted);
  }));
  it('rejects malformed state log bytes without touching them', async () => withTempProject(async (root) => {
    const log = new FileStateLogRepository(root);
    await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] });
    const target = await stateLogFile(root);
    const truncated = (await fs.readFile(target, 'utf8')).slice(0, 40);
    await fs.writeFile(target, truncated);

    await expect(log.append({ key: stateKey, expectedVersion: 1, events: [stateEvent(2)] })).rejects.toMatchObject({
      name: 'StateLogCorruptionError',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(truncated);
    await expect(log.read({ key: stateKey })).rejects.toMatchObject({
      name: 'StateLogCorruptionError',
    });
  }));
  it('reports typed expected-version conflicts for log and snapshot CAS', async () => withTempProject(async (root) => {
    const log = new FileStateLogRepository(root);
    expect(await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] })).toEqual({ kind: 'appended', version: 1, events: [stateEvent(1)] });
    expect(await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(2)] })).toEqual({ kind: 'conflict', expectedVersion: 0, actualVersion: 1 });

    const snapshots = new FileStateSnapshotRepository(root);
    expect(await snapshots.save({ snapshot: snapshot(1), expectedVersion: null })).toEqual({ kind: 'saved', sequence: 1, version: 1 });
    expect(await snapshots.save({ snapshot: snapshot(2), expectedVersion: 0 })).toEqual({ kind: 'conflict', expectedVersion: 0, actualVersion: 1 });
    expect(await snapshots.save({ snapshot: snapshot(2), expectedVersion: 1 })).toEqual({ kind: 'saved', sequence: 2, version: 2 });
  }));
  it('preserves the full event log when snapshots are missing, stale, or corrupt', async () => withTempProject(async (root) => {
    const log = new FileStateLogRepository(root);
    await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1), stateEvent(2), stateEvent(3)] });
    const snapshots = new FileStateSnapshotRepository(root);

    expect(await snapshots.readNearestValid({ key: stateKey, atOrBeforeSequence: 3, schema: 'state', schemaVersion: 1 })).toBeNull();
    await snapshots.save({ snapshot: snapshot(1), expectedVersion: null });
    await snapshots.save({ snapshot: snapshot(2), expectedVersion: 1 });
    expect((await snapshots.readNearestValid({ key: stateKey, atOrBeforeSequence: 3, schema: 'state', schemaVersion: 1 }))?.sequence).toBe(2);
    expect((await snapshots.readNearestValid({ key: stateKey, atOrBeforeSequence: 1, schema: 'state', schemaVersion: 1 }))?.sequence).toBe(1);

    await fs.writeFile(await stateSnapshotFile(root), '{ truncated snapshot bytes');
    expect(await snapshots.readNearestValid({ key: stateKey, atOrBeforeSequence: 3, schema: 'state', schemaVersion: 1 })).toBeNull();

    const afterCorruption = await log.read({ key: stateKey });
    expect(afterCorruption.version).toBe(3);
    expect(afterCorruption.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(afterCorruption.lastSequence).toBe(3);

    expect(await snapshots.save({ snapshot: snapshot(3), expectedVersion: null })).toEqual({ kind: 'saved', sequence: 3, version: 1 });
    expect((await snapshots.readNearestValid({ key: stateKey, atOrBeforeSequence: 3, schema: 'state', schemaVersion: 1 }))?.sequence).toBe(3);
  }));
  it('rejects a symlinked state-log lock with a typed error', async () => withTempProject(async (root) => {
    const directory = path.join(root, '.nova', 'state-log');
    await fs.mkdir(directory, { recursive: true });
    await fs.symlink(path.join(root, 'lock-target'), path.join(directory, '.write.lock'));

    const log = new FileStateLogRepository(root);
    await expect(log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] })).rejects.toMatchObject({
      name: 'RepositoryLockViolationError',
    });
    expect(await fs.readdir(directory)).toEqual(['.write.lock']);
  }));
  it('quarantines a stale state-log lock before appending', async () => withTempProject(async (root) => {
    const directory = path.join(root, '.nova', 'state-log');
    await fs.mkdir(directory, { recursive: true });
    const lock = path.join(directory, '.write.lock');
    await fs.writeFile(lock, JSON.stringify({ version: 1, token: 'abandoned', acquiredAt: 0 }));
    await fs.utimes(lock, new Date(0), new Date(0));

    const log = new FileStateLogRepository(root);
    expect((await log.append({ key: stateKey, expectedVersion: 0, events: [stateEvent(1)] })).kind).toBe('appended');
    expect((await fs.readdir(directory)).some((name) => name.includes('.write.lock.abandoned.') && name.endsWith('.stale'))).toBe(true);
  }));
  it('recovers interrupted journal and rejects symlinked storage', async () => withTempProject(async (root) => {
    const repository = new FileExecutionRepository(root);
    await repository.compareAndSwapAcceptedScene({ projectId: 'project', eventId: 'event-1', expectedVersion: null, value: acceptedScene() });
    const directory = path.join(root, '.nova', 'execution');
    const file = (await executionFiles(root))[0];
    await fs.writeFile(path.join(directory, '.journal.json'), JSON.stringify({ version: 1, target: file, content: JSON.stringify({ version: 1, revision: 2, value: acceptedScene('event-1') }) }));
    expect((await repository.readAcceptedScene({ projectId: 'project', eventId: 'event-1' }))?.value.eventId).toBe('event-1');
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.rm(directory, { recursive: true }); await fs.symlink(outside, directory, 'dir');
    await expect(repository.readAcceptedScene({ projectId: 'project', eventId: 'event-1' })).resolves.toBeNull();
  }));
});
