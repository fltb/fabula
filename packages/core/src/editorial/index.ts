// Editorial public contracts and semantic execution primitives.

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
export {
  addReviewComment,
  listReviewComments,
  replaceReviewComment,
  updateReviewComment,
} from './review-facade.ts';
export { executeEditorialRender, executeEditorialTreeRender, previewEditorialRun } from './render-service.ts';
export { preflightSelector } from './selector.ts';
