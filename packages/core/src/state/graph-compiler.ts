import type {
  DiscourseGraph,
  EdgeClass,
  EffectiveCoordinate,
  GraphAbsenceWitness,
  GraphCacheEntry,
  GraphCompilerOptions,
  GraphCompilerResult,
  GraphEdge,
  GraphProviderOutput,
  GraphReadResolution,
  OutputDescriptor,
  ReadRequirement,
  StoryGraph,
} from '../types/graph.js';
import {
  AmbiguousOutputError,
  AssertionMismatchError,
  BranchCoverageError,
  BranchIncompatibilityError,
  CrossClockEdgeError,
  DuplicateBranchProviderError,
  DuplicateDiscoursePositionError,
  DynamicLifecycleError,
  EdgeOriginCycleError,
  EllipsisSummaryError,
  FutureTimeError,
  type GraphCompileError,
  IncomparableTimeError,
  InitialRootMisuseError,
  MergeInputError,
  MissingOutputError,
  NoOutputEdgeError,
  ProvenanceError,
  ReadMismatchError,
  SelfPredecessorError,
  SemanticOutputDependencyError,
  StaleProviderSelectionError,
  UnknownPredecessorError,
  UnknownReadIdError,
  UnorderedSameTimeConflictError,
} from '../types/graph.js';
// Novalistically — Graph Compiler (GRAPH-1)
// Compiled graph layer over deterministic replay effects.
// FIXED compiler order (§23):
// 1. normalize outputs → 2. reads → 3. filter branch → 4. resolve declarations
// → 5. validate coordinate/order → 6. infer providers/absence
// → 7. commutativity → 8. branch/closure/cycle validation → 9. hash/replay
// ============================================================================

// ============================================================================
// Internal compilation state
// ============================================================================

/**
 * A raw node fed into the compiler — represents one effect/event/action
 * with its coordinate, raw effects (to be normalized into outputs),
 * raw read requirements, branch scope, and optional explicit edges.
 */
export interface CompileNode {
  id: string;
  coordinate: EffectiveCoordinate;
  effects: RawEffect[];
  requirements: RawRequirement[];
  branchScope: string;
  explicitEdges?: ExplicitEdgeDecl[];
  isInitialRoot?: boolean;
}

/** A raw effect before normalisation into OutputDescriptor. */
export interface RawEffect {
  effectId: string;
  canonicalKey: string;
  value: unknown;
  isUnset?: boolean;
}

/** A raw read requirement before processing into ReadRequirement. */
export interface RawRequirement {
  requirementId: string;
  canonicalKey: string;
  predicate: { type: 'exists' } | { type: 'absent' } | { type: 'equals'; value: unknown };
  phase: 'stateBefore' | 'stateAfter';
  origin: 'precondition' | 'source' | 'rule' | 'scope' | 'lifecycle' | 'merge';
}

/** An explicit edge declaration from author input. */
export interface ExplicitEdgeDecl {
  predecessor: string;
  dependent: string;
  edgeClass: EdgeClass;
  causalGroupId?: string;
}

// ============================================================================
// Stage helpers
// ============================================================================

