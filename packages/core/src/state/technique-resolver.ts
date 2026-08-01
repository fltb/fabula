// ============================================================================
// Novalistically — Technique Resolver (GRAPH-3)
// Resolves authored direct technique contracts against compiled StoryGraph and
// DiscourseGraph. Output is a deterministic map keyed by selected event ID
// with contracts in NARRATIVE_TECHNIQUE_KINDS order. Every violation throws
// ConfigError with phase 'technique-resolution' and the owning event ID.
// ============================================================================

import { ConfigError } from '../errors.ts';
import type { NarratorAssertion } from '../types/discourse.js';
import type { NarrativeEvent } from '../types/event.js';
import type { DiscourseGraph, StoryGraph } from '../types/graph.js';
import type { ResolvedNarrativeTechniqueContract } from '../types/narrative-techniques.js';

// ═════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * BFS over the forward adjacency graph, following only author_origin and
 * provider edges. Returns true when a path from `from` to `to` exists.
 */
function hasCausalPath(
  from: string,
  to: string,
  adj: ReadonlyMap<string, readonly string[]>,
  visited: Set<string>,
): boolean {
  if (from === to) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  const neighbors = adj.get(from);
  if (!neighbors) return false;
  for (const next of neighbors) {
    if (hasCausalPath(next, to, adj, visited)) return true;
  }
  return false;
}

/**
 * Build forward adjacency from StoryGraph edges — only author_origin and
 * provider edges, mapping predecessor → list of dependents.
 */
function buildCausalAdjacency(storyGraph: StoryGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const edge of storyGraph.edges) {
    if (edge.edgeClass === 'author_origin' || edge.edgeClass === 'provider') {
      let list = adj.get(edge.predecessor);
      if (!list) {
        list = [];
        adj.set(edge.predecessor, list);
      }
      list.push(edge.dependent);
    }
  }
  return adj;
}

/**
 * Extract all assertion IDs referenced by disclosure actions in the
 * selected DiscourseGraph outputs.
 */
function collectDiscourseAssertionIds(discourseGraph: DiscourseGraph): Set<string> {
  const ids = new Set<string>();
  for (const output of discourseGraph.outputs) {
    if (output.value.type !== 'set') continue;
    const action = output.value.data as Record<string, unknown> | undefined;
    if (!action || typeof action !== 'object') continue;
    if (typeof action.assertionId === 'string') ids.add(action.assertionId);
    if (typeof action.priorAssertionId === 'string') ids.add(action.priorAssertionId);
    if (typeof action.newAssertionId === 'string') ids.add(action.newAssertionId);
  }
  return ids;
}

/**
 * Collect the set of read IDs that resolved to GraphAbsenceWitness in the
 * story graph.
 */
function collectAbsenceReadIds(storyGraph: StoryGraph): Set<string> {
  const ids = new Set<string>();
  for (const res of storyGraph.resolutions) {
    if (res.type === 'absence') {
      ids.add(res.readId);
    }
  }
  return ids;
}

/**
 * Build the set of all story graph output IDs.
 */
function collectStoryOutputIds(storyGraph: StoryGraph): Set<string> {
  const ids = new Set<string>();
  for (const output of storyGraph.outputs) {
    ids.add(output.outputId);
  }
  return ids;
}

// ═════════════════════════════════════════════════════════════════════════════
// resolveNarrativeTechniques — main resolver entry point
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve authored direct technique contracts against the compiled story and
 * discourse graphs. Only `source === 'event_file'` events are processed.
 *
 * @returns A ReadonlyMap from event ID to an ordered list of resolved
 *          contracts. Contracts appear in NARRATIVE_TECHNIQUE_KINDS order.
 *          Events without any contract are omitted from the map.
 *
 * @throws ConfigError with phase 'technique-resolution' and owning eventId
 *         on any invalid reference or structural violation.
 */
