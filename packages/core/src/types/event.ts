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
  event: string;
  narrativeOrder: number;
  title: string;
  storyTime: string;
  sceneType?: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  pov: {
    character: string;
    type: 'first_person' | 'third_person_limited' | 'omniscient';
  };
  sceneBrief: string;
  preconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
  }>;
  expectedPostconditions: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    confidence?: number;
  }>;
  styleGuidance?: StyleGuidance;
  threadProgress?: Array<{
    thread: string;
    advancement: string;
    progressAfter: number;
    progressTotal: number;
  }>;
  foreshadowing?: Array<{
    id: string;
    hint: string;
    targetRevealChapter: number;
    thread?: string;
  }>;
  relationshipEffects?: Array<{
    participants: [string, string];
    effect: 'establish' | 'change' | 'dissolve' | 'reinforce' | 'complicate';
    direction: string;
    newState?: {
      type: string;
      intensity: number;
    };
  }>;
  ruleEffects?: Array<{
    rule: string;
    effect: 'reinforce' | 'weaken' | 'introduce_exception' | 'nullify';
    evidence: string;
  }>;
  introduces?: Array<{
    type: 'character' | 'location' | 'item' | 'concept';
    id: string;
    initialState: Record<string, unknown>;
  }>;
}
