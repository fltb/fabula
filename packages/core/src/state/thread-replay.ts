// ============================================================================
// Novalistically — Thread Transaction Replay
// Applies ThreadTransaction to WorldState for STATE-5 thread narrative state.
// Handles clock isolation (story vs discourse) and branch merge.
// ============================================================================

import type {
  GoalLifecycle,
  MilestoneLifecycle,
  ThreadId,
  ThreadLifecycle,
  ThreadMergeResult,
  ThreadMergeStrategy,
  ThreadRunId,
  ThreadRuntimeState,
  ThreadTransaction,
  TimeDomain,
} from '../types/index.js';

// ============================================================================
// Constants
// ============================================================================

const VALID_THREAD_TRANSITIONS: Array<[ThreadLifecycle, ThreadLifecycle]> = [
  ['planned', 'active'],
  ['active', 'blocked'],
  ['active', 'completed'],
  ['active', 'abandoned'],
  ['blocked', 'active'],
  ['blocked', 'completed'],
  ['blocked', 'abandoned'],
  ['completed', 'planned'],
  ['completed', 'active'],
  ['abandoned', 'planned'],
  ['abandoned', 'active'],
  ['planned', 'retired'],
  ['active', 'retired'],
  ['blocked', 'retired'],
  ['completed', 'retired'],
  ['abandoned', 'retired'],
];

// ============================================================================
// 1. ThreadTransaction application
// ============================================================================

/**
 * applyThreadTransaction — Apply a single ThreadTransaction to the
 * world state threads map. Handles state creation, lifecycle transitions,
 * phase changes, binding updates, goal/milestone state writes.
 */
export function applyThreadTransaction(
  threads: Record<string, ThreadRuntimeState>,
  tx: ThreadTransaction,
): void {
  const threadId = tx.thread as ThreadId;

  // Get or create runtime state
  let state = threads[threadId];
  let isNew = false;

  if (!state) {
    isNew = true;
    // Create new runtime state from transaction
    state = threads[threadId] = {
      threadId,
      status: tx.status ?? 'planned',
      currentRunId: tx.runId,
      phase: tx.phase ?? '',
      bindings: tx.bindingsAfter ?? {},
      goalStates: {},
      milestoneStates: {},
      semanticStateHash: '',
    };
  }

  // Apply lifecycle transition (skip if state was just created with this status or same-as-current)
  if (tx.status && !isNew && tx.status !== state.status) {
    validateThreadTransition(state.status, tx.status, tx.provenance);
    state.status = tx.status;
  }

  // Update run ID if provided
  state.currentRunId = tx.runId;

  // Apply phase change
  if (tx.phase !== undefined) {
    state.phase = tx.phase;
  }

  // Apply binding updates
  if (tx.bindingsAfter) {
    state.bindings = { ...state.bindings, ...tx.bindingsAfter };
  }

  // Apply goal state writes
  if (tx.goalSet) {
    for (const gs of tx.goalSet) {
      state.goalStates[gs.goalId] = gs.status;
    }
  }

  // Apply milestone state writes
  if (tx.milestoneSet) {
    for (const ms of tx.milestoneSet) {
      state.milestoneStates[ms.milestoneId] = ms.status;
    }
  }

  // Update semantic state hash
  state.semanticStateHash = computeSemanticHash(state);
}

/**
 * validateThreadTransition — validates lifecycle transitions.
 * Throws on invalid transitions.
 */
function validateThreadTransition(
  from: ThreadLifecycle,
  to: ThreadLifecycle,
  provenance: string,
): void {
  // Retired is terminal — no transitions out
  if (from === 'retired') {
    throw new Error(
      `Invalid thread lifecycle transition: retired→${to} (terminal). Provenance: ${provenance}`,
    );
  }

  // completed/abandoned can only go to planned or active (reopen)
  if ((from === 'completed' || from === 'abandoned') && to !== 'planned' && to !== 'active') {
    throw new Error(
      `Invalid thread lifecycle transition: ${from}→${to}. Only planned/active allowed for reopen. Provenance: ${provenance}`,
    );
  }

  const isValid = VALID_THREAD_TRANSITIONS.some(([f, t]) => f === from && t === to);
  if (!isValid) {
    throw new Error(
      `Invalid thread lifecycle transition: ${from}→${to}. Provenance: ${provenance}`,
    );
  }
}

// ============================================================================
// 2. Clock isolation
// ============================================================================

/**
 * getThreadTimeDomain — Determines the clock domain for a thread.
 * In the absence of a ThreadTypeCatalog, defaults to 'story'
 * (the most common domain).
 */
export function getThreadTimeDomain(
  threadId: string,
  typeCatalog?: Record<string, { timeDomain: TimeDomain }>,
  threadDeclarations?: Record<string, { typeId: string }>,
): TimeDomain {
  if (typeCatalog && threadDeclarations) {
    const decl = threadDeclarations[threadId];
    if (decl) {
      const typeDef = typeCatalog[decl.typeId];
      if (typeDef) {
        return typeDef.timeDomain;
      }
    }
  }
  return 'story';
}

/**
 * assertClockCompatibility — Enforces that transactions from different
 * clock domains cannot be applied in the same pass. In practice, this
 * is a no-op at the transaction level (the constraint is enforced
 * structurally by the replay ordering), but provided for explicit checks.
 */
