// ============================================================================
// Novalistically — Context Compiler & Render Types (§7.4.6, §7.4.17)
// ============================================================================

import type { EntityId } from './entity.js';
import type { RelationshipState } from './world.js';
import type { StyleGuidance } from './event.js';

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
  markdown: string;
}

export interface SystemContext {
  genre: string;
  style: string;
  narrativeRules: string[];
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

export interface ScribeOutput {
  prose: string;
  newFacts: Array<{
    entity: string;
    attribute: string;
    value: unknown;
    confidence: number;
  }>;
  threadProgress?: Array<{
    thread: string;
    advancement: string;
    progressAfter: number;
  }>;
  foreshadowingPlanted?: Array<{
    id: string;
    hint: string;
    targetRevealChapter: number;
  }>;
}
