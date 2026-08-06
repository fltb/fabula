import { createHash } from 'node:crypto';
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
  legacyLedgerToReviewEvents,
  parseLegacyReviewLedger,
  type ReviewEventDraftV1,
  type ReviewEventReadResultV1,
  type ReviewEventRecordV1,
  type ReviewLedgerV1,
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
  async readReviewEvents(i: {
    projectId: string;
    fromSequence?: number;
  }): Promise<ReviewEventReadResultV1> {
    await this.#ensure();
    const file = this.#streamFile(i.projectId);
    let events = await this.#readStream(file);
    if (events.length === 0) {
      // One-time migration of the legacy mutable `ledger` key. Never runs
      // once the stream has events or the import marker exists; the ledger
      // itself is left untouched (no dual-write).
      await this.#importLegacyLedgerOnce(i.projectId, file);
      events = await this.#readStream(file);
    }
    const from = i.fromSequence ?? 1;
    return {
      version: events.length,
      events: events.filter((event) => event.sequence >= from),
    };
  }
  async appendReviewEvents(i: {
    projectId: string;
    expectedVersion: number;
    events: readonly ReviewEventDraftV1[];
  }): Promise<CommitResult<readonly ReviewEventRecordV1[]>> {
    await this.#ensure();
    const file = this.#streamFile(i.projectId);
    return withDirectoryLock(this.#root, this.#directory, async () => {
      const current = await this.#readStream(file);
      if (current.length !== i.expectedVersion) {
        return {
          kind: 'conflict',
          expectedVersion: i.expectedVersion,
          actualVersion: current.length,
        };
      }
      let sequence = current.length;
      const records: ReviewEventRecordV1[] = i.events.map((draft) => {
        sequence += 1;
        return { ...clone(draft), sequence, projectId: i.projectId };
      });
      const existing = current.length === 0 ? '' : await fs.readFile(file, 'utf8');
      const appended = records.map((record) => JSON.stringify(record)).join('\n');
      await atomicWrite(this.#root, this.#directory, file, `${existing}${appended}\n`);
      return { kind: 'committed', version: sequence, value: records };
    });
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
  #streamFile(projectId: string) {
    return path.join(this.#directory, `${encodeKey(['review-stream', projectId])}.json`);
  }
  async #readStream(file: string): Promise<ReviewEventRecordV1[]> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const events: ReviewEventRecordV1[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Corrupt review event stream line in ${file}`);
      }
      if (!isReviewEventRecord(parsed))
        throw new Error(`Corrupt review event stream record in ${file}`);
      events.push(parsed);
    }
    return events;
  }
  /**
   * One-time migration of the old mutable `ledger` key into the append-only
   * stream. Runs under the directory lock; re-checks both the stream and the
   * import marker so concurrent processes import at most once.
   */
  async #importLegacyLedgerOnce(projectId: string, file: string): Promise<void> {
    const markerFile = `${file}.import.json`;
    await withDirectoryLock(this.#root, this.#directory, async () => {
      if (await this.#exists(markerFile)) return;
      const current = await this.#readStream(file);
      if (current.length > 0) return;
      const ledgerFile = this.#file(['review', projectId, 'ledger']);
      const stored = await this.readStored<ReviewRecord>(ledgerFile);
      if (!stored) return;
      let ledger: ReviewLedgerV1;
      try {
        ledger = parseLegacyReviewLedger(stored.value.value);
      } catch (error) {
        throw new Error(
          `Invalid legacy review ledger for ${projectId}: ${(error as Error).message}`,
        );
      }
      const createdAt = new Date().toISOString();
      const drafts = legacyLedgerToReviewEvents({
        projectId,
        ledger,
        createdAt,
        actorId: 'legacy-import',
      });
      let sequence = current.length;
      const records: ReviewEventRecordV1[] = drafts.map((draft) => {
        sequence += 1;
        return { ...draft, sequence, projectId };
      });
      if (records.length > 0) {
        const appended = records.map((record) => JSON.stringify(record)).join('\n');
        await atomicWrite(this.#root, this.#directory, file, `${appended}\n`);
      }
      await atomicWrite(
        this.#root,
        this.#directory,
        markerFile,
        JSON.stringify({
          version: 1,
          projectId,
          sourceReviewKey: 'ledger',
          contentHash: createHash('sha256').update(JSON.stringify(ledger)).digest('hex'),
          importedAt: createdAt,
          eventCount: records.length,
        }),
      );
    });
  }
  async #exists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
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

const REVIEW_EVENT_KINDS: Record<string, true> = {
  comment_added: true,
  comment_replaced: true,
  comment_status_changed: true,
  comment_applied: true,
  gate_opened: true,
  gate_decided: true,
  gate_superseded: true,
};

const isReviewEventRecord = (value: unknown): value is ReviewEventRecordV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.sequence === 'number' &&
    Number.isInteger(record.sequence) &&
    record.sequence > 0 &&
    typeof record.projectId === 'string' &&
    record.projectId.length > 0 &&
    typeof record.kind === 'string' &&
    REVIEW_EVENT_KINDS[record.kind] === true &&
    record.payload !== null &&
    typeof record.payload === 'object' &&
    !Array.isArray(record.payload) &&
    (record.commentId === undefined || typeof record.commentId === 'string') &&
    (record.gateId === undefined || typeof record.gateId === 'string') &&
    (record.actorId === undefined || typeof record.actorId === 'string') &&
    typeof record.createdAt === 'string'
  );
};
