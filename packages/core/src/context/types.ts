import type {
  EntityId,
  EntityRegistry,
  NarrativeEvent,
  WorldState,
} from '../types/index.js';

// ============================================================================
// RelevanceContext — Input to the 8-dimension scoring algorithm
// ============================================================================

export interface RelevanceContext {
  currentEvent: NarrativeEvent;
  worldState: WorldState;
  entityRegistry: EntityRegistry;
  recentEntities: EntityId[];
  activeThreads: string[];
}
