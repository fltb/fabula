// Editorial public contracts and workspace persistence primitives.

export {
  branchPathV1Schema,
  branchSetV1Schema,
  editorialErrorSchema,
  editorialMutationContextSchema,
  editorialOperationV1Schema,
  editorialPreviewRequestV1Schema,
  editorialRenderRequestV1Schema,
  editorialScopedRequestV1Schema,
  renderGameDialogueTreeRequestV1Schema,
  sceneMetadataV1Schema,
  sceneRevisionEnvelopeV1Schema,
  sceneSelectorSchema,
  sourceChangePreviewV1Schema,
  sourceChangeSetV1Schema,
  sourceDocumentChangeSchema,
  sourceHeadV1Schema,
  sourceRevisionV1Schema,
  transactionReadExpectationSchema,
} from '../schemas/editorial.ts';
// Versioned editorial DTOs and schemas are part of the root-safe contract.
export type * from '../types/editorial.ts';
export type {
  BranchContracts,
  CompiledSceneInfo,
  CompiledSceneState,
  EditorialCompileInput,
  EditorialCompileJob,
  EditorialCompileOutput,
  RevisionPreflightError,
} from './compiler.ts';
export {
  compileBranchContracts,
  compileEditorialRun,
  compileReadSet,
  preflightRevision,
} from './compiler.ts';
export {
  EditorialOperationError,
  PublicationError,
  toEditorialError,
} from './errors.ts';
export {
  adoptSceneProse,
  applySourceChange,
  assembleCanonicalNovel,
  assembleCustomNovel,
  getEditorialOperation,
  getEditorialWorkspace,
  getSceneRevision,
  getSourceDocument,
  getSourceRevision,
  inspectScenes,
  listEditorialOperations,
  listSceneRevisions,
  listSourceDocuments,
  listSourceRevisions,
  previewSourceChange,
  reconcileSourceWorkingCopy,
  rollbackSceneRevision,
  setSceneLock,
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
export { OperationStore } from './operation-store.ts';
export type { OverlayDocument } from './overlay-storage.ts';
export { OverlayStorage } from './overlay-storage.ts';
export type { ProjectPaths } from './paths.ts';
export { resolveProjectPaths } from './paths.ts';
export type {
  PromoteCandidateInput,
  PublishOptions,
  PublishScope,
  ScopeEventData,
  VerifiedHeadData,
} from './publisher.ts';
// Transaction‑aware publisher for scene promotions
export {
  buildNovelDocument,
  buildSceneMetadataV1,
  collectDerivedData,
  EditorialPublisher,
  envelopeToVerifiedHead,
} from './publisher.ts';
export type { PreviewResult } from './render-service.ts';
export {
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
export { SceneRevisionStore } from './scene-store.ts';
export type { CatalogEntry, SceneCatalog, SelectorPreflightResult } from './selector.ts';
// Pure compiler — selector preflight, identity computation, plan compilation
export { preflightSelector } from './selector.ts';
export { SourceRevisionStore } from './source-store.ts';
export { SourceWorkspace } from './source-workspace.ts';
export type { ProjectTransactionInput } from './transaction.ts';
export { ProjectTransactionCoordinator, stableJson } from './transaction.ts';
