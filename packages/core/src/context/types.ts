import type {
  EntityId,
  EntityLookup,
  NarrativeEvent,
  RuleDeclaration,
  WorldState,
} from '../types/index.js';

// ============================================================================
// RelevanceContext — Input to the 8-dimension scoring algorithm
// ============================================================================

export interface RelevanceContext {
  currentEvent: NarrativeEvent;
  worldState: WorldState;
  entities: EntityLookup;
  recentEntities: EntityId[];
  activeThreads: string[];
  /** Canonical rule declarations for active-rule projections. */
  ruleDeclarations: RuleDeclaration[];
}
