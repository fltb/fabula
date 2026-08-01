import * as path from 'node:path';
import YAML from 'yaml';
import { sceneMetadataV1Schema } from '../schemas/editorial.ts';
import type { Storage } from '../storage/types.ts';
import type { SceneRevisionEnvelopeV1, SceneRevisionSummary } from '../types/editorial.ts';
import type { ProjectPaths } from './paths.ts';
import { SceneRevisionStore } from './scene-store.ts';
import { ProjectTransactionCoordinator } from './transaction.ts';

/** Query-only access to immutable scene revisions. Mutations live in facade.ts. */
export class SceneService {
  private readonly store: SceneRevisionStore;

  constructor(
    private readonly storage: Storage,
    paths: ProjectPaths,
  ) {
    this.store = new SceneRevisionStore(new ProjectTransactionCoordinator(storage, paths), paths);
    this.paths = paths;
  }

  private readonly paths: ProjectPaths;

  get(eventId: string, revisionId: string): SceneRevisionEnvelopeV1 {
    return this.store.get(eventId, revisionId);
  }

  list(eventId: string): SceneRevisionSummary[] {
    const headRevisionId = this.findAcceptedHeadRevisionId(eventId);
    return this.store.list(eventId).map((revision) => ({
      revisionId: revision.revisionId,
      parentRevisionId: revision.parentRevisionId,
      ...(revision.restoredFromRevisionId
        ? { restoredFromRevisionId: revision.restoredFromRevisionId }
        : {}),
      origin: revision.origin,
      actorId: revision.actorId,
      proseHash: revision.proseHash,
      releaseStatus: revision.releaseDecision.status,
      isHead: revision.revisionId === headRevisionId,
      createdAt: revision.createdAt,
    }));
  }

  private findAcceptedHeadRevisionId(eventId: string): string | null {
    if (!this.storage.exists(this.paths.scenesDir)) return null;
    for (const chapter of this.storage.list(this.paths.scenesDir)) {
      if (!chapter.isDirectory()) continue;
      const metadataPath = path.join(this.paths.scenesDir, chapter.name, `${eventId}.yaml`);
      const raw = this.storage.readOptional(metadataPath);
      if (raw === null) continue;
      try {
        const metadata = sceneMetadataV1Schema.parse(YAML.parse(raw));
        if (metadata.event === eventId) return metadata.revision_id;
      } catch {
        // Malformed metadata cannot identify an accepted head.
      }
    }
    return null;
  }
}