interface CompileState {
  nodeById: Map<string, CompileNode>;
  outputs: OutputDescriptor[];
  reads: ReadRequirement[];
  edges: GraphEdge[];
  resolutions: Map<string, GraphReadResolution>; // key: `${readId}:${branchScope}`
  errors: GraphCompileError[];
  storyGraphs: StoryGraph[];
  discourseGraphs: DiscourseGraph[];
  cache: GraphCacheEntry[];
}
function emptyState(nodes: CompileNode[]): CompileState {
  return {
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    outputs: [],
    reads: [],
    edges: [],
    resolutions: new Map(),
    errors: [],
    storyGraphs: [],
    discourseGraphs: [],
    cache: [],
  };
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `h${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

// ============================================================================
// Stage 1: Normalize outputs
// ============================================================================

function normalizeOutputs(state: CompileState, nodes: CompileNode[]): void {
  for (const node of nodes) {
    for (const effect of node.effects) {
      const output: OutputDescriptor = {
        outputId: effect.effectId,
        canonicalKey: effect.canonicalKey,
        value: effect.isUnset ? { type: 'unset' } : { type: 'set', data: effect.value },
        branchScope: node.branchScope,
        effectiveCoordinate: node.coordinate,
        provenanceHash: simpleHash(
          `${effect.effectId}:${effect.canonicalKey}:${JSON.stringify(effect.value)}:${node.branchScope}`,
        ),
      };
      state.outputs.push(output);
    }
  }
}

// ============================================================================
// Stage 2: Extract reads
// ============================================================================

function extractReads(state: CompileState, nodes: CompileNode[]): void {
  for (const node of nodes) {
    for (const raw of node.requirements) {
      const read: ReadRequirement = {
        readId: raw.requirementId,
        canonicalKey: raw.canonicalKey,
        predicate:
          raw.predicate.type === 'equals'
            ? { type: 'equals', value: raw.predicate.value }
            : raw.predicate,
        phase: raw.phase,
        branchScope: node.branchScope,
        origin: raw.origin,
      };
      state.reads.push(read);
    }
  }
}

// ============================================================================
// Stage 3: Filter branch
// ============================================================================

function filterBranch(
  state: CompileState,
  nodes: CompileNode[],
  branchFilter?: string,
): CompileNode[] {
  if (!branchFilter) return nodes;
  return nodes.filter((n) => {
    if (n.branchScope === branchFilter) return true;
    // Branch scope MUST be subset of predecessor/dependent applicability (§21)
    // initialState carries empty branchScope — include it
    return n.branchScope === '' && n.isInitialRoot;
  });
}

// ============================================================================
// Stage 4: Resolve declarations
// ============================================================================

function resolveDeclarations(state: CompileState, nodes: CompileNode[]): void {
  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    if (!node.explicitEdges) continue;

    for (const decl of node.explicitEdges) {
      // Check unknown predecessor
      if (decl.predecessor !== '' && !nodeIds.has(decl.predecessor)) {
        state.errors.push(new UnknownPredecessorError(decl.dependent, decl.predecessor));
        continue;
      }

      // Check self predecessor
      if (decl.predecessor === decl.dependent) {
        state.errors.push(new SelfPredecessorError(decl.dependent));
        continue;
      }

      // Check initial root misuse (§18)
      // initialState CANNOT be author_origin/same_coordinate_order predecessor
      if (
        decl.predecessor !== '' &&
        (decl.edgeClass === 'author_origin' || decl.edgeClass === 'same_coordinate_order')
      ) {
        const preNode = state.nodeById.get(decl.predecessor);
        if (preNode?.isInitialRoot) {
          state.errors.push(new InitialRootMisuseError(decl.dependent, decl.edgeClass));
          continue;
        }
      }

      state.edges.push({
        predecessor: decl.predecessor,
        dependent: decl.dependent,
        edgeClass: decl.edgeClass,
        causalGroupId: decl.causalGroupId,
      });
    }
  }
}

// ============================================================================
// Stage 5: Validate coordinate/order (§16–17)
// ============================================================================

function compareCoordinates(a: EffectiveCoordinate, b: EffectiveCoordinate): number | null {
  if (a.type !== b.type) return null; // cross-clock — incomparable

  if (a.type === 'storyTime' && b.type === 'storyTime') {
    // Simple string comparison of storyTime values
    if (a.value < b.value) return -1;
    if (a.value > b.value) return 1;
    return 0;
  }

  if (a.type === 'discoursePosition' && b.type === 'discoursePosition') {
    if (a.value < b.value) return -1;
    if (a.value > b.value) return 1;
    return 0;
  }

  return null;
}

function validateCoordinateOrder(state: CompileState, nodes: CompileNode[]): void {
  const discoursePositions = new Map<number, string>();

  for (const node of nodes) {
    // Check duplicate discourse position (§16)
    if (node.coordinate.type === 'discoursePosition') {
      const existing = discoursePositions.get(node.coordinate.value);
      if (existing) {
        state.errors.push(
          new DuplicateDiscoursePositionError(node.coordinate.value, existing, node.id),
        );
      } else {
        discoursePositions.set(node.coordinate.value, node.id);
      }
    }
  }

  // Validate edges for coordinate ordering
  for (const edge of state.edges) {
    const preNode = state.nodeById.get(edge.predecessor);
    const depNode = state.nodeById.get(edge.dependent);
    if (!preNode || !depNode) continue;

    // Cross-clock edges fail (§2, §16)
    if (preNode.coordinate.type !== depNode.coordinate.type) {
      state.errors.push(new CrossClockEdgeError(edge.predecessor, edge.dependent));
      continue;
    }

    const cmp = compareCoordinates(preNode.coordinate, depNode.coordinate);

    // Future time (§16)
    if (cmp !== null && cmp > 0) {
      state.errors.push(
        new FutureTimeError(depNode.coordinate, edge.dependent, preNode.coordinate),
      );
      continue;
    }

    // Incomparable time (§16)
    if (cmp === null) {
      state.errors.push(
        new IncomparableTimeError(edge.dependent, preNode.coordinate, depNode.coordinate),
      );
      continue;
    }

    // Same coordinate requires order edge or commutativity
    if (cmp === 0 && edge.edgeClass !== 'same_coordinate_order') {
      // This will be checked in commutativity stage — flag if no ordering edge
    }
  }
}

// ============================================================================
// Stage 6: Infer providers/absence (§12–14)
// ============================================================================

/** Select the MAXIMAL write for a given canonicalKey and branch scope. */
function findMaximalProvider(
  canonicalKey: string,
  branchScope: string,
  outputs: OutputDescriptor[],
  readCoordinate?: EffectiveCoordinate,
): OutputDescriptor | null {
  const compatible = outputs.filter((o) => {
    if (o.canonicalKey !== canonicalKey) return false;
    // Branch compatibility: branch scope must be compatible
    if (o.branchScope !== branchScope && o.branchScope !== '') return false;
    // Coordinate must be earlier-or-same-and-ordered
    if (readCoordinate) {
      const cmp = compareCoordinates(o.effectiveCoordinate, readCoordinate);
      if (cmp === null || cmp > 0) return false;
    }
    return true;
  });

  if (compatible.length === 0) return null;

  // Select MAXIMAL (latest) by coordinate
  compatible.sort((a, b) => {
    const cmp = compareCoordinates(a.effectiveCoordinate, b.effectiveCoordinate);
    if (cmp !== null && cmp !== 0) return cmp;
    // Same coordinate — by output insertion order (last wins)
    return outputs.indexOf(a) - outputs.indexOf(b);
  });

  return compatible[compatible.length - 1];
}

function inferProviders(state: CompileState, nodes: CompileNode[]): void {
  for (const read of state.reads) {
    const resolutionKey = `${read.readId}:${read.branchScope}`;

    // Check if already resolved via explicit provider_selection
    if (state.resolutions.has(resolutionKey)) continue;

    const provider = findMaximalProvider(read.canonicalKey, read.branchScope, state.outputs);

    if (provider) {
      // Verify output satisfies read predicate (§12)
      let predicateSatisfied = true;
      if (read.predicate.type === 'exists') {
        predicateSatisfied = provider.value.type === 'set';
      } else if (read.predicate.type === 'absent') {
        predicateSatisfied = provider.value.type === 'unset';
      } else if (read.predicate.type === 'equals') {
        predicateSatisfied =
          provider.value.type === 'set' &&
          JSON.stringify(provider.value.data) === JSON.stringify(read.predicate.value);
      }

      if (!predicateSatisfied) {
        state.errors.push(
          new AssertionMismatchError(
            JSON.stringify(read.predicate),
            JSON.stringify(provider.value),
            read.readId,
          ),
        );
        continue;
      }

      const resolved: GraphProviderOutput = {
        type: 'output',
        outputId: provider.outputId,
        canonicalKey: provider.canonicalKey,
        coordinate: provider.effectiveCoordinate,
        provenanceHash: provider.provenanceHash,
      };
      state.resolutions.set(resolutionKey, resolved);

      // Record provider edge
      const outputNode = nodes.find((n) =>
        state.outputs.some(
          (o) =>
            o.outputId === provider.outputId &&
            n.effects.some((e) => e.effectId === provider.outputId),
        ),
      );
      if (outputNode) {
        state.edges.push({
          predecessor: outputNode.id,
          dependent: read.readId,
          edgeClass: 'provider',
        });
      }
    } else {
      // AbsenceWitness — no matching write (§12, §21)
      const witness: GraphAbsenceWitness = {
        type: 'absence',
        readId: read.readId,
        canonicalKey: read.canonicalKey,
        reason: `No compatible write for "${read.canonicalKey}" in branch "${read.branchScope}"`,
      };
      state.resolutions.set(resolutionKey, witness);
    }
  }
}

// ============================================================================
// Stage 7: Commutativity (§17)
// ============================================================================

function validateCommutativity(state: CompileState, nodes: CompileNode[]): void {
  // Group nodes by same coordinate
  const groups = new Map<string, CompileNode[]>();

  for (const node of nodes) {
    const key = JSON.stringify(node.coordinate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(node);
  }

  for (const [, group] of groups) {
    if (group.length <= 1) continue;

    // Check that same-coordinate nodes are ordered OR commutative
    const ordered = new Set<string>();
    for (const edge of state.edges) {
      if (edge.edgeClass === 'same_coordinate_order') {
        ordered.add(`${edge.predecessor}:${edge.dependent}`);
      }
    }

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        // Check if explicitly ordered in either direction
        const aBeforeB = ordered.has(`${a.id}:${b.id}`);
        const bBeforeA = ordered.has(`${b.id}:${a.id}`);

        if (aBeforeB || bBeforeA) continue; // explicitly ordered — OK

        // Check for commutativity: non-overlapping read/write sets
        const aKeys = new Set(a.effects.map((e) => e.canonicalKey));
        const bKeys = new Set(b.effects.map((e) => e.canonicalKey));

        const aReadKeys = new Set(a.requirements.map((r) => r.canonicalKey));
        const bReadKeys = new Set(b.requirements.map((r) => r.canonicalKey));

        // Conflict if one writes what the other reads or writes
        const overlap =
          [...aKeys].some((k) => bKeys.has(k) || bReadKeys.has(k)) ||
          [...bKeys].some((k) => aReadKeys.has(k));

        if (overlap) {
          state.errors.push(new UnorderedSameTimeConflictError(a.id, a.coordinate, b.id));
        }
      }
    }
  }
}

// ============================================================================
// Stage 8: Branch/closure/cycle validation (§20–21)
// ============================================================================

function validateBranches(state: CompileState, nodes: CompileNode[]): void {
  // Check each read per branch has a resolution (§21)
  for (const read of state.reads) {
    const resolutionKey = `${read.readId}:${read.branchScope}`;
    if (!state.resolutions.has(resolutionKey)) {
      state.errors.push(new BranchCoverageError(read.branchScope, read.readId));
    }
  }

  // Check for duplicate branch providers
  const providerByBranch = new Map<string, Set<string>>();
  for (const [key, res] of state.resolutions) {
    if (res.type !== 'output') continue;
    const [, branch] = key.split(':');
    if (!providerByBranch.has(branch)) providerByBranch.set(branch, new Set());
    const set = providerByBranch.get(branch)!;
    if (set.has(res.outputId)) {
      state.errors.push(
        new DuplicateBranchProviderError(res.outputId, branch, res.outputId, res.outputId),
      );
    }
    set.add(res.outputId);
  }
}

function detectCycles(state: CompileState): void {
  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const edge of state.edges) {
    if (!adj.has(edge.predecessor)) adj.set(edge.predecessor, []);
    adj.get(edge.predecessor)!.push(edge.dependent);
  }

  // DFS cycle detection
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    if (visiting.has(node)) {
      // Found cycle — extract from path
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart);
      state.errors.push(new EdgeOriginCycleError(cycle));
      return true;
    }
    if (visited.has(node)) return false;

    visiting.add(node);
    path.push(node);

    const neighbors = adj.get(node) ?? [];
    for (const next of neighbors) {
      if (dfs(next)) return true;
    }

    path.pop();
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const node of adj.keys()) {
    dfs(node);
  }
}

// ============================================================================
// Stage 9: Hash/replay
// ============================================================================

function computeGraphHash(state: CompileState, nodes: CompileNode[]): string {
  const input =
    state.edges.map((e) => `${e.predecessor}:${e.dependent}:${e.edgeClass}`).join('|') +
    '|' +
    state.outputs.map((o) => o.provenanceHash).join('|') +
    '|' +
    [...state.resolutions.values()]
      .map((r) => (r.type === 'output' ? r.provenanceHash : `${r.readId}:absent`))
      .join('|');
  return simpleHash(input);
}

function buildCacheEntry(state: CompileState, coordinatePrefix: string): GraphCacheEntry {
  return {
    targetCoordinatePrefix: coordinatePrefix,
    sameCoordinateAncestors: [],
    dependencyHashes: state.edges.map((e) => simpleHash(JSON.stringify(e))),
    outputHashes: state.outputs.map((o) => o.provenanceHash),
    absenceHashes: [...state.resolutions.values()]
      .filter((r): r is GraphAbsenceWitness => r.type === 'absence')
      .map((a) => simpleHash(`${a.readId}:${a.canonicalKey}`)),
    timestamp: Date.now(),
  };
}

// ============================================================================
// Main compile function
// ============================================================================

/**
 * Compile raw nodes into typed StoryGraph and DiscourseGraph structures.
 * Follows the FIXED 9-stage compiler order.
 *
 * @param nodes  Raw compile nodes representing effects/events/actions
 * @param options  Compiler options (branch filter, etc.)
 * @returns  Compiler result with graphs, cache, and errors
 */
export function compileGraph(
  nodes: CompileNode[],
  options: GraphCompilerOptions = {},
): GraphCompilerResult {
  const state = emptyState(nodes);

  // ── Stage 1: Normalize outputs ──────────────────────────────────────────
  normalizeOutputs(state, nodes);

  // ── Stage 2: Extract reads ──────────────────────────────────────────────
  extractReads(state, nodes);

  // ── Stage 3: Filter branch ──────────────────────────────────────────────
  const branchNodes = filterBranch(state, nodes, options.branchPath);

  // ── Stage 4: Resolve declarations ──────────────────────────────────────
  resolveDeclarations(state, branchNodes);

  // ── Stage 5: Validate coordinate/order ──────────────────────────────────
  validateCoordinateOrder(state, branchNodes);

  // ── Stage 6: Infer providers/absence ────────────────────────────────────
  inferProviders(state, branchNodes);

  // ── Stage 7: Commutativity ──────────────────────────────────────────────
  validateCommutativity(state, branchNodes);

  // ── Stage 8: Branch/closure/cycle validation ───────────────────────────
  validateBranches(state, branchNodes);
  detectCycles(state);

  // ── Stage 9: Hash/replay ────────────────────────────────────────────────
  const hash = computeGraphHash(state, branchNodes);

  // Collect output IDs from branch nodes
  const branchOutputIds = new Set<string>();
  for (const node of branchNodes) {
    for (const eff of node.effects) {
      branchOutputIds.add(eff.effectId);
    }
  }
  // Partition nodes into story vs discourse graphs
  const storyNodes = branchNodes.filter((n) => n.coordinate.type === 'storyTime');
  const discourseNodes = branchNodes.filter((n) => n.coordinate.type === 'discoursePosition');

  if (storyNodes.length > 0) {
    const storyOutputs = state.outputs.filter(
      (o) => o.effectiveCoordinate.type === 'storyTime' && branchOutputIds.has(o.outputId),
    );
    const storyReads = state.reads.filter((r) =>
      storyNodes.some((n) => n.requirements.some((req) => req.requirementId === r.readId)),
    );

    const storyGraph: StoryGraph = {
      type: 'story',
      edges: state.edges.filter((e) =>
        storyNodes.some((n) => n.id === e.predecessor || n.id === e.dependent),
      ),
      outputs: storyOutputs,
      reads: storyReads,
      resolutions: [...state.resolutions.values()],
      hash: simpleHash(`story:${hash}`),
      effectiveCoordinate: {
        type: 'storyTime',
        value: storyNodes[0].coordinate.type === 'storyTime' ? storyNodes[0].coordinate.value : '',
      },
    };
    state.storyGraphs.push(storyGraph);
  }

  if (discourseNodes.length > 0) {
    const discourseOutputs = state.outputs.filter(
      (o) => o.effectiveCoordinate.type === 'discoursePosition' && branchOutputIds.has(o.outputId),
    );

    const discourseGraph: DiscourseGraph = {
      type: 'discourse',
      edges: state.edges.filter((e) =>
        discourseNodes.some((n) => n.id === e.predecessor || n.id === e.dependent),
      ),
      outputs: discourseOutputs,
      hash: simpleHash(`discourse:${hash}`),
      effectiveCoordinate: {
        type: 'discoursePosition',
        value:
          discourseNodes[0].coordinate.type === 'discoursePosition'
            ? discourseNodes[0].coordinate.value
            : 0,
      },
      sceneSequence: [],
    };
    state.discourseGraphs.push(discourseGraph);
  }

  // Build cache entries
  const coordinatePrefix = options.branchPath ?? 'root';
  state.cache.push(buildCacheEntry(state, coordinatePrefix));

  return {
    storyGraphs: state.storyGraphs,
    discourseGraphs: state.discourseGraphs,
    cache: state.cache,
    errors: state.errors,
  };
}

/**
 * Build a single StoryGraph from story-time nodes.
 * Thin wrapper over compileGraph for convenience.
 */
export function compileStoryGraph(
  nodes: CompileNode[],
  options: GraphCompilerOptions = {},
): StoryGraph | null {
  const result = compileGraph(nodes, options);
  return result.storyGraphs[0] ?? null;
}

/**
 * Build a single DiscourseGraph from discourse-position nodes.
 * Thin wrapper over compileGraph for convenience.
 */
export function compileDiscourseGraph(
  nodes: CompileNode[],
  options: GraphCompilerOptions = {},
): DiscourseGraph | null {
  const result = compileGraph(nodes, options);
  return result.discourseGraphs[0] ?? null;
}
