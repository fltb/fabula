// ============================================================================
// ContextCompiler + RelevanceEngine (§7.4.6)
// Assembles the Narrative Context Package for LLM scene rendering.
// ============================================================================

import type {
  NarrativeEvent,
  WorldState,
  EntityRegistry,
  Entity,
  RelevanceScore,
  ContextPackage,
  SystemContext,
  SceneSpecification,
  CharacterSnapshot,
  RelationshipContext,
  WorldFact,
  KnowledgeBoundary,
  ThreadStatus,
  ThreadProgressEntry,
  StyleGuidance,
  EntityId,
} from '../types/index.js';

// ============================================================================
// RelevanceEngine — 8-dimension scoring algorithm
// ============================================================================

export interface RelevanceContext {
  currentEvent: NarrativeEvent;
  worldState: WorldState;
  entityRegistry: EntityRegistry;
  recentEntities: EntityId[];
  activeThreads: string[];
}

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
      const basis = {
        participation: this._participationScore(entity, sceneParticipants),
        threadAssociation: this._threadAssociationScore(entity, sceneThreads, currentEvent.threadProgress),
        spatioTemporal: this._spatioTemporalScore(entity, currentEvent, worldState),
        knowledgeIntersection: this._knowledgeIntersectionScore(entity, currentEvent, worldState),
        relationshipRelevance: this._relationshipRelevanceScore(entity, currentEvent, worldState),
        specificityBonus: this._specificityBonus(entity, currentEvent),
        recencyPenalty: this._recencyPenalty(entity, recentEntities),
      };

      const score =
        basis.participation * 0.30 +
        basis.threadAssociation * 0.20 +
        basis.spatioTemporal * 0.15 +
        basis.knowledgeIntersection * 0.10 +
        basis.relationshipRelevance * 0.15 +
        basis.specificityBonus * 0.05 -
        basis.recencyPenalty * 0.05;

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
            relData.direction[entity.id]?.['intensity'] ?? 0;
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

// ============================================================================
// ContextAssembler — Fill context package with 5-layer priority
// ============================================================================

export class ContextAssembler {
  private relevanceEngine: RelevanceEngine;
  private tokenBudget: number;
  private recentEntities: EntityId[] = [];

  constructor(tokenBudget = 8000) {
    this.relevanceEngine = new RelevanceEngine();
    this.tokenBudget = tokenBudget;
  }

  /**
   * Assemble a complete Context Package for a scene.
   * Fills 5 priority layers (L1-L5), truncating to token budget.
   */
  assemble(
    event: NarrativeEvent,
    state: WorldState,
    entityRegistry: EntityRegistry,
    previousSceneSummary = '',
    systemContext?: SystemContext,
    activeThreadIds?: string[],
  ): ContextPackage {
    const context: RelevanceContext = {
      currentEvent: event,
      worldState: state,
      entityRegistry,
      recentEntities: this.recentEntities,
      activeThreads: activeThreadIds ?? [],
    };

    // Score all entities for relevance
    const scores = this.relevanceEngine.scoreEntities(context);
    const relevantEntities = new Set(
      scores.filter((s) => s.score > 0.3).map((s) => s.entity),
    );

    // L1: System Context (always included)
    const sysCtx = systemContext ?? {
      genre: 'fantasy',
      style: 'literary',
      narrativeRules: [],
    };

    // L2: Scene Specification (always included)
    const sceneSpec = this._buildSceneSpec(event);

    // L3: Character Snapshots (relevant characters only)
    const characterSnapshots = this._buildCharacterSnapshots(
      event, entityRegistry, state, scores,
    );

    // L4: Relationship Context
    const relationshipContext = this._buildRelationshipContext(
      event, state,
    );

    // L5: World Facts
    const worldFacts = this._buildWorldFacts(state, scores);

    // Knowledge Boundary
    const knowledgeBoundary = this._buildKnowledgeBoundary(event, state);

    // Active Threads
    const activeThreads = this._buildThreadStatus(state);

    // Track recent entities for recency penalty in next call
    this.recentEntities = [
      ...event.participants.entities,
      ...this.recentEntities,
    ].slice(0, 10);

    const pkg: ContextPackage = {
      eventId: event.id,
      systemContext: sysCtx,
      sceneSpec,
      characterSnapshots,
      relationshipContext,
      worldFacts,
      knowledgeBoundary,
      activeThreads,
      previousSceneSummary,
      markdown: '',
    };

    // Render to markdown
    pkg.markdown = this.renderToMarkdown(pkg);

    return pkg;
  }

