// ============================================================================
// Novalistically — Narrative Event & Event File Types
// ============================================================================

import type { EntityId, StoryTimestamp, Fact } from './entity.js';
import type { BranchSet } from './branch.js';
import type { RelationshipTransaction, DimensionWrite, DimensionUnset, Membership, RelationshipId, EpochId, MembershipId, EpochLifecycle, DimensionScope, RelationshipRuntimeState, EpochRuntimeState, DimensionState } from './relationship.js';
import type { ThreadTransaction, ThreadId, ThreadRunId, ThreadLifecycle, GoalLifecycle, MilestoneLifecycle, GoalState, MilestoneState, TimeDomain, ThreadRuntimeState, ThreadTypeDefinition, ThreadTypeCatalog, ThreadDeclaration, ThreadDeclarationCatalog, ThreadMergeStrategy, ThreadMergeResult } from './thread.js';
import type { RuleEffectEntry, RuleTransaction } from './rule.js';

// ——— Narrative Event (§7.4.1) ———

export interface NarrativeEvent {
  id: string;
  event: string;
  narrativeOrder: number;
  title: string;
  storyTime: StoryTimestamp;
  narrationTime?: StoryTimestamp;
  sceneType: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  discourseMode?: 'action' | 'dialogue' | 'description' | 'exposition' | 'reflection' | 'transition';
  arcPosition?: 'opening' | 'rising' | 'climax' | 'falling' | 'denouement';
  emotionalValence?: string;
  conflictType?: string;
  resolutionType?: string;
  tense?: 'past' | 'present';
  pov: {
    character: EntityId;
    type: 'first_person' | 'third_person_limited' | 'omniscient';
  };
  sceneBrief: string;
  preconditions: Fact[];
  postconditions: Fact[];
  threadProgress: ThreadProgressEntry[];
  foreshadowing: ForeshadowEntry[];
  relationshipEffects: RelationshipTransaction[];
  ruleEffects: RuleEffectEntry[];
  styleGuidance?: StyleGuidance;
  source: 'genesis' | 'event_file' | 'branch_point' | 'system';
  branchExistence: BranchSet;
  participants: {
    entities: EntityId[];
  };
  /** Intended audience for this scene (affects prose style, vocabulary, complexity) */
  targetAudience?: string;  // e.g. "adult_literary", "young_adult", "middle_grade", "academic"
  /** Runtime status: authored events are 'draft' until rendered, then 'rendered' */
  status?: 'draft' | 'rendered' | 'blocked' | 'needs_review';
  /** Characters present in the scene, with semantic roles */
  cast?: {
    onScreen: string[];   // characters physically present
    affected: string[];   // characters affected by events (may be off-screen)
  };
}

export interface ThreadProgressEntry {
  thread: string;
  advancement: string;
  progressAfter: number;
  progressTotal: number;
}

export interface ForeshadowEntry {
  id: string;
  hint: string;
  targetRevealChapter: number;
  thread?: string;
}

export interface RelationshipChange {
  participants: [EntityId, EntityId];
  effect: 'establish' | 'change' | 'dissolve' | 'reinforce' | 'complicate';
  direction: string;
  newState?: {
    type: string;
    intensity: number;
  };
}

// ——— STATE-2 RelationshipTransaction (replaces RelationshipChange) ———
// RelationshipChange is kept as a backward-compat type; the EntityMapper
// converts it to RelationshipTransaction at load time.
// Binary relationships are a specialization of n-ary (2 members, role='member').

export type {
  RelationshipTransaction,
  DimensionWrite,
  DimensionUnset,
  Membership,
  RelationshipId,
  EpochId,
  MembershipId,
  EpochLifecycle,
  DimensionScope,
  RelationshipRuntimeState,
  EpochRuntimeState,
  DimensionState,
  RelationshipTypeDefinition,
  RelationshipRoleDefinition,
  RelationshipIdentityTransitionGroup,
  IdentityTransitionCarryEntry,
} from './relationship.js';
// ——— STATE-5 ThreadTransaction ———
// ThreadProgressEntry is kept as a backward-compat type; the replay engine
// converts it to ThreadTransaction at application time.
export type {
  ThreadTransaction,
  ThreadId,
  ThreadRunId,
  ThreadLifecycle,
  GoalLifecycle,
  MilestoneLifecycle,
  GoalState,
  MilestoneState,
  TimeDomain,
  ThreadRuntimeState,
  ThreadTypeDefinition,
  ThreadTypeCatalog,
  ThreadDeclaration,
  ThreadDeclarationCatalog,
  ThreadMergeStrategy,
  ThreadMergeResult,
} from './thread.js';


export interface StyleGuidance {
  tone?: string;
  characterVoice?: Record<string, string>;
  avoid?: string;
  scenePacing?: string;
  atmosphere?: string;
  targetWordCount?: number;
}

// ——— Event File (YAML on disk) ———

export interface EventFile {
  /** Event identifier, e.g. "E0", "E1" */
  event: string;
  /** Format version for migration tracking */
  formatVersion?: number;
  /** Narrative order within the story */
  narrativeOrder: number;
  /** Human-readable title */
  title: string;
  /** Story timestamp (references a time anchor) */
  storyTime: string;
  /** Narration timestamp (when the story is being told) */
  narrationTime?: string;
  /** Scene type */
  sceneType?: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  /** Discourse mode */
  discourseMode?: 'action' | 'dialogue' | 'description' | 'exposition' | 'reflection' | 'transition';
  /** Arc position within the story structure */
  arcPosition?: 'opening' | 'rising' | 'climax' | 'falling' | 'denouement';
  /** Emotional valence of the scene */
  emotionalValence?: string;
  /** Type of conflict in this scene */
  conflictType?: string;
  /** How the conflict is resolved */
  resolutionType?: string;
  /** Tense override for this scene */
  tense?: 'past' | 'present';
  /** Point of view */
  pov: {
    character: string;
    type: 'first_person' | 'third_person_limited' | 'omniscient';
  };
  /** Brief description of what happens in the scene */
  sceneBrief: string;
  /** Preconditions that must be true before this event */
  preconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
    narrativeHint?: string;
  }>;
  /** Expected postconditions after this event */
  expectedPostconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    confidence?: number;
    narrativeHint?: string;
  }>;
  /** Style guidance for the LLM */
  styleGuidance?: StyleGuidance;
  /** Thread progress entries */
  threadProgress?: Array<{
    thread: string;
    advancement: string;
    progressAfter: number;
    progressTotal: number;
  }>;
  /** Foreshadowing entries */
  foreshadowing?: Array<{
    id: string;
    hint: string;
    targetRevealChapter: number;
    thread?: string;
  }>;
  /** Relationship effects */
  relationshipEffects?: Array<{
    participants: [string, string];
    effect: 'establish' | 'change' | 'dissolve' | 'reinforce' | 'complicate';
    direction: string;
    newState?: {
      type: string;
      intensity: number;
    };
  }>;
  /** Rule effects */
  ruleEffects?: Array<{
    rule: string;
    effect: 'reinforce' | 'weaken' | 'introduce_exception' | 'nullify';
    evidence: string;
  }>;
  /** Entities introduced by this event */
  introduces?: Array<{
    type: 'character' | 'location' | 'item' | 'concept';
    id: string;
    initialState: Record<string, unknown>;
  }>;
  /** Intended audience for this scene (affects prose style, vocabulary, complexity) */
  targetAudience?: string;
  /** Characters present in the scene, with semantic roles */
  cast?: {
    onScreen: string[];
    affected: string[];
  };
  /** Absolute file path to this event's YAML file on disk (set by EntityMapper) */
  filePath?: string;
}
