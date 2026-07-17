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
  RuleEffectEntry,
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
  KnowledgeDefinition,
  KnowledgeEvent,
  KnowledgeEventType,
} from './knowledge.js';

export type {
  RelationshipDefinition,
  RelationshipEvent,
  RelationshipEventType,
} from './relationship.js';

export type {
  LocationDefinition,
  ItemDefinition,
} from './location.js';

export type {
  RuleDefinition,
  LogicalConsequence,
} from './rule.js';

export type {
  PluginManifest,
  ArbitrationStrategy,
} from './plugin.js';

export type {
  ValidatorContext,
  ValidationIssue,
  Validator,
  ValidationResult,
} from './validator.js';

export type {
  AnalysisResult,
  AnalysisContent,
  PostconditionAnalysis,
  PreconditionAnalysis,
  POVAnalysis,
  InventedDetail,
  QualityAnalysis,
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
  ScribeOutput,
} from './context.js';

export type {
  ReviewComment,
  ReviewPatch,
  PatchChange,
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
