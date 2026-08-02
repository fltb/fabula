import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AcceptedSceneRecord,
  OperationRecord,
  PublicationRecord,
  ReviewRecord,
  SceneRevisionRecord,
  StateEvent,
  StateSnapshotRecord,
  StateStreamKey,
  TraceRecord,
} from '@novalistically/core';

export async function withTempProject<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-host-execution-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export const stateKey: StateStreamKey = {
  projectId: 'project',
  streamId: 'main',
  branchId: 'primary',
};
export const stateEvent = (sequence: number): StateEvent => ({
  eventId: `event-${sequence}`,
  sequence,
  type: 'fact',
  payload: { sequence },
});
export const acceptedScene = (eventId = 'event-1'): AcceptedSceneRecord => ({
  version: 1,
  projectId: 'project',
  eventId,
  sourceHash: 'a'.repeat(64),
  revisionId: 'revision-1',
  prose: 'accepted',
  proseHash: 'b'.repeat(64),
  sceneHash: 'c'.repeat(64),
});
export const sceneRevision = (
  eventId = 'event-1',
  revisionId = 'revision-1',
): SceneRevisionRecord => ({
  version: 1,
  projectId: 'project',
  eventId,
  revisionId,
  parentRevisionId: null,
  sourceHash: 'a'.repeat(64),
  value: { prose: 'draft' },
});
export const review = (reviewId = 'review-1'): ReviewRecord => ({
  version: 1,
  projectId: 'project',
  reviewId,
  value: { comments: [] },
});
export const publication = (): PublicationRecord => ({
  version: 1,
  projectId: 'project',
  sourceHash: 'a'.repeat(64),
  value: { manifest: 'draft' },
});
export const operation = (operationId = 'operation-1'): OperationRecord => ({
  version: 1,
  projectId: 'project',
  operationId,
  value: { kind: 'edit' },
});
export const trace = (operationId = 'operation-1'): TraceRecord => ({
  version: 1,
  projectId: 'project',
  operationId,
  value: { spans: [] },
});
export const snapshot = (sequence: number): StateSnapshotRecord => ({
  version: 1,
  key: stateKey,
  schema: 'state',
  schemaVersion: 1,
  sequence,
  state: { sequence },
  snapshotHash: `${sequence}`.padStart(64, '0'),
});
export async function executionFiles(root: string): Promise<string[]> {
  const directory = path.join(root, '.nova', 'execution');
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}
export async function stateLogFile(root: string): Promise<string> {
  const [file] = await fs.readdir(path.join(root, '.nova', 'state-log'));
  return path.join(root, '.nova', 'state-log', file);
}
export async function stateSnapshotFile(root: string): Promise<string> {
  const [file] = await fs.readdir(path.join(root, '.nova', 'state-snapshots'));
  return path.join(root, '.nova', 'state-snapshots', file);
}
