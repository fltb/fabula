// ============================================================================
// Novalistically — Core Type Definitions — Public API
// Re-exports all types from domain-specific sibling files.
// Every existing import like `import { ... } from '../types/index.js'` keeps
// working unchanged.
// ============================================================================

export type {
  AnalysisResult,
  AppearanceCheck,
  CharacterReference,
  ChecklistResult,
  ConflictAnalysis,
  InventedDetail,
  MatchLevel,
  NarrativeCheck,
  POVAnalysis,
  PreconditionAnalysis,
  QualityAnalysis,
  TenseDetected,
} from './analysis.js';
export type {
  BranchChoice,
  BranchPath,
  BranchPoint,
  BranchPointsFile,
  BranchSet,
  Condition,
} from './branch.js';
export type {
  GameDialogueChoice,
  GameDialogueEffect,
} from './game-dialogue.js';
export type {
  ChapterMetadata,
  ProjectConfig,
} from './chapter.js';
export type {
  CharacterDefinition,
  CharacterRelationshipDef,
  FactionDefinition,
} from './character.js';
export type {
  CharacterSnapshot,
  ContextPackage,
  KnowledgeBoundary,
  RelationshipContext,
  RelevanceScore,
  SceneSpecification,
  SystemContext,
  ThreadStatus,
  WorldFact,
} from './context.js';
// ——— CORPUS-1: NarrativeEllipsis & NarrativeNode ———
export type {
  EllipsisProvenance,
  NarrativeEllipsis as CorpusEllipsis,
  NarrativeEllipsisFile,
  NarrativeNode as CorpusNode,
} from './corpus.js';
export type {
  Anachrony,
  AnachronyFunction,
  AnachronyScope,
  AnachronyType,
  DiegeticRelation,
  NarrativeLevel,
  VoiceProfile,
} from './discourse.js';
// ——— S6: Genette Base Narratology Types ———
export type {
  DurationProfile,
  DurationType,
} from './duration.js';
export type {
  AbsoluteTimestamp,
  AuthoredLocatableStoryTime,
  AuthoredStoryTime,
  ChapterTimestamp,
  Entity,
  EntityId,
  EntityKind,
  EntityRegistry,
  EntityRuntimeState,
  EntityTypeRef,
  Fact,
  FactId,
  FactValidity,
  IndeterminateTimestamp,
  InitialStoryCoordinate,
  LocatableStoryTimestamp,
  PointStoryCoordinate,
  RelativeTimestamp,
  SceneStoryCoordinate,
  StoryCoordinate,
  StoryOffsetTimestamp,
  StoryTimestamp,
  TemporalOrder,
  TimeAnchor,
  TimeUnit,
  UnlocatedStoryCoordinate,
} from './entity.js';
export type {
  AttributeDefinition,
  EntityDeclaration,
  EntityDeclarationCatalog,
  EntityTypeCatalog,
  EntityTypeDefinition,
  RequiredAt,
  WritePolicy,
} from './entity-catalog.js';
export type {
  EventFile,
  ForeshadowEntry,
  NarrativeEvent,
  RelationshipChange,
  StyleGuidance,
  ThreadProgressEntry,
} from './event.js';
export type {
  FrequencyProfile,
  FrequencyType,
} from './frequency.js';
// ——— GRAPH-1: Typed Causal Graph Types ———
export type {
  AmbiguousOutputError,
  AssertionMismatchError,
  BranchCoverageError,
  BranchIncompatibilityError,
  CrossClockEdgeError,
  DiscourseCoordinate,
  DiscourseGraph,
  DiscourseSceneSequenceEntry,
  DuplicateBranchProviderError,
  DuplicateDiscoursePositionError,
  DynamicLifecycleError,
  EdgeClass,
  EdgeOriginCycleError,
  EffectiveCoordinate,
  EllipsisSummaryError,
  FutureTimeError,
  GraphAbsenceWitness,
  GraphBoundaryReference,
  GraphCacheEntry,
  GraphCompileError,
  GraphCompilerOptions,
  GraphCompilerResult,
  GraphEdge,
  GraphErrorContext,
  GraphNarrativeEllipsis,
  GraphProviderOutput,
  GraphReadResolution,
  InitialRootMisuseError,
  InvalidSameCoordinateOrderError,
  MergeInputError,
  MissingOutputError,
  NoOutputEdgeError,
  OutputDescriptor,
  OutputValue,
  PresencePredicate,
  ProvenanceError,
  ReadMismatchError,
  ReadOrigin,
  ReadPhase,
  ReadRequirement,
  SelfPredecessorError,
  SemanticOutputDependencyError,
  StaleProviderSelectionError,
  StoryGraph,
  UnknownPredecessorError,
  UnknownReadIdError,
  UnorderedStoryConflictError,
} from './graph.js';
export type {
  GreyLine,
  GreyLineNode,
} from './grey-line.js';
// ——— S7: Upper IR Types ———
export type {
  EmotionalArcDefinition,
  IdeaIR,
  ThematicIntent,
} from './idea-ir.js';
export type {
  ISSDimension,
  ISSGap,
  ISSSnapshot,
} from './iss.js';
// ——— STATE-4 Knowledge/Belief Types ———
export type {
  ActProposition,
  Claim,
  ClaimAssessment,
  ClaimEvidenceRecord,
  ClaimGrade,
  ClaimPolarity,
  CommonGroundRecord,
  ConflictedAssessment,
  claimKey,
  EpistemicLedger,
  EpistemicProposition,
  EvaluationResult,
  EvidenceSource,
  ForgottenAssessment,
  GroundedProposition,
  GroupEpistemicMode,
  GroupEpistemicQueryDefinition,
  InformationAct,
  InformationActType,
  IntensionalProposition,
  NarrativeKnowledgeBoundary,
  Proposition,
  PropositionCatalog,
  PropositionId,
  PropositionKind,
  SettledAssessment,
  SuspendedAssessment,
  UnsetAssessment,
} from './knowledge.js';
export type {
  ItemDefinition,
  LocationDefinition,
} from './location.js';
export type {
  MergeConflict,
  MergeConflictReport,
  SceneQuality,
} from './merge.js';
// ——— Narrative Technique Contracts ———
export type {
  AbsentApparatus,
  CausalDiscontinuity,
  CausalMultiplicity,
  IrresolvableIndeterminacy,
  MetanarrativeLevel,
  Multiplicity,
  NarrativeTechniqueKind,
  ResolvedNarrativeTechniqueContract,
  SurfaceMode,
  VoiceDissonance,
} from './narrative-techniques.js';
export {
  NARRATIVE_TECHNIQUE_KINDS,
} from './narrative-techniques.js';
export type {
  NarrativeChecklist,
  NarrativeChecklistItem,
} from './narrative-checklist.js';
export type {
  ArbitrationStrategy,
  PluginManifest,
} from './plugin.js';
export type {
  DimensionScope,
  DimensionState,
  DimensionUnset,
  DimensionWrite,
  EpochId,
  EpochLifecycle,
  EpochRuntimeState,
  IdentityTransitionCarryEntry,
  Membership,
  MembershipId,
  RelationshipDefinition,
  RelationshipEvent,
  RelationshipEventType,
  RelationshipId,
  RelationshipIdentityTransitionGroup,
  RelationshipRoleDefinition,
  RelationshipRuntimeState,
  RelationshipTransaction,
  RelationshipTypeDefinition,
} from './relationship.js';
export type {
  NewReviewComment,
  PatchChange,
  ReviewApplicationV1,
  ReviewComment,
  ReviewLedgerV1,
  ReviewPatch,
} from './review.js';
export type {
  LogicalConsequence,
  RuleActivation,
  RuleApplicableEffectiveness,
  RuleClass,
  RuleConstraint,
  RuleConstraintKind,
  RuleDefinition,
  RuleEffectEntry,
  RuleEffectiveness,
  RuleEnforcement,
  RuleEpochId,
  RuleEvaluationRecord,
  RuleEvaluationResult,
  RuleException,
  RuleExceptionCondition,
  RuleExceptionEffect,
  RuleExceptionId,
  RuleExceptionStatus,
  RuleId,
  RulePredicate,
  RuleRuntimeState,
  RuleSpecification,
  RuleSpecificationId,
  RuleTransaction,
  RuleTransactionOperation,
  RuleTypeDefinition,
} from './rule.js';
// ——— S4: Source Context Types ———
export type {
  SourceContext,
  SourceContextEntry,
} from './source-context.js';
export type {
  Blocker,
  NextAction,
  StatusReport,
  ThreadSnapshot,
} from './status.js';
export type {
  ActantModel,
  StoryArchetype,
  StructuralFunction,
} from './story-ir.js';
// ——— STATE-5 Thread Types ———
export type {
  GoalLifecycle,
  GoalState,
  MilestoneLifecycle,
  MilestoneState,
  ThreadDeclaration,
  ThreadDeclarationCatalog,
  ThreadId,
  ThreadLifecycle,
  ThreadMergeResult,
  ThreadMergeStrategy,
  ThreadRunId,
  ThreadRuntimeState,
  ThreadTransaction,
  ThreadTypeCatalog,
  ThreadTypeDefinition,
  TimeDomain,
} from './thread.js';
export type {
  AnalysisBlockRequirement,
  PostRenderInput,
  PreRenderInput,
  StoryValidationContext,
  ValidationIssue,
  ValidationResult,
  ValidationRunOptions,
  Validator,
  ValidatorContext,
} from './validator.js';
// ——— S8 removed (design incompatible with Novel IR) ———
// NarrativePlannerMode, NarrativeGoal, ActionDefinition types deleted 2026-07-24.
// Correct direction: standalone YAML editor module, not forward planner.
export type {
  Relationship,
  RelationshipDef,
  RelationshipEffect,
  RelationshipState,
  Snapshot,
  WorldInitialState,
  WorldState,
} from './world.js';

