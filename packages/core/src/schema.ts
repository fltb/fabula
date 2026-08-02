// ============================================================================
// @novalistically/core/schema — Zod schemas for authored project files.
// Scoped entry point: importable current surface without a compatibility
// guarantee beyond the root contract.
// ============================================================================

export { analysisResultSchema, buildAnalysisResultSchema } from './schemas/analysis.ts';
export {
  acceptedArtifactRecordSchema,
  acceptedSceneRecordSchema,
  commitResultSchema,
  commitSuccessSchema,
  layeredCacheKeySchema,
  operationRecordSchema,
  projectSourceSnapshotV1Schema,
  publicationRecordSchema,
  renderCacheRecordSchema,
  reviewRecordSchema,
  sceneRevisionRecordSchema,
  sourceAnalysisV1Schema,
  sourceChangeV1Schema,
  sourceDiagnosticV1Schema,
  sourceDocumentV1Schema,
  sourceParseResultV1Schema,
  stateAppendResultSchema,
  stateAppendSuccessSchema,
  stateEventSchema,
  stateLogReadResultSchema,
  stateSnapshotRecordSchema,
  stateSnapshotWriteResultSchema,
  stateSnapshotWriteSuccessSchema,
  stateStreamKeySchema,
  stateVersionConflictSchema,
  traceRecordSchema,
  versionConflictSchema,
} from './schemas/core-contracts.js';
export { entityTypeCatalogSourceSchema } from './schemas/entity-catalog.ts';
export { eventFileSchema } from './schemas/event.ts';
export { canonicalGraphRuntimeSnapshotSchema } from './schemas/graph.ts';
export { projectConfigSchema } from './schemas/project.js';
