import { branchPathToString, includesPath } from '../branch/index.ts';
import { sha256Canonical } from '../cache/render-cache.ts';
import { resolveTimestampToDay } from '../entity/timestamp.ts';
import { ConfigError } from '../errors.ts';
import type {
  BranchPath,
  Fact,
  NarrativeEvent,
  NarratorAssertion,
  PlannedDiscourseLedger,
  StoryTimestamp,
} from '../types/index.ts';
import type { DiscourseGraph, StoryGraph } from '../types/graph.ts';
import { compileGraph, type CompileNode, type RawEffect, type RawRequirement } from './graph-compiler.ts';
import type { AdjacencyList } from './dag.ts';

const INITIAL_FACTS_ROOT_ID = 'system:initial-facts';

export interface CompiledNarrativeGraphs {
  storyGraph: StoryGraph;
  discourseGraph: DiscourseGraph;
  storyAdjacency: AdjacencyList;
}

interface SceneSequenceEntry {
  sceneId: string;
  sequence: number;
  chapter: number;
  actionInterval?: { start: number; end: number };
}

function storyCoordinateValue(timestamp: StoryTimestamp): string {
  switch (timestamp.type) {
    case 'absolute':
      return timestamp.value;
    case 'relative':
      return `${timestamp.anchor}+${timestamp.offset.amount}${timestamp.offset.unit}`;
    case 'chapter':
      return `chapter_${timestamp.chapter}`;
  }
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
  return {
    requirementId,
    canonicalKey: factKey(fact),
    predicate: { type: 'equals', value: fact.value },
    phase: 'stateBefore',
    origin: 'precondition',
  };
}

function compileSceneSequence(
  events: readonly NarrativeEvent[],
  ledger: PlannedDiscourseLedger,
  discourseBranch: string,
): SceneSequenceEntry[] {
  const eventIds = new Set(events.map((event) => event.id));
  const chapters = ledger.chapters.filter((chapter) => chapter.branch === discourseBranch);
  if (chapters.length === 0) {
    throw new ConfigError(
      `Discourse ledger "${ledger.id}" has no chapter sequence for branch "${discourseBranch}".`,
      { phase: 'narrative-graphs' },
    );
  }

  const sceneIds: string[] = [];
  const seenSceneIds = new Set<string>();
  let previousChapter = 0;
  for (const chapter of chapters) {
    if (chapter.chapter <= previousChapter) {
      throw new ConfigError(
        `Discourse ledger "${ledger.id}" has non-increasing chapter ${chapter.chapter} ` +
          `for branch "${discourseBranch}".`,
        { phase: 'narrative-graphs' },
      );
    }
    previousChapter = chapter.chapter;
    for (const sceneId of chapter.sceneIds) {
      if (!eventIds.has(sceneId)) {
        throw new ConfigError(
          `Discourse ledger "${ledger.id}" references unknown scene "${sceneId}" ` +
            `for branch "${discourseBranch}".`,
          { phase: 'narrative-graphs', eventId: sceneId },
        );
      }
      if (seenSceneIds.has(sceneId)) {
        throw new ConfigError(
          `Discourse ledger "${ledger.id}" lists scene "${sceneId}" more than once ` +
            `for branch "${discourseBranch}".`,
          { phase: 'narrative-graphs', eventId: sceneId },
        );
      }
      seenSceneIds.add(sceneId);
      sceneIds.push(sceneId);
    }
  }
  for (const eventId of eventIds) {
    if (!seenSceneIds.has(eventId)) {
      throw new ConfigError(
        `Discourse ledger "${ledger.id}" omits reachable scene "${eventId}" ` +
          `for branch "${discourseBranch}".`,
        { phase: 'narrative-graphs', eventId },
      );
    }
  }

  const entriesByScene = new Map<string, typeof ledger.entries>();
  for (const entry of ledger.entries) {
    if (entry.branch !== discourseBranch) continue;
    if (!eventIds.has(entry.sceneId)) {
      throw new ConfigError(
        `Discourse ledger "${ledger.id}" action "${entry.id}" references unknown scene "${entry.sceneId}".`,
        { phase: 'narrative-graphs', eventId: entry.sceneId },
      );
    }
    const entries = entriesByScene.get(entry.sceneId) ?? [];
    entries.push(entry);
    entriesByScene.set(entry.sceneId, entries);
  }

  const intervals = new Map<string, { start: number; end: number }>();
  for (const [sceneId, entries] of entriesByScene) {
    const positions = entries.map((entry) => entry.discoursePosition).sort((left, right) => left - right);
    intervals.set(sceneId, { start: positions[0]!, end: positions[positions.length - 1]! });
  }

  return chapters.flatMap((chapter) =>
    chapter.sceneIds.map((sceneId) => {
      const interval = intervals.get(sceneId);
      return {
        sceneId,
        sequence: sceneIds.indexOf(sceneId),
        chapter: chapter.chapter,
        ...(interval === undefined ? {} : { actionInterval: interval }),
      };
    }),
  );
}

