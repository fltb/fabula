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
} from '../ports/execution-repository.ts';
import type {
  LayeredCacheKey,
  RenderCacheRecord,
  RenderCacheRepository,
} from '../ports/render-cache-repository.ts';
import type {
  StateAppendResult,
  StateEvent,
  StateLogReadResult,
  StateLogRepository,
  StateSnapshotRecord,
  StateSnapshotRepository,
  StateSnapshotWriteResult,
  StateStreamKey,
} from '../ports/state-repository.ts';

type Stored<T> = { version: number; value: T };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const keyOf = (...parts: readonly string[]): string => JSON.stringify(parts);
const cacheKeyOf = (key: LayeredCacheKey): string =>
  JSON.stringify({
    version: key.version,
    sourceHash: key.sourceHash,
    layers: Object.keys(key.layers)
      .sort()
      .map((name) => [name, key.layers[name]]),
  });

export class MemoryExecutionRepository implements CoreExecutionRepository {
  private readonly acceptedScenes = new Map<string, Stored<AcceptedSceneRecord>>();
  private readonly sceneRevisions = new Map<string, Stored<SceneRevisionRecord>>();
  private readonly reviews = new Map<string, Stored<ReviewRecord>>();
  private readonly publications = new Map<string, Stored<PublicationRecord>>();
  private readonly operations = new Map<string, Stored<OperationRecord>>();
  private readonly traces = new Map<string, Stored<TraceRecord>>();

  async readAcceptedScene(input: {
    projectId: string;
    eventId: string;
  }): Promise<ReadResult<AcceptedSceneRecord> | null> {
    return this.read(this.acceptedScenes, keyOf(input.projectId, input.eventId));
  }
  async readSceneRevision(input: {
    projectId: string;
    eventId: string;
    revisionId: string;
  }): Promise<ReadResult<SceneRevisionRecord> | null> {
    return this.read(this.sceneRevisions, keyOf(input.projectId, input.eventId, input.revisionId));
  }
  async readReview(input: {
    projectId: string;
    reviewId: string;
  }): Promise<ReadResult<ReviewRecord> | null> {
    return this.read(this.reviews, keyOf(input.projectId, input.reviewId));
  }
  async readPublication(input: {
    projectId: string;
  }): Promise<ReadResult<PublicationRecord> | null> {
    return this.read(this.publications, input.projectId);
  }
  async readOperation(input: {
    projectId: string;
    operationId: string;
  }): Promise<ReadResult<OperationRecord> | null> {
    return this.read(this.operations, keyOf(input.projectId, input.operationId));
  }
  async readTrace(input: {
    projectId: string;
    operationId: string;
  }): Promise<ReadResult<TraceRecord> | null> {
    return this.read(this.traces, keyOf(input.projectId, input.operationId));
  }
  async resolveAcceptedArtifact(input: {
    projectId: string;
    eventId: string;
  }): Promise<AcceptedArtifactRecord | null> {
    const scene = await this.readAcceptedScene(input);
    if (!scene) return null;
    return clone({
      version: 1,
      projectId: scene.value.projectId,
      eventId: scene.value.eventId,
      revisionId: scene.value.revisionId,
      sourceHash: scene.value.sourceHash,
      prose: scene.value.prose,
      proseHash: scene.value.proseHash,
      sceneHash: scene.value.sceneHash,
    });
  }

  compareAndSwapAcceptedScene(input: {
    projectId: string;
    eventId: string;
    expectedVersion: number | null;
    value: AcceptedSceneRecord;
  }): Promise<CommitResult<AcceptedSceneRecord>> {
    return this.commit(
      this.acceptedScenes,
      keyOf(input.projectId, input.eventId),
      input.expectedVersion,
      input.value,
    );
  }
  compareAndSwapSceneRevision(input: {
    projectId: string;
    eventId: string;
    revisionId: string;
    expectedVersion: number | null;
    value: SceneRevisionRecord;
  }): Promise<CommitResult<SceneRevisionRecord>> {
    return this.commit(
      this.sceneRevisions,
      keyOf(input.projectId, input.eventId, input.revisionId),
      input.expectedVersion,
      input.value,
    );
  }
  compareAndSwapReview(input: {
    projectId: string;
    reviewId: string;
    expectedVersion: number | null;
    value: ReviewRecord;
  }): Promise<CommitResult<ReviewRecord>> {
    return this.commit(
      this.reviews,
      keyOf(input.projectId, input.reviewId),
      input.expectedVersion,
      input.value,
    );
  }
  compareAndSwapPublication(input: {
    projectId: string;
    expectedVersion: number | null;
    value: PublicationRecord;
  }): Promise<CommitResult<PublicationRecord>> {
    return this.commit(this.publications, input.projectId, input.expectedVersion, input.value);
  }
  compareAndSwapOperation(input: {
    projectId: string;
    operationId: string;
    expectedVersion: number | null;
    value: OperationRecord;
  }): Promise<CommitResult<OperationRecord>> {
    return this.commit(
      this.operations,
      keyOf(input.projectId, input.operationId),
      input.expectedVersion,
      input.value,
    );
  }
  compareAndSwapTrace(input: {
    projectId: string;
    operationId: string;
    expectedVersion: number | null;
    value: TraceRecord;
  }): Promise<CommitResult<TraceRecord>> {
    return this.commit(
      this.traces,
      keyOf(input.projectId, input.operationId),
      input.expectedVersion,
      input.value,
    );
  }

