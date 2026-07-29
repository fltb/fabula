import * as path from 'node:path';
import { ConfigError } from '../errors.ts';
import { sourceHeadV1Schema, sourceRevisionV1Schema } from '../schemas/editorial.ts';
import { computeFileHash } from '../storage/hash.ts';
import type { SourceHeadV1, SourceRevisionV1 } from '../types/editorial.ts';
import { EditorialOperationError } from './errors.ts';
import type { ProjectPaths } from './paths.ts';
import { ProjectTransactionCoordinator, stableJson } from './transaction.ts';

export class SourceRevisionStore {
  constructor(
    private readonly coordinator: ProjectTransactionCoordinator,
    private readonly paths: ProjectPaths,
  ) {}

  revisionPath(revisionId: string): string {
    return path.join(this.paths.sourceRevisionsDir, `${revisionId}.json`);
  }

  getHead(): SourceHeadV1 | null {
    const content = this.coordinator.storage.readOptional(this.paths.sourceHeadPath);
    if (content === null) return null;
    try {
      return sourceHeadV1Schema.parse(JSON.parse(content)) as SourceHeadV1;
    } catch (error) {
      throw new ConfigError(`Invalid source head at ${this.paths.sourceHeadPath}: ${(error as Error).message}`, {
        path: this.paths.sourceHeadPath,
        phase: 'source_revision',
      });
    }
  }

  headHash(): string | null {
    return computeFileHash(this.coordinator.storage, this.paths.sourceHeadPath);
  }

  save(revision: SourceRevisionV1, head: SourceHeadV1, expectedHeadHash: string | null): void {
    const parsedRevision = sourceRevisionV1Schema.parse(revision) as SourceRevisionV1;
    const parsedHead = sourceHeadV1Schema.parse(head) as SourceHeadV1;
    if (parsedHead.revisionId !== parsedRevision.revisionId) {
      throw new ConfigError('Source head revisionId must identify the saved revision', {
        path: this.paths.sourceHeadPath,
        phase: 'source_revision',
      });
    }
    const revisionPath = this.revisionPath(parsedRevision.revisionId);
    this.coordinator.commit({
      readSet: [
        { kind: 'file', path: revisionPath, expectedHash: null },
        { kind: 'file', path: this.paths.sourceHeadPath, expectedHash: expectedHeadHash },
      ],
      writes: [
        { type: 'put', path: revisionPath, content: stableJson(parsedRevision), expectedHash: null },
        {
          type: 'put',
          path: this.paths.sourceHeadPath,
          content: stableJson(parsedHead),
          expectedHash: expectedHeadHash,
        },
      ],
    });
  }

  get(revisionId: string): SourceRevisionV1 {
    const revisionPath = this.revisionPath(revisionId);
    const content = this.coordinator.storage.readOptional(revisionPath);
    if (content === null) {
      throw new EditorialOperationError('REVISION_NOT_FOUND', `Source revision not found: ${revisionId}`, {
        path: revisionPath,
      });
    }
    return this.parseRevision(content, revisionPath);
  }

  list(pathFilter?: string): SourceRevisionV1[] {
    if (!this.coordinator.storage.exists(this.paths.sourceRevisionsDir)) return [];
    return this.coordinator.storage
      .listFiles(this.paths.sourceRevisionsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const revisionPath = path.join(this.paths.sourceRevisionsDir, name);
        return this.parseRevision(this.coordinator.storage.read(revisionPath), revisionPath);
      })
      .filter(
        (revision) =>
          pathFilter === undefined || revision.documents.some((document) => document.path === pathFilter),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.revisionId.localeCompare(right.revisionId),
      );
  }

  private parseRevision(content: string, revisionPath: string): SourceRevisionV1 {
    try {
      return sourceRevisionV1Schema.parse(JSON.parse(content)) as SourceRevisionV1;
    } catch (error) {
      throw new ConfigError(`Invalid source revision at ${revisionPath}: ${(error as Error).message}`, {
        path: revisionPath,
        phase: 'source_revision',
      });
    }
  }
}
