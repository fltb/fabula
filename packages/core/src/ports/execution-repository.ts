import type { JsonValue } from '../contracts/json.js';
import type {
  ReviewEventDraftV1,
  ReviewEventReadResultV1,
  ReviewEventRecordV1,
} from '../review/events.js';

export type {
  ReviewEventDraftV1,
  ReviewEventKindV1,
  ReviewEventReadResultV1,
  ReviewEventRecordV1,
} from '../review/events.js';

/** JSON-safe values accepted by semantic Core ports. */
export interface AcceptedSceneRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly eventId: string;
  readonly sourceHash: string;
  readonly revisionId: string;
  readonly prose: string;
  readonly proseHash: string;
  readonly sceneHash: string;
  readonly value?: JsonValue;
}

export interface SceneRevisionRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly eventId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly sourceHash: string;
  readonly value: JsonValue;
}

export interface ReviewRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly reviewId: string;
  readonly value: JsonValue;
}

export interface PublicationRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly sourceHash: string;
  readonly value: JsonValue;
}

export interface OperationRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly operationId: string;
  readonly value: JsonValue;
}

export interface TraceRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly operationId: string;
  readonly value: JsonValue;
}

/** The only artifact shape that may be used as an accepted scene input. */
export interface AcceptedArtifactRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly eventId: string;
  readonly revisionId: string;
  readonly sourceHash: string;
  readonly prose: string;
  readonly proseHash: string;
  readonly sceneHash: string;
}

export interface VersionConflict {
  readonly kind: 'conflict';
  readonly expectedVersion: number | null;
  readonly actualVersion: number | null;
}

export interface CommitSuccess<T> {
  readonly kind: 'committed';
  readonly version: number;
  readonly value: T;
}

export type CommitResult<T> = CommitSuccess<T> | VersionConflict;

/** Read result: stored record plus its CAS revision; never alters the record's declared schema version. */
export interface ReadResult<T> {
  readonly revision: number;
  readonly value: T;
}

export interface CoreExecutionRepository {
  readAcceptedScene(input: {
    readonly projectId: string;
    readonly eventId: string;
  }): Promise<ReadResult<AcceptedSceneRecord> | null>;
  readSceneRevision(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly revisionId: string;
  }): Promise<ReadResult<SceneRevisionRecord> | null>;
  readReview(input: {
    readonly projectId: string;
    readonly reviewId: string;
  }): Promise<ReadResult<ReviewRecord> | null>;
  readPublication(input: {
    readonly projectId: string;
  }): Promise<ReadResult<PublicationRecord> | null>;
  readOperation(input: {
    readonly projectId: string;
    readonly operationId: string;
  }): Promise<ReadResult<OperationRecord> | null>;
  readTrace(input: {
    readonly projectId: string;
    readonly operationId: string;
  }): Promise<ReadResult<TraceRecord> | null>;
  resolveAcceptedArtifact(input: {
    readonly projectId: string;
    readonly eventId: string;
  }): Promise<AcceptedArtifactRecord | null>;

  compareAndSwapAcceptedScene(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly expectedVersion: number | null;
    readonly value: AcceptedSceneRecord;
  }): Promise<CommitResult<AcceptedSceneRecord>>;
  compareAndSwapSceneRevision(input: {
    readonly projectId: string;
    readonly eventId: string;
    readonly revisionId: string;
    readonly expectedVersion: number | null;
    readonly value: SceneRevisionRecord;
  }): Promise<CommitResult<SceneRevisionRecord>>;
  compareAndSwapReview(input: {
    readonly projectId: string;
    readonly reviewId: string;
    readonly expectedVersion: number | null;
    readonly value: ReviewRecord;
  }): Promise<CommitResult<ReviewRecord>>;

  /**
   * Read the append-only review event stream for one project. `version` is
   * the event count: the `expectedVersion` the next append must pass.
   * Implementations MUST assign contiguous 1-based `sequence` values.
   */
  readReviewEvents(input: {
    readonly projectId: string;
    readonly fromSequence?: number;
  }): Promise<ReviewEventReadResultV1>;
  /**
   * Append immutable review events with CAS-on-version semantics. The store
   * assigns sequences; committed events are returned with them assigned.
   */
  appendReviewEvents(input: {
    readonly projectId: string;
    readonly expectedVersion: number;
    readonly events: readonly ReviewEventDraftV1[];
  }): Promise<CommitResult<readonly ReviewEventRecordV1[]>>;
  compareAndSwapPublication(input: {
    readonly projectId: string;
    readonly expectedVersion: number | null;
    readonly value: PublicationRecord;
  }): Promise<CommitResult<PublicationRecord>>;
  compareAndSwapOperation(input: {
    readonly projectId: string;
    readonly operationId: string;
    readonly expectedVersion: number | null;
    readonly value: OperationRecord;
  }): Promise<CommitResult<OperationRecord>>;
  compareAndSwapTrace(input: {
    readonly projectId: string;
    readonly operationId: string;
    readonly expectedVersion: number | null;
    readonly value: TraceRecord;
  }): Promise<CommitResult<TraceRecord>>;
}
