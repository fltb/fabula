import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  AcceptedArtifactRecord,
  AcceptedSceneRecord,
  CommitResult,
  CoreExecutionRepository,
  OperationRecord,
  PublicationRecord,
  ReadResult,
  ReviewRecord,
  SceneRevisionRecord,
  TraceRecord,
} from '@novalistically/core';
import {
  assertSafeDirectory,
  atomicWrite,
  clone,
  encodeKey,
  isMissing,
  prepareDirectory,
  recoverJournal,
  type StoredRecord,
  withDirectoryLock,
} from './types.js';

export class FileExecutionRepository implements CoreExecutionRepository {
  readonly #root: string;
  readonly #directory: string;
  constructor(projectRoot: string, relativeDirectory = path.join('.nova', 'execution')) {
    this.#root = path.resolve(projectRoot);
    this.#directory = path.resolve(this.#root, relativeDirectory);
    if (!this.#directory.startsWith(`${this.#root}${path.sep}`))
      throw new Error('Execution directory escapes project root');
  }

  async readAcceptedScene(i: { projectId: string; eventId: string }) {
    return this.read<AcceptedSceneRecord>(['accepted', i.projectId, i.eventId]);
  }
  async readSceneRevision(i: { projectId: string; eventId: string; revisionId: string }) {
    return this.read<SceneRevisionRecord>(['revision', i.projectId, i.eventId, i.revisionId]);
  }
  async readReview(i: { projectId: string; reviewId: string }) {
    return this.read<ReviewRecord>(['review', i.projectId, i.reviewId]);
  }
  async readPublication(i: { projectId: string }) {
    return this.read<PublicationRecord>(['publication', i.projectId]);
  }
  async readOperation(i: { projectId: string; operationId: string }) {
    return this.read<OperationRecord>(['operation', i.projectId, i.operationId]);
  }
  async readTrace(i: { projectId: string; operationId: string }) {
    return this.read<TraceRecord>(['trace', i.projectId, i.operationId]);
  }
  async resolveAcceptedArtifact(i: {
    projectId: string;
    eventId: string;
  }): Promise<AcceptedArtifactRecord | null> {
    const scene = await this.readAcceptedScene(i);
    return scene
      ? clone({
          version: 1 as const,
          projectId: scene.value.projectId,
          eventId: scene.value.eventId,
          revisionId: scene.value.revisionId,
          sourceHash: scene.value.sourceHash,
          prose: scene.value.prose,
          proseHash: scene.value.proseHash,
          sceneHash: scene.value.sceneHash,
        })
      : null;
  }

  compareAndSwapAcceptedScene(i: {
    projectId: string;
    eventId: string;
    expectedVersion: number | null;
    value: AcceptedSceneRecord;
  }) {
    return this.commit(['accepted', i.projectId, i.eventId], i.expectedVersion, i.value);
  }
  compareAndSwapSceneRevision(i: {
    projectId: string;
    eventId: string;
    revisionId: string;
    expectedVersion: number | null;
    value: SceneRevisionRecord;
  }) {
    return this.commit(
      ['revision', i.projectId, i.eventId, i.revisionId],
      i.expectedVersion,
      i.value,
    );
  }
  compareAndSwapReview(i: {
    projectId: string;
    reviewId: string;
    expectedVersion: number | null;
    value: ReviewRecord;
  }) {
    return this.commit(['review', i.projectId, i.reviewId], i.expectedVersion, i.value);
  }
  compareAndSwapPublication(i: {
    projectId: string;
    expectedVersion: number | null;
    value: PublicationRecord;
  }) {
    return this.commit(['publication', i.projectId], i.expectedVersion, i.value);
  }
  compareAndSwapOperation(i: {
    projectId: string;
    operationId: string;
    expectedVersion: number | null;
    value: OperationRecord;
  }) {
    return this.commit(['operation', i.projectId, i.operationId], i.expectedVersion, i.value);
  }
  compareAndSwapTrace(i: {
    projectId: string;
    operationId: string;
    expectedVersion: number | null;
    value: TraceRecord;
  }) {
    return this.commit(['trace', i.projectId, i.operationId], i.expectedVersion, i.value);
  }

  async #ensure() {
    await prepareDirectory(this.#root, this.#directory);
    await recoverJournal(this.#root, this.#directory);
  }
  #file(parts: readonly string[]) {
    return path.join(this.#directory, `${encodeKey(parts)}.json`);
  }
  async read<T>(parts: readonly string[]): Promise<ReadResult<T> | null> {
    try {
      await assertSafeDirectory(this.#root, this.#directory);
      await recoverJournal(this.#root, this.#directory);
      const stored = await this.readStored<T>(this.#file(parts));
      return stored ? { revision: stored.revision, value: clone(stored.value) } : null;
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
  }
  async commit<T>(
    parts: readonly string[],
    expectedVersion: number | null,
    value: T,
  ): Promise<CommitResult<T>> {
    await this.#ensure();
    const file = this.#file(parts);
    return withDirectoryLock(this.#root, this.#directory, async () => {
      const current = await this.readStored<T>(file);
      const actualVersion = current?.revision ?? null;
      if (actualVersion !== expectedVersion) {
        return { kind: 'conflict', expectedVersion, actualVersion };
      }
      const revision = (current?.revision ?? 0) + 1;
      await atomicWrite(
        this.#root,
        this.#directory,
        file,
        JSON.stringify({ version: 1, revision, value: clone(value) } satisfies StoredRecord<T>),
      );
      return { kind: 'committed', version: revision, value: clone(value) };
    });
  }
  async readStored<T>(file: string): Promise<StoredRecord<T> | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      return isStoredRecord<T>(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
const isStoredRecord = <T>(value: unknown): value is StoredRecord<T> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'version' in value &&
    value.version === 1 &&
    'revision' in value &&
    typeof value.revision === 'number' &&
    'value' in value
  );
};
