// ============================================================================
// ContextAssembler — Fill context package with 5-layer priority
// ============================================================================

import type {
  CharacterSnapshot,
  ContextPackage,
  EntityId,
  EntityRegistry,
  KnowledgeBoundary,
  NarrativeEvent,
  RelationshipContext,
  RelationshipState,
  RelevanceScore,
  RuleDefinition,
  LogicalConsequence,
  RuleEffectEntry,
  SceneSpecification,
  SystemContext,
  ThreadStatus,
  WorldFact,
  WorldState,
} from '../types/index.js';

import { type RelevanceContext } from './types.ts';
import { RelevanceEngine } from './relevance.ts';

export class ContextAssembler {
  private relevanceEngine: RelevanceEngine;
  private recentEntities: EntityId[] = [];

  constructor() {
    this.relevanceEngine = new RelevanceEngine();
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
    volumeSummary = '',
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

    // L1: System Context (always included)
    const sysCtx: SystemContext = {
      ...(systemContext ?? {
        genre: 'literary',
        style: 'literary',
        narrativeRules: [],
      }),
      targetAudience: event.targetAudience ?? systemContext?.targetAudience,
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

    // Active World Rules
    const activeRules = this._buildActiveRules(state, entityRegistry);

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
      volumeSummary,
      markdown: '',
      activeRules,
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
        archetype: povEntity.state['archetype'] as string | undefined,
        appearance: povEntity.state['appearance'] as Record<string, string> | undefined,
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
        archetype: entity.state['archetype'] as string | undefined,
        appearance: entity.state['appearance'] as Record<string, string> | undefined,
      });
    }

    return snapshots;
  }

  private _buildRelationshipContext(
    event: NarrativeEvent,
    state: WorldState,
  ): RelationshipContext[] {
    const contexts: RelationshipContext[] = [];

    for (const [relKey, relData] of Object.entries(state.relationships ?? {})) {
      // Guard: skip old-format (pre STATE-2) relationships that lack epochs
      if (!relData || typeof relData !== 'object' || !('epochs' in relData)) continue;

      // Derive participants from active epoch memberships
      const activeEpoch = relData.activeEpochId ? relData.epochs[relData.activeEpochId] : undefined;
      const entityIds = activeEpoch
        ? Object.values(activeEpoch.memberships).map((m) => m.entityId)
        : [];

      const hasParticipant = event.participants.entities.some((p) =>
        entityIds.includes(p),
      );
      if (!hasParticipant) continue;

      // Build pseudo participants tuple (first 2 for binary compat)
      const participants: [EntityId, EntityId] =
        entityIds.length >= 2
          ? [entityIds[0], entityIds[1]]
          : [entityIds[0] ?? '', entityIds[1] ?? ''];

      contexts.push({
        id: relKey,
        participants,
        // TODO(T3-remaining): RelationshipRuntimeState and RelationshipState are structurally
        // incompatible types. This cast bridges the legacy RelationshipContext API. Requires
        // either a data transformation or a type unification to eliminate.
        currentState: relData as unknown as RelationshipState,
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
    return Object.entries(state.threads).map(([id, data]) => {
      const goals = Object.values(data.goalStates);
      return {
        id,
        name: id,
        progress: goals.filter((s) => s === 'achieved').length,
        total: goals.length,
        description: '',
      };
    });
  }

  private _buildActiveRules(state: WorldState, registry: EntityRegistry): RuleDefinition[] {
    const activeRules: RuleDefinition[] = [];
    for (const [ruleId, ruleState] of Object.entries(state.rules)) {
      // Rule is active if enabled and not nullified
      if (ruleState.activation === 'enabled' && ruleState.effectiveness !== 'nullified') {
        const entity = registry.resolve(ruleId);
        if (entity) {
          activeRules.push({
            ruleId,
            name: (entity.state['name'] as string) ?? ruleId,
            statement: (entity.state['statement'] as string) ?? '',
            category: (entity.state['category'] as string) ?? 'unknown',
            type: (entity.state['type'] as string) ?? 'unknown',
            logicalConsequences: (entity.state['logicalConsequences'] as LogicalConsequence[] | undefined) ?? [],
            evidenceChain: (entity.state['evidenceChain'] as RuleEffectEntry[] | undefined) ?? [],
          });
        }
      }
    }
    return activeRules;
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
    if (pkg.systemContext.targetAudience) {
      lines.push(`- Target Audience: ${pkg.systemContext.targetAudience}`);
    }
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
      if (cs.archetype) {
        lines.push(`Archetype: ${cs.archetype}`);
      }
      if (cs.appearance && Object.keys(cs.appearance).length > 0) {
        lines.push('Appearance:');
        for (const [feature, desc] of Object.entries(cs.appearance)) {
          lines.push(`  - ${feature}: ${desc}`);
        }
      }
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
        if (rc.currentState && typeof rc.currentState === 'object' && 'direction' in rc.currentState && rc.currentState.direction) {
          // Old-format (pre STATE-2): direction-based relationship state
          for (const [dir, data] of Object.entries(rc.currentState.direction as Record<string, unknown>)) {
            const dims = Object.entries(data as Record<string, unknown>)
              .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
              .join(', ');
            lines.push(`  ${dir}: { ${dims} }`);
          }
        } else if (rc.currentState && typeof rc.currentState === 'object' && 'activeEpochId' in rc.currentState) {
          // New-format (STATE-2): render dimensions from active epoch
          const rs = rc.currentState as { activeEpochId?: string; epochs?: Record<string, { dimensions?: Record<string, { value: unknown }> }> };
          const epoch = rs.activeEpochId ? rs.epochs?.[rs.activeEpochId] : undefined;
          if (epoch?.dimensions) {
            for (const [k, v] of Object.entries(epoch.dimensions)) {
              lines.push(`  ${k}: ${JSON.stringify(v.value)}`);
            }
          }
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

    // Active World Rules
    if (pkg.activeRules && pkg.activeRules.length > 0) {
      lines.push('## Active World Rules');
      for (const rule of pkg.activeRules) {
        lines.push(`- **${rule.name}** (${rule.ruleId}) [${rule.category}]`);
        lines.push(`  Statement: ${rule.statement}`);
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

    // Volume Summary
    if (pkg.volumeSummary) {
      lines.push(pkg.volumeSummary);
      lines.push('');
    }

    return lines.join('\n');
  }
}
