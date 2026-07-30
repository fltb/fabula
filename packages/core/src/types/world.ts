// ============================================================================
// Novalistically — World State, Knowledge, Relationship & State Transition Types
// ============================================================================

import type { EntityId, Fact, FactId } from './entity.js';
import type { NarrativeEvent } from './event.js';
import type { EpistemicLedger, PropositionCatalog } from './knowledge.js';
import type {
  DimensionState,
  EpochRuntimeState,
  Membership,
  RelationshipId,
  RelationshipRuntimeState,
} from './relationship.js';
import type { ThreadRuntimeState } from './thread.js';

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
  direction: Record<
    EntityId,
    {
      dimensions: Record<string, number | string>;
      perceivedBy: Record<EntityId, number>;
    }
  >;
}

export interface RelationshipEffect {
  relationshipId: string;
  dimension: string;
  change:
    | { type: 'numeric'; delta: number }
    | { type: 'qualitative'; trigger: string; from: string; to: string };
}

// ——— World State ———
import type { RuleRuntimeState } from './rule.js';

export interface WorldState {
  entities: Record<EntityId, Record<string, unknown>>;
  relationships: Record<RelationshipId, RelationshipRuntimeState>;
  knowledge: Record<EntityId, { knownFacts: FactId[] }>;
  /** STATE-4 EpistemicLedger — character knowledge attitudes toward propositions */
  epistemicLedger?: EpistemicLedger;
  /** STATE-4 PropositionCatalog — immutable catalog of propositions */
  propositionCatalog?: PropositionCatalog;
  threads: Record<string, ThreadRuntimeState>;
  rules: Record<string, RuleRuntimeState>;
  facts: Fact[];
}

// ——— Event Store & Snapshot (§7.4.19) ———

export interface Snapshot {
  eventCount: number;
  eventId: string;
  timestamp: string;
  version: number;
  state: WorldState;
}

// ——— World Initial State ———

export interface WorldInitialState {
  info: {
    currentEra: string;
    politicalSituation: string;
  };
  timeAnchors?: Array<{ id: string; at: string; description?: string }>;
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
