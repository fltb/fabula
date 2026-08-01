import { branchPathToString, includesPath } from '../branch/index.ts';
import { sha256Canonical } from '../cache/render-cache.ts';
import type { TemporalContext } from '../entity/timestamp.ts';
import { INITIAL_STORY_ROOT_ID, resolveTemporalContext } from '../entity/timestamp.ts';
import { ConfigError } from '../errors.ts';
import type { DiscourseGraph, ReadRequirement, StoryGraph } from '../types/graph.ts';
import type {
  BranchPath,
  Fact,
  NarrativeEvent,
  NarratorAssertion,
  PlannedDiscourseLedger,
  TimeAnchor,
} from '../types/index.ts';
import type { ResolvedNarrativeTechniqueContract } from '../types/narrative-techniques.ts';
import type { AdjacencyList, StoryOrderIndex } from './dag.ts';
import { buildStoryOrderIndex } from './dag.ts';
import { compileDiscourseSceneSequence } from './discourse-sequence.ts';
import {
  type CompileNode,
  compileGraph,
  type RawEffect,
  type RawRequirement,
} from './graph-compiler.ts';
import { resolveNarrativeTechniques } from './technique-resolver.ts';

// Re-export the canonical initial root ID for replay consumers.
export { INITIAL_STORY_ROOT_ID };

export interface CompiledNarrativeGraphs {
  storyGraph: StoryGraph;
  discourseGraph: DiscourseGraph;
  storyAdjacency: AdjacencyList;
  /** Branch-filtered events — the canonical event set both story
   *  boundaries and discourse contexts compile from. */
  selectedEvents: readonly NarrativeEvent[];
  techniquesByEventId: ReadonlyMap<string, readonly ResolvedNarrativeTechniqueContract[]>;
}

export interface CompiledStoryRuntimeGraph {
  initialRootId: string;
  storyGraph: StoryGraph;
  storyAdjacency: AdjacencyList;
  selectedEvents: readonly NarrativeEvent[];
  initialFacts: readonly Fact[];
  initialThreads: readonly { id: string }[];
  temporalContext: TemporalContext;
  order: StoryOrderIndex;
}

function factKey(fact: Fact): string {
  return `${fact.entityId}.${fact.attribute}`;
}

function outputFromFact(fact: Fact, outputId: string): RawEffect | null {
  if (fact.operation === 'unset') {
    return { effectId: outputId, canonicalKey: factKey(fact), value: undefined, isUnset: true };
  }
  if (fact.value === undefined) return null;
  return { effectId: outputId, canonicalKey: factKey(fact), value: fact.value };
}

function requirementFromFact(fact: Fact, requirementId: string): RawRequirement | null {
  if (fact.narrativeHint !== undefined) return null;
  const operator = fact.operator ?? 'eq';
  if (operator === 'exists') {
    return {
      requirementId,
      canonicalKey: factKey(fact),
      predicate: { type: 'exists' },
      phase: 'stateBefore',
      origin: 'precondition',
    };
  }
  if (operator === 'not_exists') {
    return {
      requirementId,
      canonicalKey: factKey(fact),
      predicate: { type: 'absent' },
      phase: 'stateBefore',
      origin: 'precondition',
    };
  }
  if (fact.value === undefined) return null;

  // Predicate type mapping: the Fact operator name (minus 'eq'→'equals')
  // is used as the predicate discriminant so compilation resolves the key
  // without falsely asserting equality.  Runtime enforcement of the actual
  // operator semantics is delegated to applyNarrativeEvent.
  const predicateType = operator === 'eq' ? 'equals' : operator;

  return {
    requirementId,
    canonicalKey: factKey(fact),
    predicate: { type: predicateType, value: fact.value } as RawRequirement['predicate'],
    phase: 'stateBefore',
    origin: 'precondition',
  };
}

/**
 * Resolve temporal context on all events, project selected coordinates after
 * resolution, then build story graph nodes with a normalized initial root
 * rather than a synthetic scene time. Initial facts are applied to the root
 * directly as state inputs, not replayed as authored events.
 */
