// ============================================================================
// Novalistically — Narrative Event & Event File Types
// ============================================================================

import type { JsonValue } from '../contracts/json.js';
import type { BranchSet } from './branch.js';
import type { Anachrony, VoiceProfile } from './discourse.js';
import type { DurationProfile } from './duration.js';
import type { AuthoredStoryTime, EntityId, Fact, StoryTimestamp } from './entity.js';
import type { FrequencyProfile } from './frequency.js';
import type { GameDialogueChoice } from './game-dialogue.js';
import type { GreyLine } from './grey-line.js';
import type { KnowledgeTransaction, RuntimeKnowledgeTransaction } from './knowledge.js';
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
import type { RelationshipEffect } from './relationship.js';
import type { RuleTransaction } from './rule.js';
import type { SourceContext } from './source-context.js';
import type { ThreadTransaction } from './thread.js';

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
  /** Catalog-checked thread transactions — normalized once by the mapper. */
  threadProgress: ThreadTransaction[];
  greyLines?: GreyLine[];
  foreshadowing: ForeshadowEntry[];
  relationshipEffects: RelationshipEffect[];
  /** Normalized knowledge effects; absent when the event authors none. */
  knowledgeTransactions?: RuntimeKnowledgeTransaction[];
  ruleEffects: RuleTransaction[];
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
  /** Read-only plugin extension payloads — never written into WorldState. */
  extensions?: Readonly<Record<string, JsonValue>>;
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
  RelationshipDeclaration,
  RelationshipEffect,
  RelationshipId,
  RelationshipIdentityTransitionGroup,
  RelationshipRoleDefinition,
  RelationshipRuntimeState,
  RelationshipTransaction,
  RelationshipTypeCatalog,
  RelationshipTypeDefinition,
} from './relationship.js';
// ——— STATE-5 ThreadTransaction ———
// ThreadProgressEntry remains the EventFile wire projection; the mapper
// normalizes it once into catalog-checked ThreadTransaction values, so
// NarrativeEvent.threadProgress is never a second state source.
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
  /** Explicit knowledge writes, information acts, and common-ground effects. */
  knowledgeTransactions?: KnowledgeTransaction[];
  /** Grey line motif tracking entries */
  greyLines?: GreyLine[];
  /** Foreshadowing entries */
  foreshadowing?: Array<{
    id: string;
    hint: string;
    targetRevealChapter: number;
    thread?: string;
  }>;
  /** Canonical relationship effects. */
  relationshipEffects?: RelationshipEffect[];
  /** Rule transactions */
  ruleEffects?: RuleTransaction[];
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
  /**
   * Plugin extension payloads, keyed by enabled plugin name. Read-only
   * source data: extensions never enter WorldState and never mutate state;
   * all source modification still flows through working validate → submit.
   */
  extensions?: Record<string, JsonValue>;
}