  private _buildSceneSpec(event: NarrativeEvent): SceneSpecification {
    return {
      goal: event.sceneBrief,
      povType: event.pov.type,
      povCharacter: event.pov.character,
      conflict: event.styleGuidance?.scenePacing ?? 'TBD',
      expectedOutcome: event.postconditions
        .map((pc) => `${pc.entityId}.${pc.attribute} = ${pc.value}`)
        .join('; '),
    };
  }

  private _buildCharacterSnapshots(
    event: NarrativeEvent,
    registry: EntityRegistry,
    state: WorldState,
    scores: RelevanceScore[],
  ): CharacterSnapshot[] {
    const snapshots: CharacterSnapshot[] = [];
    const seen = new Set<string>();

    // Always include POV character first
    const povEntity = registry.resolve(event.pov.character);
    if (povEntity && povEntity.kind === 'character') {
      seen.add(povEntity.id);
      snapshots.push({
        id: povEntity.id,
        name: povEntity.name,
        currentState: state.entities[povEntity.id] ?? {},
        traits: (povEntity.state['traits'] as string[]) ?? [],
        voiceNotes: (povEntity.state['voice_notes'] as string) ?? '',
      });
    }

    // Add other relevant characters by score
    for (const score of scores) {
      if (seen.has(score.entity)) continue;
      const entity = registry.resolve(score.entity);
      if (!entity || entity.kind !== 'character') continue;
      if (score.score < 0.2) continue;
      seen.add(entity.id);

      snapshots.push({
        id: entity.id,
        name: entity.name,
        currentState: state.entities[entity.id] ?? entity.state,
        traits: (entity.state['traits'] as string[]) ?? [],
        voiceNotes: (entity.state['voice_notes'] as string) ?? '',
      });
    }

    return snapshots;
  }

  private _buildRelationshipContext(
    event: NarrativeEvent,
    state: WorldState,
  ): RelationshipContext[] {
    const contexts: RelationshipContext[] = [];

    for (const [relKey, relData] of Object.entries(state.relationships)) {
      const parts = relKey.split('_');
      const hasParticipant = event.participants.entities.some((p) =>
        parts.includes(p),
      );
      if (!hasParticipant) continue;

      contexts.push({
        id: relKey,
        participants: parts as [EntityId, EntityId],
        currentState: relData,
        unresolvedTensions: [],
      });
    }

    return contexts;
  }

  private _buildWorldFacts(
    state: WorldState,
    scores: RelevanceScore[],
  ): WorldFact[] {
    const topEntities = new Set(
      scores
        .filter((s) => s.score > 0.4)
        .map((s) => s.entity),
    );

    return state.facts
      .filter((f) => topEntities.has(f.entityId))
      .slice(0, 20)
      .map((f) => ({
        id: f.id,
        description: `${f.entityId}.${f.attribute}`,
        value: f.value,
      }));
  }

  private _buildKnowledgeBoundary(
    event: NarrativeEvent,
    state: WorldState,
  ): KnowledgeBoundary {
    const povChar = event.pov.character;
    const charKnowledge = state.knowledge[povChar];

    return {
      characterId: povChar,
      knownFacts: charKnowledge?.knownFacts ?? [],
      unknownFacts: [],
    };
  }

  private _buildThreadStatus(state: WorldState): ThreadStatus[] {
    return Object.entries(state.threads).map(([id, data]) => ({
      id,
      name: id,
      progress: data.progress,
      total: data.total,
      description: '',
    }));
  }

