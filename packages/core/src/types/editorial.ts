import type { CompletionResponse, LLMProvider, Message } from '../ai/types.ts';
import type { ProjectSourceSnapshotV1 } from '../contracts/source.ts';
import type { TypedEventBus } from '../event-bus.ts';
import type { CoreRuntimeServices } from '../ports/runtime-services.ts';
import type { ProjectReferencePacketV1 } from '../reference.ts';
import type { AnalysisResult } from './analysis.ts';
import type { BranchPath, BranchSet } from './branch.ts';
import type { GameDialogueChoice } from './game-dialogue.ts';
import type { ReleaseDecision } from './render-surface.ts';
import type { ReviewComment } from './review.ts';
import type { ValidationResult } from './validator.ts';

export type SceneProseSource = 'llm' | 'human_edited' | 'human_locked';
export type SceneRevisionOrigin = 'llm_draft' | 'llm_revision' | 'human_edit' | 'rollback';
export type TokenUsage = CompletionResponse['usage'];

export interface ProviderCallLedgerEntryV1 {
  phase: 'pass1' | 'pass2' | 'pass2_verify';
  attempt: number;
  outcome: 'success' | 'failure';
  requestHash: string;
  model: string;
  seed: number | null;
  failureReason?: string;
}

export interface RenderRequestRecordV1 {
  phase: 'pass1' | 'pass2';
  attempt: number;
  requestHash: string;
  messages: readonly Message[];
  responseContent?: string | null;
}

export interface SceneRevisionEnvelopeV1 {
  version: 1;
  revisionId: string;
  parentRevisionId: string | null;
  restoredFromRevisionId?: string;
  operationId: string;
  planHash: string;
  actorId: string;
  eventId: string;
  origin: SceneRevisionOrigin;
  prose: string;
  proseHash: string;
  sceneHash: string;
  editorialBasisHash: string;
  scopeHash: string;
  validationIdentity: string;
  modelUsed?: string;
  feedbackHash: string | null;
  reviewIds: string[];
  analysis: AnalysisResult | null;
  validation: ValidationResult | null;
  releaseDecision: ReleaseDecision;
  released: boolean;
  cacheHit: boolean;
  errors: string[];
  llmPass1: TokenUsage;
  llmPass2: TokenUsage | null;
  attempts: number;
  needsReview: boolean;
  promptHash: string;
  pass2Rejection?: 'empty' | 'parse' | 'validation';
  providerCalls: ProviderCallLedgerEntryV1[];
  promotionReadSet: readonly unknown[];
  requestRecords: RenderRequestRecordV1[];
  createdAt: string;
}

export interface SceneEditHistoryEntryV1 {
  action: 'llm_generated' | 'llm_revised' | 'human_adopted' | 'locked' | 'unlocked' | 'rollback';
  actor_id: string;
  operation_id: string;
  timestamp: string;
  note?: string;
  revision_id?: string;
  review_ids?: string[];
}

export interface SceneMetadataV1 {
  schema_version: 1;
  event: string;
  narrative_order: number;
  revision_id: string;
  prose_source: SceneProseSource;
  prose_hash: string;
  scene_hash: string;
  editorial_basis_hash: string;
  scope_hash: string;
  validation_identity: string;
  model_used?: string;
  rendered_at: string;
  word_count: number;
  text_count_version: number;
  edit_history: SceneEditHistoryEntryV1[];
  branch_existence: BranchSet;
  player_choices?: GameDialogueChoice[];
}

export interface PublicationManifestV1 {
  version: 1;
  status: 'current' | 'stale';
  branch_scope_hash: string;
  novel_hash: string | null;
  revision_ids: Record<string, string>;
  last_assembled_at: string | null;
  active_operation_id?: string;
  reasons: EditorialError[];
}

export interface EditorialMutationContext {
  operationId: string;
  actorId: string;
}

export type SceneSelector =
  | { type: 'events'; eventIds: readonly string[] }
  | { type: 'chapter'; chapter: number }
  | { type: 'all' };

export interface RevisionRequest {
  reviewIds?: readonly string[];
  instruction?: string;
}

export interface ProviderFactory {
  readonly profile: string;
  create(): Promise<LLMProvider>;
}

export interface EditorialRuntime {
  services?: CoreRuntimeServices;
  provider?: LLMProvider;
  providerFactory?: ProviderFactory;
  signal?: AbortSignal;
  eventBus?: TypedEventBus;
  trace?: boolean;
  concurrency?: number;
}

