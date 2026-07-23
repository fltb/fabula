# State Semantics Reference

**Version:** 1.0
**Date:** 2026-07-22
**Status:** Baseline frozen

**Source files:**
- `packages/core/src/state/dag.ts` — `buildCausalEdges()`, `topologicalSort()`, `DagCycleError`, `DagProviderError`
- `packages/core/src/state/replay.ts` — `ReplayEngine`, `checkOperator()`, `PreconditionMismatchError`
- `packages/core/src/state/story-boundaries.ts` — `compileStoryBoundaries()`, `StoryBoundaries`
- `packages/core/src/state/snapshot.ts` — `SnapshotEngine`
- `packages/core/src/state/merge-plan.ts` — `compileMergePlan()`, `reconcileMergePlan()`
- `packages/core/src/state/manager.ts` — `StateManager`
- `packages/core/src/entity/fact-value.ts` — `canonicalizeFactValue()`, `isCanonicalFactValue()`, `canonicalDeepEqual()`
- `packages/core/src/entity/compare.ts` — `compareFact()`
- `packages/core/src/schemas/primitives.ts` — `preconditionSchema`, `postconditionSchema`, `PLACEHOLDER_PATTERN`
- `packages/core/src/schemas/event.ts` — `eventFileSchema`
- `packages/core/src/schemas/state-initial.ts` — `worldInitialStateSchema`
- `packages/core/src/types/entity.ts` — `Fact`, `FactId`
- `packages/core/src/types/event.ts` — `NarrativeEvent`, `EventFile`
- `packages/core/src/types/branch.ts` — `BranchPath`, `BranchSet`, `BranchPoint`, `Condition`
- `packages/core/src/errors.ts` — all error classes (17 types)

This document defines the state semantics of the Novalistically narrative engine per STORY-SEMANTICS specification (TODO.md L896-914). It is the authoritative reference for authors and integrators.

---

## 1. Supported Scope

Novalistically models story state as a **discrete, deterministic, replayable** system. Every state change is recorded as a `NarrativeEvent`. The world state is never mutated in place — it is always **derived by replaying events from an initial state**.

### 1.1 Event Sourcing Architecture

The `WorldState` interface captures six dimensions of narrative state:

| Dimension | Key | Description |
|-----------|-----|-------------|
| `entities` | `EntityId → Record<string, unknown>` | Entity runtime state (lifecycle, attributes) |
| `relationships` | `string → RelationshipState` | Multi-entity relationship state |
| `knowledge` | `EntityId → EpistemicLedger` | Character/faction knowledge/belief |
| `threads` | `string → ThreadRuntimeState` | Narrative thread state |
| `rules` | `string → RuleRuntimeState` | World rule state |
| `facts` | `Fact[]` | Append-only fact log |

**Source:** `packages/core/src/types/world.ts`, `packages/core/src/types/entity.ts`

### 1.2 Causal DAG

The `buildCausalEdges()` function (in `dag.ts`) constructs a directed acyclic graph from events' deterministic `preconditions` and `postconditions`:

- Each deterministic precondition (where `fact.value !== undefined`) creates a read-after-write edge from the latest earlier event that writes a matching fact key.
- `factKey()` is computed as `{entityId}\0{attribute}\0{JSON.stringify(value)}` — matching exact entity, attribute, and value.
- `topologicalSort()` runs Kahn's algorithm with story-time day as deterministic tiebreaker and event ID (localeCompare) as secondary key. `narrativeOrder` is NEVER consulted for causal ordering.
- The sorted result is the **unique deterministic causal order** per branch.

**Test:** `dag.test.ts` (causal ordering, tiebreaking), `dag-tiebreaker.test.ts` (storyTime > narrativeOrder)

### 1.3 Story Boundaries (StorySnapshot)

`compileStoryBoundaries()` in `story-boundaries.ts` produces:

- `orderedEventIds: string[]` — events in causal order
- `stateBeforeByEventId: Map<string, WorldState>` — snapshot of state before each event
- `finalState: WorldState` — state after all events

Initial facts (`initialFacts`) are applied before the first event, providing the genesis state. These are NOT a synthetic `NarrativeEvent` — they are separate deterministic input.

