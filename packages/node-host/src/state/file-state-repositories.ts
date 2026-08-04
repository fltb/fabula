import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  StateAppendResult,
  StateEvent,
  StateLogReadResult,
  StateLogRepository,
  StateSnapshotRecord,
  StateSnapshotRepository,
  StateSnapshotWriteResult,
  StateStreamKey,
} from '@novalistically/core';
import {
  assertSafeDirectory,
  atomicWrite,
  clone,
  encodeKey,
  isMissing,
  prepareDirectory,
  recoverJournal,
  withDirectoryLock,
} from '../execution/types.js';

const streamId = (key: StateStreamKey) => ['state', key.projectId, key.streamId, key.branchId];

export class StateLogCorruptionError extends Error {
  constructor(file: string, cause?: unknown) {
    super(`State log is corrupt: ${file}`, { cause });
    this.name = 'StateLogCorruptionError';
  }
}

export class FileStateLogRepository implements StateLogRepository {
  readonly #root: string;
  readonly #directory: string;

  constructor(projectRoot: string, relativeDirectory = path.join('.nova', 'state-log')) {
    this.#root = path.resolve(projectRoot);
    this.#directory = path.resolve(this.#root, relativeDirectory);
    if (!this.#directory.startsWith(`${this.#root}${path.sep}`)) {
      throw new Error('State log directory escapes project root');
    }
  }

  async append(input: {
    key: StateStreamKey;
    expectedVersion: number;
    events: readonly StateEvent[];
  }): Promise<StateAppendResult> {
    await this.#ensure();
    const file = this.#file(input.key);
    return withDirectoryLock(this.#root, this.#directory, async () => {
      const existing = await this.#readEvents(file, input.key);
      if (existing.length !== input.expectedVersion) {
        return {
          kind: 'conflict',
          expectedVersion: input.expectedVersion,
          actualVersion: existing.length,
        };
      }
      input.events.forEach((event, index) => {
        if (event.sequence !== input.expectedVersion + index + 1) {
          throw new RangeError('State events must be contiguous and ordered');
        }
      });
      const events = [...existing, ...input.events.map(clone)];
      await atomicWrite(
        this.#root,
        this.#directory,
        file,
        JSON.stringify({ version: 1, key: input.key, events }),
      );
      return { kind: 'appended', version: events.length, events: clone(input.events) };
    });
  }

  async read(input: { key: StateStreamKey; fromSequence?: number }): Promise<StateLogReadResult> {
    try {
      await assertSafeDirectory(this.#root, this.#directory);
      await recoverJournal(this.#root, this.#directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const events = await this.#readEvents(this.#file(input.key), input.key);
    const from = input.fromSequence ?? 1;
    const selected = events.filter((event) => event.sequence >= from);
    return clone({
      key: input.key,
      events: selected,
      version: events.length,
      firstSequence: events[0]?.sequence ?? null,
      lastSequence: events.at(-1)?.sequence ?? null,
    });
  }

  async #ensure() {
    await prepareDirectory(this.#root, this.#directory);
    await recoverJournal(this.#root, this.#directory);
  }

  #file(key: StateStreamKey) {
    return path.join(this.#directory, `${encodeKey(streamId(key))}.json`);
  }

  async #readEvents(file: string, key: StateStreamKey): Promise<StateEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredStateLog(parsed, key)) {
        throw new Error('State log does not match the expected schema or stream key');
      }
      return [...parsed.events];
    } catch (error) {
      throw new StateLogCorruptionError(file, error);
    }
  }
}

interface StoredStateLog {
  readonly version: 1;
  readonly key: StateStreamKey;
  readonly events: readonly StateEvent[];
}

const isJsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

const hasMatchingKey = (value: unknown, key: StateStreamKey): value is StateStreamKey => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'projectId' in value &&
    value.projectId === key.projectId &&
    'streamId' in value &&
    value.streamId === key.streamId &&
    'branchId' in value &&
    value.branchId === key.branchId
  );
};

