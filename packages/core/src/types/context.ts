// ============================================================================
// Novalistically — Context Compiler & Render Types (§7.4.6, §7.4.17)
// ============================================================================

import type { EntityId } from './entity.js';
import type { RelationshipState } from './world.js';
import type { RuleDefinition } from './rule.js';
import type { NarratorProfile } from './discourse.js';
import type { ThematicIntent } from './idea-ir.js';

// ——— Relevance Score ———

export interface RelevanceScore {
  entity: EntityId;
  score: number;
  basis: {
    participation: number;
    threadAssociation: number;
    spatioTemporal: number;
    knowledgeIntersection: number;
    relationshipRelevance: number;
    specificityBonus: number;
    recencyPenalty: number;
    importanceBonus: number;
  };
}

// ——— Context Package (§7.4.6) ———

export interface ContextPackage {
  eventId: string;
  systemContext: SystemContext;
  sceneSpec: SceneSpecification;
  characterSnapshots: CharacterSnapshot[];
  relationshipContext: RelationshipContext[];
  worldFacts: WorldFact[];
  knowledgeBoundary: KnowledgeBoundary;
  activeThreads: ThreadStatus[];
  previousSceneSummary: string;
  volumeSummary: string;
  markdown: string;
  activeRules?: RuleDefinition[];
  /** Resolved narrator profile for this event, when narratorProfileRef is set (S6c). */
  narratorProfile?: NarratorProfile;
  /** Discourse replay error message, when replayDiscourseState() threw for this event (DISCOURSE-1). */
  discourseReplayError?: string;
}

export interface SystemContext {
  genre: string;
  style: string;
  narrativeRules: string[];
  /** Intended audience for this scene (e.g. "adult_literary", "young_adult") */
  targetAudience?: string;
  /** Whole-work thematic intent (S7a Idea IR), when declared in nova.yaml */
  thematicIntent?: ThematicIntent;
}

export interface SceneSpecification {
  goal: string;
  povType: string;
  povCharacter: string;
  conflict: string;
  expectedOutcome: string;
}

export interface CharacterSnapshot {
  id: EntityId;
  name: string;
  currentState: Record<string, unknown>;
  traits: string[];
  voiceNotes: string;
  archetype?: string;
  appearance?: Record<string, string>;
}

export interface RelationshipContext {
  id: string;
  participants: [EntityId, EntityId];
  currentState: RelationshipState;
  unresolvedTensions: string[];
}

export interface WorldFact {
  id: string;
  description: string;
  value: unknown;
}

export interface KnowledgeBoundary {
  characterId: EntityId;
  knownFacts: string[];
  unknownFacts: string[];
}

export interface ThreadStatus {
  id: string;
  name: string;
  progress: number;
  total: number;
  description: string;
}

// ——— Render System (§7.4.17) ———
// Activated by PromptAssembler (context/prompt-assembler.ts)

export interface RenderRequest {
  event: string;
  mode: 'draft' | 'revise' | 'retry';
  revisionNotes?: string;
  provider?: string;
  model?: string;
  temperature?: number;
}

export interface FinalPrompt {
  systemPrompt: string;
  userPrompt: string;
}