**Test:** `story-boundaries.test.ts`, `genesis-root.test.ts`

### 1.4 ReplayEngine

`ReplayEngine.replay()` (in `replay.ts`) processes events in a 4-phase loop per event:

1. **Phase 1: Validate all deterministic preconditions** — throws `PreconditionMismatchError` on failure
2. **Phase 2: Apply postcondition effects** — set/unset writes, entity lifecycle
3. **Phase 3: Thread progress** — applies thread transactions
4. **Phase 4: Relationship effects** — applies relationship transactions

### 1.5 SnapshotEngine

`SnapshotEngine` in `snapshot.ts` periodically captures `WorldState` at configurable intervals (default every 20 events). Snapshots are keyed by event count (not narrativeOrder). `findNearest()` enables fast recovery by finding the closest snapshot and replaying forward.

---

## 2. Rejection Cases

Every rejection case produces a typed error with a stable `code` string and structured `context`. No fallback, silent initialization, or degraded path is ever used.

### 2.1 DAG Cycle

**Error:** `DagCycleError` (`DAG_CYCLE`)

**When thrown:** `topologicalSort()` detects a cycle in the causal graph.

**Context fields:** `cycle: string[]` (event IDs in the cycle), `phase: string`

**Trigger examples:**
- Event A precondition-depends on event B, which precondition-depends on event A
- Same-time unordered non-commuting writes to the same cell

**Test:** `dag.test.ts` ("does not mutate indegree and rejects cycles"), `graph-compiler.test.ts`

### 2.2 Placeholder Values

**Schema rejection:** `postconditionSchema` and `preconditionSchema` in `primitives.ts`

The `PLACEHOLDER_PATTERN` regex rejects: `changed`, `resolved`, `updated`, `affected`, `modified`, `altered` (case-insensitive).

**Where rejected:** `preconditionSchema.value` and `postconditionSchema.value` via `.refine()`

**Example invalid YAML:**
```yaml
expectedPostconditions:
  - entity: hero
    attribute: status
    value: changed  # ERROR: placeholder rejected
```

**Test:** `contracts.test.ts`

### 2.3 Precondition Mismatch

**Error:** `PreconditionMismatchError` (`PRECONDITION_MISMATCH`)

**When thrown:** An event's deterministic precondition does not match the current world state during replay.

**Context fields:** `eventId: string`, `stateKey: string`, `phase: 'replay' | 'story-boundaries'`

**Location:** `replay.ts` Phase 1 and `story-boundaries.ts` compile-time boundary check.

**Test:** `replay-set-unset.test.ts`, `presence-aware-preconditions.test.ts`

### 2.4 Unset initialFacts

**Rejection:** `story-boundaries.ts` `applyFacts()` only processes facts with `value !== undefined`. The `compileStoryBoundaries()` function rejects `initialFacts` that contain `operation: 'unset'` or `narrativeHint`-only facts — initialFacts must be deterministic set writes.

**Test:** `genesis-root.test.ts`

### 2.5 Missing Provenance

**Error:** Various graph compiler errors from `graph-compiler.ts`:
- `UnknownPredecessorError` — explicit edge references non-existent node
- `MissingOutputError` — read requirement has no provider
- `AmbiguousOutputError` — multiple candidates for same read at same time
- `ProvenanceError` — missing/invalid provenance metadata

**Test:** `graph-compiler.test.ts`

### 2.6 Branch-Incompatible Provider

**Error:** `DagProviderError` (`DAG_PROVIDER_INVALID`)

**When thrown:** No earlier provider for a deterministic precondition, ambiguous latest provider, self-dependency, or provider in a different branch lane not visible from the current path.

**Test:** `dag.test.ts`, `diamond.test.ts`

### 2.7 Other Rejection Cases

