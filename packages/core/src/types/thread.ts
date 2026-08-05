// ============================================================================
// Novalistically — STATE-5: Thread Narrative State Types
// Thread = independent narrative-state domain; projects existence domains into
// author-defined long-range plot structure.
// ============================================================================

// ============================================================================
// 1. Identity (opaque branded strings)
// ============================================================================

import type { ActantModel, StructuralFunction } from './story-ir.js';
// ============================================================================
// 1. Identity (opaque branded strings)
// ============================================================================

/** ThreadId — permanent lineage, never reused across declarations */
export type ThreadId = string & { readonly __brand: 'ThreadId' };

/** ThreadRunId — one activation-to-closure incarnation */
export type ThreadRunId = string & { readonly __brand: 'ThreadRunId' };

// ============================================================================
// 2. Lifecycle
// ============================================================================

/**
 * Thread lifecycle:
 *  planned→active; active↔blocked; active→completed/abandoned;
 *  blocked→completed (if all blockers resolved + required goals met);
 *  blocked→abandoned; completed/abandoned→new run per reopen policy;
 *  retired is terminal.
 */
export type ThreadLifecycle =
  | 'planned'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'abandoned'
  | 'retired';

// ============================================================================
// 3. Goal / Milestone canonical states
// ============================================================================

/**
 * Goal lifecycle — absolute semantic status:
 *  pending → active → achieved | failed | waived
 */
export type GoalLifecycle = 'pending' | 'active' | 'achieved' | 'failed' | 'waived';

/**
 * Milestone lifecycle:
 *  pending → achieved | failed | waived | invalidated
 */
export type MilestoneLifecycle = 'pending' | 'achieved' | 'failed' | 'waived' | 'invalidated';

export interface GoalState {
  goalId: string;
  status: GoalLifecycle;
}

export interface MilestoneState {
  milestoneId: string;
  status: MilestoneLifecycle;
}

// ============================================================================
// 4. Time domain — clock isolation (story vs discourse)
// ============================================================================

/** Each thread type picks exactly one clock domain */
export type TimeDomain = 'story' | 'discourse';

// ============================================================================
// 5. ThreadTypeDefinition — immutable catalog-level type
// ============================================================================

export interface ThreadTypeDefinition {
  typeId: string;
  description: string;
  /** Ordered list of phases this thread progresses through */
  allowedPhases: string[];
  /** Reopen policy after completion/abandonment */
  lifecyclePolicy: {
    reopenPolicy: 'forbidden' | 'allowed' | 'requiresExplicitReason';
  };
  /** Clock domain: story (branch-resolved storyTime) or discourse (assembled order) */
  timeDomain: TimeDomain;
  /** Declared goals that this thread tracks */
  stableGoals: GoalState[];
  /** Declared milestones for this thread */
  stableMilestones: MilestoneState[];
  /** Optional narrative hints about this thread type */
  narrativeHints?: string[];
  /** Optional Propp structural function label */
  structuralFunction?: StructuralFunction;
  /** Optional Greimas actant role assignment */
  actantModel?: ActantModel;
  /** Provenance / author tracking */
  provenance?: string;
}

export interface ThreadTypeCatalog {
  types: Record<string, ThreadTypeDefinition>;
}

// ============================================================================
// 6. ThreadDeclaration — project-level declaration
// ============================================================================

export interface ThreadDeclaration {
  threadId: string;
  name: string;
  description: string;
  typeId: string;
  /** Optional initial phase; the compiler checks it against the type catalog. */
  initialPhase?: string;
  /** Initial bindings: role → entity/lineage/epoch/proposition */
  initialBindings?: Record<string, string>;
  /** Override initial goal states; IDs must be declared by the thread type. */
  initialGoalStates?: GoalState[];
  /** Override initial milestone states; IDs must be declared by the thread type. */
  initialMilestoneStates?: MilestoneState[];
  provenance?: string;
  /** Author-facing retained metadata for progress/reveal projections. */
  targetRevealChapter?: number;
  initialProgress?: string;
  structuralFunction?: StructuralFunction;
}

/** Canonical state_initial.threads declaration list. */
export type ThreadDeclarationCatalog = readonly ThreadDeclaration[];

// ============================================================================
// 7. ThreadRuntimeState — stored in WorldState
// ============================================================================

export interface ThreadRuntimeState {
  threadId: ThreadId;
  status: ThreadLifecycle;
  currentRunId: ThreadRunId;
  phase: string;
  /** Narrative function bindings: role → entity/lineage/epoch/proposition */
  bindings: Record<string, string>;
  /** Absolute goal states (goalId → status) */
  goalStates: Record<string, GoalLifecycle>;
  /** Absolute milestone states (milestoneId → status) */
  milestoneStates: Record<string, MilestoneLifecycle>;
  /** Hash of semantic state for merge comparison */
  semanticStateHash: string;
}

// ============================================================================
// 8. ThreadTransaction — one per node per thread
// ============================================================================

export interface ThreadTransaction {
  thread: string;
  runId: ThreadRunId;
  /** Status transition (if any) */
  status?: ThreadLifecycle;
  /** Phase transition (if any) */
  phase?: string;
  /** Final bindings after this node's effect */
  bindingsAfter?: Record<string, string>;
  /** Goal status writes (absolute) */
  goalSet?: GoalState[];
  /** Milestone status writes (absolute) */
  milestoneSet?: MilestoneState[];
  /** Provenance: eventId where this transaction originated */
  provenance: string;
  /** Narrative description of what advanced (from legacy ThreadProgressEntry) */
  advancement?: string;
}

// ============================================================================
// 9. Branch merge types
// ============================================================================

export type ThreadMergeStrategy = 'requireEqual' | 'selectBranch' | 'literal' | 'newRun';

export interface ThreadMergeResult {
  threadId: ThreadId;
  strategy: ThreadMergeStrategy;
  mergedState: ThreadRuntimeState;
  newRunId?: ThreadRunId;
}