// The above are aliased to avoid conflict with INTEGRATION-1 NarrativeEllipsis/NarrativeNode.
// CORPUS-1 types supersede the integration.ts stubs and should be used for all new code.

// ——— CAPABILITY-1: Capability Manifest types ———
export type {
  CapabilityManifest,
  CapabilityManifestEntry,
  CapabilityStatus,
  EvidenceClass,
  StageGate,
} from './capability.js';
// ——— DISCOURSE-1: Discourse State & Narrator types ———
export type {
  AssertionEvidence,
  AssertionPolarity,
  AssertionType,
  AudienceSemantics,
  ClaimAction,
  CorrectionAction,
  DisclosureAction,
  DisclosureActionType,
  DisclosureObservation,
  DiscourseCacheKey,
  DiscourseContextProjection,
  DiscoursePosition,
  DiscourseState,
  ExcerptDisclosureCheckpoint,
  ExplicitLedgerProfile,
  FocalizerBoundProfile,
  FullWorkContext,
  Hint,
  HintAction,
  HintState,
  InitialExposureContract,
  ModelReaderProfile,
  ModelReaderProfileId,
  NarrationBoundary,
  NarrationDisclosurePolicy,
  NarratorAccess,
  NarratorAssertion,
  NarratorAssertionCapability,
  NarratorFidelity,
  NarratorProfile,
  NarratorProfileBase,
  NarratorProfileType,
  NarratorSincerity,
  NarratorTruthCapability,
  OmniscientProfile,
  PlannedDiscourseLedger,
  PlannedDiscourseLedgerSource,
  PlannedLedgerEntry,
  RetractionAction,
  RetrospectiveEntityProfile,
  RevealAction,
  SparseCorpusMode,
  SparseRunDeclaration,
  TruthBoundary,
  ValidationKey,
  WithholdEndAction,
  WithholdingPolicy,
  WithholdStartAction,
} from './discourse.js';
// ——— INTEGRATION-1: Cross-domain resolution, Merge & dual coverage ———
export type {
  AbsenceBasis,
  AbsenceWitness,
  BoundaryReference,
  CoverageManifest,
  DiscourseBridge,
  DiscourseNode,
  DiscourseSnapshot,
  MergePlan,
  MergePolicy,
  NarrativeEllipsis,
  NarrativeNode,
  ProviderOutput,
  ReadResolution,
  ScenePresentation,
  StorySnapshot,
} from './integration.js';
// ——— INTEGRATION-2: ReferenceEligibility & lifecycle closure ———
export type {
  ReferenceEntry,
  ReferenceIndex,
  ReferenceKind,
  ReferenceMode,
} from './reference.js';
export type {
  AcceptedSceneArtifact,
  AttemptKey,
  AutoGroupConfig,
  CompiledSceneContract,
  ContinuityPacket,
  LogicalRenderKey,
  PlannerMode,
  ReleaseDecision,
  RevisionContext,
  RenderGroup,
  RenderGroupManifest,
  RenderSurfaceAutoConfig,
  RenderSurfaceConfig,
  RenderSurfaceExtraction,
  RenderSurfaceGroup,
  RenderSurfaceLane,
  SceneTransition,
  SerialLane,
  StyleMetrics,
  StyleProfile,
  StyleResolutionPath,
  SurfaceDependencyGraph,
  SurfaceErrorCode,
  SurfacePlanProposal,
  SurfacePlannerError,
  SurfacePlannerOptions,
  SurfacePlanResult,
  SurfacePolicy,
  SurfaceReferencePacket,
  SurfaceRenderKey,
  SurfaceValidationKey,
  ValidationGate,
  ValidationGateGraph,
  ValidationGateStatus,
  ValidationPolicy,
} from './render-surface.js';
// ——— EDITORIAL: shared types (type-only re-export, never imported by pipeline modules) ———
export type { ProviderFactory } from './editorial.js';
// ——— SUMMARY: Volume Summary types ———
export type {
  ChapterMeta,
  SceneMeta,
  VolumeSummary,
} from './summary.js';