export function compileStoryRuntimeGraph(input: {
  events: readonly NarrativeEvent[];
  initialFacts: readonly Fact[];
  initialThreads: readonly { id: string }[];
  timeAnchors: readonly TimeAnchor[];
  branchPath: BranchPath;
}): CompiledStoryRuntimeGraph {
  // 1. Resolve TemporalContext on ALL events before branch selection.
  //    This validates temporal syntax, detects cycles, and assigns coordinates
  //    for every event. An event excluded by branchPath may still serve as an
  //    anchor target for selected events.
  const temporalContext = resolveTemporalContext(input.events, input.timeAnchors);

  // 2. Filter selected events by branch.
  const selectedEvents: NarrativeEvent[] = [];
  for (const event of input.events) {
    if (!includesPath(event.branchExistence, input.branchPath)) continue;
    selectedEvents.push(event);
  }
  const selectedScope = branchPathToString(input.branchPath);

  // 3. Reject duplicate initial thread IDs before building root effects.
  const seenThreadIds = new Set<string>();
  for (const thread of input.initialThreads) {
    if (seenThreadIds.has(thread.id)) {
      throw new ConfigError(`Duplicate initial thread ID "${thread.id}"`, {
        phase: 'narrative-graphs',
      });
    }
    seenThreadIds.add(thread.id);
  }

  // 4. Normalize selected initial facts onto the root.
  const allInitialFactEntries: Array<{ fact: Fact; index: number }> = [];
  let factIndex = 0;
  for (const fact of input.initialFacts) {
    if (includesPath(fact.validity.branches, input.branchPath)) {
      allInitialFactEntries.push({ fact, index: factIndex++ });
    }
  }

  // Deduplicate root facts: same canonicalKey + same operation/value → emit once.
  // Conflicting facts (same key, different operation or different value) → hard error.
  const rootEffects: RawEffect[] = [];
  const dedupMap = new Map<string, RawEffect>();
  for (const { fact, index } of allInitialFactEntries) {
    const effect = outputFromFact(fact, `${INITIAL_STORY_ROOT_ID}:fact:${index}`);
    if (effect === null) continue;
    const existing = dedupMap.get(effect.canonicalKey);
    if (existing) {
      const bothUnset = existing.isUnset && effect.isUnset;
      if (bothUnset) continue;
      if (existing.isUnset !== effect.isUnset) {
        throw new ConfigError(
          `Conflicting initial facts for "${effect.canonicalKey}": ` +
            (existing.isUnset
              ? 'first fact unsets it, second tries to set a value'
              : 'first fact sets a value, second tries to unset it'),
          { phase: 'narrative-graphs' },
        );
      }
      if (sha256Canonical(existing.value) === sha256Canonical(effect.value)) continue;
      throw new ConfigError(
        `Conflicting initial facts for "${effect.canonicalKey}": ` +
          `both set but with different values`,
        { phase: 'narrative-graphs' },
      );
    }
    dedupMap.set(effect.canonicalKey, effect);
    rootEffects.push(effect);
  }
  for (const thread of input.initialThreads) {
    rootEffects.push({
      effectId: `thread:${thread.id}`,
      canonicalKey: `thread:${thread.id}`,
      value: { id: thread.id, status: 'planned' },
    });
  }

  // 5. Build CompileNodes with resolved coordinates.
  const storyNodes: CompileNode[] = [
    {
      id: INITIAL_STORY_ROOT_ID,
      coordinate: { type: 'storyTime', kind: 'initial' },
      effects: rootEffects,
      requirements: [],
      branchScope: '',
      isInitialRoot: true,
    },
    ...selectedEvents.map((event): CompileNode => {
      const coordinate = temporalContext.coordinatesByEventId.get(event.id);
      if (!coordinate) {
        throw new ConfigError(`Event "${event.id}" has no resolved story coordinate`, {
          phase: 'narrative-graphs',
          eventId: event.id,
        });
      }

      // Build explicit edges from authored causalPredecessors.
      const explicitEdges: CompileNode['explicitEdges'] = event.causalPredecessors
        ? event.causalPredecessors.map((predecessor) => {
            if (!selectedEvents.some((candidate) => candidate.id === predecessor)) {
              throw new ConfigError(
                `Event "${event.id}" causalPredecessor "${predecessor}" is not a reachable ` +
                  `event on branch "${selectedScope}".`,
                { phase: 'narrative-graphs', eventId: event.id },
              );
            }
            return {
              predecessor,
              dependent: event.id,
              edgeClass: 'author_origin' as const,
            };
          })
        : undefined;

      const effects: RawEffect[] = [];

      // Postconditions → entity:<entityId>:<attribute>
      for (let i = 0; i < event.postconditions.length; i++) {
        const fact = event.postconditions[i];
        if (!includesPath(fact.validity.branches, input.branchPath)) continue;
        const effect = outputFromFact(fact, `${event.id}:fact:${i}`);
        if (effect !== null) effects.push(effect);
      }

      // Thread progress → thread:<thread>
      for (let i = 0; i < event.threadProgress.length; i++) {
        const entry = event.threadProgress[i];
        effects.push({
          effectId: `${event.id}:thread:${i}`,
          canonicalKey: `thread:${entry.thread}`,
          value: entry,
        });
      }

      // Relationship effects → relationship:<relationshipId>
      // EntityMapper converts legacy RelationshipChange entries to
      // RelationshipTransaction at load time, so relationshipId is always present.
      for (let i = 0; i < event.relationshipEffects.length; i++) {
        const entry = event.relationshipEffects[i];
        effects.push({
          effectId: `${event.id}:relationship:${i}`,
          canonicalKey: `relationship:${entry.relationshipId}`,
          value: entry,
        });
      }

      // Rule effects → rule:<rule>
      for (let i = 0; i < event.ruleEffects.length; i++) {
        const entry = event.ruleEffects[i];
        effects.push({
          effectId: `${event.id}:rule:${i}`,
          canonicalKey: `rule:${entry.rule}`,
          value: entry,
        });
      }

      return {
        id: event.id,
        coordinate,
        effects,
        requirements: event.preconditions
          .filter((fact) => includesPath(fact.validity.branches, input.branchPath))
          .map((fact, index) => requirementFromFact(fact, `${event.id}:precondition:${index}`))
          .filter((requirement): requirement is RawRequirement => requirement !== null),
        branchScope: selectedScope,
        explicitEdges,
      };
    }),
  ];

  // 6. Compile the story graph.
  const storyResult = compileGraph(storyNodes, { branchPath: selectedScope });
  if (storyResult.errors.length > 0 || storyResult.storyGraphs[0] === undefined) {
    throw new ConfigError(
      `StoryGraph compilation failed: ${storyResult.errors.map((error) => error.message).join('; ') || 'no graph produced'}`,
      { phase: 'narrative-graphs' },
    );
  }
  const compiledStory = storyResult.storyGraphs[0];
  const storyGraph: StoryGraph = {
    ...compiledStory,
    hash: sha256Canonical({ graph: compiledStory.hash, scope: selectedScope }),
  };

  // 7. Build event-to-event adjacency including all edge classes.
  const storyAdjacency = storyGraphToEventAdjacency(
    storyGraph,
    selectedEvents.map((e) => e.id),
  );

  // 8. Build StoryOrderIndex for the selected events.
  const order = buildStoryOrderIndex(
    INITIAL_STORY_ROOT_ID,
    selectedEvents.map((e) => e.id),
    storyAdjacency,
    new Map(
      selectedEvents
        .map((e) => [e.id, temporalContext.coordinatesByEventId.get(e.id)!] as const)
        .filter(([, coord]) => coord !== undefined),
    ),
  );

  return {
    initialRootId: INITIAL_STORY_ROOT_ID,
    storyGraph,
    storyAdjacency,
    selectedEvents,
    initialFacts: input.initialFacts,
    initialThreads: input.initialThreads,
    temporalContext,
    order,
  };
}