  /** Render context package to LLM-readable markdown */
  renderToMarkdown(pkg: ContextPackage): string {
    const lines: string[] = [];

    lines.push(`# Context Package: ${pkg.eventId}`);
    lines.push('');

    // System Context
    lines.push('## System Context');
    lines.push(`- Genre: ${pkg.systemContext.genre}`);
    lines.push(`- Style: ${pkg.systemContext.style}`);
    for (const rule of pkg.systemContext.narrativeRules) {
      lines.push(`- Rule: ${rule}`);
    }
    lines.push('');

    // Scene Specification
    lines.push('## Scene Specification');
    lines.push(`- Goal: ${pkg.sceneSpec.goal}`);
    lines.push(`- POV: ${pkg.sceneSpec.povType} from ${pkg.sceneSpec.povCharacter}`);
    lines.push(`- Conflict: ${pkg.sceneSpec.conflict}`);
    lines.push(`- Expected Outcome: ${pkg.sceneSpec.expectedOutcome}`);
    lines.push('');

    // Character Snapshots
    lines.push('## Characters');
    for (const cs of pkg.characterSnapshots) {
      lines.push(`### ${cs.name} (${cs.id})`);
      if (cs.traits.length > 0) {
        lines.push(`Traits: ${cs.traits.join(', ')}`);
      }
      for (const [key, value] of Object.entries(cs.currentState)) {
        if (key !== 'traits' && key !== 'voice_notes') {
          lines.push(`- ${key}: ${JSON.stringify(value)}`);
        }
      }
      if (cs.voiceNotes) {
        lines.push(`Voice: ${cs.voiceNotes}`);
      }
      lines.push('');
    }

    // Relationship Context
    if (pkg.relationshipContext.length > 0) {
      lines.push('## Relationships');
      for (const rc of pkg.relationshipContext) {
        lines.push(`- ${rc.participants[0]} ↔ ${rc.participants[1]}`);
        for (const [dir, data] of Object.entries(rc.currentState.direction)) {
          const dims = Object.entries(data)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join(', ');
          lines.push(`  ${dir}: { ${dims} }`);
        }
      }
      lines.push('');
    }

    // World Facts
    if (pkg.worldFacts.length > 0) {
      lines.push('## Relevant World Facts');
      for (const wf of pkg.worldFacts) {
        lines.push(`- ${wf.description}: ${JSON.stringify(wf.value)}`);
      }
      lines.push('');
    }

    // Knowledge Boundary
    lines.push('## POV Knowledge Boundary');
    lines.push(`Character: ${pkg.knowledgeBoundary.characterId}`);
    lines.push(`Known facts: ${pkg.knowledgeBoundary.knownFacts.length}`);
    lines.push('');

    // Active Threads
    if (pkg.activeThreads.length > 0) {
      lines.push('## Active Threads');
      for (const t of pkg.activeThreads) {
        lines.push(`- ${t.id}: ${t.progress}/${t.total}`);
      }
      lines.push('');
    }

    // Previous Scene Summary
    if (pkg.previousSceneSummary) {
      lines.push('## Previous Scene Summary');
      lines.push(pkg.previousSceneSummary);
      lines.push('');
    }

    return lines.join('\n');
  }
}

// ============================================================================
// ContextCompiler — Main entry point
// ============================================================================

export class ContextCompiler {
  private assembler: ContextAssembler;

  constructor(tokenBudget = 8000) {
    this.assembler = new ContextAssembler(tokenBudget);
  }

  /**
   * Compile a context package for a given event.
   */
  compile(
    event: NarrativeEvent,
    state: WorldState,
    entityRegistry: EntityRegistry,
    options?: {
      previousSceneSummary?: string;
      systemContext?: SystemContext;
      activeThreadIds?: string[];
    },
  ): ContextPackage {
    return this.assembler.assemble(
      event,
      state,
      entityRegistry,
      options?.previousSceneSummary ?? '',
      options?.systemContext,
      options?.activeThreadIds,
    );
  }

  /**
   * Export context package as inspector JSON (for debugging).
   */
  inspect(pkg: ContextPackage): string {
    return JSON.stringify(
      {
        eventId: pkg.eventId,
        characterCount: pkg.characterSnapshots.length,
        relationshipCount: pkg.relationshipContext.length,
        worldFactCount: pkg.worldFacts.length,
        threadCount: pkg.activeThreads.length,
        knownFacts: pkg.knowledgeBoundary.knownFacts.length,
      },
      null,
      2,
    );
  }
}
