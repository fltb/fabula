// Editorial public contracts and semantic execution primitives.

export { assembleRelease } from '../assembler/release-assembly.ts';
export type {
  EvaluateReleaseDecisionOptions,
  ReleaseGateIdentityContext,
} from '../pipeline/release-decision.ts';
export {
  computeReleaseGateId,
  computeWarningFingerprint,
} from '../pipeline/release-decision.ts';
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
} from '../schemas/editorial.ts';
export type * from '../types/editorial.ts';
export type { ReleasePolicy, ReleaseWarningPolicy } from '../types/render-surface.ts';
export type {
  BranchContracts,
  CompiledSceneInfo,
  CompiledSceneState,
  EditorialCompileInput,
  EditorialCompileJob,
  EditorialCompileOutput,
  RevisionPreflightError,
} from './compiler.ts';
export { compileBranchContracts, compileEditorialRun, preflightRevision } from './compiler.ts';
export { EditorialOperationError, PublicationError, toEditorialError } from './errors.ts';
export {
  getEditorialOperation,
  getSceneRevision,
  getSourceDocument,
  listSourceDocuments,
  previewSourceChange,
} from './facade.ts';
export type { CompiledSceneIdentity, PlanHashInput, ValidationIdentityInput } from './identity.ts';
export {
  canonicalJson,
  computeEditorialBasisHash,
  computePlanHash,
  computeSceneSourceHash,
  computeScopeHash,
  computeSelectorHash,
  computeValidationIdentity,
} from './identity.ts';
export type {
  ReleaseGateResolutionV1,
  ResolveReleaseGateInputV1,
} from './release-gate.ts';
export { resolveReleaseGate } from './release-gate.ts';
export type {
  EditorialCandidateSetV1,
  EditorialCandidatesOutcome,
  EditorialCommitResultV1,
  EditorialHeadCommitOutcomeV1,
  EditorialSceneCommitV1,
} from './render-service.ts';
export {
  commitEditorialCandidates,
  executeEditorialCandidates,
  executeEditorialRender,
  executeEditorialTreeRender,
  previewEditorialRun,
} from './render-service.ts';
export {
  addReviewComment,
  listReviewComments,
  replaceReviewComment,
  updateReviewComment,
} from './review-facade.ts';
export { preflightSelector } from './selector.ts';