  private read<T>(map: Map<string, Stored<T>>, key: string): ReadResult<T> | null {
    const stored = map.get(key);
    return stored ? { revision: stored.version, value: clone(stored.value) } : null;
  }
  private commit<T>(
    map: Map<string, Stored<T>>,
    key: string,
    expectedVersion: number | null,
    value: T,
  ): Promise<CommitResult<T>> {
    const current = map.get(key);
    const actualVersion = current?.version ?? null;
    if (actualVersion !== expectedVersion)
      return Promise.resolve({ kind: 'conflict', expectedVersion, actualVersion });
    const version = (current?.version ?? 0) + 1;
    map.set(key, { version, value: clone(value) });
    return Promise.resolve({ kind: 'committed', version, value: clone(value) });
  }
}

export class MemoryRenderCacheRepository implements RenderCacheRepository {
  private readonly records = new Map<string, RenderCacheRecord>();
  async get(input: { key: LayeredCacheKey }): Promise<RenderCacheRecord | null> {
    const record = this.records.get(cacheKeyOf(input.key));
    return record ? clone(record) : null;
  }
  async put(input: { key: LayeredCacheKey; record: RenderCacheRecord }): Promise<void> {
    this.records.set(cacheKeyOf(input.key), clone(input.record));
  }
  async remove(input: { key: LayeredCacheKey }): Promise<void> {
    this.records.delete(cacheKeyOf(input.key));
  }
}

export class MemoryStateLogRepository implements StateLogRepository {
  private readonly streams = new Map<string, { key: StateStreamKey; events: StateEvent[] }>();
  async append(input: {
    key: StateStreamKey;
    expectedVersion: number;
    events: readonly StateEvent[];
  }): Promise<StateAppendResult> {
    const id = keyOf(input.key.projectId, input.key.streamId, input.key.branchId);
    const stream = this.streams.get(id) ?? { key: clone(input.key), events: [] };
    if (stream.events.length !== input.expectedVersion)
      return {
        kind: 'conflict',
        expectedVersion: input.expectedVersion,
        actualVersion: stream.events.length,
      };
    input.events.forEach((event, index) => {
      if (event.sequence !== input.expectedVersion + index + 1)
        throw new RangeError('State events must be contiguous and ordered');
    });
    const events = input.events.map(clone);
    stream.events.push(...events);
    this.streams.set(id, stream);
    return { kind: 'appended', version: stream.events.length, events: clone(events) };
  }
  async read(input: { key: StateStreamKey; fromSequence?: number }): Promise<StateLogReadResult> {
    const stream = this.streams.get(
      keyOf(input.key.projectId, input.key.streamId, input.key.branchId),
    );
    const from = input.fromSequence ?? 1;
    const events = stream?.events.filter((event) => event.sequence >= from) ?? [];
    return clone({
      key: input.key,
      events,
      version: stream?.events.length ?? 0,
      firstSequence: stream?.events[0]?.sequence ?? null,
      lastSequence: stream?.events.at(-1)?.sequence ?? null,
    });
  }
}

export class MemoryStateSnapshotRepository implements StateSnapshotRepository {
  private readonly snapshots = new Map<
    string,
    { version: number; records: StateSnapshotRecord[] }
  >();
  async save(input: {
    snapshot: StateSnapshotRecord;
    expectedVersion: number | null;
  }): Promise<StateSnapshotWriteResult> {
    const id = keyOf(
      input.snapshot.key.projectId,
      input.snapshot.key.streamId,
      input.snapshot.key.branchId,
    );
    const current = this.snapshots.get(id);
    const actualVersion = current?.version ?? null;
    if (actualVersion !== input.expectedVersion)
      return { kind: 'conflict', expectedVersion: input.expectedVersion, actualVersion };
    const version = (current?.version ?? 0) + 1;
    const records = current?.records ?? [];
    records.push(clone(input.snapshot));
    this.snapshots.set(id, { version, records });
    return { kind: 'saved', sequence: input.snapshot.sequence, version };
  }
  async readNearestValid(input: {
    key: StateStreamKey;
    atOrBeforeSequence: number;
    schema: string;
    schemaVersion: number;
  }): Promise<StateSnapshotRecord | null> {
    const id = keyOf(input.key.projectId, input.key.streamId, input.key.branchId);
    const match = (this.snapshots.get(id)?.records ?? [])
      .filter(
        (snapshot) =>
          snapshot.sequence <= input.atOrBeforeSequence &&
          snapshot.schema === input.schema &&
          snapshot.schemaVersion === input.schemaVersion,
      )
      .sort((a, b) => b.sequence - a.sequence)[0];
    return match ? clone(match) : null;
  }
}
