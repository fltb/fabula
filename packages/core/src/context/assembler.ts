// ============================================================================
// ContextAssembler — Fill context package with 5-layer priority
// ============================================================================

import type {
  CharacterSnapshot,
  ContextPackage,
  EntityId,
  EntityLookup,
  KnowledgeBoundary,
  NarrativeEvent,
  RelationshipContext,
  RelevanceScore,
  RuleDeclaration,
  SceneSpecification,
  SystemContext,
  ThreadDeclaration,
  ThreadStatus,
  WorldFact,
  WorldState,
} from '../types/index.js';
import { RelevanceEngine } from './relevance.ts';
import type { RelevanceContext } from './types.ts';

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
    entities: EntityLookup,
    volumeSummary = '',
    systemContext?: SystemContext,
    activeThreadIds?: string[],
    ruleDeclarations: RuleDeclaration[] = [],
    threadDeclarations: readonly ThreadDeclaration[] = [],
  ): ContextPackage {
    const context: RelevanceContext = {
      currentEvent: event,
      worldState: state,
      entities,
      recentEntities: this.recentEntities,
      activeThreads: activeThreadIds ?? [],
      ruleDeclarations,
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
    const characterSnapshots = this._buildCharacterSnapshots(event, entities, state, scores);
    // L3a: Merge resolvable on-screen cast characters not already selected
    if (event.cast?.onScreen) {
      for (const charId of event.cast.onScreen) {
        if (characterSnapshots.some((cs) => cs.id === charId)) continue;
        const entity = entities.resolve(charId);
        if (entity?.kind !== 'character') continue;
        characterSnapshots.push({
          id: entity.id,
          name: entity.name,
          currentState: state.entities[entity.id] ?? entity.state,
          traits: (entity.state.traits as string[]) ?? [],
          voiceNotes: (entity.state.voice_notes as string) ?? '',
          archetype: entity.state.archetype as string | undefined,
          appearance: entity.state.appearance as Record<string, string> | undefined,
        });
      }
    }

    // L4: Relationship Context
    const relationshipContext = this._buildRelationshipContext(event, state);

    // L5: World Facts
    const worldFacts = this._buildWorldFacts(state, scores);

    // Knowledge Boundary
    const knowledgeBoundary = this._buildKnowledgeBoundary(event, state);

    // Active Threads
    const activeThreads = this._buildThreadStatus(event, state, threadDeclarations);

    // Active World Rules
    const activeRules = this._buildActiveRules(state, ruleDeclarations);

    // Track recent entities for recency penalty in next call
    this.recentEntities = [...event.participants.entities, ...this.recentEntities].slice(0, 10);

    const pkg: ContextPackage = {
      eventId: event.id,
      systemContext: sysCtx,
      sceneSpec,
      characterSnapshots,
      relationshipContext,
      worldFacts,
      knowledgeBoundary,
      activeThreads,
      volumeSummary,
      markdown: '',
      activeRules,
      narrativeTechniques: [],
    };

    // Render to markdown
    pkg.markdown = this.renderToMarkdown(pkg);

    return pkg;
  }

  private _buildSceneSpec(event: NarrativeEvent): SceneSpecification {
    return {
      goal: event.sceneBrief,
      beats: event.beats,
      povType: event.pov.type,
      povCharacter: event.pov.character,
      conflict: event.styleGuidance?.scenePacing ?? 'TBD',
      expectedOutcome: event.postconditions
        .map((pc) => `${pc.entityId}.${pc.attribute} = ${pc.value}`)
        .join('; '),
      emotionalValence: event.emotionalValence,
      authorNotes: event.authorNotes,
    };
  }

  private _buildCharacterSnapshots(
    event: NarrativeEvent,
    entities: EntityLookup,
    state: WorldState,
    scores: RelevanceScore[],
  ): CharacterSnapshot[] {
    const snapshots: CharacterSnapshot[] = [];
    const seen = new Set<string>();

    // Always include POV character first
    const povEntity = entities.resolve(event.pov.character);
    if (povEntity && povEntity.kind === 'character') {
      seen.add(povEntity.id);
      snapshots.push({
        id: povEntity.id,
        name: povEntity.name,
        currentState: state.entities[povEntity.id] ?? {},
        traits: (povEntity.state.traits as string[]) ?? [],
        voiceNotes: (povEntity.state.voice_notes as string) ?? '',
        archetype: povEntity.state.archetype as string | undefined,
        appearance: povEntity.state.appearance as Record<string, string> | undefined,
      });
    }

    // Add other relevant characters by score
    for (const score of scores) {
      if (seen.has(score.entity)) continue;
      const entity = entities.resolve(score.entity);
      if (entity?.kind !== 'character') continue;
      if (score.score < 0.2) continue;
      seen.add(entity.id);

      snapshots.push({
        id: entity.id,
        name: entity.name,
        currentState: state.entities[entity.id] ?? entity.state,
        traits: (entity.state.traits as string[]) ?? [],
        voiceNotes: (entity.state.voice_notes as string) ?? '',
        archetype: entity.state.archetype as string | undefined,
        appearance: entity.state.appearance as Record<string, string> | undefined,
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
      if (!activeEpoch) continue;
      const entityIds = Object.values(activeEpoch.memberships).map(
        (membership) => membership.entityId,
      );

      const hasParticipant = event.participants.entities.some((p) => entityIds.includes(p));
      if (!hasParticipant) continue;

      // Build pseudo participants tuple (first 2 for binary compat)
      const participants: [EntityId, EntityId] =
        entityIds.length >= 2
          ? [entityIds[0], entityIds[1]]
          : [entityIds[0] ?? '', entityIds[1] ?? ''];
      contexts.push({
        id: relKey,
        participants,
        currentState: {
          lifecycle: activeEpoch.lifecycle,
          dimensions: Object.fromEntries(
            Object.entries(activeEpoch.dimensions).map(([key, dimension]) => [
              key,
              dimension.value,
            ]),
          ),
        },
      });
    }

    return contexts;
  }

  private _buildWorldFacts(state: WorldState, scores: RelevanceScore[]): WorldFact[] {
    const topEntities = new Set(scores.filter((s) => s.score > 0.4).map((s) => s.entity));

    return state.facts
      .filter((f) => topEntities.has(f.entityId))
      .slice(0, 20)
      .map((f) => ({
        id: f.id,
        description: `${f.entityId}.${f.attribute}`,
        value: f.value,
      }));
  }

  private _buildKnowledgeBoundary(event: NarrativeEvent, state: WorldState): KnowledgeBoundary {
    const knownFacts = Object.values(state.epistemicLedger.claims)
      .filter(
        (claim) =>
          claim.subject === event.pov.character &&
          claim.assessment.type === 'settled' &&
          claim.assessment.polarity === 'affirmative',
      )
      .map((claim) => claim.propositionId);

    return { characterId: event.pov.character, knownFacts };
  }

  private _buildThreadStatus(
    event: NarrativeEvent,
    state: WorldState,
    declarations: readonly ThreadDeclaration[],
  ): ThreadStatus[] {
    const declarationsById = new Map(
      declarations.map((declaration) => [declaration.threadId, declaration]),
    );
    return Object.entries(state.threads).map(([id, data]) => {
      const goals = Object.values(data.goalStates);
      const progressEntry = event.threadProgress.find((transaction) => transaction.thread === id);
      const declaration = declarationsById.get(id);
      return {
        id,
        name: declaration?.name ?? id,
        progress: goals.filter((status) => status === 'achieved').length,
        total: goals.length,
        description: progressEntry?.advancement ?? declaration?.description ?? '',
      };
    });
  }

  private _buildActiveRules(
    state: WorldState,
    ruleDeclarations: RuleDeclaration[],
  ): RuleDeclaration[] {
    const activeRules: RuleDeclaration[] = [];
    for (const declaration of ruleDeclarations) {
      const ruleState = state.rules[declaration.ruleId];
      // Rule is active if it has runtime state and is enabled and not nullified.
      // Declarations with no runtime state are not yet materialized and cannot
      // be reported as active.
      if (ruleState?.activation === 'enabled' && ruleState.effectiveness !== 'nullified') {
        activeRules.push(declaration);
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
    if (pkg.sceneSpec.beats.length > 0) {
      lines.push('- Beats:');
      pkg.sceneSpec.beats.forEach((beat, index) => {
        lines.push(`  ${index + 1}. ${beat}`);
      });
    }
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
        lines.push(`  lifecycle: ${rc.currentState.lifecycle}`);
        for (const [key, value] of Object.entries(rc.currentState.dimensions)) {
          lines.push(`  ${key}: ${JSON.stringify(value)}`);
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
        lines.push(`- **${rule.name}** (${rule.ruleId}) [${rule.typeId}]`);
        for (const specification of Object.values(rule.specifications)) {
          lines.push(`  Statement: ${specification.statement}`);
        }
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

    // Volume Summary
    if (pkg.volumeSummary) {
      lines.push(pkg.volumeSummary);
      lines.push('');
    }

    return lines.join('\n');
  }
}
