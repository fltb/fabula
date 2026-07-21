// ============================================================================
// ReplayEngine — Replay events to reconstruct world state
// ============================================================================

import type { NarrativeEvent, WorldState, BranchPath, EntityRuntimeState, EntityDeclarationCatalog, EntityTypeCatalog, EntityTypeDefinition } from '../types/index.js';
import {
  createEmptyBranchPath,
  includesPath,
} from '../branch/index.js';
import { buildCausalEdges, topologicalSort } from './dag.js';
import { ConfigError, PreconditionMismatchError } from '../errors.js';
import { compareFact } from '../entity/compare.js';
import { canonicalizeFactValue } from '../entity/fact-value.js';
import { applyRelationshipTransaction } from './relationship-replay.js';
import { convertRelationshipChange } from '../types/relationship.js';
import type { ThreadTransaction } from '../types/index.js';
import { applyThreadTransaction, convertLegacyThreadProgress, isLegacyThreadProgress } from './thread-replay.js';
import { applyRuleTransaction, convertLegacyRuleEffect, isLegacyRuleEffect } from './rule-replay.js';
const LIFECYCLE_STATES: Record<string, true> = { active: true, inactive: true, retired: true };

const DEFAULT_LIFECYCLE_TRANSITIONS: Array<[EntityRuntimeState, EntityRuntimeState]> = [
  ['active', 'inactive'],
  ['active', 'retired'],
  ['inactive', 'active'],
  ['inactive', 'retired'],
];




// ——— Rule effect application helper (backward-compat) ———
//
// Legacy RuleEffectEntry is converted to RuleTransaction and applied
// via the structured rule-replay path. This wrapper preserves the
// original function signature for backward compatibility.
//
function applyRuleEffect(
  state: WorldState,
  re: { rule: string; effect: string; evidence: string }
): void {
  const tx = convertLegacyRuleEffect(
    { rule: re.rule, effect: re.effect as 'reinforce' | 'weaken' | 'introduce_exception' | 'nullify', evidence: re.evidence },
    'replay',
  );
  applyRuleTransaction(state.rules, tx, { nodeId: 'replay' });
}

// ——— Precondition operator checker ———

function checkOperator(
  operator: string,
  stateValue: unknown,
  factValue: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return stateValue === factValue;
    case 'neq':
      // Missing state does not satisfy neq
      if (stateValue === undefined) return false;
      return stateValue !== factValue;
    case 'gt':
      if (typeof stateValue !== 'number' || typeof factValue !== 'number') return false;
      return stateValue > factValue;
    case 'gte':
      if (typeof stateValue !== 'number' || typeof factValue !== 'number') return false;
      return stateValue >= factValue;
    case 'lt':
      if (typeof stateValue !== 'number' || typeof factValue !== 'number') return false;
      return stateValue < factValue;
    case 'lte':
      if (typeof stateValue !== 'number' || typeof factValue !== 'number') return false;
      return stateValue <= factValue;
    case 'contains':
      if (typeof stateValue === 'string' && typeof factValue === 'string') {
        return stateValue.includes(factValue);
      }
      if (Array.isArray(stateValue)) {
        return stateValue.some((v) => v === factValue);
      }
      return false;
    case 'not_contains':
      if (typeof stateValue === 'string' && typeof factValue === 'string') {
        return !stateValue.includes(factValue);
      }
      if (Array.isArray(stateValue)) {
        return !stateValue.some((v) => v === factValue);
      }
      // Missing or incompatible state: definitely does not contain, so not_contains is true
      return true;
    default:
      return stateValue === factValue;
  }
}

export class ReplayEngine {
  private entityDeclarationCatalog?: EntityDeclarationCatalog;
  private entityTypeCatalog?: EntityTypeCatalog;

  constructor(catalogs?: { entityDeclarationCatalog?: EntityDeclarationCatalog; entityTypeCatalog?: EntityTypeCatalog }) {
    this.entityDeclarationCatalog = catalogs?.entityDeclarationCatalog;
    this.entityTypeCatalog = catalogs?.entityTypeCatalog;
  }

