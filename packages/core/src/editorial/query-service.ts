// ============================================================================
// Editorial QueryService — read-only query facade for the editorial pipeline.
//
// Wraps EditorialWorkspace with error-safe JSON-friendly access patterns
// suitable for REST/API consumption.  Every public method catches expected
// errors and returns structured JSON-safe results.
// ============================================================================

import type { Storage } from '../storage/types.ts';
import type {
  EditorialError,
  EditorialOperationV1,
  EditorialWorkspaceSnapshotV1,
  PublicationManifestV1,
  SceneInspection,
  SourceDocumentV1,
  SourceHeadV1,
  SourceRevisionV1,
} from '../types/editorial.ts';
import type { ReviewComment } from '../types/review.ts';
import {
  type EditorialWorkspace,
  getEditorialWorkspace,
  type LegacySceneInspection,
} from './workspace.ts';

// ─── Error-safe result wrapper ─────────────────────────────────────────────

export interface QueryResult<T> {
  ok: boolean;
  data?: T;
  error?: EditorialError;
}

function ok<T>(data: T): QueryResult<T> {
  return { ok: true, data };
}

function fail(code: EditorialError['code'], message: string): QueryResult<never> {
  return { ok: false, error: { code, message } };
}

function notFound(entity: string, id: string): QueryResult<never> {
  return fail('REVISION_NOT_FOUND', `${entity} not found: ${id}`);
}

// ─── QueryService ──────────────────────────────────────────────────────────

/**
 * Read-only query service for editorial workspace data.
 *
 * Every public method is error-safe — expected errors (not found, malformed
 * data) return `QueryResult<T>` with `ok: false` and a structured error
 * rather than throwing.  Unexpected internal errors (programming mistakes)
 * still propagate.
 *
 * All results survive JSON.stringify / JSON.parse round-trips.
 */
export class QueryService {
  private readonly ws: EditorialWorkspace;

  constructor(projectDir: string, outputDir?: string, storage?: Storage) {
    this.ws = getEditorialWorkspace(projectDir, outputDir, storage);
  }

  /** Access the underlying workspace for callers that need typed results. */
  get workspace(): EditorialWorkspace {
    return this.ws;
  }

  // ── Source queries ───────────────────────────────────────────────────────

  /** List all source documents. */
  listSources(): QueryResult<SourceDocumentV1[]> {
    try {
      return ok(this.ws.listSources());
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to list sources: ${(err as Error).message}`);
    }
  }

  /** Get a single source document by relative path. */
  getSource(relPath: string): QueryResult<SourceDocumentV1> {
    try {
      const doc = this.ws.getSource(relPath);
      if (!doc) return notFound('Source document', relPath);
      return ok(doc);
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to get source: ${(err as Error).message}`);
    }
  }

  // ── Source revision queries ──────────────────────────────────────────────

  /** List all source revisions. */
  listSourceRevisions(pathFilter?: string): QueryResult<SourceRevisionV1[]> {
    try {
      return ok(this.ws.listSourceRevisions(pathFilter));
    } catch (err) {
      return fail(
        'INVALID_OPERATION',
        `Failed to list source revisions: ${(err as Error).message}`,
      );
    }
  }

  /** Get a single source revision by ID. */
  getSourceRevision(revisionId: string): QueryResult<SourceRevisionV1> {
    try {
      return ok(this.ws.getSourceRevision(revisionId));
    } catch (err) {
      const e = err as EditorialError & { code?: string };
      if (e.code === 'REVISION_NOT_FOUND') return notFound('Source revision', revisionId);
      return fail('INVALID_OPERATION', `Failed to get source revision: ${(err as Error).message}`);
    }
  }

  /** Get the current source head. */
  getSourceHead(): QueryResult<SourceHeadV1 | null> {
    try {
      return ok(this.ws.getSourceHead());
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to get source head: ${(err as Error).message}`);
    }
  }

  // ── Scene queries ────────────────────────────────────────────────────────

  /** List all scenes with full inspection data. */
  listScenes(): QueryResult<SceneInspection[]> {
    try {
      return ok(this.ws.listScenes());
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to list scenes: ${(err as Error).message}`);
    }
  }

  /** Inspect a single scene by event ID. */
  inspectScene(eventId: string): QueryResult<SceneInspection> {
    try {
      return ok(this.ws.inspectScene(eventId));
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to inspect scene: ${(err as Error).message}`);
    }
  }

  // ── Operation queries ────────────────────────────────────────────────────

  /** List all operations, sorted by startedAt. */
  listOperations(): QueryResult<EditorialOperationV1[]> {
    try {
      return ok(this.ws.listOperations());
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to list operations: ${(err as Error).message}`);
    }
  }

  /** Get a single operation by ID. */
  getOperation(operationId: string): QueryResult<EditorialOperationV1> {
    try {
      return ok(this.ws.getOperation(operationId));
    } catch (err) {
      const e = err as EditorialError & { code?: string };
      if (e.code === 'INVALID_OPERATION') return notFound('Operation', operationId);
      return fail('INVALID_OPERATION', `Failed to get operation: ${(err as Error).message}`);
    }
  }

  // ── Review queries ───────────────────────────────────────────────────────

  /** List all review comments, sorted by creation time. */
  listReviews(): QueryResult<ReviewComment[]> {
    try {
      return ok(this.ws.listReviews());
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to list reviews: ${(err as Error).message}`);
    }
  }

  /** Get a single review by ID. */
  getReview(reviewId: string): QueryResult<ReviewComment> {
    try {
      const review = this.ws.getReview(reviewId);
      if (!review) return notFound('Review', reviewId);
      return ok(review);
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to get review: ${(err as Error).message}`);
    }
  }

  // ── Publication queries ──────────────────────────────────────────────────

  /** Get the publication manifest (synthetic stale if absent). */
  getPublication(): QueryResult<PublicationManifestV1> {
    try {
      return ok(this.ws.getPublication());
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to get publication: ${(err as Error).message}`);
    }
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /** Build a full workspace snapshot. Active operation is strict-parsed. */
  snapshot(): QueryResult<EditorialWorkspaceSnapshotV1> {
    try {
      return ok(this.ws.snapshot());
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to build snapshot: ${(err as Error).message}`);
    }
  }

  // ── Legacy migration ─────────────────────────────────────────────────────

  /** Inspect a scene for legacy migration eligibility (read-only). */
  inspectLegacyScene(eventId: string): QueryResult<LegacySceneInspection> {
    try {
      return ok(this.ws.inspectLegacyScene(eventId));
    } catch (err) {
      return fail('INVALID_OPERATION', `Failed to inspect legacy scene: ${(err as Error).message}`);
    }
  }
}
