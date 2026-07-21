// ============================================================================
// ReplayEngine — Replay events to reconstruct world state
// ============================================================================

import type { NarrativeEvent, WorldState, BranchPath, Snapshot, EntityRuntimeState, EntityDeclarationCatalog, EntityTypeCatalog, EntityTypeDefinition } from '../types/index.js';
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
// ——— Lifecycle transition defaults ———
const LIFECYCLE_STATES: Record<string, true> = { active: true, inactive: true, retired: true };

const DEFAULT_LIFECYCLE_TRANSITIONS: Array<[EntityRuntimeState, EntityRuntimeState]> = [
  ['active', 'inactive'],
  ['active', 'retired'],
  ['inactive', 'active'],
  ['inactive', 'retired'],
];




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
    const { edges, inDegree } = buildCausalEdges(selectedEvents, { branchPath: bp });
    const sortedIds = topologicalSort(selectedEvents, edges, inDegree);
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


      // ── Phase 3: Thread progress ──
      for (const tp of event.threadProgress) {
        state.threads[tp.thread] = {
          progress: tp.progressAfter,
          total: tp.progressTotal,
        };
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

      // ── Phase 5: Rule evidence ──
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
    if (!snapshot) {
      return this.getStateAt(events, narrativeOrder, branchPath);
    }

    const bp = branchPath ?? createEmptyBranchPath();
    const state = JSON.parse(JSON.stringify(snapshot.state)) as WorldState;

    // Replay only events after snapshot, in causal order
    const eventsAfter = events.filter(
      (e) => e.narrativeOrder > snapshot.narrativeOrder && e.narrativeOrder <= narrativeOrder,
    );

    if (eventsAfter.length === 0) return state;

    const selectedEvents = eventsAfter.filter((event) =>
      includesPath(event.branchExistence, bp),
    );

    const anchors = new Map<string, number>();
    for (const { storyTime } of selectedEvents) {
      if (storyTime.type === 'absolute') {
        const m = storyTime.value.match(/^day[_\s]*(-?\d+)$/i);
        if (m) anchors.set(storyTime.value, parseInt(m[1], 10));
      }
    }

    const { edges, inDegree } = buildCausalEdges(selectedEvents, { anchors, branchPath: bp });
    const ordered = topologicalSort(selectedEvents, edges, inDegree, anchors);
    const eventById = new Map(events.map((event) => [event.id, event]));

    for (const eventId of ordered) {
      const event = eventById.get(eventId)!;

      // Track introduced entities for participant check
      const introducedThisEvent = new Set<string>();

      for (const fact of event.postconditions) {
        if (!includesPath(fact.validity.branches, bp)) continue;

        // Introduce entity with lifecycle: active
        if (!state.entities[fact.entityId]) {
          state.entities[fact.entityId] = { lifecycle: 'active' };
          introducedThisEvent.add(fact.entityId);
        }

        // Retired entity guard
        if (state.entities[fact.entityId]?.lifecycle === 'retired' && fact.attribute !== 'lifecycle') {
          throw new ConfigError(
            `Cannot modify retired entity ${fact.entityId}`,
            { path: fact.entityId, eventId, phase: 'replay' },
          );
        }

        // Lifecycle transition handling
        const rawValue = fact.value !== undefined ? String(fact.value) : undefined;
        if (
          fact.attribute === 'lifecycle' &&
          rawValue !== undefined &&
          LIFECYCLE_STATES[rawValue]
        ) {
          const currentLifecycle = (state.entities[fact.entityId]?.lifecycle as EntityRuntimeState) ?? 'active';
          const newLifecycle = rawValue as EntityRuntimeState;

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

          if (!allowedTransitions.some(([from, to]) => from === currentLifecycle && to === newLifecycle)) {
            throw new ConfigError(
              `Invalid lifecycle transition: ${currentLifecycle} → ${newLifecycle} for entity ${fact.entityId}`,
              { path: fact.entityId, eventId, phase: 'replay' },
            );
          }
        }

        if (fact.value !== undefined) {
          state.facts.push(fact);
          state.entities[fact.entityId][fact.attribute] = fact.value;
        }
      }

      // Participant lifecycle check
      if (event.participants) {
        for (const pid of event.participants.entities) {
          if (state.entities[pid]?.lifecycle === 'retired' && !introducedThisEvent.has(pid)) {
            throw new ConfigError(
              `Retired entity ${pid} cannot participate in event ${eventId}`,
              { path: pid, eventId, phase: 'replay' },
            );
          }
        }
      }

      for (const tp of event.threadProgress) {
        state.threads[tp.thread] = { progress: tp.progressAfter, total: tp.progressTotal };
      }
      event.ruleEffects.forEach((re) => applyRuleEffect(state, re));
    }

    return state;
  }

}
