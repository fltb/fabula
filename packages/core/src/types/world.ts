// ============================================================================
// Novalistically — World State, Knowledge, Relationship & State Transition Types
// ============================================================================

import type { AuthoredLocatableStoryTime, EntityId, Fact } from './entity.js';
import type { NarrativeEvent } from './event.js';
import type {
  CommonGroundRecord,
  EpistemicLedger,
  KnowledgeInitialState,
  PropositionCatalog,
} from './knowledge.js';
import type { RelationshipId, RelationshipRuntimeState } from './relationship.js';
import type { RuleRuntimeState } from './rule.js';
import type { ThreadDeclaration, ThreadRuntimeState } from './thread.js';

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

// ——— World State ———

export interface WorldState {
  entities: Record<EntityId, Record<string, unknown>>;
  relationships: Record<RelationshipId, RelationshipRuntimeState>;
  /** Explicit proposition knowledge; indexes are compiler-owned ledger data. */
  epistemicLedger: EpistemicLedger;
  /** Immutable project proposition catalog. */
  propositionCatalog: PropositionCatalog;
  /** Explicit common-ground records, in deterministic declaration/event order. */
  commonGround: CommonGroundRecord[];
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
  timeAnchors?: Array<{
    id: string;
    at: AuthoredLocatableStoryTime;
    description?: string;
    significance?: string;
  }>;
  threads: ThreadDeclaration[];
  knowledge: KnowledgeInitialState;
  worldFacts: Array<{
    id: string;
    value: unknown;
    description: string;
  }>;
}