export function resolveNarrativeTechniques(input: {
  events: readonly NarrativeEvent[];
  storyGraph: StoryGraph;
  discourseGraph: DiscourseGraph;
  assertions: Readonly<Record<string, NarratorAssertion>>;
}): ReadonlyMap<string, readonly ResolvedNarrativeTechniqueContract[]> {
  // Filter to authored event-file scenes only
  const selectedEvents = input.events.filter((ev) => ev.source === 'event_file');
  const selectedEventIds = new Set(selectedEvents.map((ev) => ev.id));

  // Pre-compute indices
  const causalAdj = buildCausalAdjacency(input.storyGraph);
  const absenceReadIds = collectAbsenceReadIds(input.storyGraph);
  const discourseAssertionIds = collectDiscourseAssertionIds(input.discourseGraph);
  const storyOutputIds = collectStoryOutputIds(input.storyGraph);

  const result = new Map<string, ResolvedNarrativeTechniqueContract[]>();

  for (const event of selectedEvents) {
    const eid = event.id;
    const contracts: ResolvedNarrativeTechniqueContract[] = [];

    // ── causalDiscontinuity ──────────────────────────────────────────────
    if (event.causalDiscontinuity) {
      const { predecessor, dependent, instruction, requiredEvidence } = event.causalDiscontinuity;

      // Dependent MUST be the owning event
      if (dependent !== eid) {
        throw new ConfigError(
          `causalDiscontinuity dependent "${dependent}" must equal owning event "${eid}"`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }

      // Predecessor and dependent must be selected story nodes
      if (!selectedEventIds.has(predecessor) || !selectedEventIds.has(dependent)) {
        throw new ConfigError(
          `causalDiscontinuity predecessor "${predecessor}" or dependent ` +
            `"${dependent}" not in selected story nodes`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }

      // NO direct or transitive causal path via author_origin/provider edges
      if (hasCausalPath(predecessor, dependent, causalAdj, new Set())) {
        throw new ConfigError(
          `causalDiscontinuity: causal path exists from "${predecessor}" to ` +
            `"${dependent}" via author_origin/provider edges — contract conflicts with graph`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }

      contracts.push({ kind: 'causalDiscontinuity', instruction, requiredEvidence });
    }

    // ── surfaceMode ──────────────────────────────────────────────────────
    // No external references; strict-schema validated instruction/evidence only.
    if (event.surfaceMode) {
      const { instruction, requiredEvidence } = event.surfaceMode;
      contracts.push({ kind: 'surfaceMode', instruction, requiredEvidence });
    }

    // ── causalMultiplicity ───────────────────────────────────────────────
    if (event.causalMultiplicity) {
      const { minimumOutgoingEdges, instruction, requiredEvidence } = event.causalMultiplicity;

      const outgoingDependents = causalAdj.get(eid);
      const uniqueCount = outgoingDependents ? new Set(outgoingDependents).size : 0;

      if (uniqueCount < minimumOutgoingEdges) {
        throw new ConfigError(
          `causalMultiplicity: event "${eid}" has ${uniqueCount} unique outgoing ` +
            `author_origin/provider edge(s) but minimumOutgoingEdges is ${minimumOutgoingEdges}`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }

      contracts.push({ kind: 'causalMultiplicity', instruction, requiredEvidence });
    }

    // ── irresolvableIndeterminacy ────────────────────────────────────────
    if (event.irresolvableIndeterminacy) {
      const { assertionIds, instruction, requiredEvidence } = event.irresolvableIndeterminacy;

      for (const aid of assertionIds) {
        if (!(aid in input.assertions)) {
          throw new ConfigError(
            `irresolvableIndeterminacy: assertion "${aid}" not found in ` +
              `runtime assertion catalog`,
            { phase: 'technique-resolution', eventId: eid },
          );
        }
        if (!discourseAssertionIds.has(aid)) {
          throw new ConfigError(
            `irresolvableIndeterminacy: assertion "${aid}" not referenced by ` +
              `selected DiscourseGraph.outputs`,
            { phase: 'technique-resolution', eventId: eid },
          );
        }
      }

      contracts.push({ kind: 'irresolvableIndeterminacy', instruction, requiredEvidence });
    }

    // ── absentApparatus ──────────────────────────────────────────────────
    if (event.absentApparatus) {
      const { readId, instruction, requiredEvidence } = event.absentApparatus;

      const ownedRead = input.storyGraph.reads.some(
        (read) => read.readId === readId && readId.startsWith(`${eid}:precondition:`),
      );
      if (!ownedRead || !absenceReadIds.has(readId)) {
        throw new ConfigError(
          `absentApparatus: readId "${readId}" must be an owning event precondition ` +
            `resolved by GraphAbsenceWitness for event "${eid}"`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }

      contracts.push({ kind: 'absentApparatus', instruction, requiredEvidence });
    }

    // ── voiceDissonance ──────────────────────────────────────────────────
    if (event.voiceDissonance) {
      const { assertionId, storyOutputId, instruction, requiredEvidence } = event.voiceDissonance;

      if (!(assertionId in input.assertions)) {
        throw new ConfigError(
          `voiceDissonance: assertion "${assertionId}" not found in ` + `runtime assertion catalog`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }
      if (!discourseAssertionIds.has(assertionId)) {
        throw new ConfigError(
          `voiceDissonance: assertion "${assertionId}" not referenced by ` +
            `selected DiscourseGraph.outputs`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }
      if (!storyOutputIds.has(storyOutputId)) {
        throw new ConfigError(
          `voiceDissonance: storyOutputId "${storyOutputId}" not found in ` +
            `selected StoryGraph.outputs`,
          { phase: 'technique-resolution', eventId: eid },
        );
      }

      contracts.push({ kind: 'voiceDissonance', instruction, requiredEvidence });
    }

    // ── multiplicity ─────────────────────────────────────────────────────
    if (event.multiplicity) {
      const { assertionIds, instruction, requiredEvidence } = event.multiplicity;

      for (const aid of assertionIds) {
        if (!(aid in input.assertions)) {
          throw new ConfigError(
            `multiplicity: assertion "${aid}" not found in runtime assertion catalog`,
            { phase: 'technique-resolution', eventId: eid },
          );
        }
        if (!discourseAssertionIds.has(aid)) {
          throw new ConfigError(
            `multiplicity: assertion "${aid}" not referenced by selected ` +
              `DiscourseGraph.outputs`,
            { phase: 'technique-resolution', eventId: eid },
          );
        }
      }

      contracts.push({ kind: 'multiplicity', instruction, requiredEvidence });
    }

    // ── metanarrativeLevel ───────────────────────────────────────────────
    // No external references; strict-schema validated instruction/evidence only.
    if (event.metanarrativeLevel) {
      const { instruction, requiredEvidence } = event.metanarrativeLevel;
      contracts.push({ kind: 'metanarrativeLevel', instruction, requiredEvidence });
    }

    if (contracts.length > 0) {
      result.set(eid, contracts);
    }
  }

  return result;
}
