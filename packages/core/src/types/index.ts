// ============================================================================
// Novalistically — Core Type Definitions — Public API
// Re-exports all types from domain-specific sibling files.
// Every existing import like `import { ... } from '../types/index.js'` keeps
// working unchanged.
// ============================================================================

export type {
  EntityId,
  EntityKind,
  Entity,
  EntityTypeRef,
  EntityRuntimeState,
  StoryTimestamp,
  AbsoluteTimestamp,
  RelativeTimestamp,
  ChapterTimestamp,
  TimeAnchor,
  FactId,
  Fact,
  FactValidity,
  EntityRegistry,
} from './entity.js';

export type {
  AttributeDefinition,
  WritePolicy,
  RequiredAt,
  EntityTypeDefinition,
  EntityDeclaration,
  EntityTypeCatalog,
  EntityDeclarationCatalog,
} from './entity-catalog.js';

export type {
  BranchPath,
  BranchSet,
  BranchPoint,
  BranchChoice,
  Condition,
  BranchPointsFile,
} from './branch.js';

export type {
  NarrativeEvent,
  ThreadProgressEntry,
  ForeshadowEntry,
  RelationshipChange,
  StyleGuidance,
  EventFile,
} from './event.js';

export type {
  KnowledgeState,
  KnowledgeEntry,
  KnowledgeSource,
  Relationship,
  RelationshipDef,
  RelationshipState,
  RelationshipEffect,
  StateTransitionRule,
  TransitionEffect,
  WorldState,
  Snapshot,
  WorldInitialState,
} from './world.js';

export type {
  CharacterDefinition,
  FactionDefinition,
  CharacterRelationshipDef,
} from './character.js';


export type {
  RelationshipDefinition,
  RelationshipEvent,
  RelationshipEventType,
  RelationshipTypeDefinition,
  RelationshipRoleDefinition,
  RelationshipId,
  EpochId,
  MembershipId,
  EpochLifecycle,
  DimensionScope,
  Membership,
  RelationshipTransaction,
  DimensionWrite,
  DimensionUnset,
  RelationshipRuntimeState,
  EpochRuntimeState,
  DimensionState,
  RelationshipIdentityTransitionGroup,
  IdentityTransitionCarryEntry,
} from './relationship.js';

export type {
  LocationDefinition,
  ItemDefinition,
} from './location.js';

export type {
  RuleDefinition,
  LogicalConsequence,
  RuleId,
  RuleEpochId,
  RuleExceptionId,
  RuleSpecificationId,
  RuleTypeDefinition,
  RuleSpecification,
  RuleConstraint,
  RuleConstraintKind,
  RuleEnforcement,
  RuleApplicableEffectiveness,
  RulePredicate,
  RuleRuntimeState,
  RuleActivation,
  RuleEffectiveness,
  RuleEvaluationRecord,
  RuleEvaluationResult,
  RuleException,
  RuleExceptionStatus,
  RuleExceptionEffect,
  RuleExceptionCondition,
  RuleTransaction,
  RuleTransactionOperation,
  RuleEffectEntry,
  RuleClass,
} from './rule.js';

export type {
  PluginManifest,
  ArbitrationStrategy,
} from './plugin.js';

export type {
  PreRenderInput,
  PostRenderInput,
  ValidatorContext,
  ValidationIssue,
  Validator,
  ValidationResult,
  AnalysisBlockRequirement,
} from './validator.js';

export type {
  AnalysisResult,
  PreconditionAnalysis,
  POVAnalysis,
  InventedDetail,
  QualityAnalysis,
  MatchLevel,
  NarrativeCheck,
  AppearanceCheck,
  CharacterReference,
  TenseDetected,
  ConflictAnalysis,
} from './analysis.js';

export type {
  RelevanceScore,
  ContextPackage,
  SystemContext,
  SceneSpecification,
  CharacterSnapshot,
  RelationshipContext,
  WorldFact,
  KnowledgeBoundary,
  ThreadStatus,
  RenderRequest,
  FinalPrompt,
} from './context.js';

export type {
  ReviewComment,
  ReviewPatch,
  PatchChange,
  Proposal,
} from './review.js';

export type {
  ISSSnapshot,
  ISSDimension,
  ISSGap,
} from './iss.js';

export type {
  StatusReport,
  ThreadSnapshot,
  Blocker,
  NextAction,
} from './status.js';

export type {
  ChapterMetadata,
  SceneMetadata,
  ProjectConfig,
} from './chapter.js';

export type {
  MergeConflict,
  MergeConflictReport,
  SceneQuality,
} from './merge.js';

// ——— STATE-4 Knowledge/Belief Types ———
export type {
  PropositionId,
  PropositionKind,
  Proposition,
  GroundedProposition,
  EpistemicProposition,
  ActProposition,
  IntensionalProposition,
  PropositionCatalog,
  ClaimGrade,
  ClaimPolarity,
  ClaimAssessment,
  SettledAssessment,
  ConflictedAssessment,
  SuspendedAssessment,
  ForgottenAssessment,
  UnsetAssessment,
  EvidenceSource,
  ClaimEvidenceRecord,
  Claim,
  EpistemicLedger,
  InformationActType,
  InformationAct,
  GroupEpistemicMode,
  GroupEpistemicQueryDefinition,
  CommonGroundRecord,
  NarrativeKnowledgeBoundary,
  EvaluationResult,
  claimKey,
} from './knowledge.js';
// ——— STATE-5 Thread Types ———
export type {
  ThreadId,
  ThreadRunId,
  ThreadLifecycle,
  GoalLifecycle,
  MilestoneLifecycle,
  GoalState,
  MilestoneState,
  TimeDomain,
  ThreadTypeDefinition,
  ThreadTypeCatalog,
  ThreadDeclaration,
  ThreadDeclarationCatalog,
  ThreadRuntimeState,
  ThreadTransaction,
  ThreadMergeStrategy,
  ThreadMergeResult,
} from './thread.js';