| Case | Error | Code | Source |
|------|-------|------|--------|
| Invalid YAML syntax | `ConfigError` | `CONFIG_INVALID` | `schemas/` strict Zod parsers |
| Unknown event field | `ConfigError` | `CONFIG_INVALID` | `.strict()` schema rejection |
| Duplicate write in one event | `ConfigError` | `CONFIG_INVALID` | `replay.ts` Phase 2 |
| Unset on absent attribute | `ConfigError` | `CONFIG_INVALID` | `replay.ts` Phase 2 |
| Unknown entity | `ConfigError` | `CONFIG_INVALID` | `replay.ts` Phase 2 |
| Invalid lifecycle transition | `ConfigError` | `CONFIG_INVALID` | `replay.ts` Phase 2 |
| Write to retired entity | `ConfigError` | `CONFIG_INVALID` | `replay.ts` Phase 2 |
| Same-time lifecycle conflict | `ConfigError` | `CONFIG_INVALID` | `replay.ts`, `story-boundaries.ts` |
| Invalid canonical value | `ConfigError` | `CONFIG_INVALID` | `fact-value.ts` |
| value + narrativeHint together | Schema validation | custom | `primitives.ts` superRefine |

**Test:** `errors.test.ts` (all 17 error types), `contracts.test.ts` (schema validation)

---

## 3. YAML Causal Dependency Syntax

### 3.1 Preconditions (10 Operators)

| Operator | Requires value | Behavior |
|----------|---------------|----------|
| `eq` (default) | Yes | `stateValue === factValue` |
| `neq` | Yes | `stateValue !== factValue` (missing state = false) |
| `gt` | Yes (numeric) | `stateValue > factValue` |
| `gte` | Yes (numeric) | `stateValue >= factValue` |
| `lt` | Yes (numeric) | `stateValue < factValue` |
| `lte` | Yes (numeric) | `stateValue <= factValue` |
| `contains` | Yes | string contains / array includes |
| `not_contains` | Yes | string does NOT contain / array does NOT include |
| `exists` | **No** | attribute present (any value, including null) |
| `not_exists` | **No** | attribute absent |

**YAML syntax:**
```yaml
preconditions:
  # eq (default)
  - entity: xianglins_wife
    attribute: location
    value: fourth_master_lu_house

  # neq
  - entity: xianglins_wife
    attribute: status
    operator: neq
    value: dead

  # numeric comparison
  - entity: hero
    attribute: level
    operator: gte
    value: 5

  # existence check
  - entity: hero
    attribute: hidden_skill
    operator: exists
    # NO value field

  # narrativeHint-only (deferred to Pass 2)
  - entity: xianglins_wife
    attribute: emotional_state
    narrativeHint: "She appears hopeful"
```

### 3.2 Postconditions (Three Forms)

**Form 1 — Set (default):**
```yaml
expectedPostconditions:
  - entity: xianglins_wife
    attribute: spiritual_state
    value: broken
```

**Form 2 — Unset:**
```yaml
expectedPostconditions:
  - entity: xianglins_wife
    attribute: temporary_flag
    operation: unset
```

**Form 3 — narrativeHint-only:**
```yaml
expectedPostconditions:
  - entity: xianglins_wife
    attribute: social_status
    narrativeHint: "After donating the threshold she believes she has atoned"
```

**Validation rules:**
- value + narrativeHint together → schema error
- unset + value → schema error
- unset + narrativeHint → schema error
- no value, no narrativeHint, no unset → schema error
- duplicate write to same `(entityId, attribute)` within one event → `ConfigError`

**Test:** `fact-three-forms.test.ts`

### 3.3 Example: Complete Event YAML

```yaml
event: E5
title: "Threshold Rejection"
narrativeOrder: 6
sceneType: flashback
storyTime: winter_solstice
pov:
  character: narrator
  type: first_person
sceneBrief: "Xianglin's Wife suffers the threshold rejection"

preconditions:
  - entity: xianglins_wife
    attribute: location
    value: fourth_master_lu_house
  - entity: xianglins_wife
    attribute: marital_status
    value: widowed_twice

expectedPostconditions:
  - entity: xianglins_wife
    attribute: spiritual_state
    value: broken
```

**Fixture sources:** `fixtures/zhu-fu/`, `fixtures/arcane-aftermath/`

---

## 4. State Key / Set / Unset Semantics

### 4.1 Fact Structure

