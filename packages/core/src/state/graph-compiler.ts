import { sha256Canonical } from '../cache/render-cache.js';
import { compareStoryCoordinates } from '../entity/timestamp.js';
import { DagCycleError, DagProviderError } from '../errors.js';
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
  ReadPhase,
  ReadRequirement,
  StoryGraph,
} from '../types/graph.js';
import {
  AssertionMismatchError,
  BranchCoverageError,
  CrossClockEdgeError,
  DuplicateBranchProviderError,
  DuplicateDiscoursePositionError,
  EdgeOriginCycleError,
  FutureTimeError,
  type GraphCompileError,
  InitialRootMisuseError,
  InvalidSameCoordinateOrderError,
  SelfPredecessorError,
  UnknownPredecessorError,
  UnknownReadIdError,
  UnorderedStoryConflictError,
} from '../types/graph.js';
import type { SceneStoryCoordinate, StoryCoordinate } from '../types/index.js';
import { buildStoryOrderIndex, isProvenBefore, type StoryOrderIndex } from './dag.js';
// Novalistically — Graph Compiler (GRAPH-1)
// Compiled graph layer over deterministic replay effects.
// FIXED compiler order (§23):
// 1. normalize outputs → 2. reads → 3. filter branch → 4. resolve declarations
// → 5. validate coordinate/order → 6. derive temporal edges
// → 7. pre-provider StoryOrderIndex → 8. infer providers/absence
// → 9. rebuild final StoryOrderIndex → 10. commutativity
// → 11. branch/closure/cycle validation → 12. hash/replay
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
  predicate:
    | { type: 'exists' }
    | { type: 'absent' }
    | { type: 'equals'; value: unknown }
    | { type: 'neq'; value: unknown }
    | { type: 'gt'; value: unknown }
    | { type: 'gte'; value: unknown }
    | { type: 'lt'; value: unknown }
    | { type: 'lte'; value: unknown }
    | { type: 'contains'; value: unknown }
    | { type: 'not_contains'; value: unknown };
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
  /** Final StoryOrderIndex after provider edges, used for commutativity. */
  finalOrder?: StoryOrderIndex;
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
        provenanceHash: sha256Canonical(
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
          // value-bearing predicates flow through to ReadRequirement;
          // non-value types (exists/absent) pass through as-is.
          raw.predicate.type === 'equals' ||
          raw.predicate.type === 'neq' ||
          raw.predicate.type === 'gt' ||
          raw.predicate.type === 'gte' ||
          raw.predicate.type === 'lt' ||
          raw.predicate.type === 'lte' ||
          raw.predicate.type === 'contains' ||
          raw.predicate.type === 'not_contains'
            ? { type: raw.predicate.type, value: raw.predicate.value }
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
  const selected = nodes.filter((n) => {
    if (n.branchScope === branchFilter) return true;
    // Branch scope MUST be subset of predecessor/dependent applicability (§21)
    // initialState carries empty branchScope — include it
    return n.branchScope === '' && n.isInitialRoot;
  });

  // Shrink compile state so excluded branches cannot affect resolutions/hashes
  const selectedOutputIds = new Set<string>();
  const selectedReadIds = new Set<string>();
  for (const node of selected) {
    for (const eff of node.effects) selectedOutputIds.add(eff.effectId);
    for (const req of node.requirements) selectedReadIds.add(req.requirementId);
  }

  state.nodeById = new Map(selected.map((n) => [n.id, n]));
  state.outputs = state.outputs.filter((o) => selectedOutputIds.has(o.outputId));
  state.reads = state.reads.filter((r) => selectedReadIds.has(r.readId));

  return selected;
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

function validateCoordinateOrder(state: CompileState, nodes: CompileNode[]): void {
  // Check duplicate discourse position (§16)
  const discoursePositions = new Map<number, string>();

  for (const node of nodes) {
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

  // Validate every explicit edge for coordinate ordering
  for (const edge of state.edges) {
    const preNode = state.nodeById.get(edge.predecessor);
    const depNode = state.nodeById.get(edge.dependent);
    if (!preNode || !depNode) continue;

    // Cross-domain edges (story ↔ discourse) are always invalid
    if (preNode.coordinate.type !== depNode.coordinate.type) {
      state.errors.push(new CrossClockEdgeError(edge.predecessor, edge.dependent));
      continue;
    }

    if (preNode.coordinate.type === 'storyTime' && depNode.coordinate.type === 'storyTime') {
      const preCoord = preNode.coordinate;
      const depCoord = depNode.coordinate;
      const order = compareStoryCoordinates(preCoord, depCoord);

      // same_coordinate_order: only valid for equal point coordinates
      if (edge.edgeClass === 'same_coordinate_order') {
        if (order !== 'equal' || preCoord.kind === 'initial') {
          state.errors.push(
            new InvalidSameCoordinateOrderError(edge.predecessor, edge.dependent, {
              code: 'INVALID_SAME_COORDINATE_ORDER',
              nodeId: edge.dependent,
              detail: `predecessor coordinate: ${JSON.stringify(preCoord)}, dependent coordinate: ${JSON.stringify(depCoord)}`,
            }),
          );
        }
        continue;
      }

      // For author_origin, internal, and provider edges:
      // - cross-clock (incomparable) is allowed — provides causal DAG for unlocated scenes
      // - unlocated vs anything is 'incomparable' — allowed
      // - equal coordinates are allowed
      // - only same-clock point predecessors that are strictly later than dependent fail
      if (order === 'incomparable') continue;
      if (order === 'equal') continue;
      if (order === 'after') {
        state.errors.push(new FutureTimeError(depCoord, edge.dependent, preCoord));
        continue;
      }
      // order === 'before' — correct direction, OK
    }

    if (
      preNode.coordinate.type === 'discoursePosition' &&
      depNode.coordinate.type === 'discoursePosition'
    ) {
      if (preNode.coordinate.value > depNode.coordinate.value) {
        state.errors.push(
          new FutureTimeError(depNode.coordinate, edge.dependent, preNode.coordinate),
        );
      }
    }
  }
}

// ============================================================================
// Stage 6: Derive temporal internal edges
// ============================================================================

/**
 * Add derived internal edges between adjacent same-clock scalar buckets.
 * Only storyTime point coordinates generate temporal edges; unlocated,
 * initial, and discourse nodes are excluded. Bipartite edges connect every
 * node in bucket N to every node in bucket N+1 of the same clock, using
 * causalGroupId = "temporal:<clock>:<fromScalar>:<toScalar>".
 * Transitivity guarantees that any earlier point reaches any later one.
 */
function deriveTemporalEdges(state: CompileState, nodes: CompileNode[]): void {
  const storyNodes = nodes.filter(
    (n): n is CompileNode & { coordinate: StoryCoordinate } => n.coordinate.type === 'storyTime',
  );

  // Group point nodes by clock
  const byClock = new Map<string, { nodeId: string; scalar: number }[]>();
  for (const node of storyNodes) {
    if (node.coordinate.kind !== 'point') continue;
    const entries = byClock.get(node.coordinate.clock);
    if (entries) {
      entries.push({ nodeId: node.id, scalar: node.coordinate.scalar });
    } else {
      byClock.set(node.coordinate.clock, [{ nodeId: node.id, scalar: node.coordinate.scalar }]);
    }
  }

  // Build equal-scalar buckets and add bipartite edges between adjacent buckets
  for (const [clock, entries] of byClock) {
    entries.sort((a, b) => a.scalar - b.scalar);

    // Group into equal-scalar buckets
    const buckets: { scalar: number; nodeIds: string[] }[] = [];
    for (const entry of entries) {
      const last = buckets[buckets.length - 1];
      if (last && last.scalar === entry.scalar) {
        last.nodeIds.push(entry.nodeId);
      } else {
        buckets.push({ scalar: entry.scalar, nodeIds: [entry.nodeId] });
      }
    }

    // Add complete bipartite edges between adjacent buckets
    for (let i = 0; i < buckets.length - 1; i++) {
      const fromBucket = buckets[i];
      const toBucket = buckets[i + 1];
      const causalGroupId = `temporal:${clock}:${fromBucket.scalar}:${toBucket.scalar}`;
      for (const fromId of fromBucket.nodeIds) {
        for (const toId of toBucket.nodeIds) {
          state.edges.push({
            predecessor: fromId,
            dependent: toId,
            edgeClass: 'internal',
            causalGroupId,
          });
        }
      }
    }
  }
}

// ============================================================================
// Internal: build StoryOrderIndex from current edges
// ============================================================================

/**
 * Build a StoryOrderIndex from the current edge set and selected nodes.
 * Validates that every edge endpoint is a known node; unknown endpoints
 * surface DagProviderError through the shared ordering path instead of
 * being silently dropped.
 */
function buildOrderFromEdges(
  state: CompileState,
  nodes: CompileNode[],
  initialRootId: string | null,
): StoryOrderIndex {
  const ordinaryNodes = nodes.filter((node) => node.id !== initialRootId);
  const nodeIds = ordinaryNodes.map((node) => node.id);
  const nodeIdSet = new Set(nodeIds);
  if (initialRootId !== null) nodeIdSet.add(initialRootId);

  // First pass: validate every edge endpoint against the known node set.
  // Empty-string endpoints are no-op markers ("no predecessor") and are
  // silently skipped — they do not create real edges.
  for (const edge of state.edges) {
    if (edge.predecessor !== '' && !nodeIdSet.has(edge.predecessor)) {
      state.errors.push(
        new UnknownPredecessorError(edge.dependent, edge.predecessor, {
          detail: `unknown predecessor '${edge.predecessor}' referenced by edge in story graph`,
        }),
      );
    }
    if (edge.dependent !== '' && !nodeIdSet.has(edge.dependent)) {
      state.errors.push(
        new UnknownPredecessorError(edge.predecessor, edge.dependent, {
          detail: `unknown dependent '${edge.dependent}' referenced by edge in story graph`,
        }),
      );
    }
  }

  // Build adjacency — only include edges between known non-empty nodes
  const adj = new Map<string, string[]>();
  for (const id of nodeIdSet) adj.set(id, []);

  for (const edge of state.edges) {
    if (
      edge.predecessor !== '' &&
      edge.dependent !== '' &&
      nodeIdSet.has(edge.predecessor) &&
      nodeIdSet.has(edge.dependent)
    ) {
      adj.get(edge.predecessor)?.push(edge.dependent);
    }
  }

  // Build coordinate map for story nodes only
  const coordinatesByEventId = new Map<string, SceneStoryCoordinate>();
  for (const node of ordinaryNodes) {
    if (node.coordinate.type === 'storyTime' && node.coordinate.kind !== 'initial') {
      coordinatesByEventId.set(node.id, node.coordinate);
    }
  }

  try {
    return buildStoryOrderIndex(initialRootId, nodeIds, adj, coordinatesByEventId);
  } catch (e: unknown) {
    if (e instanceof DagCycleError) {
      const cycle = e.context?.cycle as string[] | undefined;
      state.errors.push(new EdgeOriginCycleError(cycle ?? [], { detail: e.message }));
    } else if (e instanceof DagProviderError) {
      const eventId = (e.context?.eventId as string | undefined) ?? 'unknown';
      state.errors.push(new UnknownPredecessorError(eventId, eventId, { detail: e.message }));
    } else {
      throw e;
    }
    // Return fallback empty order so compilation can continue gathering errors
    return {
      initialRootId,
      topologicalOrder: [],
      ancestorsByEventId: new Map(),
    };
  }
}

// ============================================================================
// Stage 7 (was 6): Infer providers/absence (§12–14)
// ============================================================================

/**
 * Select the MAXIMAL write for a given canonicalKey, branchScope, and read
 * timing rules. Uses the pre-provider StoryOrderIndex and isProvenBefore for
 * visibility: only outputs whose owning node is proven-before (or is the same
 * as) the consumer are eligible. Among eligible outputs, the maximal one
 * (no other eligible output's node is proven-before it) is returned.
 * Returns null when no eligible output exists, or when multiple incomparable
 * maximal candidates are found (caller emits DuplicateBranchProviderError).
 */
function findMaximalProvider(
  canonicalKey: string,
  branchScope: string,
  outputs: OutputDescriptor[],
  owningNode: CompileNode,
  readPhase: ReadPhase,
  outputToNode: ReadonlyMap<string, CompileNode>,
  preProviderOrder: StoryOrderIndex,
): OutputDescriptor | null {
  const requireOutputNode = (outputId: string): CompileNode => {
    const outputNode = outputToNode.get(outputId);
    if (outputNode === undefined) {
      throw new DagProviderError(`Compiled output "${outputId}" has no owning graph node`, {
        phase: 'graph-provider',
        stateKey: outputId,
      });
    }
    return outputNode;
  };
  // Filter compatible outputs by key and branch
  const candidates = outputs.filter((o) => {
    if (o.canonicalKey !== canonicalKey) return false;
    if (o.branchScope !== branchScope && o.branchScope !== '') return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Filter by visibility via pre-provider order
  const visible = candidates.filter((o) => {
    const outputNode = requireOutputNode(o.outputId);
    if (readPhase === 'stateAfter' && outputNode.id === owningNode.id) return true;
    // All other cases: requires isProvenBefore
    return isProvenBefore(outputNode.id, owningNode.id, preProviderOrder);
  });

  if (visible.length === 0) return null;

  // Find maximal candidates (no other visible candidate is proven-before this one)
  // Since isProvenBefore is a strict partial order, at least one maximal exists
  // when visible is non-empty.
  const maximal: OutputDescriptor[] = [];
  for (const candidate of visible) {
    const candidateNode = requireOutputNode(candidate.outputId);
    let dominated = false;
    for (const other of visible) {
      if (other === candidate) continue;
      const otherNode = requireOutputNode(other.outputId);
      // Candidate is dominated if it is proven-before (earlier than) another
      // visible candidate — the later (maximal) provider should win.
      if (isProvenBefore(candidateNode.id, otherNode.id, preProviderOrder)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) maximal.push(candidate);
  }

  if (maximal.length === 0) return null; // should not happen
  if (maximal.length > 1) return null; // incomparable maximal candidates → ambiguity

  return maximal[0];
}

function inferProviders(state: CompileState, nodes: CompileNode[]): void {
  // Build output → owning node and read → owning node maps
  const outputToNode = new Map<string, CompileNode>();
  const readToNode = new Map<string, CompileNode>();
  for (const node of nodes) {
    for (const eff of node.effects) outputToNode.set(eff.effectId, node);
    for (const req of node.requirements) readToNode.set(req.requirementId, node);
  }

  // Build pre-provider StoryOrderIndex from authored + derived temporal edges
  // This excludes provider edges, preventing self-bootstrapping.
  // Extract the initial root node ID so that isProvenBefore works correctly
  // for initial state visibility.
  const initialRootNode = nodes.find((n) => n.isInitialRoot);
  const initialRootId = initialRootNode?.id ?? null;
  const preProviderOrder = buildOrderFromEdges(state, nodes, initialRootId);

  for (const read of state.reads) {
    const resolutionKey = `${read.readId}:${read.branchScope}`;

    // Check if already resolved via explicit provider_selection
    if (state.resolutions.has(resolutionKey)) continue;

    // Identify the owning CompileNode for this read
    const owningNode = readToNode.get(read.readId);
    if (!owningNode) {
      state.errors.push(new UnknownReadIdError(read.readId));
      continue;
    }

    const provider = findMaximalProvider(
      read.canonicalKey,
      read.branchScope,
      state.outputs,
      owningNode,
      read.phase,
      outputToNode,
      preProviderOrder,
    );

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
      } else if (
        read.predicate.type === 'neq' ||
        read.predicate.type === 'gt' ||
        read.predicate.type === 'gte' ||
        read.predicate.type === 'lt' ||
        read.predicate.type === 'lte' ||
        read.predicate.type === 'contains'
      ) {
        // Non-equality operators: compile-time only checks that the key
        // is visible (has a set provider).  Full operator enforcement is
        // delegated to applyNarrativeEvent at runtime.
        predicateSatisfied = provider.value.type === 'set';
      } else if (read.predicate.type === 'not_contains') {
        // not_contains is satisfied at runtime when the key is absent OR
        // when present but not containing the value — accept either state.
        predicateSatisfied = true;
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

      // Record provider edge: provider node → reader node.
      // Skip self-edge when owning node reads its own stateAfter output.
      const providerNode = outputToNode.get(provider.outputId);
      if (providerNode && providerNode.id !== owningNode.id) {
        state.edges.push({
          predecessor: providerNode.id,
          dependent: owningNode.id,
          edgeClass: 'provider',
        });
      }
    } else {
      // Distinguish provider ambiguity from genuine absence.
      // Ambiguity: compatible outputs exist at incomparable maximal candidates
      // — findMaximalProvider returns null when maximal.length > 1.
      const hasCompatibleOutput = state.outputs.some((o) => {
        if (o.canonicalKey !== read.canonicalKey) return false;
        if (o.branchScope !== read.branchScope && o.branchScope !== '') return false;
        const outputNode = outputToNode.get(o.outputId);
        if (!outputNode) return false;
        if (read.phase === 'stateAfter' && outputNode.id === owningNode.id) return true;
        return isProvenBefore(outputNode.id, owningNode.id, preProviderOrder);
      });

      if (hasCompatibleOutput) {
        // Genuine provider ambiguity at the maximal position
        state.errors.push(
          new DuplicateBranchProviderError(
            read.readId,
            read.branchScope,
            `coordinate ${JSON.stringify(owningNode.coordinate)}`,
            `multiple incomparable maximal providers for "${read.canonicalKey}"`,
          ),
        );
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

  // Rebuild final StoryOrderIndex including provider edges
  state.finalOrder = buildOrderFromEdges(state, nodes, initialRootId);
}

// ============================================================================
// Stage 10 (was 7): Commutativity (§17)
// ============================================================================

/**
 * Validate commutativity using the final StoryOrderIndex.
 * Every unordered node pair (neither is proven-before the other) with
 * overlapping read/write effect keys is a conflict.
 *
 * Required external type: UnorderedStoryConflictError (code UNORDERED_STORY_CONFLICT).
 * Currently uses GraphCompileError with the target code.
 */
function validateCommutativity(state: CompileState, nodes: CompileNode[]): void {
  const order = state.finalOrder;
  if (!order) return; // no story nodes in this compilation

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];

      // Check if ordered in the final order (either direction)
      if (isProvenBefore(a.id, b.id, order)) continue;
      if (isProvenBefore(b.id, a.id, order)) continue;

      // Unordered pair — check overlapping effect keys
      const aWriteKeys = new Set(a.effects.map((e) => e.canonicalKey));
      const bWriteKeys = new Set(b.effects.map((e) => e.canonicalKey));
      const aReadKeys = new Set(a.requirements.map((r) => r.canonicalKey));
      const bReadKeys = new Set(b.requirements.map((r) => r.canonicalKey));

      // Conflict if one writes what the other reads or writes
      const overlap =
        [...aWriteKeys].some((k) => bWriteKeys.has(k) || bReadKeys.has(k)) ||
        [...bWriteKeys].some((k) => aReadKeys.has(k));

      if (overlap) {
        state.errors.push(
          new UnorderedStoryConflictError(a.id, a.coordinate, b.id, {
            code: 'UNORDERED_STORY_CONFLICT',
            detail: `overlapping read/write keys at ${JSON.stringify(a.coordinate)} / ${JSON.stringify(b.coordinate)}`,
          }),
        );
      }
    }
  }
}

// ============================================================================
// Stage 11 (was 8): Branch/closure/cycle validation (§20–21)
// ============================================================================

function validateBranches(state: CompileState, _nodes: CompileNode[]): void {
  // Check each read per branch has a resolution (§21)
  for (const read of state.reads) {
    const resolutionKey = `${read.readId}:${read.branchScope}`;
    if (!state.resolutions.has(resolutionKey)) {
      state.errors.push(new BranchCoverageError(read.branchScope, read.readId));
    }
  }
  // Provider reuse across different reads of the same output is legal (§14).
  // DuplicateBranchProviderError fires only during provider resolution when
  // a single read has multiple incomparable maximal providers — detected by
  // findMaximalProvider returning null while compatible outputs exist.
}

function detectCycles(state: CompileState): void {
  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const edge of state.edges) {
    if (!adj.has(edge.predecessor)) adj.set(edge.predecessor, []);
    adj.get(edge.predecessor)?.push(edge.dependent);
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
// Stage 12 (was 9): Hash/replay
// ============================================================================

function computeGraphHash(state: CompileState, nodes: CompileNode[]): string {
  // Sort edges deterministically for hash stability
  const sortedEdges = [...state.edges].sort((a, b) => {
    if (a.predecessor !== b.predecessor) return a.predecessor < b.predecessor ? -1 : 1;
    if (a.dependent !== b.dependent) return a.dependent < b.dependent ? -1 : 1;
    if (a.edgeClass !== b.edgeClass) return a.edgeClass < b.edgeClass ? -1 : 1;
    if ((a.causalGroupId ?? '') !== (b.causalGroupId ?? ''))
      return (a.causalGroupId ?? '') < (b.causalGroupId ?? '') ? -1 : 1;
    return 0;
  });

  const sortedResolutions = [...state.resolutions.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // Include node coordinate hashes so coordinate-only changes invalidate cache
  const sortedNodes = [...nodes]
    .filter((n) => n.coordinate.type === 'storyTime')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return sha256Canonical({
    nodes: sortedNodes.map((n) => ({
      id: n.id,
      coordinate: n.coordinate,
    })),
    edges: sortedEdges.map((e) => ({
      predecessor: e.predecessor,
      dependent: e.dependent,
      edgeClass: e.edgeClass,
      causalGroupId: e.causalGroupId,
    })),
    outputs: [...state.outputs]
      .sort((a, b) => (a.outputId < b.outputId ? -1 : a.outputId > b.outputId ? 1 : 0))
      .map((o) => ({ outputId: o.outputId, provenanceHash: o.provenanceHash })),
    resolutions: sortedResolutions.map(([, r]) =>
      r.type === 'output'
        ? { type: 'output', provenanceHash: r.provenanceHash }
        : { type: 'absence', readId: r.readId },
    ),
  });
}

/**
 * Build a cache entry from compiled state.
 * Uses branchScope as the sole scope identifier (no targetCoordinatePrefix/
 * sameCoordinateAncestors). All hash arrays are deterministically sorted to
 * ensure stable cache keys across builds.
 * The timestamp is a deterministic, content-derived identity — never
 * wall-clock — so identical inputs compile to byte-identical entries
 * regardless of when they are built.
 */
function buildCacheEntry(state: CompileState, branchScope: string): GraphCacheEntry {
  // Deterministic sort for edges
  const sortedEdges = [...state.edges].sort((a, b) => {
    if (a.predecessor !== b.predecessor) return a.predecessor < b.predecessor ? -1 : 1;
    if (a.dependent !== b.dependent) return a.dependent < b.dependent ? -1 : 1;
    if (a.edgeClass !== b.edgeClass) return a.edgeClass < b.edgeClass ? -1 : 1;
    if ((a.causalGroupId ?? '') !== (b.causalGroupId ?? ''))
      return (a.causalGroupId ?? '') < (b.causalGroupId ?? '') ? -1 : 1;
    return 0;
  });

  // Deterministic sort for outputs
  const sortedOutputs = [...state.outputs].sort((a, b) =>
    a.outputId < b.outputId ? -1 : a.outputId > b.outputId ? 1 : 0,
  );

  const dependencyHashes = sortedEdges.map((e) => sha256Canonical(e));
  const outputHashes = sortedOutputs.map((o) => o.provenanceHash);
  const absenceHashes = [...state.resolutions.values()]
    .filter((r): r is GraphAbsenceWitness => r.type === 'absence')
    .map((a) => sha256Canonical(`${a.readId}:${a.canonicalKey}`))
    .sort();

  return {
    branchScope,
    dependencyHashes,
    outputHashes,
    absenceHashes,
    // Content-derived cache identity — never wall-clock: identical compiled
    // input yields a byte-identical entry regardless of when it is built.
    timestamp: Number.parseInt(
      sha256Canonical({ branchScope, dependencyHashes, outputHashes, absenceHashes }).slice(0, 8),
      16,
    ),
  };
}

// ============================================================================
// Main compile function
// ============================================================================

/**
 * Compile raw nodes into typed StoryGraph and DiscourseGraph structures.
 * Follows the FIXED 12-stage compiler order.
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

  // ── Stage 6: Derive temporal internal edges ─────────────────────────────
  deriveTemporalEdges(state, branchNodes);

  // ── Stage 7 (was 6): Infer providers/absence ────────────────────────────
  // (builds pre-provider StoryOrderIndex internally, then final order)
  inferProviders(state, branchNodes);

  // ── Stage 8 (was 7): Commutativity ──────────────────────────────────────
  validateCommutativity(state, branchNodes);

  // ── Stage 9 (was 8): Branch/closure/cycle validation ───────────────────
  validateBranches(state, branchNodes);
  detectCycles(state);

  // ── Stage 10 (was 9): Hash ──────────────────────────────────────────────
  const hash = computeGraphHash(state, branchNodes);

  // Partition nodes into story vs discourse graphs
  const storyNodes = branchNodes.filter((n) => n.coordinate.type === 'storyTime');
  const discourseNodes = branchNodes.filter((n) => n.coordinate.type === 'discoursePosition');

  if (storyNodes.length > 0) {
    const storyNodeIds = new Set(storyNodes.map((node) => node.id));
    const storyOutputIds = new Set(
      storyNodes.flatMap((node) => node.effects.map((effect) => effect.effectId)),
    );
    const storyReadIds = new Set(
      storyNodes.flatMap((node) =>
        node.requirements.map((requirement) => requirement.requirementId),
      ),
    );
    const storyOutputs = state.outputs.filter((output) => storyOutputIds.has(output.outputId));
    const storyReads = state.reads.filter((read) => storyReadIds.has(read.readId));

    const storyGraph: StoryGraph = {
      type: 'story',
      edges: state.edges.filter(
        (edge) => storyNodeIds.has(edge.predecessor) && storyNodeIds.has(edge.dependent),
      ),
      outputs: storyOutputs,
      reads: storyReads,
      resolutions: [...state.resolutions.entries()]
        .filter(([key, resolution]) => {
          const read = storyReads.find(
            (candidate) => key === `${candidate.readId}:${candidate.branchScope}`,
          );
          return (
            read !== undefined &&
            (resolution.type === 'absence' || storyOutputIds.has(resolution.outputId))
          );
        })
        .map(([, resolution]) => resolution),
      hash: sha256Canonical(`story:${hash}`),
    };
    state.storyGraphs.push(storyGraph);
  }

  if (discourseNodes.length > 0) {
    const discourseNodeIds = new Set(discourseNodes.map((node) => node.id));
    const discourseOutputIds = new Set(
      discourseNodes.flatMap((node) => node.effects.map((effect) => effect.effectId)),
    );
    const discourseOutputs = state.outputs.filter((output) =>
      discourseOutputIds.has(output.outputId),
    );

    const discourseGraph: DiscourseGraph = {
      type: 'discourse',
      edges: state.edges.filter(
        (edge) => discourseNodeIds.has(edge.predecessor) && discourseNodeIds.has(edge.dependent),
      ),
      outputs: discourseOutputs,
      hash: sha256Canonical(`discourse:${hash}`),
      sceneSequence: [],
    };
    state.discourseGraphs.push(discourseGraph);
  }

  // Build cache entries
  const branchScope = options.branchPath ?? 'root';
  state.cache.push(buildCacheEntry(state, branchScope));

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
