// Editorial — pure source analysis and semantic execution contracts.
// Published as `@novalistically/core/editorial`.

export { previewEditorialRun, renderGameDialogueTree, renderNovel } from './api.ts';
export { assembleRelease } from './assembler/release-assembly.ts';
export { compileGameDialogueTree } from './branch/game-dialogue-tree.ts';
export { branchPathsEqual } from './branch/path.ts';
export type {
  ProjectSourceSnapshotV1,
  SourceAnalysisV1,
  SourceChangeV1,
  SourceDocumentV1,
} from './contracts/source.ts';
export {
  getEditorialOperation,
  getSceneRevision,
  getSourceDocument,
  listSourceDocuments,
  previewSourceChange,
} from './editorial/facade.ts';
export type {
  ReleaseGateResolutionV1,
  ResolveReleaseGateInputV1,
} from './editorial/release-gate.ts';
export { resolveReleaseGate } from './editorial/release-gate.ts';
export type {
  EditorialCandidateSetV1,
  EditorialCandidatesOutcome,
  EditorialCommitResultV1,
  EditorialHeadCommitOutcomeV1,
  EditorialSceneCommitV1,
} from './editorial/render-service.ts';
export {
  commitEditorialCandidates,
  executeEditorialCandidates,
} from './editorial/render-service.ts';
export {
  addReviewComment,
  listReviewComments,
  replaceReviewComment,
  updateReviewComment,
} from './editorial/review-facade.ts';
export { TypedEventBus } from './event-bus.ts';
export type {
  EvaluateReleaseDecisionOptions,
  ReleaseGateIdentityContext,
} from './pipeline/release-decision.ts';
export {
  computeReleaseGateId,
  computeWarningFingerprint,
} from './pipeline/release-decision.ts';
export type { CommentFilter } from './review/types.ts';
export {
  branchPathV1Schema,
  branchSetV1Schema,
  editorialErrorSchema,
  editorialMutationContextSchema,
  editorialOperationV1Schema,
  editorialPreviewRequestV1Schema,
  editorialProgressEventV1Schema,
  editorialRenderRequestV1Schema,
  renderGameDialogueTreeRequestV1Schema,
  sceneMetadataV1Schema,
  sceneRevisionEnvelopeV1Schema,
  sceneSelectorSchema,
  sourceChangePreviewV1Schema,
  sourceChangeSetV1Schema,
  sourceDocumentChangeSchema,
} from './schemas/editorial.ts';
export {
  newReviewCommentSchema,
  reviewApplicationV1Schema,
  reviewCommentSchema,
  reviewLedgerV1Schema,
} from './schemas/review.ts';
export type {
  AssembleReleaseFailureV1,
  AssembleReleaseOutcomeV1,
  AssembleReleaseResultV1,
  AssembleRequestV1,
  EditorialAssembleResult,
  EditorialError,
  EditorialErrorCode,
  EditorialMutationContext,
  EditorialOperationKind,
  EditorialOperationStatus,
  EditorialOperationV1,
  EditorialPlanSummaryV1,
  EditorialProgressEventV1,
  EditorialRenderRequestV1,
  EditorialRuntime,
  PublicationResult,
  RenderGameDialogueTreeRequestV1,
  RenderGameDialogueTreeResult,
  RenderNovelResult,
  RenderNovelSceneResult,
  RevisionRequest,
  SceneActionResult,
  SceneDisposition,
  SceneInspection,
  SceneMetadataV1,
  SceneProseInput,
  SceneRevisionEnvelopeV1,
  SceneRevisionSummary,
  SceneSelector,
} from './types/editorial.ts';
export type { ReleasePolicy, ReleaseWarningPolicy } from './types/render-surface.ts';
export type {
  NewReviewComment,
  ReviewApplicationV1,
  ReviewComment,
  ReviewLedgerV1,
} from './types/review.ts';