const isStateEvent = (value: unknown, sequence: number): value is StateEvent => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'eventId' in value &&
    typeof value.eventId === 'string' &&
    value.eventId.length > 0 &&
    'sequence' in value &&
    value.sequence === sequence &&
    'type' in value &&
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    'payload' in value &&
    isJsonValue(value.payload)
  );
};

const isStoredStateLog = (value: unknown, key: StateStreamKey): value is StoredStateLog => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'version' in value &&
    value.version === 1 &&
    'key' in value &&
    hasMatchingKey(value.key, key) &&
    'events' in value &&
    Array.isArray(value.events) &&
    value.events.every((event, index) => isStateEvent(event, index + 1))
  );
};

export class FileStateSnapshotRepository implements StateSnapshotRepository {
  readonly #root: string;
  readonly #directory: string;
  constructor(projectRoot: string, relativeDirectory = path.join('.nova', 'state-snapshots')) {
    this.#root = path.resolve(projectRoot);
    this.#directory = path.resolve(this.#root, relativeDirectory);
    if (!this.#directory.startsWith(`${this.#root}${path.sep}`))
      throw new Error('Snapshot directory escapes project root');
  }
  async save(input: {
    snapshot: StateSnapshotRecord;
    expectedVersion: number | null;
  }): Promise<StateSnapshotWriteResult> {
    await prepareDirectory(this.#root, this.#directory);
    await recoverJournal(this.#root, this.#directory);
    const file = this.#file(input.snapshot.key);
    return withDirectoryLock(this.#root, this.#directory, async () => {
      const records = await this.#read(file, input.snapshot.key);
      const actualVersion = records.length ? records.length : null;
      if (actualVersion !== input.expectedVersion) {
        return { kind: 'conflict', expectedVersion: input.expectedVersion, actualVersion };
      }
      records.push(clone(input.snapshot));
      await atomicWrite(
        this.#root,
        this.#directory,
        file,
        JSON.stringify({ version: 1, key: input.snapshot.key, records }),
      );
      return { kind: 'saved', sequence: input.snapshot.sequence, version: records.length };
    });
  }
  async readNearestValid(input: {
    key: StateStreamKey;
    atOrBeforeSequence: number;
    schema: string;
    schemaVersion: number;
  }): Promise<StateSnapshotRecord | null> {
    try {
      await assertSafeDirectory(this.#root, this.#directory);
      await recoverJournal(this.#root, this.#directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const records = await this.#read(this.#file(input.key), input.key);
    const valid = records.filter(
      (snapshot) =>
        snapshot.sequence <= input.atOrBeforeSequence &&
        snapshot.schema === input.schema &&
        snapshot.schemaVersion === input.schemaVersion,
    );
    valid.sort((a, b) => b.sequence - a.sequence);
    return valid[0] ? clone(valid[0]) : null;
  }
  #file(key: StateStreamKey) {
    return path.join(this.#directory, `${encodeKey(streamId(key))}.json`);
  }
  async #read(file: string, key: StateStreamKey): Promise<StateSnapshotRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredSnapshotCollection(parsed)) return [];
      return parsed.records.filter((record) => isStateSnapshotRecord(record, key));
    } catch {
      return [];
    }
  }
}

const isStoredSnapshotCollection = (
  value: unknown,
): value is { readonly version: 1; readonly records: readonly unknown[] } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'version' in value && value.version === 1 && 'records' in value && Array.isArray(value.records)
  );
};

const isStateSnapshotRecord = (
  value: unknown,
  key: StateStreamKey,
): value is StateSnapshotRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'version' in value &&
    value.version === 1 &&
    'key' in value &&
    hasMatchingKey(value.key, key) &&
    'schema' in value &&
    typeof value.schema === 'string' &&
    'schemaVersion' in value &&
    typeof value.schemaVersion === 'number' &&
    Number.isInteger(value.schemaVersion) &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isInteger(value.sequence) &&
    'state' in value &&
    isJsonValue(value.state) &&
    'snapshotHash' in value &&
    typeof value.snapshotHash === 'string' &&
    value.snapshotHash.length > 0
  );
};