  /**
   * Replay events to build the current world state.
   * Optionally filter by branch path for branch-aware state.
   */
  replay(
    events: NarrativeEvent[],
    branchPath?: BranchPath,
  ): WorldState {
    const bp = branchPath ?? createEmptyBranchPath();

    const selectedEvents = events.filter((event) => includesPath(event.branchExistence, bp));

    // Extract anchors from absolute storyTimes for deterministic day-based sorting
    const anchors = new Map<string, number>();
    for (const { storyTime } of selectedEvents) {
      if (storyTime.type === 'absolute') {
        const m = storyTime.value.match(/^day[_\s]*(-?\d+)$/i);
        if (m) anchors.set(storyTime.value, parseInt(m[1], 10));
      }
    }

    const { edges, inDegree } = buildCausalEdges(selectedEvents, { anchors, branchPath: bp });
    const sortedIds = topologicalSort(selectedEvents, edges, inDegree, anchors);
    const idToEvent = new Map(selectedEvents.map((event) => [event.id, event]));
    const sorted = sortedIds.map((id) => idToEvent.get(id)!);

    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };
    // Track lifecycle changes by storyTime for conflict detection
    const lifecycleChangesByStoryTime = new Map<string, Set<string>>();


    for (const event of sorted) {
      // Branch filtering: skip events not on this path
      if (!includesPath(event.branchExistence, bp)) continue;

      // ── Phase 1: Validate all deterministic preconditions BEFORE effects ──
      for (const fact of event.preconditions) {
        if (!includesPath(fact.validity.branches, bp)) continue;

        const op = (fact as unknown as Record<string, unknown>).operator as string | undefined;

        // exists / not_exists: direct check, no value required
        if (op === 'exists') {
          if (state.entities[fact.entityId]?.[fact.attribute] === undefined) {
            throw new PreconditionMismatchError(
              `Precondition exists fails: ${fact.entityId}.${fact.attribute} is absent`,
              { eventId: event.id, stateKey: `${fact.entityId}.${fact.attribute}`, phase: 'replay' },
            );
          }
          continue;
        }
        if (op === 'not_exists') {
          if (state.entities[fact.entityId]?.[fact.attribute] !== undefined) {
            throw new PreconditionMismatchError(
              `Precondition not_exists fails: ${fact.entityId}.${fact.attribute} is present`,
              { eventId: event.id, stateKey: `${fact.entityId}.${fact.attribute}`, phase: 'replay' },
            );
          }
          continue;
        }

        // Skip narrativeHint-only preconditions (deferred to Pass 2)
        if (fact.value === undefined) continue;

        // Operator-based check (defaults to 'eq')
        const operator = op ?? 'eq';
        const stateValue = state.entities[fact.entityId]?.[fact.attribute];
        const matched = checkOperator(operator, stateValue, fact.value);
        if (!matched) {
          throw new PreconditionMismatchError(
            `Precondition ${operator} fails for ${fact.entityId}.${fact.attribute}`,
            { eventId: event.id, stateKey: `${fact.entityId}.${fact.attribute}`, phase: 'replay' },
          );
        }
      }

      // ── Phase 2: Apply postcondition effects ──
      const writtenKeys = new Set<string>();
      const introducedThisEvent = new Set<string>();
      for (const fact of event.postconditions) {
        if (!includesPath(fact.validity.branches, bp)) continue;

        const op = (fact as unknown as Record<string, unknown>).operation as string | undefined;

        // Form 3: narrativeHint-only — skip WorldState write
        if (fact.value === undefined && fact.narrativeHint !== undefined && op !== 'unset') {
          state.facts.push(fact);
          continue;
        }

        // Introduce or resolve entity
        if (!state.entities[fact.entityId]) {
          // Entity not yet in state — check declaration catalog if available
          if (this.entityDeclarationCatalog && !this.entityDeclarationCatalog.declarations[fact.entityId]) {
            throw new ConfigError(
              `Unknown entity ${fact.entityId}: not found in declaration catalog`,
              { path: fact.entityId, eventId: event.id, phase: 'replay' },
            );
          }
          state.entities[fact.entityId] = { lifecycle: 'active' };
          introducedThisEvent.add(fact.entityId);
        }

        // Retired entity guard: no writes allowed except lifecycle attribute itself
        if (state.entities[fact.entityId]?.lifecycle === 'retired' && fact.attribute !== 'lifecycle') {
          throw new ConfigError(
            `Cannot modify retired entity ${fact.entityId}`,
            { path: fact.entityId, eventId: event.id, phase: 'replay' },
          );
        }

        // Prevent unset of lifecycle
        if (fact.attribute === 'lifecycle' && op === 'unset') {
          throw new ConfigError(
            `Cannot unset lifecycle on ${fact.entityId}`,
            { path: fact.entityId, eventId: event.id, phase: 'replay' },
          );
        }

        // Detect duplicate write to same (entityId, attribute) within this node
        const key = `${fact.entityId}::${fact.attribute}`;
        if (writtenKeys.has(key)) {
          throw new ConfigError(
            `Duplicate write to ${fact.entityId}.${fact.attribute} within event ${event.id}`,
            { path: fact.entityId, eventId: event.id, phase: 'replay' },
          );
        }
        writtenKeys.add(key);

        // ── Lifecycle transition detection ──
        const rawValue = fact.value !== undefined ? String(fact.value) : undefined;
        if (
          fact.attribute === 'lifecycle' &&
          rawValue !== undefined &&
          op !== 'unset' &&
          LIFECYCLE_STATES[rawValue]
        ) {
          const newLifecycle = rawValue as EntityRuntimeState;
          const currentLifecycle = (state.entities[fact.entityId]?.lifecycle as EntityRuntimeState) ?? 'active';

          // Resolve allowed transitions
          let allowedTransitions = DEFAULT_LIFECYCLE_TRANSITIONS;
          if (this.entityTypeCatalog && this.entityDeclarationCatalog) {
            const decl = this.entityDeclarationCatalog.declarations[fact.entityId];
            if (decl) {
              const typeDef = this.entityTypeCatalog.types[decl.typeRef.typeId];
              if (typeDef) {
                allowedTransitions = typeDef.lifecyclePolicy.allowedTransitions;
              }
            }
          }

          const isValid = allowedTransitions.some(
            ([from, to]) => from === currentLifecycle && to === newLifecycle,
          );
          if (!isValid) {
            throw new ConfigError(
              `Invalid lifecycle transition: ${currentLifecycle} → ${newLifecycle} for entity ${fact.entityId}`,
              { path: fact.entityId, eventId: event.id, phase: 'replay' },
            );
          }

          // Same storyTime lifecycle conflict detection
          if (event.storyTime) {
            const stKey = JSON.stringify(event.storyTime);
            if (!lifecycleChangesByStoryTime.has(stKey)) {
              lifecycleChangesByStoryTime.set(stKey, new Set());
            }
            if (lifecycleChangesByStoryTime.get(stKey)!.has(fact.entityId)) {
              throw new ConfigError(
                `Same storyTime lifecycle conflict: multiple events at ${stKey} modify lifecycle of ${fact.entityId}`,
                { path: fact.entityId, eventId: event.id, phase: 'replay' },
              );
            }
            lifecycleChangesByStoryTime.get(stKey)!.add(fact.entityId);
          }
        }

        if (op === 'unset') {
          // Form 2: unset — delete attribute
          if (!state.entities[fact.entityId] || !(fact.attribute in state.entities[fact.entityId])) {
            throw new ConfigError(
              `Cannot unset absent attribute ${fact.entityId}.${fact.attribute}`,
              { path: fact.entityId, eventId: event.id, phase: 'replay' },
            );
          }
          delete state.entities[fact.entityId][fact.attribute];
          state.facts.push(fact);
        } else if (fact.value !== undefined) {
          // Form 1: set (default or explicit 'set') — write canonicalized value
          state.entities[fact.entityId][fact.attribute] = canonicalizeFactValue(fact.value);
          state.facts.push(fact);
        }
      }

      // ── Participant lifecycle check: retired entities cannot participate unless introduced this event ──
      if (event.participants) {
        for (const pid of event.participants.entities) {
          if (state.entities[pid]?.lifecycle === 'retired' && !introducedThisEvent.has(pid)) {
            throw new ConfigError(
              `Retired entity ${pid} cannot participate in event ${event.id}`,
              { path: pid, eventId: event.id, phase: 'replay' },
            );
          }
        }
      }


      // ── Phase 3: Thread progress (STATE-5) ──
      // Backward compat: convert legacy ThreadProgressEntry to ThreadTransaction
      for (const tp of event.threadProgress) {
        const tx = isLegacyThreadProgress(tp)
          ? convertLegacyThreadProgress(tp, event.id)
          : (tp as unknown as ThreadTransaction);
        applyThreadTransaction(state.threads, tx);
      }

      // ── Phase 4: Relationship state (STATE-2) ──
      // Apply RelationshipTransaction[] from event.
      // Backward compat: items with 'participants' (old RelationshipChange shape)
      // are converted inline.
      for (const re of event.relationshipEffects) {
        let tx;
        if ('participants' in re && !('effectId' in re)) {
          // Old-style RelationshipChange — convert inline
          const idx = event.relationshipEffects.indexOf(re);
          tx = convertRelationshipChange(
            re as unknown as { participants: [string, string]; effect: string; direction: string; newState?: { type: string; intensity: number } },
            event.id,
            idx,
          );
        } else {
          tx = re;
        }
        applyRelationshipTransaction(state.relationships, tx);
      }

      // Knowledge state is owned by STATE-4 EpistemicLedger; replay does not write state.knowledge.
      // (Keep empty init for existing readers that access state.knowledge[entityId]?.knownFacts)
      for (const fact of event.postconditions) {
        if (fact.attribute === 'knows' || fact.attribute === 'knowledge') {
          if (!state.knowledge[fact.entityId]) {
            state.knowledge[fact.entityId] = { knownFacts: [] };
          }
        }
      }

      // ── Phase 5: Rule evidence (STATE-6) ──
      // Backward compat: convert legacy RuleEffectEntry to RuleTransaction
      for (const re of event.ruleEffects) {
        if (isLegacyRuleEffect(re)) {
          const tx = convertLegacyRuleEffect(re, event.id);
          applyRuleTransaction(state.rules, tx, { nodeId: event.id });
        } else {
          // Already a RuleTransaction
          applyRuleTransaction(state.rules, re as never, { nodeId: event.id });
        }
      }
    }

    return state;
  }

  /**
   * Get state at a specific DAG position (by replaying that many events in causal order).
   */
  getStateAt(
    events: NarrativeEvent[],
    position: number,
    branchPath?: BranchPath,
  ): WorldState {
    const bp = branchPath ?? createEmptyBranchPath();
    const selectedEvents = events.filter((event) => includesPath(event.branchExistence, bp));
    const anchors = new Map<string, number>();
    for (const { storyTime } of selectedEvents) {
      if (storyTime.type === 'absolute') {
        const m = storyTime.value.match(/^day[_\s]*(-?\d+)$/i);
        if (m) anchors.set(storyTime.value, parseInt(m[1], 10));
      }
    }
    const { edges, inDegree } = buildCausalEdges(selectedEvents, { anchors, branchPath: bp });
    const sortedIds = topologicalSort(selectedEvents, edges, inDegree, anchors);
    const idToEvent = new Map(selectedEvents.map((event) => [event.id, event]));
    const eventsToReplay = sortedIds.slice(0, position).map((id) => idToEvent.get(id)!);
    return this.replay(eventsToReplay, bp);
  }


}
