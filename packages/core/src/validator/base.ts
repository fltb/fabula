// ============================================================================
// Shared helpers for all validators
// ============================================================================

import type {
  NarrativeEvent,
  WorldState,
  EntityRegistry,
  ValidatorContext,
  ValidationIssue,
  EntityId,
  EntityKind,
  WritePolicy,
} from '../types/index.js';
import { defaultEntityTypeCatalog } from '../entity/index.js';

// ============================================================================
// Helper: build ValidatorContext from current state
// ============================================================================

export function buildContext(
  event: NarrativeEvent,
  state: WorldState,
  registry: EntityRegistry,
  events: NarrativeEvent[],
  chapter: number,
): ValidatorContext {
  return {
    worldState: state,
    events,
    entityRegistry: registry,
    currentEvent: event,
    currentChapter: chapter,
    narrativeOrder: event.narrativeOrder,
    queryState: (entityId: EntityId, attribute: string) =>
      state.entities[entityId]?.[attribute],
    getKnowledge: (characterId: EntityId) =>
      state.epistemicLedger ?? { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
    getThreadProgress: (threadId: string) =>
      state.threads[threadId] ?? { progress: 0, total: 0 },
  };
}

export function makeIssue(
  validator: string,
  eventId: string,
  entity: string,
  severity: 'error' | 'warning' | 'info',
  message: string,
  fixSuggestion: string,
  fixAction: ValidationIssue['fixAction'] = 'manual',
  attribute?: string,
  file?: string,
  value?: unknown,
): ValidationIssue {
  return {
    validator,
    severity,
    event: eventId,
    entity,
    attribute,
    message,
    fixSuggestion,
    fixAction,
    fixTarget: { file: file ?? '', field: attribute, value },
  };
}

// ============================================================================
// Catalog-driven attribute lookup helpers (STATE-3b)
// ============================================================================
// Replace hardcoded attribute-name checks in validators with semanticRole
// and writePolicy lookups from the entity type catalog.
// ============================================================================

/** Look up the semanticRole for a given entity kind + attributeId */
export function getAttributeSemanticRole(kind: EntityKind, attributeId: string): string | undefined {
  const typeDef = defaultEntityTypeCatalog.types[kind];
  if (!typeDef) return undefined;
  const attrDef = typeDef.attributes[attributeId];
  return attrDef?.semanticRole;
}

/** Look up the writePolicy for a given entity kind + attributeId */
export function getAttributeWritePolicy(kind: EntityKind, attributeId: string): WritePolicy | undefined {
  const typeDef = defaultEntityTypeCatalog.types[kind];
  if (!typeDef) return undefined;
  const attrDef = typeDef.attributes[attributeId];
  return attrDef?.writePolicy;
}

/** Get all attributeIds for an entity kind that have a specific semanticRole */
export function getAttributesBySemanticRole(kind: EntityKind, semanticRole: string): string[] {
  const typeDef = defaultEntityTypeCatalog.types[kind];
  if (!typeDef) return [];
  return Object.values(typeDef.attributes)
    .filter(a => a.semanticRole === semanticRole)
    .map(a => a.attributeId);
}
