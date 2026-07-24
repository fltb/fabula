// ============================================================================
// Novalistically — S8: Planner Types (forward event generation)
// ============================================================================

import type { Fact } from './entity.js';

// ---------------------------------------------------------------------------
// Precondition — a condition on WorldState that must hold for an action to
// be available. Mirrors the structure of EventFile precondition entries but
// typed as a standalone interface.
// ---------------------------------------------------------------------------
export interface Precondition {
  entity: string;
  attribute: string;
  value?: unknown;
  operator?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'exists' | 'not_exists';
  narrativeHint?: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Effect — a postcondition asserted after an action is taken.
// ---------------------------------------------------------------------------
export interface Effect {
  entity: string;
  attribute: string;
  value?: unknown;
  confidence?: number;
  narrativeHint?: string;
}

// ---------------------------------------------------------------------------
// Planner mode — determines how candidate events are produced.
//   manual : author writes YAML, system validates preconditions against WS
//   suggest: system proposes candidates, author selects
//   auto   : research-grade, deferred
// ---------------------------------------------------------------------------
export type NarrativePlannerMode = 'manual' | 'suggest' | 'auto';

// ---------------------------------------------------------------------------
// NarrativeGoal — an author-defined goal that the planner tries to satisfy.
// Distinct from thread's GoalLifecycle: adds successCondition (verifiable WS
// predicate) and priority (multi-goal decision).
// ---------------------------------------------------------------------------
export interface NarrativeGoal {
  goalId: string;
  threadId: string;
  description: string;
  type: 'achieve' | 'maintain' | 'avoid' | 'resolve';
  priority: number;
  preconditions?: Fact[];
  successCondition: {
    entity: string;
    attribute: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'exists';
    value: unknown;
  };
  suggestedEvents?: string[];
}

// ---------------------------------------------------------------------------
// ActionDefinition — the catalog entry that tells the planner what events are
// possible. Each entry defines preconditions (WorldState facts that must
// hold), effects (postconditions), and narrative metadata.
// ---------------------------------------------------------------------------
export interface ActionDefinition {
  actionId: string;
  name: string;
  description: string;
  preconditions: Precondition[];
  effects: Effect[];
  narrativeTags: string[];
  typicalDuration: number;
  typicalArcPositions: string[];
  conflictTypes?: string[];
  resolutionTypes?: string[];
  relatedThreadTypes?: string[];
}
