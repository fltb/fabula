import type { Fact, NarrativeEvent } from '../types/index.js';
import type { BranchPath } from '../types/branch.js';
import { includesPath } from '../branch/index.js';
import { DagCycleError, DagProviderError } from '../errors.js';
import { resolveTimestampToDay } from '../entity/timestamp.js';

export type AdjacencyList = Map<string, string[]>;

export interface CausalGraphOptions {
  anchors?: Map<string, number>;
  branchPath?: BranchPath;
  initialFacts?: readonly Fact[];
}

interface Write {
  eventId: string;
  day: number;
}

function factKey(fact: Fact): string {
  return `${fact.entityId}\u0000${fact.attribute}\u0000${JSON.stringify(fact.value)}`;
}

function eventDay(event: NarrativeEvent, anchors: Map<string, number>): number {
  return resolveTimestampToDay(event.storyTime, anchors);
}

/** Compiles deterministic causal dependencies for one concrete branch. */
export function buildCausalEdges(events: NarrativeEvent[], options: CausalGraphOptions = {}): { edges: AdjacencyList; inDegree: Map<string, number> } {
  const anchors = options.anchors ?? new Map<string, number>();
  const selectedEvents = options.branchPath
    ? events.filter((event) => includesPath(event.branchExistence, options.branchPath!))
    : events.filter((event) => event.branchExistence.type === 'all');
  const writes = new Map<string, Write[]>();
  const initial = new Set((options.initialFacts ?? []).filter((fact) => fact.value !== undefined).map(factKey));
  const edges: AdjacencyList = new Map();
  const inDegree = new Map<string, number>();

  for (const event of selectedEvents) {
    if (edges.has(event.id)) throw new DagProviderError('Duplicate event ID', { eventId: event.id, phase: 'causal-compile' });
    edges.set(event.id, []);
    inDegree.set(event.id, 0);
    const day = eventDay(event, anchors);
    for (const fact of event.postconditions) {
      if (fact.value === undefined) continue;
      const key = factKey(fact);
      const writers = writes.get(key) ?? [];
      writers.push({ eventId: event.id, day });
      writes.set(key, writers);
    }
  }

  for (const event of selectedEvents) {
    const consumerDay = eventDay(event, anchors);
    for (const precondition of event.preconditions) {
      if (precondition.value === undefined) continue;
      const key = factKey(precondition);
      const candidates = (writes.get(key) ?? []).filter((writer) => writer.day < consumerDay);
      if (candidates.length === 0) {
        if (initial.has(key)) continue;
        throw new DagProviderError(`No earlier provider for deterministic precondition in event ${event.id} at ${key}`, { eventId: event.id, stateKey: key, phase: 'causal-compile' });
      }
      const newestDay = Math.max(...candidates.map((c) => c.day));
      const newest = candidates.filter((candidate) => candidate.day === newestDay);
      if (newest.length !== 1) {
        throw new DagProviderError(`Ambiguous latest provider for deterministic precondition in event ${event.id} at ${key}`, { eventId: event.id, stateKey: key, phase: 'causal-compile' });
      }
      const provider = newest[0];
      if (provider.eventId === event.id) {
        throw new DagProviderError(`Event ${event.id} cannot provide its own precondition at ${key}`, { eventId: event.id, stateKey: key, phase: 'causal-compile' });
      }
      edges.get(provider.eventId)!.push(event.id);
      inDegree.set(event.id, (inDegree.get(event.id) ?? 0) + 1);
    }
  }

  return { edges, inDegree };
}
/** Kahn sort that leaves its input graph untouched and rejects cycles.
 *  When multiple events become ready simultaneously (in-degree 0),
 *  story-time day acts as deterministic tiebreaker, with event id as
 *  secondary key. This guarantees the output respects causal edges. */
export function topologicalSort(
  events: NarrativeEvent[],
  edges: AdjacencyList,
  inputInDegree: Map<string, number>,
  anchors?: Map<string, number>,
): string[] {
  const inDegree = new Map(inputInDegree);
  const eventById = new Map(events.map((event) => [event.id, event]));

  // Deterministic priority: earliest story-time day first, event id as last resort
  function compareByStory(a: string, b: string): number {
    const ea = eventById.get(a)!;
    const eb = eventById.get(b)!;
    const dayA = anchors ? resolveTimestampToDay(ea.storyTime, anchors) : 0;
    const dayB = anchors ? resolveTimestampToDay(eb.storyTime, anchors) : 0;
    return (dayA - dayB) || a.localeCompare(b);
  }

  const ready = events
    .filter((event) => inDegree.get(event.id) === 0)
    .map((event) => event.id)
    .sort(compareByStory);
  const result: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    result.push(current);
    const newReady: string[] = [];
    for (const neighbor of edges.get(current) ?? []) {
      const remaining = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, remaining);
      if (remaining === 0) newReady.push(neighbor);
    }
    if (newReady.length > 0) {
      newReady.sort(compareByStory);
      ready.push(...newReady);
    }
  }

  if (result.length !== events.length) {
    const cycle = events.filter((event) => !result.includes(event.id)).map((event) => event.id);
    throw new DagCycleError('Causal graph contains a cycle', { cycle, phase: 'causal-sort' });
  }
  if (result.some((id) => !eventById.has(id))) throw new DagProviderError('Causal graph contains an unknown event', { phase: 'causal-sort' });
  return result;
}
