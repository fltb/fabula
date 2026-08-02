import { analyzeSource } from '../entity/source-analysis.ts';
import type {
  ProjectSourceSnapshotV1,
  SourceAnalysisV1,
  SourceChangeV1,
  SourceDocumentV1,
} from '../contracts/source.ts';
import type { CoreExecutionRepository } from '../ports/execution-repository.ts';
import type {
  EditorialOperationV1,
  EditorialRuntime,
  SceneRevisionEnvelopeV1,
} from '../types/editorial.ts';
import { EditorialOperationError } from './errors.ts';

function execution(runtime?: EditorialRuntime): CoreExecutionRepository {
  const repository = runtime?.services?.execution;
  if (!repository) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'CoreExecutionRepository is required for editorial execution queries',
    );
  }
  return repository;
}

/** Return the canonical documents from an immutable source snapshot. */
export function listSourceDocuments(
  snapshot: ProjectSourceSnapshotV1,
): readonly SourceDocumentV1[] {
  return snapshot.documents;
}

/** Resolve one logical document from an immutable source snapshot. */
export function getSourceDocument(
  snapshot: ProjectSourceSnapshotV1,
  logicalPath: string,
): SourceDocumentV1 {
  const document = snapshot.documents.find((candidate) => candidate.logicalPath === logicalPath);
  if (!document) {
    throw new EditorialOperationError(
      'SOURCE_DOCUMENT_NOT_FOUND',
      `Source document not found: ${logicalPath}`,
      { path: logicalPath },
    );
  }
  return document;
}

/** Analyze a candidate source change without persistence or host access. */
export function previewSourceChange(
  snapshot: ProjectSourceSnapshotV1,
  changes: readonly SourceChangeV1[],
): SourceAnalysisV1 {
  return analyzeSource(snapshot, changes);
}

/** Read an accepted scene revision through the semantic execution repository. */
export async function getSceneRevision(
  request: { projectId: string; eventId: string; revisionId: string },
  runtime?: EditorialRuntime,
): Promise<SceneRevisionEnvelopeV1> {
  const record = await execution(runtime).readSceneRevision(request);
  if (!record) {
    throw new EditorialOperationError(
      'REVISION_NOT_FOUND',
      `Scene revision ${request.revisionId} was not found`,
      { eventId: request.eventId },
    );
  }
  return record.value.value as unknown as SceneRevisionEnvelopeV1;
}

/** Read an operation through the semantic execution repository. */
export async function getEditorialOperation(
  request: { projectId: string; operationId: string },
  runtime?: EditorialRuntime,
): Promise<EditorialOperationV1> {
  const record = await execution(runtime).readOperation(request);
  if (!record) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      `Operation ${request.operationId} was not found`,
      { operationId: request.operationId },
    );
  }
  return record.value.value as unknown as EditorialOperationV1;
}
