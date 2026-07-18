// ============================================================================
// ReplayEngine — Replay events to reconstruct world state
// ============================================================================

import type { NarrativeEvent, WorldState, BranchPath, Fact, Snapshot } from '../types/index.js';
import {
  createEmptyBranchPath,
  includesPath,
} from '../branch/index.js';
import { buildCausalEdges, topologicalSort } from './dag.js';

// ——— Rule effect application helper ———

function applyRuleEffect(
  state: WorldState,
  re: { rule: string; effect: string; evidence: string }
): void {
  if (!state.rules[re.rule]) {
    state.rules[re.rule] = { activeEvidence: 0, nullified: false, exceptions: [] };
  }
  switch (re.effect) {
    case 'reinforce':
      state.rules[re.rule].activeEvidence++;
      state.rules[re.rule].nullified = false;  // reinforce clears nullification
      break;
    case 'weaken':
      state.rules[re.rule].activeEvidence = Math.max(0, state.rules[re.rule].activeEvidence - 1);
      break;
    case 'nullify':
      state.rules[re.rule].activeEvidence = 0;
      state.rules[re.rule].nullified = true;
      break;
    case 'introduce_exception':
      state.rules[re.rule].exceptions.push(re.evidence);
      break;
  }
}

export class ReplayEngine {
  /**
   * Replay events to build the current world state.
   * Optionally filter by branch path for branch-aware state.
   */
  replay(
    events: NarrativeEvent[],
    branchPath?: BranchPath,
  ): WorldState {
    const bp = branchPath ?? createEmptyBranchPath();

    // Sort events by causal DAG order; fall back to narrativeOrder on cycle
    let sorted: NarrativeEvent[];
    try {
      const { edges, inDegree } = buildCausalEdges(events);
      const sortedIds = topologicalSort(events, edges, inDegree);
      const idToEvent = new Map(events.map((e) => [e.id, e]));
      sorted = sortedIds.map((id) => idToEvent.get(id)!);
    } catch (err) {
      if (err instanceof Error && err.message.includes('cycle detected')) {
        console.warn(
          '[ReplayEngine] DAG cycle detected, falling back to narrativeOrder sort',
        );
        sorted = [...events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
      } else {
        throw err;
      }
    }

    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    for (const event of sorted) {
      // Branch filtering: skip events not on this path
      if (!includesPath(event.branchExistence, bp)) continue;

      // Apply postconditions to entities
      for (const fact of event.postconditions) {
        // Also filter facts by branch
        if (!includesPath(fact.validity.branches, bp)) continue;

        if (!state.entities[fact.entityId]) {
          state.entities[fact.entityId] = {};
        }
        // Only write deterministic values; narrativeHint facts are skipped
        // (they are consumed by Pass 2 analysis, not written to WorldState)
        if (fact.value !== undefined) {
          state.facts.push(fact);
          state.entities[fact.entityId][fact.attribute] = fact.value;
        }
      }

      // Apply preconditions (they become known facts about the entity too)
      for (const fact of event.preconditions) {
        if (!includesPath(fact.validity.branches, bp)) continue;
        if (!state.entities[fact.entityId]) {
          state.entities[fact.entityId] = {};
        }
        // Only set if not already set by a later postcondition AND has a deterministic value
        if (!(fact.attribute in state.entities[fact.entityId]) && fact.value !== undefined) {
          state.entities[fact.entityId][fact.attribute] = fact.value;
        }
      }

      // Update thread progress
      for (const tp of event.threadProgress) {
        state.threads[tp.thread] = {
          progress: tp.progressAfter,
          total: tp.progressTotal,
        };
      }

      // Update relationship state
      for (const re of event.relationshipEffects) {
        const relKey = [re.participants[0], re.participants[1]].sort().join('_');
        if (!state.relationships[relKey]) {
          state.relationships[relKey] = { direction: {} };
        }

        // Parse direction (e.g., "camille → npc_gear")
        const dirMatch = re.direction.match(/(\S+)\s*→\s*(\S+)/);
        if (dirMatch) {
          const from = dirMatch[1];
          if (!state.relationships[relKey].direction[from]) {
            state.relationships[relKey].direction[from] = { dimensions: {}, perceivedBy: {} };
          }
          if (re.newState) {
            const dirEntry = state.relationships[relKey].direction[from]!;
            if (re.newState.type !== undefined) {
              dirEntry.dimensions['type'] = re.newState.type;
            }
            if (re.newState.intensity !== undefined) {
              dirEntry.dimensions['intensity'] = re.newState.intensity;
            }
          }
        }
      }

      // Update knowledge (from postconditions that look like "entity.knows = X")
      for (const fact of event.postconditions) {
        if (fact.attribute === 'knows' || fact.attribute === 'knowledge') {
          if (!state.knowledge[fact.entityId]) {
            state.knowledge[fact.entityId] = { knownFacts: [] };
          }
          state.knowledge[fact.entityId].knownFacts.push(fact.id);
        }
      }

      // Update rule evidence
      event.ruleEffects.forEach(re => applyRuleEffect(state, re));
    }

    return state;
  }

  /**
   * Get state at a specific narrative order (by replaying up to that point).
   */
  getStateAt(
    events: NarrativeEvent[],
    narrativeOrder: number,
    branchPath?: BranchPath,
  ): WorldState {
    const relevantEvents = events.filter(
      (e) => e.narrativeOrder <= narrativeOrder,
    );
    return this.replay(relevantEvents, branchPath);
  }

  /**
   * Optimized: use snapshot + incremental replay
   */
  getStateAtOptimized(
    events: NarrativeEvent[],
    narrativeOrder: number,
    snapshot: Snapshot | null,
    branchPath?: BranchPath,
  ): WorldState {
    const bp = branchPath ?? createEmptyBranchPath();

    if (!snapshot) {
      return this.getStateAt(events, narrativeOrder, bp);
    }

    // Start from snapshot state
    const state = JSON.parse(JSON.stringify(snapshot.state)) as WorldState;

    // Replay events after the snapshot
    const eventsAfter = events.filter(
      (e) =>
        e.narrativeOrder > snapshot.narrativeOrder &&
        e.narrativeOrder <= narrativeOrder,
    ).sort((a, b) => a.narrativeOrder - b.narrativeOrder);

    for (const event of eventsAfter) {
      if (!includesPath(event.branchExistence, bp)) continue;

      for (const fact of event.postconditions) {
        if (!includesPath(fact.validity.branches, bp)) continue;

        if (!state.entities[fact.entityId]) {
          state.entities[fact.entityId] = {};
        }
        if (fact.value !== undefined) {
          state.facts.push(fact);
          state.entities[fact.entityId][fact.attribute] = fact.value;
        }
      }

      for (const tp of event.threadProgress) {
        state.threads[tp.thread] = {
          progress: tp.progressAfter,
          total: tp.progressTotal,
        };
      }

      event.ruleEffects.forEach(re => applyRuleEffect(state, re));
    }

    return state;
  }
}