/**
 * Compile the branch-selected StoryGraph and reader-order DiscourseGraph from
 * the same authored event set by reusing compileStoryRuntimeGraph for the
 * story domain. Both graph domains are present even when the reader-order
 * ledger has no disclosure actions.
 */
export function compileNarrativeGraphs(input: {
  events: readonly NarrativeEvent[];
  initialFacts: readonly Fact[];
  initialThreads: readonly { id: string }[];
  timeAnchors: readonly TimeAnchor[];
  branchPath: BranchPath;
  discourseBranch: string;
  ledger: PlannedDiscourseLedger;
  assertions: Readonly<Record<string, NarratorAssertion>>;
}): CompiledNarrativeGraphs {
  const selectedScope = branchPathToString(input.branchPath);

  // ── Story graph via shared entrypoint ──────────────────────────────────
  const storyResult = compileStoryRuntimeGraph({
    events: input.events,
    initialFacts: input.initialFacts,
    initialThreads: input.initialThreads,
    timeAnchors: input.timeAnchors,
    branchPath: input.branchPath,
  });
  const { storyGraph, storyAdjacency, selectedEvents } = storyResult;

  // ── Discourse graph ────────────────────────────────────────────────────
  const sceneSequence = compileDiscourseSceneSequence({
    events: selectedEvents,
    ledger: input.ledger,
    branch: input.discourseBranch,
  });

  const discourseNodes: CompileNode[] = input.ledger.entries
    .filter((entry) => entry.branch === input.discourseBranch)
    .map((entry) => ({
      id: `discourse:${entry.id}`,
      coordinate: { type: 'discoursePosition' as const, value: entry.discoursePosition },
      effects: [
        {
          effectId: `discourse:${entry.id}:action`,
          canonicalKey: `disclosure:${entry.sceneId}:${entry.id}`,
          value: entry.action,
        },
      ],
      requirements: [],
      branchScope: selectedScope,
    }));
  const discourseResult = compileGraph(discourseNodes, { branchPath: selectedScope });
  if (discourseResult.errors.length > 0) {
    throw new ConfigError(
      `DiscourseGraph compilation failed: ${discourseResult.errors.map((error) => error.message).join('; ')}`,
      { phase: 'narrative-graphs' },
    );
  }
  const compiledDiscourse = discourseResult.discourseGraphs[0];
  const discourseGraph: DiscourseGraph = {
    type: 'discourse',
    edges: compiledDiscourse?.edges ?? [],
    outputs: compiledDiscourse?.outputs ?? [],
    sceneSequence,
    hash: sha256Canonical({
      graph: compiledDiscourse?.hash ?? null,
      ledgerHash: input.ledger.hash,
      scope: selectedScope,
      sceneSequence,
    }),
  };

  // Resolve narrative technique contracts against compiled graphs
  const techniquesByEventId = resolveNarrativeTechniques({
    events: selectedEvents,
    storyGraph,
    discourseGraph,
    assertions: input.assertions,
  });

  // ── Deterministic read closure ────────────────────────────────────────
  // Absence is legal ONLY for:
  //   1. Reads whose predicate is 'absent' (not_exists operator)
  //   2. ReadIds claimed by a valid absentApparatus contract of the same
  //      owning event (readId starts with `<eventId>:precondition:` and a
  //      GraphAbsenceWitness exists for it)
  // All other exists/equals deterministic reads that resolve to absence
  // are a ConfigError with phase 'narrative-graphs'.

  const readMap = new Map<string, ReadRequirement>();
  for (const read of storyGraph.reads) {
    readMap.set(read.readId, read);
  }

  // Collect claimed absentApparatus readIds from source events (only
  // contracts that survived resolution are in techniquesByEventId, but
  // we re-derive from source events to validate readId ownership).
  const claimedAbsenceReadIds = new Set<string>();
  for (const event of selectedEvents) {
    if (event.absentApparatus) {
      const readId = event.absentApparatus.readId;
      // No cross-event claims: readId must begin with the owning event's
      // deterministic precondition ID prefix.
      if (!readId.startsWith(`${event.id}:precondition:`)) {
        throw new ConfigError(
          `absentApparatus readId "${readId}" must begin with owning event ` +
            `precondition ID prefix "${event.id}:precondition:"`,
          { phase: 'narrative-graphs', eventId: event.id },
        );
      }
      claimedAbsenceReadIds.add(readId);
    }
  }

  for (const resolution of storyGraph.resolutions) {
    if (resolution.type === 'absence') {
      const read = readMap.get(resolution.readId);
      if (!read) {
        throw new ConfigError(`Absence resolution references unknown read "${resolution.readId}"`, {
          phase: 'narrative-graphs',
        });
      }

      // Legal: predicate is 'absent' (not_exists operator)
      if (read.predicate.type === 'absent') continue;

      // Legal: claimed by a valid absentApparatus of the same owning event
      if (claimedAbsenceReadIds.has(resolution.readId)) continue;

      // Unclaimed exists/equals absence → ConfigError
      const readEventId = resolution.readId.split(':precondition:')[0];
      throw new ConfigError(
        `Deterministic read "${resolution.readId}" (predicate: ` +
          `"${read.predicate.type}") resolved to absence but no valid ` +
          `absent predicate or absentApparatus claim covers it. ` +
          `Reads with exists/equals predicates must have a graph provider.`,
        { phase: 'narrative-graphs', eventId: readEventId },
      );
    }
  }
  return {
    storyGraph,
    discourseGraph,
    storyAdjacency,
    selectedEvents,
    techniquesByEventId,
  };
}

/** Project StoryGraph ordering edges to replayable event-to-event adjacency. */
export function storyGraphToEventAdjacency(
  storyGraph: StoryGraph,
  eventIds: readonly string[],
): AdjacencyList {
  const selectedIds = new Set(eventIds);
  const adjacency: Map<string, string[]> = new Map(eventIds.map((eventId) => [eventId, []]));
  for (const edge of storyGraph.edges) {
    // Include all event-to-event edge classes: author_origin, provider,
    // same_coordinate_order, and internal (derived temporal edges).
    if (!selectedIds.has(edge.predecessor) || !selectedIds.has(edge.dependent)) {
      continue;
    }
    const successors = adjacency.get(edge.predecessor)!;
    if (!successors.includes(edge.dependent)) successors.push(edge.dependent);
  }
  return adjacency;
}
