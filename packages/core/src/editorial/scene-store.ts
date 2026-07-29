import * as path from 'node:path';
import { ConfigError } from '../errors.ts';
import { sceneRevisionEnvelopeV1Schema } from '../schemas/editorial.ts';
import { computeContentHash, computeFileHash } from '../storage/hash.ts';
import type { SceneRevisionEnvelopeV1 } from '../types/editorial.ts';
import { EditorialOperationError } from './errors.ts';
import type { ProjectPaths } from './paths.ts';
import { ProjectTransactionCoordinator, stableJson } from './transaction.ts';

export class SceneRevisionStore {
  constructor(
    private readonly coordinator: ProjectTransactionCoordinator,
    private readonly paths: ProjectPaths,
  ) {}

  revisionPath(eventId: string, revisionId: string): string {
    return path.join(this.paths.sceneRevisionsDir, eventId, `${revisionId}.json`);
  }

  latestPath(eventId: string): string {
    return path.join(this.paths.responsesDir, `${eventId}.json`);
  }

  archive(envelope: SceneRevisionEnvelopeV1): string {
    const parsed = this.validateEnvelope(envelope);
    const revisionPath = this.revisionPath(parsed.eventId, parsed.revisionId);
    this.coordinator.commit({
      readSet: [{ kind: 'file', path: revisionPath, expectedHash: null }],
      writes: [{ type: 'put', path: revisionPath, content: stableJson(parsed), expectedHash: null }],
    });
    return revisionPath;
  }

  updateLatest(envelope: SceneRevisionEnvelopeV1, expectedHash: string | null): void {
    const parsed = this.validateEnvelope(envelope);
    const latestPath = this.latestPath(parsed.eventId);
    this.coordinator.commit({
      readSet: [{ kind: 'file', path: latestPath, expectedHash }],
      writes: [{ type: 'put', path: latestPath, content: stableJson(parsed), expectedHash }],
    });
  }

  archiveAndUpdateLatest(
    envelope: SceneRevisionEnvelopeV1,
    expectedLatestHash: string | null,
  ): string {
    const parsed = this.validateEnvelope(envelope);
    const revisionPath = this.revisionPath(parsed.eventId, parsed.revisionId);
    const latestPath = this.latestPath(parsed.eventId);
    const serialized = stableJson(parsed);
    this.coordinator.commit({
      readSet: [
        { kind: 'file', path: revisionPath, expectedHash: null },
        { kind: 'file', path: latestPath, expectedHash: expectedLatestHash },
      ],
      writes: [
        {
          type: 'put',
          path: revisionPath,
          content: serialized,
          expectedHash: null,
        },
        {
          type: 'put',
          path: latestPath,
          content: serialized,
          expectedHash: expectedLatestHash,
        },
      ],
    });
    return revisionPath;
  }

  get(eventId: string, revisionId: string): SceneRevisionEnvelopeV1 {
    const revisionPath = this.revisionPath(eventId, revisionId);
    const content = this.coordinator.storage.readOptional(revisionPath);
    if (content === null) {
      throw new EditorialOperationError('REVISION_NOT_FOUND', `Scene revision not found: ${revisionId}`, {
        eventId,
        path: revisionPath,
      });
    }
    return this.parseEnvelope(content, revisionPath, eventId);
  }

  getLatest(eventId: string): SceneRevisionEnvelopeV1 | null {
    const latestPath = this.latestPath(eventId);
    const content = this.coordinator.storage.readOptional(latestPath);
    return content === null ? null : this.parseEnvelope(content, latestPath, eventId);
  }

  latestHash(eventId: string): string | null {
    return computeFileHash(this.coordinator.storage, this.latestPath(eventId));
  }

  list(eventId: string): SceneRevisionEnvelopeV1[] {
    const eventDir = path.join(this.paths.sceneRevisionsDir, eventId);
    if (!this.coordinator.storage.exists(eventDir)) return [];
    return this.coordinator.storage
      .listFiles(eventDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const revisionPath = path.join(eventDir, name);
        return this.parseEnvelope(this.coordinator.storage.read(revisionPath), revisionPath, eventId);
      })
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.revisionId.localeCompare(right.revisionId),
      );
  }

  private validateEnvelope(envelope: SceneRevisionEnvelopeV1): SceneRevisionEnvelopeV1 {
    const parsed = sceneRevisionEnvelopeV1Schema.parse(envelope) as SceneRevisionEnvelopeV1;
    if (computeContentHash(parsed.prose) !== parsed.proseHash) {
      throw new ConfigError(`Scene revision ${parsed.revisionId} proseHash does not match prose`, {
        eventId: parsed.eventId,
        phase: 'scene_revision',
      });
    }
    const accepted = parsed.releaseDecision.status === 'accepted';
    if (parsed.released !== accepted || (accepted && parsed.analysis === null)) {
      throw new ConfigError(`Scene revision ${parsed.revisionId} release fields are inconsistent`, {
        eventId: parsed.eventId,
        phase: 'scene_revision',
      });
    }
    return parsed;
  }

  private parseEnvelope(content: string, revisionPath: string, eventId: string): SceneRevisionEnvelopeV1 {
    try {
      return this.validateEnvelope(JSON.parse(content) as SceneRevisionEnvelopeV1);
    } catch (error) {
      if (error instanceof EditorialOperationError) throw error;
      throw new ConfigError(`Invalid scene revision at ${revisionPath}: ${(error as Error).message}`, {
        eventId,
        path: revisionPath,
        phase: 'scene_revision',
      });
    }
  }
}