export interface EditorialRenderRequestV1 {
  version: 1;
  source: ProjectSourceSnapshotV1;
  selector?: SceneSelector;
  revision?: RevisionRequest;
  mutation: EditorialMutationContext;
  model?: string;
  providerProfile?: string;
  branchPath?: BranchPath;
  discourseBranch?: string;
  waivers?: readonly WaiverRecordV1[];
  batch?: { batchSize?: number; windowSize?: number; failFast?: boolean };
  maxRounds?: number;
  /** Explicit, bounded, non-authoritative citations for Pass 1 only. */
  referencePacket?: ProjectReferencePacketV1;
}
export type RenderGameDialogueTreeRequestV1 = Omit<
  EditorialRenderRequestV1,
  'selector' | 'revision' | 'branchPath' | 'discourseBranch'
>;

export interface WaiverRecordV1 {
  gateId: string;
  signedBy: string;
  signedAt: string;
  reason: string;
}

export type EditorialErrorCode =
  | 'INVALID_OPERATION'
  | 'OPERATION_IN_PROGRESS'
  | 'OPERATION_INTERRUPTED'
  | 'OPERATION_CANCELLED'
  | 'PROVIDER_REQUIRED'
  | 'SOURCE_DOCUMENT_NOT_FOUND'
  | 'SOURCE_CHANGED'
  | 'REVIEW_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'STORAGE_CONFLICT'
  | 'INVALID_SELECTOR'
  | 'SCENE_NOT_FOUND'
  | 'SCENE_NOT_IN_BRANCH'
  | 'INVALID_REVIEW_SELECTION'
  | 'NO_ACCEPTED_BASE'
  | 'NO_OPEN_FEEDBACK'
  | 'SCENE_LOCKED'
  | 'SCENE_LOCK_STALE'
  | 'SCENE_CONTENT_CONFLICT'
  | 'PUBLICATION_CONTENT_CONFLICT'
  | 'REVISION_BLOCKED'
  | 'REVISION_STALE'
  | 'PUBLICATION_INCOMPLETE'
  | 'REFERENCE_PROJECT_MISMATCH'
  | 'INVALID_SOURCE_CHANGE';

export interface EditorialError {
  code: EditorialErrorCode;
  message: string;
  eventId?: string;
  path?: string;
  operationId?: string;
}

export type SceneDisposition =
  | 'candidate_promoted'
  | 'candidate_blocked'
  | 'candidate_pending_waiver'
  | 'candidate_stale'
  | 'head_reused'
  | 'locked_reused'
  | 'no_revision_needed'
  | 'skipped_by_lock'
  | 'preflight_failed'
  | 'cancelled';

export interface RenderNovelSceneResult {
  eventId: string;
  prose: string;
  wordCount: number;
  cacheHit: boolean;
  released: boolean;
  revisionId: string | null;
  promoted: boolean;
  locked: boolean;
  disposition: SceneDisposition;
  releaseDecision: ReleaseDecision | null;
  analysis: AnalysisResult | null;
  validationErrors: number;
  validationIssueMessages: string[];
  providerCalls: ProviderCallLedgerEntryV1[];
  promptHash: string;
  pass2Rejection?: string;
  errors: string[];
  editorialErrors: EditorialError[];
}

export interface PublicationResult {
  status: 'current' | 'stale' | 'unchanged';
  outputPath: string;
  novelHash: string | null;
  reasons: EditorialError[];
}

export interface RenderNovelResult {
  operationId: string;
  results: RenderNovelSceneResult[];
  errors: string[];
  editorialErrors: EditorialError[];
  publication: PublicationResult;
}

export interface RenderGameDialogueTreeResult {
  operationId: string;
  tree: {
    eventScopes: Record<string, BranchSet>;
    representativePathByEventId: Record<string, BranchPath>;
    choicesByEventId: Record<string, GameDialogueChoice[]>;
  };
  results: RenderNovelSceneResult[];
  errors: string[];
  editorialErrors: EditorialError[];
  dialogueTree?: string;
  outputPath?: string;
  publication: PublicationResult;
}

export type EditorialOperationKind =
  | 'render'
  | 'revise'
  | 'render_tree'
  | 'adopt_scene'
  | 'rollback_scene'
  | 'assemble'
  | 'set_scene_lock'
  | 'add_review'
  | 'replace_review'
  | 'update_review';

export type EditorialOperationStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface Clock {
  now(): number;
}

export interface EditorialAssembleResult {
  operationId: string;
  markdown: string;
  wordCount: number;
  sceneCount: number;
  publication: PublicationResult;
}

export interface EditorialOperationV1 {
  version: 1;
  operationId: string;
  kind: EditorialOperationKind;
  actorId: string;
  requestHash: string;
  status: EditorialOperationStatus;
  startedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  lastSequence?: number;
  completedAt?: string;
  result:
    | RenderNovelResult
    | RenderGameDialogueTreeResult
    | SceneActionResult
    | SourceChangeResultV1
    | EditorialAssembleResult
    | ReviewComment
    | null;
  errors: EditorialError[];
}

