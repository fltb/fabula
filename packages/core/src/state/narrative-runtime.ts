import { createEmptyBranchPath, includesPath } from '../branch/index.js';
import type { BranchPath } from '../types/branch.js';
import type {
  Fact,
  NarrativeEvent,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedger,
  TimeAnchor,
} from '../types/index.js';
import { compileNarrativeGraphs } from './graph-adapter.ts';
import type { CompiledNarrativeGraphs } from './graph-adapter.ts';
import { compileDiscourseBoundaries } from './discourse-context.ts';
import type { CompiledDiscourseRenderContext } from './discourse-context.ts';
import { compileStoryBoundariesFromGraph } from './story-boundaries.ts';
import type { StoryBoundaries } from './story-boundaries.ts';

// ═════════════════════════════════════════════════════════════════════════════
// CompiledNarrativeRuntime — single compiled artifact from graphs → state
// boundaries → discourse contexts, in that fixed production order.
// ═════════════════════════════════════════════════════════════════════════════

export interface CompiledNarrativeRuntime {
  readonly graphs: CompiledNarrativeGraphs;
  readonly boundaries: StoryBoundaries;
  readonly discourseContextsByEventId: Readonly<
    Record<string, CompiledDiscourseRenderContext>
  >;
}

export interface CompileNarrativeRuntimeInput {
  readonly events: readonly NarrativeEvent[];
  readonly initialFacts: readonly Fact[];
  readonly timeAnchors: readonly TimeAnchor[];
  readonly branchPath?: BranchPath;
  readonly discourseBranch?: string;
  readonly ledger: PlannedDiscourseLedger;
  readonly assertions: Readonly<Record<string, NarratorAssertion>>;
  readonly narratorProfiles: Readonly<Record<string, NarratorProfile>>;
  readonly initialThreads?: readonly { id: string }[];
}

/**
 * Compile the full narrative runtime for one branch in deterministic order:
 * 1. compile narrative graphs (story + discourse)
 * 2. compute graph-driven story state boundaries
 * 3. compile discourse render contexts
 *
 * Preflight errors at any step fail closed before provider / cache / prompt.
 * The standalone ReplayEngine / StateManager event-store APIs are untouched;
 * this is the production path for projects with a discourse ledger.
 */
export function compileNarrativeRuntime(
  input: CompileNarrativeRuntimeInput,
): CompiledNarrativeRuntime {
  const branchPath = input.branchPath ?? createEmptyBranchPath();
  const discourseBranch = input.discourseBranch ?? 'main';

  // Step 1 — compile narrative graphs (branch filtering happens inside)
  const graphs = compileNarrativeGraphs({
    events: input.events,
    initialFacts: input.initialFacts,
    initialThreads: input.initialThreads ?? [],
    timeAnchors: input.timeAnchors,
    branchPath,
    discourseBranch,
    ledger: input.ledger,
    assertions: input.assertions,
  });

  // Step 2 — compute graph-driven story state boundaries
  // Reuse the same branch filter compileNarrativeGraphs applies internally.
  const selectedEvents = input.events.filter((event) =>
    includesPath(event.branchExistence, branchPath),
  );
  const boundaries = compileStoryBoundariesFromGraph(
    selectedEvents,
    input.initialFacts,
    graphs.storyAdjacency,
    branchPath,
    input.initialThreads as Array<{ id: string }> | undefined,
  );

  // Step 3 — compile discourse render contexts
  const discourseContextsByEventId = compileDiscourseBoundaries(
    selectedEvents,
    input.ledger,
    input.assertions as Record<string, NarratorAssertion>,
    input.narratorProfiles as Record<string, NarratorProfile>,
    discourseBranch,
  );

  return { graphs, boundaries, discourseContextsByEventId };
}
