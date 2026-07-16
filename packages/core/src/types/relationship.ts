// ============================================================================
// Novalistically — Relationship: First-class entity types for the Relationship system
// ============================================================================

import type { EntityId } from './entity.js';

// ——— RelationshipDefinition (first-class entity) ———

export interface RelationshipDefinition {
  id: string;
  type: string;             // 'friendship' | 'rivalry' | 'love' | 'fear' | 'hate' | 'professional' etc.
  participants: [EntityId, EntityId];  // exactly 2
  bidirectional: boolean;   // false = asymmetric (A→B different from B→A)
  initialState: {
    trust: number;            // -100 to 100
    emotionalDistance: number; // 0 = close, 100 = distant
    intensity: number;        // 0-100
    status: string;           // 'active' | 'dormant' | 'broken' | 'formed'
    notes?: string;
  };
  establishedEvent?: string;
  breakingEvent?: string;
}

// ——— Relationship Events ———

export type RelationshipEventType = 'strengthen' | 'weaken' | 'break' | 'form' | 'shift';

export interface RelationshipEvent {
  id: string;
  type: RelationshipEventType;
  relationshipId: string;
  delta: Partial<{
    trust: number;
    emotionalDistance: number;
    intensity: number;
    status: string;
  }>;
  sourceEvent: string;
}