```typescript
interface Fact {
  id: FactId;
  entityId: EntityId;
  attribute: string;
  value?: unknown;          // Deterministic value to write
  narrativeHint?: string;   // Pass 2 semantic description (NEVER writes WorldState)
  confidence?: number;
  operation?: 'set' | 'unset';
  operator?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
            | 'contains' | 'not_contains' | 'exists' | 'not_exists';
  validity: FactValidity;
}
```

### 4.2 Operation Semantics

**`operation: 'set'` (default when value present)**
- Writes `canonicalizeFactValue(value)` to `state.entities[entityId][attribute]`
- Creates a causal provider edge for future events
- Overwrites any previous value for the same (entityId, attribute)

**`operation: 'unset'`**
- Deletes the attribute from `state.entities[entityId]` entirely
- Throws `ConfigError` if the attribute is already absent
- `value` and `narrativeHint` must NOT be present
- `lifecycle` attribute cannot be unset

### 4.3 canonicalizeFactValue

Every value written to `WorldState` passes through `canonicalizeFactValue()` in `fact-value.ts`:

**Accepted types:** `null`, `boolean`, finite `number`, `string`, plain `object`, `array` (recursive)
**Rejected types:** `undefined`, `NaN`, `±Infinity`, `Date`, class instances, `function`, `Symbol`, `BigInt`, `RegExp`

**Test:** `canonical-fact-value.test.ts`

### 4.4 compareFact() — Single Entry Point

`compareFact()` in `entity/compare.ts` is the **sole** entry point for all deterministic fact comparison:

```typescript
type CompareOutcome = 'match' | 'mismatch' | 'deferred';

function compareFact(fact: Fact, stateValue: unknown): CompareOutcome
```

**Rules:**
- `'match'` — fact has a value and it equals the state value
- `'mismatch'` — fact has a value and it does NOT equal the state value
- `'deferred'` — fact has only `narrativeHint`; Pass 2 handles semantic inspection
- All validators MUST use `compareFact()` — no ad-hoc comparison is permitted

**Test:** `comparefact-deferred.test.ts`

### 4.5 Value Forms Summary

| Form | `value` | `narrativeHint` | `operation` | WorldState effect | Causal edge | Pass 2 effect |
|------|---------|-----------------|-------------|-------------------|-------------|---------------|
| Set | set | absent | `'set'` | Writes canonical value | Yes | None |
| Unset | absent | absent | `'unset'` | Deletes attribute | Yes (removes provider) | None |
| Hint | absent | set | omitted | None | None | Analyzed |

---

## 5. Branch / Merge Rules

### 5.1 BranchPath

A `BranchPath` records the sequence of decisions:

```typescript
interface BranchPath {
  decisions: Array<{
    atEventId: string;
    choiceId: string;
    narrativeOrder: number;
  }>;
}
```

**Test:** `branch/diamond.test.ts`

### 5.2 BranchSet Filtering

```yaml
# Always visible (linear default)
existenceCondition:
  type: all

# Explicit path list
existenceCondition:
  type: paths
  paths:
    - decisions:
        - atEventId: E0
          choiceId: trust_seraphine
          narrativeOrder: 1

# Exclusion
existenceCondition:
  type: except
  branches:
    type: paths
    paths:
      - decisions:
          - atEventId: E0
            choiceId: betray_seraphine
            narrativeOrder: 1
```

**Core predicate:** `includesPath(branchSet, branchPath)` in `branch/set.ts`:
- `type: 'all'` → always `true`
- `type: 'paths'` → deep equality with any listed path
- `type: 'except'` → negates inner inclusion check
- Empty `BranchPath` (linear) → only matches `type: 'all'`

### 5.3 DAG Branch Filtering

`buildCausalEdges()` accepts an optional `branchPath` parameter. When provided:
1. Events are filtered by `branchExistence`
2. Causal edges are built only within the selected event set
3. Each concrete branch has its own independent DAG, topological sort, and replay state

**Test:** `diamond.test.ts` — Trunk → branch choice → lane A/B → rejoin

### 5.4 Merge Plan

