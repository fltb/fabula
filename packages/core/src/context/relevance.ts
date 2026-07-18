// ============================================================================
// RelevanceEngine — 8-dimension scoring algorithm
// ============================================================================

import type {
  Entity,
  EntityId,
  NarrativeEvent,
  RelevanceScore,
  ThreadProgressEntry,
  WorldState,
} from '../types/index.js';

import { type RelevanceContext } from './types.ts';

export { type RelevanceContext } from './types.ts';

const IMPORTANCE_BONUS: Record<string, number> = {
  antagonist: 0.25,
  supporting: 0.15,
  minor: 0.05,
  background: 0,
};

export class RelevanceEngine {
  /**
   * Score all entities for relevance to the current scene.
   * Uses 8 dimensions: participation, threadAssociation, spatioTemporal,
   * knowledgeIntersection, relationshipRelevance, specificityBonus,
   * recencyPenalty, threadSaturation.
   */
  scoreEntities(context: RelevanceContext): RelevanceScore[] {
    const { currentEvent, worldState, entityRegistry, recentEntities, activeThreads } = context;
    const entities = entityRegistry.getAll();
    const scores: RelevanceScore[] = [];

    const sceneParticipants = new Set(currentEvent.participants.entities);
    const sceneThreads = new Set(currentEvent.threadProgress.map((tp) => tp.thread));

    for (const entity of entities) {
      const role = entity.state['role'] as string | undefined;
      const importanceBonus = IMPORTANCE_BONUS[role ?? 'background'] ?? 0;

      const basis = {
        participation: this._participationScore(entity, sceneParticipants),
        threadAssociation: this._threadAssociationScore(entity, sceneThreads, currentEvent.threadProgress),
        spatioTemporal: this._spatioTemporalScore(entity, currentEvent, worldState),
        knowledgeIntersection: this._knowledgeIntersectionScore(entity, currentEvent, worldState),
        relationshipRelevance: this._relationshipRelevanceScore(entity, currentEvent, worldState),
        specificityBonus: this._specificityBonus(entity, currentEvent),
        recencyPenalty: this._recencyPenalty(entity, recentEntities),
        importanceBonus,
      };

      const score =
        basis.participation * 0.30 +
        basis.threadAssociation * 0.20 +
        basis.spatioTemporal * 0.15 +
        basis.knowledgeIntersection * 0.10 +
        basis.relationshipRelevance * 0.15 +
        basis.specificityBonus * 0.05 -
        basis.recencyPenalty * 0.05 +
        basis.importanceBonus * 0.05;

      scores.push({
        entity: entity.id,
        score: Math.max(0, Math.min(1, score)),
        basis,
      });
    }

    return scores.sort((a, b) => b.score - a.score);
  }

  /** Entity is directly participating in this scene → high relevance */
  private _participationScore(entity: Entity, sceneParticipants: Set<EntityId>): number {
    if (sceneParticipants.has(entity.id)) return 1.0;
    if (entity.state['location'] && sceneParticipants.has(entity.state['location'] as string)) return 0.6;
    return 0.0;
  }

  /** Entity shares active threads with the scene */
  private _threadAssociationScore(
    entity: Entity,
    sceneThreads: Set<string>,
    threadProgress: ThreadProgressEntry[],
  ): number {
    // Entities that appear in thread progress entries get associated
    const entityThreads = threadProgress
      .filter((tp) => sceneThreads.has(tp.thread))
      .length;
    if (entityThreads > 0) return 0.5 + entityThreads * 0.1;
    return 0.0;
  }

  /** Entity is spatially or temporally close to the scene */
  private _spatioTemporalScore(
    entity: Entity,
    event: NarrativeEvent,
    state: WorldState,
  ): number {
    let score = 0;

    // Same location as POV character or participants
    const povLocation = state.entities[event.pov.character]?.['location'];
    const entityLocation = entity.state['location'];

    if (povLocation && entityLocation && povLocation === entityLocation) {
      score += 0.4;
    }

    // Check if entity location matches any scene participant's location
    for (const participant of event.participants.entities) {
      const pLoc = state.entities[participant]?.['location'];
      if (pLoc && entityLocation && pLoc === entityLocation) {
        score += 0.3;
        break;
      }
    }

    return Math.min(1, score);
  }

  /** Entity's knowledge intersects with scene knowledge requirements */
  private _knowledgeIntersectionScore(
    entity: Entity,
    event: NarrativeEvent,
    state: WorldState,
  ): number {
    const entityKnowledge = state.knowledge[entity.id];
    if (!entityKnowledge) return 0;

    // Check if entity knows facts relevant to scene preconditions
    const relevantFacts = event.preconditions.map((p) => p.id);
    const knownCount = relevantFacts.filter((f) =>
      entityKnowledge.knownFacts.includes(f),
    ).length;

    if (relevantFacts.length === 0) return 0;
    return knownCount / relevantFacts.length;
  }

  /** Entity has a relationship with scene participants */
  private _relationshipRelevanceScore(
    entity: Entity,
    event: NarrativeEvent,
    state: WorldState,
  ): number {
    let score = 0;
    const participants = event.participants.entities;

    for (const [relKey, relData] of Object.entries(state.relationships)) {
      const parts = relKey.split('_');
      if (parts.includes(entity.id)) {
        // Entity is in this relationship
        const otherParty = parts.find((p) => participants.includes(p));
        if (otherParty) {
          score += 0.4;
          // Higher intensity = higher relevance
          const intensity =
            relData.direction[entity.id]?.dimensions?.['intensity'] ?? 0;
          if (typeof intensity === 'number') {
            score += intensity * 0.3;
          }
        }
      }
    }

    return Math.min(1, score);
  }

  /** More specific preconditions → bonus (anti-laziness) */
  private _specificityBonus(entity: Entity, event: NarrativeEvent): number {
    const entityPreconditions = event.preconditions.filter(
      (p) => p.entityId === entity.id,
    );
    if (entityPreconditions.length === 0) return 0;
    // More preconditions = more specific = higher bonus
    return Math.min(0.3, entityPreconditions.length * 0.1);
  }

  /** Entity appeared recently → slight penalty (avoid repetition) */
  private _recencyPenalty(entity: Entity, recentEntities: EntityId[]): number {
    const idx = recentEntities.indexOf(entity.id);
    if (idx === -1) return 0;
    // More recent = higher penalty
    return Math.max(0, 1 - idx / recentEntities.length) * 0.3;
  }
}
