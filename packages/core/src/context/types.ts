import type { EntityId, EntityLookup, NarrativeEvent, WorldState } from '../types/index.js';

// ============================================================================
// RelevanceContext — Input to the 8-dimension scoring algorithm
// ============================================================================

export interface RelevanceContext {
  currentEvent: NarrativeEvent;
  worldState: WorldState;
  entities: EntityLookup;
  recentEntities: EntityId[];
  activeThreads: string[];
}
