// ============================================================================
// Novalistically — Knowledge: First-class entity types for the Knowledge system
// ============================================================================

import type { EntityId } from './entity.js';

// ——— KnowledgeDefinition ———

export interface KnowledgeDefinition {
  id: string;
  type: 'fact' | 'belief' | 'secret' | 'rumor' | 'discovery';
  subject: EntityId;       // who knows
  object: EntityId;        // about whom/what
  content: string;         // the knowledge itself
  confidence: number;      // 0-1
  acquiredAt: string;      // story time reference
  source: 'direct_experience' | 'hearsay' | 'deduction' | 'deception' | 'default';
  isVerified: boolean;     // true if confirmed by experience
  verificationEvent?: string;   // event that confirmed it
}

// ——— Knowledge Events ———

export type KnowledgeEventType = 'learn' | 'forget' | 'misbelieve' | 'deceive' | 'confirm';

export interface KnowledgeEvent {
  id: string;
  type: KnowledgeEventType;
  knowledgeId: string;
  targetEntity: EntityId;       // who learns/forgets etc.
  sourceEvent?: string;          // the narrative event that triggered this
  data: Record<string, unknown>; // event-specific payload
}