export interface EditorialProgressEventV1 {
  version: 1;
  operationId: string;
  sequence: number;
  timestamp: string;
  kind:
    | 'operation_started'
    | 'scene_started'
    | 'cache_hit'
    | 'provider_started'
    | 'candidate_archived'
    | 'scene_promoted'
    | 'publication_updated'
    | 'operation_completed'
    | 'operation_failed'
    | 'operation_cancelled';
  eventId?: string;
  phase?: 'pass1' | 'pass2' | 'promotion' | 'publication';
  completedScenes?: number;
  totalScenes?: number;
  disposition?: SceneDisposition;
}

export type SourceDocumentKind =
  | 'project'
  | 'initial_state'
  | 'character'
  | 'location'
  | 'item'
  | 'faction'
  | 'relationship'
  | 'rule'
  | 'narrator'
  | 'assertion'
  | 'discourse_ledger'
  | 'chapter'
  | 'event';

export interface SourceDocumentV1 {
  version: 1;
  path: string;
  kind: SourceDocumentKind;
  content: string;
  contentHash: string;
  parsedValue: unknown | null;
  diagnostics: EditorialError[];
}

export type SourceDocumentChange =
  | { type: 'put'; path: string; expectedHash: string | null; content: string }
  | { type: 'delete'; path: string; expectedHash: string };

export interface SourceChangeSetV1 {
  version: 1;
  expectedProjectSourceHash: string;
  changes: readonly SourceDocumentChange[];
}

export interface SourceChangePreviewV1 {
  version: 1;
  changeSet: SourceChangeSetV1;
  previewToken: string;
  documents: Array<{
    path: string;
    beforeContent: string | null;
    afterContent: string | null;
  }>;
  projectBeforeHash: string;
  projectAfterHash: string;
  affectedEventIds: string[];
  validation: { valid: boolean; errors: EditorialError[] };
}

export interface SourceChangeResultV1 {
  operationId: string;
  sourceHash: string;
  changedDocuments: Array<{ path: string; contentHash: string | null }>;
  affectedEventIds: string[];
  publication: PublicationResult;
}

export interface EditorialScopedRequestV1 {
  version: 1;
  model?: string;
  providerProfile?: string;
  branchPath?: BranchPath;
  discourseBranch?: string;
  waivers?: readonly WaiverRecordV1[];
}

export interface SceneRevisionSummary {
  revisionId: string;
  parentRevisionId: string | null;
  restoredFromRevisionId?: string;
  origin: SceneRevisionOrigin;
  actorId: string;
  proseHash: string;
  releaseStatus: ReleaseDecision['status'];
  isHead: boolean;
  createdAt: string;
}

export interface SceneInspection {
  eventId: string;
  chapter: number;
  state: 'missing' | 'current' | 'stale' | 'manual_change_untracked' | 'legacy_unverified';
  revisionId: string | null;
  proseSource: SceneProseSource | null;
  locked: boolean;
  prose: string | null;
  sceneContent: string | null;
  proseHash: string | null;
  sceneHash: string | null;
  playerChoices?: GameDialogueChoice[];
  staleReasons: EditorialError[];
  latestCandidate: { revisionId: string; status: ReleaseDecision['status'] } | null;
  openReviewCount: number;
  artifactPaths: {
    scene: string;
    metadata: string;
    latestResponse: string;
    revision: string | null;
    novel: string;
  };
}

export type SceneProseInput =
  | {
      type: 'replacement';
      prose: string;
      expectedRevisionId: string | null;
      expectedSceneHash: string | null;
    }
  | { type: 'working_copy'; expectedSceneHash: string };

export interface SceneActionResult {
  operationId: string;
  eventId: string;
  revisionId: string | null;
  proseHash: string | null;
  sceneHash: string | null;
  proseSource: SceneProseSource | null;
  locked: boolean;
  released: boolean;
  promoted: boolean;
  releaseDecision: ReleaseDecision | null;
  publication: PublicationResult;
  editorialErrors: EditorialError[];
}

export interface AssembleRequestV1 {
  version: 1;
  mutation: EditorialMutationContext;
  outputPath?: string;
  title?: string;
  language?: string;
  branchPath?: BranchPath;
  discourseBranch?: string;
}

export interface EditorialPlanSummaryV1 {
  version: 1;
  planHash: string;
  sourceHash: string;
  scopeHash: string;
  validationIdentity: string;
  selectedEventIds: string[];
  scenes: Array<{
    eventId: string;
    editorialBasisHash: string;
    state:
      | 'will_render'
      | 'cache_hit'
      | 'head_reused'
      | 'locked_reused'
      | 'no_revision_needed'
      | 'preflight_failed';
    requiresProvider: boolean;
    editorialErrors: EditorialError[];
  }>;
}

export interface EditorialWorkspaceSnapshotV1 {
  version: 1;
  sourceHash: string;
  publication: PublicationManifestV1;
  scenes: SceneInspection[];
  reviewSummary: { open: number; addressed: number; blocking: number };
  activeOperation: EditorialOperationV1 | null;
}
