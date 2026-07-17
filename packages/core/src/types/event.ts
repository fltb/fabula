// ============================================================================
// Novalistically — Narrative Event & Event File Types
// ============================================================================

import type { EntityId, StoryTimestamp, Fact, FactId } from './entity.js';
import type { BranchSet } from './branch.js';

// ——— Narrative Event (§7.4.1) ———

export interface NarrativeEvent {
  id: string;
  event: string;
  narrativeOrder: number;
  title: string;
  storyTime: StoryTimestamp;
  narrationTime?: StoryTimestamp;
  sceneType: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  pov: {
    character: EntityId;
    type: 'first_person' | 'third_person_limited' | 'omniscient';
  };
  sceneBrief: string;
  preconditions: Fact[];
  postconditions: Fact[];
  threadProgress: ThreadProgressEntry[];
  foreshadowing: ForeshadowEntry[];
  relationshipEffects: RelationshipChange[];
  ruleEffects: RuleEffectEntry[];
  styleGuidance?: StyleGuidance;
  source: 'genesis' | 'event_file' | 'branch_point' | 'system';
  branchExistence: BranchSet;
  participants: {
    entities: EntityId[];
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

export interface RuleEffectEntry {
  rule: string;
  effect: 'reinforce' | 'weaken' | 'introduce_exception' | 'nullify';
  evidence: string;
}

export interface StyleGuidance {
  tone?: string;
  characterVoice?: Record<string, string>;
  avoid?: string;
  scenePacing?: string;
  atmosphere?: string;
}

// ——— Event File (YAML on disk) ———

export interface EventFile {
  /** Event identifier, e.g. "E0", "E1" */
  event: string;
  /** Narrative order within the story */
  narrativeOrder: number;
  /** Human-readable title */
  title: string;
  /** Story timestamp (references a time anchor) */
  storyTime: string;
  /** Scene type */
  sceneType?: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
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
  }>;
  /** Expected postconditions after this event */
  expectedPostconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    confidence?: number;
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
  /** Absolute file path to this event's YAML file on disk (set by EntityMapper) */
  filePath?: string;
}
