import type { JsonValue } from '../contracts/json.js';

export interface StateStreamKey {
  readonly projectId: string;
  readonly streamId: string;
  readonly branchId: string;
}

export interface StateEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: JsonValue;
}

export interface StateLogReadResult {
  readonly key: StateStreamKey;
  readonly events: readonly StateEvent[];
  readonly version: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
}

export interface StateAppendSuccess {
  readonly kind: 'appended';
  readonly version: number;
  readonly events: readonly StateEvent[];
}

export interface StateVersionConflict {
  readonly kind: 'conflict';
  readonly expectedVersion: number | null;
  readonly actualVersion: number | null;
}

export type StateAppendResult = StateAppendSuccess | StateVersionConflict;

export interface StateLogRepository {
  append(input: {
    readonly key: StateStreamKey;
    readonly expectedVersion: number;
    readonly events: readonly StateEvent[];
  }): Promise<StateAppendResult>;
  read(input: {
    readonly key: StateStreamKey;
    readonly fromSequence?: number;
  }): Promise<StateLogReadResult>;
}

export interface StateSnapshotRecord {
  readonly version: 1;
  readonly key: StateStreamKey;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly state: JsonValue;
  readonly snapshotHash: string;
}

export interface StateSnapshotWriteSuccess {
  readonly kind: 'saved';
  readonly sequence: number;
  readonly version: number;
}

export type StateSnapshotWriteResult = StateSnapshotWriteSuccess | StateVersionConflict;

export interface StateSnapshotRepository {
  save(input: {
    readonly snapshot: StateSnapshotRecord;
    readonly expectedVersion: number | null;
  }): Promise<StateSnapshotWriteResult>;
  readNearestValid(input: {
    readonly key: StateStreamKey;
    readonly atOrBeforeSequence: number;
    readonly schema: string;
    readonly schemaVersion: number;
  }): Promise<StateSnapshotRecord | null>;
}
