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
} from '../types/index.js';

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
    getKnowledge: (characterId: EntityId) => ({
      worldTruth: state.facts,
      characterKnowledge: {
        [characterId]: {
          knownFacts: state.knowledge[characterId]?.knownFacts?.map((fid) => ({
            fact: state.facts.find((f) => f.id === fid) ?? {
              id: fid, entityId: '', attribute: '', value: null,
              validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
            },
            acquiredAt: { type: 'absolute' as const, value: 'day_0' },
            source: { type: 'direct_experience' as const, eventId: event.id },
            confidence: 1,
          })) ?? [],
          unknownFacts: [],
          misbeliefs: [],
        },
      },
      readerKnowledge: [],
      narratorKnowledge: [],
    }),
    getThreadProgress: (threadId: string) =>
      state.threads[threadId] ?? { progress: 0, total: 0 },
    getRuleEvidence: (_ruleId: string) => [],
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