export function assertClockCompatibility(domain: TimeDomain, tx: ThreadTransaction): void {
  // Clock domain is a type-level constraint, not per-transaction.
  // This function is a hook for future cross-clock-provider edge detection.
  void domain;
  void tx;
}

// ============================================================================
// 3. Branch merge
// ============================================================================

/**
 * mergeThreadStates — Merges two ThreadRuntimeState instances for
 * branch-aware state reconstruction.
 *
 * Story-domain: semantic equality auto-converges (provider lineage preserved);
 * else requireEqual/selectBranch/literal.
 * Discourse-domain: branch-local/non-destructive merge.
 *
 * Different active story runs merging → new merge run, branch-local bindings remint.
 */
export function mergeThreadStates(
  left: ThreadRuntimeState,
  right: ThreadRuntimeState,
  strategy: ThreadMergeStrategy = 'requireEqual',
): ThreadMergeResult {
  const threadId = left.threadId;

  if (strategy === 'requireEqual') {
    // Auto-converge if semantic hashes match
    if (left.semanticStateHash === right.semanticStateHash) {
      return {
        threadId,
        strategy: 'requireEqual',
        mergedState: { ...left },
      };
    }
    // Different hashes with requireEqual → error
    throw new Error(
      `Thread merge conflict: "${threadId}" hashes differ (${left.semanticStateHash} vs ${right.semanticStateHash}) and requireEqual strategy selected.`,
    );
  }

  if (strategy === 'selectBranch') {
    // Select the more advanced state (prefer right for branch resolution)
    return {
      threadId,
      strategy: 'selectBranch',
      mergedState: { ...right },
    };
  }

  if (strategy === 'literal') {
    // Literal merge: take left's status/runId/phase, right's bindings
    // and union of goal/milestone states
    const merged: ThreadRuntimeState = {
      ...left,
      bindings: { ...left.bindings, ...right.bindings },
      goalStates: { ...left.goalStates, ...right.goalStates },
      milestoneStates: { ...left.milestoneStates, ...right.milestoneStates },
    };
    merged.semanticStateHash = computeSemanticHash(merged);
    return {
      threadId,
      strategy: 'literal',
      mergedState: merged,
    };
  }

  if (strategy === 'newRun') {
    // New merge run: keep left's base state, create new run, remint bindings
    const newRunId = `merge-${left.currentRunId}-${right.currentRunId}` as ThreadRunId;
    const merged: ThreadRuntimeState = {
      ...left,
      threadId,
      currentRunId: newRunId,
      bindings: { ...left.bindings, ...right.bindings },
      goalStates: { ...left.goalStates, ...right.goalStates },
      milestoneStates: { ...left.milestoneStates, ...right.milestoneStates },
      semanticStateHash: '',
    };
    merged.semanticStateHash = computeSemanticHash(merged);
    return {
      threadId,
      strategy: 'newRun',
      mergedState: merged,
      newRunId,
    };
  }

  // Fallback: requireEqual behavior
  return {
    threadId,
    strategy: 'requireEqual',
    mergedState: { ...left },
  };
}

// ============================================================================
// 4. Helpers
// ============================================================================

/**
 * computeSemanticHash — Computes a deterministic hash of a thread runtime
 * state for merge comparison. Uses a simple JSON-based string hash.
 */
function computeSemanticHash(state: ThreadRuntimeState): string {
  // Deterministic: sort keys, produce stable JSON, hash
  const canonical = JSON.stringify(state, Object.keys(state).sort());
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    const char = canonical.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return `h${Math.abs(hash).toString(36)}`;
}

/**
 * initializeThreadRuntimeState — Creates a new ThreadRuntimeState from
 * a ThreadDeclaration and ThreadTypeDefinition.
 */
export function initializeThreadRuntimeState(
  threadId: string,
  declaration: {
    initialPhase?: string;
    initialBindings?: Record<string, string>;
    initialGoalStates?: { goalId: string; status: GoalLifecycle }[];
    initialMilestoneStates?: { milestoneId: string; status: MilestoneLifecycle }[];
  },
  typeDef: {
    allowedPhases: string[];
    stableGoals: { goalId: string; status: GoalLifecycle }[];
    stableMilestones: { milestoneId: string; status: MilestoneLifecycle }[];
  },
  initialStatus: ThreadLifecycle = 'planned',
): ThreadRuntimeState {
  const goalStates: Record<string, GoalLifecycle> = {};
  const milestoneStates: Record<string, MilestoneLifecycle> = {};

  // Initialize from type definition
  for (const g of typeDef.stableGoals) {
    goalStates[g.goalId] = g.status;
  }
  for (const m of typeDef.stableMilestones) {
    milestoneStates[m.milestoneId] = m.status;
  }

  // Override with declaration-specific initial states
  if (declaration.initialGoalStates) {
    for (const g of declaration.initialGoalStates) {
      goalStates[g.goalId] = g.status;
    }
  }
  if (declaration.initialMilestoneStates) {
    for (const m of declaration.initialMilestoneStates) {
      milestoneStates[m.milestoneId] = m.status;
    }
  }

  const state: ThreadRuntimeState = {
    threadId: threadId as ThreadId,
    status: initialStatus,
    currentRunId: `init-${threadId}` as ThreadRunId,
    phase: declaration.initialPhase ?? typeDef.allowedPhases[0] ?? '',
    bindings: declaration.initialBindings ?? {},
    goalStates,
    milestoneStates,
    semanticStateHash: '',
  };
  state.semanticStateHash = computeSemanticHash(state);
  return state;
}
