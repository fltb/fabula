import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryExecutionRepository } from '../../src/testing/memory-repositories.ts';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const sourceHash = hash('immutable authored source');
const scene = (prose: string, revisionId: string, source = sourceHash) => ({ version: 1 as const, projectId: 'manual-edit', eventId: 'E001', sourceHash: source, revisionId, prose, proseHash: hash(prose), sceneHash: hash(`${source}\0${prose}`) });

describe('manual edit lock freshness — semantic execution repository', () => {
  it('accepts a scene head and rejects stale compare-and-swap writes', async () => {
    const repository = new MemoryExecutionRepository();
    const original = scene('Original accepted prose.', 'revision-1');
    const first = await repository.compareAndSwapAcceptedScene({ projectId: original.projectId, eventId: original.eventId, expectedVersion: null, value: original });
    expect(first.kind).toBe('committed');
    const current = await repository.readAcceptedScene({ projectId: original.projectId, eventId: original.eventId });
    expect(current?.value.sourceHash).toBe(sourceHash);
    const replacement = scene('Human replacement prose.', 'revision-2');
    const stale = await repository.compareAndSwapAcceptedScene({ projectId: original.projectId, eventId: original.eventId, expectedVersion: null, value: replacement });
    expect(stale.kind).toBe('conflict');
    const committed = await repository.compareAndSwapAcceptedScene({ projectId: original.projectId, eventId: original.eventId, expectedVersion: 1, value: replacement });
    expect(committed.kind).toBe('committed');
    expect((await repository.resolveAcceptedArtifact({ projectId: original.projectId, eventId: original.eventId }))?.prose).toBe(replacement.prose);
  });

  it('marks a locked head stale when the accepted source hash changes', async () => {
    const repository = new MemoryExecutionRepository();
    const original = scene('Locked prose.', 'revision-1');
    await repository.compareAndSwapAcceptedScene({ projectId: original.projectId, eventId: original.eventId, expectedVersion: null, value: original });
    const changedSource = hash('changed authored source');
    const current = await repository.readAcceptedScene({ projectId: original.projectId, eventId: original.eventId });
    expect(current?.value.sourceHash).not.toBe(changedSource);
    expect(current?.value.sourceHash === changedSource).toBe(false);
    const refreshed = scene(original.prose, 'revision-2', changedSource);
    const result = await repository.compareAndSwapAcceptedScene({ projectId: original.projectId, eventId: original.eventId, expectedVersion: 1, value: refreshed });
    expect(result.kind).toBe('committed');
    expect((await repository.readAcceptedScene({ projectId: original.projectId, eventId: original.eventId }))?.value.sourceHash).toBe(changedSource);
  });

  it('preserves revision lineage while changing prose', async () => {
    const repository = new MemoryExecutionRepository();
    const original = scene('Historical prose.', 'revision-1');
    await repository.compareAndSwapAcceptedScene({ projectId: original.projectId, eventId: original.eventId, expectedVersion: null, value: original });
    const revision = { version: 1 as const, projectId: original.projectId, eventId: original.eventId, revisionId: 'revision-2', parentRevisionId: original.revisionId, sourceHash, value: { prose: 'New accepted prose.', restoredFromRevisionId: original.revisionId } };
    const stored = await repository.compareAndSwapSceneRevision({ projectId: original.projectId, eventId: original.eventId, revisionId: revision.revisionId, expectedVersion: null, value: revision });
    expect(stored.kind).toBe('committed');
    const restored = await repository.readSceneRevision({ projectId: original.projectId, eventId: original.eventId, revisionId: revision.revisionId });
    expect(restored?.value.parentRevisionId).toBe(original.revisionId);
    expect(restored?.value.value).toEqual({ prose: 'New accepted prose.', restoredFromRevisionId: original.revisionId });
  });
});