/**
 * Compile the branch-selected StoryGraph and reader-order DiscourseGraph from
 * the same authored event set. Both graph domains are present even when the
 * reader-order ledger has no disclosure actions.
 */
export function compileNarrativeGraphs(input: {
  events: readonly NarrativeEvent[];
  initialFacts: readonly Fact[];
  timeAnchors: ReadonlyMap<string, number>;
  branchPath: BranchPath;
  discourseBranch: string;
  ledger: PlannedDiscourseLedger;
  assertions: Readonly<Record<string, NarratorAssertion>>;
}): CompiledNarrativeGraphs {
  const selectedEvents = input.events.filter((event) => includesPath(event.branchExistence, input.branchPath));
  const selectedScope = branchPathToString(input.branchPath);
  const anchors = new Map(input.timeAnchors);
  const sceneSequence = compileSceneSequence(selectedEvents, input.ledger, input.discourseBranch);

  const rootEffects = input.initialFacts
    .filter((fact) => includesPath(fact.validity.branches, input.branchPath))
    .map((fact, index) => outputFromFact(fact, `${INITIAL_FACTS_ROOT_ID}:fact:${index}`))
    .filter((effect): effect is RawEffect => effect !== null);
  const storyNodes: CompileNode[] = [
    {
      id: INITIAL_FACTS_ROOT_ID,
      coordinate: { type: 'storyTime', value: 'initial' },
      effects: rootEffects,
      requirements: [],
      branchScope: '',
      isInitialRoot: true,
    },
    ...selectedEvents.map((event) => ({
      id: event.id,
      coordinate: { type: 'storyTime' as const, value: storyCoordinateValue(event.storyTime) },
      effects: event.postconditions
        .filter((fact) => includesPath(fact.validity.branches, input.branchPath))
        .map((fact, index) => outputFromFact(fact, `${event.id}:postcondition:${index}`))
        .filter((effect): effect is RawEffect => effect !== null),
      requirements: event.preconditions
        .filter((fact) => includesPath(fact.validity.branches, input.branchPath))
        .map((fact, index) => requirementFromFact(fact, `${event.id}:precondition:${index}`))
        .filter((requirement): requirement is RawRequirement => requirement !== null),
      branchScope: selectedScope,
      explicitEdges: (event.causalPredecessors ?? [])
        .filter((predecessor) => selectedEvents.some((candidate) => candidate.id === predecessor))
        .map((predecessor) => ({
          predecessor,
          dependent: event.id,
          edgeClass: 'author_origin' as const,
        })),
    })),
  ];

  for (const event of selectedEvents) {
    resolveTimestampToDay(event.storyTime, anchors);
  }

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
    effectiveCoordinate: compiledDiscourse?.effectiveCoordinate ?? {
      type: 'discoursePosition',
      value: 0,
    },
    sceneSequence,
    hash: sha256Canonical({
      graph: compiledDiscourse?.hash ?? null,
      ledgerHash: input.ledger.hash,
      scope: selectedScope,
      sceneSequence,
    }),
  };

  return {
    storyGraph,
    discourseGraph,
    storyAdjacency: storyGraphToEventAdjacency(storyGraph, selectedEvents.map((event) => event.id)),
  };
}

/** Project StoryGraph ordering edges to replayable event-to-event adjacency. */
export function storyGraphToEventAdjacency(
  storyGraph: StoryGraph,
  eventIds: readonly string[],
): AdjacencyList {
  const selectedIds = new Set(eventIds);
  const adjacency: AdjacencyList = new Map(eventIds.map((eventId) => [eventId, []]));
  for (const edge of storyGraph.edges) {
    if (
      (edge.edgeClass !== 'author_origin' &&
        edge.edgeClass !== 'provider' &&
        edge.edgeClass !== 'same_coordinate_order') ||
      !selectedIds.has(edge.predecessor) ||
      !selectedIds.has(edge.dependent)
    ) {
      continue;
    }
    const successors = adjacency.get(edge.predecessor)!;
    if (!successors.includes(edge.dependent)) successors.push(edge.dependent);
  }
  return adjacency;
}
