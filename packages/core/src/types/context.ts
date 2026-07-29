// ============================================================================
// Novalistically — Context Compiler & Render Types (§7.4.6, §7.4.17)
// ============================================================================

import type { DiscourseContextProjection, NarratorProfile } from './discourse.js';
import type { EntityId } from './entity.js';
import type { ThematicIntent } from './idea-ir.js';
import type { RuleDefinition } from './rule.js';
import type { RelationshipState } from './world.js';

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
  volumeSummary: string;
  markdown: string;
  activeRules?: RuleDefinition[];
  /** Resolved narrator profile for this event, when narratorProfileRef is set (S6c). */
  narratorProfile?: NarratorProfile;
  /** Pass 1-safe disclosure state derived from the planned discourse ledger. */
  discourseProjection?: DiscourseContextProjection;
}

export interface SystemContext {
  genre: string;
  style: string;
  narrativeRules: string[];
  /** Intended audience for this scene (e.g. "adult_literary", "young_adult") */
  targetAudience?: string;
  /** Whole-work thematic intent (S7a Idea IR), when declared in nova.yaml */
  thematicIntent?: ThematicIntent;
  /** Whole-work synopsis from nova.yaml, when declared */
  synopsis?: string;
}

export interface SceneSpecification {
  goal: string;
  povType: string;
  povCharacter: string;
  conflict: string;
  expectedOutcome: string;
  /** Emotional keynote for the scene (from event.emotionalValence) */
  emotionalValence?: string;
  /** Emotional beat from ideaIR.emotionalArc matching this event */
  emotionalBeat?: string;
  /** Free-form author notes passed verbatim to the Pass 1 prompt */
  authorNotes?: string[];
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
}

export interface WorldFact {
  id: string;
  description: string;
  value: unknown;
}

export interface KnowledgeBoundary {
  characterId: EntityId;
  knownFacts: string[];
}

export interface ThreadStatus {
  id: string;
  name: string;
  progress: number;
  total: number;
  description: string;
}

