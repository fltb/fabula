// ============================================================================
// Novalistically — Narrative Event & Event File Types
// ============================================================================

import type { BranchSet } from './branch.js';
import type { Anachrony, VoiceProfile } from './discourse.js';
import type { DurationProfile } from './duration.js';
import type { AuthoredStoryTime, EntityId, Fact, StoryTimestamp } from './entity.js';
import type { FrequencyProfile } from './frequency.js';
import type { GameDialogueChoice } from './game-dialogue.js';
import type { GreyLine } from './grey-line.js';
import type { NarrativeChecklist } from './narrative-checklist.js';
import type {
  AbsentApparatus,
  CausalDiscontinuity,
  CausalMultiplicity,
  IrresolvableIndeterminacy,
  MetanarrativeLevel,
  Multiplicity,
  SurfaceMode,
  VoiceDissonance,
} from './narrative-techniques.js';
import type { RelationshipTransaction } from './relationship.js';
import type { RuleEffectEntry } from './rule.js';
import type { SourceContext } from './source-context.js';

// ——— Narrative Event (§7.4.1) ———

export interface NarrativeEvent {
  kind: 'event';
  id: string;
  event: string;
  narrativeOrder: number;
  title: string;
  storyTime: StoryTimestamp;
  narrationTime?: StoryTimestamp;
  sceneType: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  discourseMode?:
    | 'action'
    | 'dialogue'
    | 'description'
    | 'exposition'
    | 'reflection'
    | 'transition';
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
  /** Ordered, non-empty beats: the sequence of actions/turns in the scene. */
  beats: [string, ...string[]];
  preconditions: Fact[];
  postconditions: Fact[];
  /** Event-local player choices leading to child game-tree nodes. */
  choices?: GameDialogueChoice[];
  threadProgress: ThreadProgressEntry[];
  greyLines?: GreyLine[];
  foreshadowing: ForeshadowEntry[];
  relationshipEffects: RelationshipTransaction[];
  ruleEffects: RuleEffectEntry[];
  styleGuidance?: StyleGuidance;
  source: 'event_file' | 'branch_point' | 'system';
  /** Explicit predecessor events injected by trusted internal compilation. */
  causalPredecessors?: string[];
  branchExistence: BranchSet;
  participants: {
    entities: EntityId[];
  };
  /** Intended audience for this scene (affects prose style, vocabulary, complexity) */
  targetAudience?: string; // e.g. "adult_literary", "young_adult", "middle_grade", "academic"
  /** Runtime status: authored events are 'draft' until rendered, then 'rendered' */
  status?: 'draft' | 'rendered' | 'blocked' | 'needs_review';
  /** Characters present in the scene, with semantic roles */
  cast?: {
    onScreen: string[]; // characters physically present
    affected: string[]; // characters affected by events (may be off-screen)
  };
  /** Narrative checklist — dimensions the prose must cover (S1) */
  narrativeChecklist?: NarrativeChecklist;
  /** Source context — style anchors (S4) */
  sourceContext?: SourceContext;
  /** Genette Duration (S6a) */
  duration?: DurationProfile;
  /** Genette Frequency (S6b) */
  frequency?: FrequencyProfile;
  /** Genette Anachrony (S6e) */
  anachrony?: Anachrony;
  /** Genette Voice (S6d) */
  voice?: VoiceProfile;
  /** NarratorProfile reference (S6c) */
  narratorProfileRef?: string;
  /** Genette Mood focalization (S6c) */
  focalization?: {
    type: 'zero' | 'internal' | 'external';
    variation?: 'fixed' | 'variable' | 'multiple';
    characterSequence?: { character: string; scope: string }[];
  };
  /** Graph-resolved narrative technique contracts. */
  causalDiscontinuity?: CausalDiscontinuity;
  surfaceMode?: SurfaceMode;
  causalMultiplicity?: CausalMultiplicity;
  irresolvableIndeterminacy?: IrresolvableIndeterminacy;
  absentApparatus?: AbsentApparatus;
  voiceDissonance?: VoiceDissonance;
  multiplicity?: Multiplicity;
  metanarrativeLevel?: MetanarrativeLevel;
  /** Entities introduced by this event (forwarded from EventFile) */
  introduces?: Array<{
    type: 'character' | 'location' | 'item' | 'concept';
    id: string;
    initialState: Record<string, unknown>;
  }>;
  /** Free-form author notes passed verbatim to the Pass 1 prompt (pure pass-through) */
  authorNotes?: string[];
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
  RelationshipId,
  RelationshipIdentityTransitionGroup,
  RelationshipRoleDefinition,
  RelationshipRuntimeState,
  RelationshipTransaction,
  RelationshipTypeDefinition,
} from './relationship.js';
// ——— STATE-5 ThreadTransaction ———
// ThreadProgressEntry is kept as a backward-compat type; the replay engine
// converts it to ThreadTransaction at application time.
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
  /** Narrative order within the story */
  narrativeOrder: number;
  /** Human-readable title */
  title: string;
  /** Story timestamp authored for this scene; omission means unlocated. */
  storyTime?: AuthoredStoryTime;
  /** Narration timestamp (when the story is being told). */
  narrationTime?: AuthoredStoryTime;
  /** Authored causal predecessors for scenes without comparable story time. */
  causalPredecessors?: string[];
  /** Scene type */
  sceneType?: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  /** Discourse mode */
  discourseMode?:
    | 'action'
    | 'dialogue'
    | 'description'
    | 'exposition'
    | 'reflection'
    | 'transition';
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
  /** Ordered, non-empty beats: the sequence of actions/turns in the scene. */
  beats: [string, ...string[]];
  /** Preconditions that must be true before this event */
  preconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    operator?:
      | 'eq'
      | 'neq'
      | 'gt'
      | 'gte'
      | 'lt'
      | 'lte'
      | 'contains'
      | 'not_contains'
      | 'exists'
      | 'not_exists';
    narrativeHint?: string;
  }>;
  /** Expected postconditions after this event */
  expectedPostconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    confidence?: number;
    narrativeHint?: string;
    operation?: 'set' | 'unset';
  }>;
  /** Event-local player choices leading to child game-tree nodes. */
  choices?: GameDialogueChoice[];
  /** Style guidance for the LLM */
  styleGuidance?: StyleGuidance;
  /** Thread progress entries */
  threadProgress?: Array<{
    thread: string;
    advancement: string;
    progressAfter: number;
    progressTotal: number;
  }>;
  /** Grey line motif tracking entries */
  greyLines?: GreyLine[];
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
  /** Logical source path to this event's YAML document in the snapshot. */
  logicalPath?: string;
  /** Narrative checklist — dimensions the prose must cover (S1) */
  narrativeChecklist?: NarrativeChecklist;
  /** Source context — style anchors from original source text (S4) */
  sourceContext?: SourceContext;
  /** Genette Duration profile — scene/summary/ellipsis/pause/stretch (S6a) */
  duration?: DurationProfile;
  /** Genette Frequency profile — singulative/repeating/iterative (S6b) */
  frequency?: FrequencyProfile;
  /** Genette Anachrony — refined flashback/flashforward classification (S6e) */
  anachrony?: Anachrony;
  /** Genette Voice — narrative level and diegetic relation (S6d) */
  voice?: VoiceProfile;
  /** Reference to a NarratorProfile defined in project discourse config (S6c) */
  narratorProfileRef?: string;
  /** Genette Mood — focalization type and variation (S6c) */
  focalization?: {
    type: 'zero' | 'internal' | 'external';

    variation?: 'fixed' | 'variable' | 'multiple';
    characterSequence?: { character: string; scope: string }[];
  };
  /** Graph-resolved narrative technique contracts. */
  causalDiscontinuity?: CausalDiscontinuity;
  surfaceMode?: SurfaceMode;
  causalMultiplicity?: CausalMultiplicity;
  irresolvableIndeterminacy?: IrresolvableIndeterminacy;
  absentApparatus?: AbsentApparatus;
  voiceDissonance?: VoiceDissonance;
  multiplicity?: Multiplicity;
  metanarrativeLevel?: MetanarrativeLevel;
  /** Free-form author notes passed verbatim to the Pass 1 prompt (pure pass-through) */
  authorNotes?: string[];
}
