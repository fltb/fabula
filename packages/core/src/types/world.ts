// ============================================================================
// Novalistically — World State, Knowledge, Relationship & State Transition Types
// ============================================================================

import type { EntityId, StoryTimestamp, Fact, FactId } from './entity.js';
import type { NarrativeEvent, RuleEffectEntry } from './event.js';

// ——— Knowledge System (§7.4.2) ———

export interface KnowledgeState {
  worldTruth: Fact[];
  characterKnowledge: Record<EntityId, {
    knownFacts: KnowledgeEntry[];
    unknownFacts: FactId[];
    misbeliefs: KnowledgeEntry[];
  }>;
  readerKnowledge: FactId[];
  narratorKnowledge: FactId[];
}

export interface KnowledgeEntry {
  fact: Fact;
  acquiredAt: StoryTimestamp;
  source: KnowledgeSource;
  confidence: number;
}

export type KnowledgeSource =
  | { type: 'direct_experience'; eventId: string }
  | { type: 'told_by'; characterId: EntityId; eventId: string }
  | { type: 'inferred'; basis: FactId[] }
  | { type: 'deceived_by'; characterId: EntityId; actualFact: FactId };

// ——— Relationship System (§7.4.3) ———

export interface Relationship {
  id: string;
  participants: [EntityId, EntityId];
  definition: RelationshipDef;
  state: RelationshipState;
  history: NarrativeEvent[];
}

export interface RelationshipDef {
  type: string;
  description?: string;
}

export interface RelationshipState {
  direction: Record<EntityId, {
    dimensions: Record<string, number | string>;
    perceivedBy: Record<EntityId, number>;
  }>;
}

export interface RelationshipEffect {
  relationshipId: string;
  dimension: string;
  change:
    | { type: 'numeric'; delta: number }
    | { type: 'qualitative'; trigger: string; from: string; to: string };
}

// ——— State Transition Rule (§7.4.4) ———

export interface StateTransitionRule {
  id: string;
  eventType: string;
  condition?: (event: NarrativeEvent, state: WorldState) => boolean;
  effects: TransitionEffect[];
}

export interface TransitionEffect {
  target: 'character' | 'relationship' | 'knowledge' | 'world';
  dimension: string;
  delta?: number;
  qualitative?: {
    semantics: 'irreversible' | 'conditional' | 'gradual' | 'threshold';
    threshold?: number;
    description: string;
  };
}

// ——— World State ———

export interface WorldState {
  entities: Record<EntityId, Record<string, unknown>>;
  relationships: Record<string, RelationshipState>;
  knowledge: Record<EntityId, { knownFacts: FactId[] }>;
  threads: Record<string, { progress: number; total: number }>;
  rules: Record<string, { activeEvidence: number }>;
  facts: Fact[];
}

// ——— Event Store & Snapshot (§7.4.19) ———

export interface Snapshot {
  narrativeOrder: number;
  eventId: string;
  timestamp: string;
  state: WorldState;
}

// ——— World Initial State ———

export interface WorldInitialState {
  info: {
    currentEra: string;
    politicalSituation: string;
  };
  timeAnchors?: Array<{ id: string; day: number; description?: string }>;
  threads: Array<{
    id: string;
    name: string;
    description: string;
    type: string;
    targetRevealChapter: number;
    initialProgress: string;
  }>;
  worldFacts: Array<{
    id: string;
    value: unknown;
    description: string;
  }>;
}