Cross-branch reconciliation uses `MergePlan` with three policy types:

| Policy | Behavior |
|--------|----------|
| `requireEqual` | All incoming branches must have identical state |
| `selectBranch` | Select state from one branch by `branchId` |
| `literal` | Accept explicit literal state |

**Test:** `merge-plan.test.ts`

### 5.5 Non-Rules

- `narrativeOrder` is NEVER used for causal ordering, state replay, or snapshot keying
- Linear narratives (empty `BranchPath`) NEVER include lane-scoped events
- Events with non-matching `branchExistence` are completely invisible
- Same-storyTime events require explicit `same_coordinate_order` edges or provably commutative read/write sets

---

## 6. Error Examples

### 6.1 DAG Cycle

```yaml
events:
  - id: A
    preconditions:
      - entity: hero
        attribute: location
        value: forest
    storyTime: day_1
  - id: B
    preconditions:
      - entity: hero
        attribute: location
        value: town
    storyTime: day_1
```

**Result:** `DagCycleError: Causal graph contains a cycle` (code `DAG_CYCLE`)

**Test:** `dag.test.ts` (cycle rejection), `graph-compiler.test.ts`

### 6.2 Placeholder Value

```yaml
expectedPostconditions:
  - entity: hero
    attribute: status
    value: changed  # REJECTED
```

**Result:** `ConfigError` at the schema level — placeholder values are rejected.

**Test:** `contracts.test.ts`

### 6.3 Precondition Mismatch

Event expects `hero.status === 'alive'` but state has `hero.status === 'dead'`.

**Result:** `PreconditionMismatchError` (code `PRECONDITION_MISMATCH`)

**Test:** `presence-aware-preconditions.test.ts` (all 10 operators)

### 6.4 Missing/Duplicate Provider

Two events at the same storyTime both write `hero.status` → ambiguous provider.

**Result:** `DagProviderError: Ambiguous latest provider` (code `DAG_PROVIDER_INVALID`)

**Test:** `dag.test.ts`

### 6.5 Branch-Incompatible Provider

Event on lane B expects a write from lane A's scoped event.

**Result:** `DagProviderError: No earlier provider` (code `DAG_PROVIDER_INVALID`)

**Test:** `diamond.test.ts`

### 6.6 Unset on Absent Attribute

```yaml
expectedPostconditions:
  - entity: hero
    attribute: nonexistent_flag
    operation: unset
```

**Result:** `ConfigError: Cannot unset absent attribute`

**Test:** `replay-set-unset.test.ts`

### 6.7 Duplicate Write in One Event

Two postconditions write the same `(entityId, attribute)` → `ConfigError`

**Test:** `fact-three-forms.test.ts`

---

## Test Reference Map

| Rule / Component | Test File(s) |
|-----------------|-------------|
| DAG causal ordering | `dag.test.ts` |
| Cycle rejection | `dag.test.ts`, `graph-compiler.test.ts` |
| Story-time tiebreaker | `dag-tiebreaker.test.ts` |
| Causal vs narrative order | `dag-divergence.test.ts` |
| Story boundaries | `story-boundaries.test.ts`, `genesis-root.test.ts` |
| Replay set/unset | `replay-set-unset.test.ts` |
| Three postcondition forms | `fact-three-forms.test.ts` |
| 10 precondition operators | `presence-aware-preconditions.test.ts` |
| Entity lifecycle | `entity-lifecycle.test.ts` |
| Branch path filtering | `diamond.test.ts` |
| Graph compiler | `graph-compiler.test.ts` |
| Merge plan policies | `merge-plan.test.ts` |
| compareFact outcomes | `comparefact-deferred.test.ts` |
| Canonical fact value | `canonical-fact-value.test.ts` |
| Schema contract validation | `contracts.test.ts` |
| Error classes | `errors.test.ts` |
| Integration pipeline | `integration.test.ts` |
| Context compilation | `context.test.ts` |

---

*This document is the reference for STORY-SEMANTICS specification (TODO.md L896-914). Every rejection case references a schema or compiler fixture. Every support rule references replay, snapshot, cache, and boundary-oracle tests.*
