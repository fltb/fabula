# State Semantics Reference

**Version:** 1.0
**Date:** 2026-07-22
**Status:** Baseline frozen

**Source files:**
- `packages/core/src/state/graph-adapter.ts` — `compileStoryRuntimeGraph()`, `compileNarrativeGraphs()`, `INITIAL_STORY_ROOT_ID`
- `packages/core/src/state/graph-compiler.ts` — `compileGraph()`, `compileStoryGraph()`, `compileDiscourseGraph()`, 12-stage compiler
- `packages/core/src/state/dag.ts` — `buildStoryOrderIndex()`, `isProvenBefore()`, `DagCycleError`, `DagProviderError`
- `packages/core/src/state/replay.ts` — `ReplayEngine`, `PreconditionMismatchError`
- `packages/core/src/state/event-application.ts` — `applyNarrativeEvent()`, `applyInitialFacts()`
- `packages/core/src/state/story-boundaries.ts` — `compileStoryBoundaries()`, `StoryBoundaries`
- `packages/core/src/state/snapshot.ts` — `SnapshotEngine`
- `packages/core/src/state/merge-plan.ts` — `compileMergePlan()`, `reconcileMergePlan()`
- `packages/core/src/state/manager.ts` — `StateManager`
- `packages/core/src/entity/timestamp.ts` — `parseStoryTimestamp()`, `resolveTemporalContext()`, `compareStoryCoordinates()`
- `packages/core/src/entity/fact-value.ts` — `canonicalizeFactValue()`, `isCanonicalFactValue()`, `canonicalDeepEqual()`
- `packages/core/src/entity/compare.ts` — `compareFact()`
- `packages/core/src/schemas/primitives.ts` — `preconditionSchema`, `postconditionSchema`, `PLACEHOLDER_PATTERN`
- `packages/core/src/schemas/event.ts` — `eventFileSchema`
- `packages/core/src/schemas/state-initial.ts` — `worldInitialStateSchema`
- `packages/core/src/types/entity.ts` — `Fact`, `FactId`, `TimeAnchor`, `AuthoredStoryTime`
- `packages/core/src/types/event.ts` — `NarrativeEvent`, `EventFile`
- `packages/core/src/types/graph.ts` — `StoryGraph`, `DiscourseGraph`, 24 `GraphCompileError` subclasses
- `packages/core/src/types/branch.ts` — `BranchPath`, `BranchSet`, `BranchPoint`, `Condition`
- `packages/core/src/types/thread.ts` — `ThreadRuntimeState`
- `packages/core/src/errors.ts` — all error classes (17 types)

This document defines the state semantics of the Novalistically narrative engine per STORY-SEMANTICS specification (TODO.md L896-914). It is the authoritative reference for authors and integrators.

---

## 1. Supported Scope

Novalistically models story state as a **discrete, deterministic, replayable** system. Every state change is recorded as a `NarrativeEvent`. The world state is never mutated in place — it is always **derived by replaying events from an initial state**.

### 1.1 Event Sourcing Architecture

The `WorldState` interface captures the core dimensions of narrative state:

| Dimension | Key | Description |
|-----------|-----|-------------|
| `entities` | `EntityId → Record<string, unknown>` | Entity runtime state (lifecycle, attributes) |
| `relationships` | `RelationshipId → RelationshipRuntimeState` | Multi-entity relationship state (dimensions, epochs, membership) |
| `knowledge` | `EntityId → { knownFacts: FactId[] }` | Character/faction knowledge/belief |
| `epistemicLedger?` | `EpistemicLedger` | STATE-4: character attitudes toward propositions (optional) |
| `propositionCatalog?` | `PropositionCatalog` | STATE-4: immutable proposition catalog (optional) |
| `threads` | `string → ThreadRuntimeState` | Narrative thread state (`threadId`, `status`, `currentRunId`, `phase`, `bindings`, `goalStates`, `milestoneStates`, `semanticStateHash`) |
| `rules` | `string → RuleRuntimeState` | World rule state (`activation`, `effectiveness`, `exceptions[]`) |
| `facts` | `Fact[]` | Append-only fact log |

**Source:** `packages/core/src/types/world.ts`, `packages/core/src/types/entity.ts`, `packages/core/src/types/thread.ts`

### 1.2 Graph Compilation (GRAPH-1)

The causal order is produced by a three-stage compilation pipeline (`buildCausalEdges()` / `topologicalSort()` no longer exist):

1. **`compileStoryRuntimeGraph()`** (`graph-adapter.ts`) resolves the temporal context for ALL events *before* branch projection (`resolveTemporalContext()`), filters events by `includesPath(event.branchExistence, branchPath)`, merges `initialFacts` + genesis postconditions into the `system:initial` root node (genesis is NOT replayed as an ordinary event), and emits normalized `CompileNode[]` (effects, reads, branch scope, explicit edges).
2. **`compileGraph()`** (`graph-compiler.ts`) runs a fixed 12-stage compiler: normalize outputs → extract reads → filter branch → resolve declarations → validate coordinate/order → derive temporal edges → infer providers/absence → commutativity → branch/closure/cycle validation → hash. It produces a `StoryGraph` and/or `DiscourseGraph` with four edge classes: `author_origin` (explicit `causalPredecessors`), `provider` (read→write), `same_coordinate_order` (explicit ordering at equal coordinates), and `internal` (derived temporal edges).
3. **`buildStoryOrderIndex()`** (`dag.ts`) runs Kahn's algorithm over the compiled adjacency to produce the deterministic linear extension plus a transitive-ancestor index. Story point coordinates on the same clock already generate bipartite `internal` temporal edges between adjacent scalar buckets (`causalGroupId: "temporal:<clock>:<from>:<to>"`), so the index itself only breaks ties among genuinely unrelated nodes — by event ID (`localeCompare`), with the initial root first. `narrativeOrder` is NEVER consulted for causal ordering.

Canonical keys: deterministic facts use `factKey(fact) = "${entityId}.${attribute}"`; thread effects use `thread:<threadId>`, relationship effects `relationship:<relationshipId>`, rule effects `rule:<ruleId>`. Values are NOT part of the key — same-cell later writes supersede earlier ones via provider resolution.

**Tests:** `graph-compiler.test.ts`, `graph-adapter.test.ts`, `dag.test.ts` (ordering, tiebreaking, cycle rejection), `dag-tiebreaker.test.ts` (storyTime > narrativeOrder), `dag-divergence.test.ts`

### 1.3 Story Boundaries (StorySnapshot)

`compileStoryBoundaries()` / `compileStoryBoundariesFromGraph()` in `story-boundaries.ts` produces:

- `orderedEventIds: string[]` — events in causal order
- `stateBeforeByEventId: Map<string, WorldState>` — snapshot of state before each event
- `stateAfterByEventId: Map<string, WorldState>` — snapshot of state after each event
- `finalState: WorldState` — state after all events

Initial facts (`initialFacts`) are applied before the first event, providing the genesis state. These are NOT a synthetic `NarrativeEvent` — they are separate deterministic input.

**Test:** `story-boundaries.test.ts`, `genesis-root.test.ts`

### 1.4 ReplayEngine

`ReplayEngine.replay()` (in `replay.ts`) first compiles `compileStoryRuntimeGraph()` and then replays the ordinary events in `order.topologicalOrder`, applying the baseline (`applyInitialFacts` + initial thread declarations) before the first event. Each event is applied through `applyNarrativeEvent()` (`event-application.ts`) in a fixed phase order:

1. **Phase 1: Validate all deterministic preconditions** — throws `PreconditionMismatchError` on failure
2. **Phase 2: Apply postcondition effects** — set/unset writes, lifecycle validation (invalid transition, duplicate write, unset on absent attribute, retired-entity writes all throw `ConfigError`)
3. **Phase 3: Validate participants** — retired entities cannot participate
4. **Phase 4: Apply transactions** — thread transactions, relationship transactions, rule transactions

`getStateAt(position)` replays only the first `position` causally ordered events (0 = baseline).

### 1.5 SnapshotEngine

`SnapshotEngine` in `snapshot.ts` periodically captures `WorldState` at configurable intervals (default every 20 events). Snapshots are keyed by event count (not narrativeOrder). Each `Snapshot` stores `{ eventCount, eventId, timestamp, version, state }`. `findNearest()` enables fast recovery by finding the closest snapshot at or before a target count.

### 1.6 Timestamp Resolution

`entity/timestamp.ts` is the single authored-YAML → runtime-AST boundary. `parseStoryTimestamp()` accepts the authored union (legacy string or `{ at }` / `{ after }` / `{ offset }` / `{ chapter }` / `{ type: indeterminate }`); omitted input yields `{ type: 'indeterminate', mode: 'unspecified' }`, explicit indeterminacy yields `mode: 'intentional'` (with optional `reason`). `resolveTemporalContext()` then resolves every event (before branch projection) into graph-only coordinates:

- **`day_N` / bare duration strings** → **story clock** point: `scalar = number × unit millis` (`day` = 86_400_000, `hour` = 3_600_000, …). Example: `day_3` → scalar 259_200_000.
- **ISO date-time** (`YYYY-MM-DD[THH:MM[:SS[.mmm]][Z|±HH:MM]`) → **calendar clock** point (UTC millis, timezone-adjusted; invalid calendar dates/offsets throw).
- **`chapter_N`** → **chapter clock** point (scalar = chapter number).
- **`indeterminate`** → `{ type: 'storyTime', kind: 'unlocated' }` — an unlocated scene generates NO temporal edges and is incomparable with every other coordinate.
- **Event/anchor references** resolve to the referenced coordinate; `relative` (`<ref> + N unit`) requires a story or calendar point base (chapter bases are rejected).
- **Reference, cycle, and unknown errors are resolver errors**: unknown references (`Unknown story-time reference` / `Unknown event` / `Unknown time anchor`), cyclic references (`Cyclic story-time reference`), duplicate/reserved IDs, anchor↔event ID collisions, non-finite scalars, and invalid ISO dates/offsets all throw `ConfigError` with `phase: 'timestamp'`, before any graph compilation.

`compareStoryCoordinates()`: `initial` is before everything; `unlocated` or cross-clock coordinates are `incomparable`; same-clock points compare by scalar.

**Tests:** `entity.test.ts` (parser equivalence for `{ at }` / `{ after }` / `{ offset }` / `{ chapter }` vs legacy strings; resolver errors: unknown reference, cyclic event/anchor reference, duplicate/reserved IDs, bare-duration anchor IDs, chapter-base relative rejection)

---

Every rejection case produces a typed error with a stable `code` string and structured `context`. No fallback, silent initialization, or degraded path is ever used.

### 2.1 Graph Cycle

**Error:** `EdgeOriginCycleError` (in graph compilation) / `DagCycleError` (`DAG_CYCLE`, in `buildStoryOrderIndex()`). Through `compileStoryRuntimeGraph()` both are aggregated and surfaced as `ConfigError` with `phase: 'narrative-graphs'`.

**When thrown:** `compileGraph()`'s DFS cycle detection or `buildStoryOrderIndex()`'s Kahn algorithm detects a cycle in the compiled graph (explicit `author_origin` edges, provider edges, or same-coordinate ordering).

**Context fields:** `cycle: string[]` (event IDs in the cycle), `phase: string`

**Trigger examples:**
- Event A precondition-depends on event B, which precondition-depends on event A

> 注意：same-time unordered 且 read/write key 重叠的两个 writer **不是**环错误——
> commutativity 阶段（Stage 8）对它们报告 `UnorderedStoryConflictError`（code
> `UNORDERED_STORY_CONFLICT`），见 §6.4。

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

**Rejection:** `event-application.ts` `applyInitialFacts()` rejects `operation: 'unset'`（initialFacts 必须是确定性 set writes）。但对 hint-only fact（`value === undefined`）它在 unset 检查后直接 `continue`——**hint-only initial facts 今天会被静默忽略**，并不被拒绝；`compileStoryBoundaries()` 也没有额外的 hint 校验。（若要在 schema/编译层拒绝 hint-only initial facts，需要先加源级校验。）

**Test:** `genesis-root.test.ts`（未覆盖 hint-only 拒绝）

### 2.5 Graph Compile Errors & Absence Semantics

**Errors:** the compiler emits typed `GraphCompileError` subclasses (24 categories in `types/graph.ts`), including:
- `UnknownPredecessorError` — explicit edge references non-existent node
- `MissingOutputError` — read requirement has no provider
- `AmbiguousOutputError` — multiple candidates for same read at same time
- `DuplicateBranchProviderError` — multiple incomparable maximal providers for one read
- `BranchCoverageError` — read has no resolution for its branch
- `AssertionMismatchError` — provider value does not satisfy the read predicate (exists/absent/equals only; other operators are enforced at replay time)
- `EdgeOriginCycleError` — cycle detected during compilation
- `ProvenanceError` — missing/invalid provenance metadata
- `CrossClockEdgeError`, `FutureTimeError`, `InvalidSameCoordinateOrderError`, `UnorderedStoryConflictError`, `SelfPredecessorError`, `ReadMismatchError`, `UnknownReadIdError`, `StaleProviderSelectionError`, `InitialRootMisuseError`, `SemanticOutputDependencyError`, `DynamicLifecycleError`, `MergeInputError`, `EllipsisSummaryError`, `NoOutputEdgeError`, `DuplicateDiscoursePositionError`

**Absence semantics:** a deterministic read resolves to canonical absence (`GraphAbsenceWitness`) only when NO compatible write is visible. Absence is legal ONLY for: (1) reads whose predicate is `absent` (`not_exists` operator), or (2) reads claimed by a valid `absentApparatus` contract of the same owning event. Every other exists/equals read that resolves to absence is a `ConfigError` (`phase: 'narrative-graphs'`) at the adapter boundary.

**Test:** `graph-compiler.test.ts`, `graph-adapter.test.ts`, `absence-resolver.test.ts`

### 2.6 Provider Errors

**Errors:** `DagProviderError` (`DAG_PROVIDER_INVALID`, thrown by `buildStoryOrderIndex()` for duplicate/unknown node IDs), `DuplicateBranchProviderError` (multiple incomparable maximal providers for the same read), `BranchCoverageError` (no resolution for a read on the branch), `UnknownPredecessorError` (edge endpoint unknown). All surface through `compileStoryRuntimeGraph()` as `ConfigError` (`phase: 'narrative-graphs'`).

**When thrown:** No visible provider for a deterministic precondition, ambiguous latest provider, self-dependency, provider in a different branch lane not visible from the current path, or an unclaimed exists/equals read resolving to absence.

**Test:** `dag.test.ts`, `diamond.test.ts`, `graph-compiler.test.ts`

### 2.7 Other Rejection Cases

| Case | Error | Code | Source |
|------|-------|------|--------|
| Invalid YAML syntax | `ConfigError` | `CONFIG_INVALID` | `schemas/` strict Zod parsers |
| Unknown event field | `ConfigError` | `CONFIG_INVALID` | `.strict()` schema rejection |
| Duplicate write in one event | `ConfigError` | `CONFIG_INVALID` | `event-application.ts` Phase 2 |
| Unset on absent attribute | `ConfigError` | `CONFIG_INVALID` | `event-application.ts` Phase 2 |
| Unknown entity | `ConfigError` | `CONFIG_INVALID` | `event-application.ts` Phase 2 (declaration catalog) |
| Invalid lifecycle transition | `ConfigError` | `CONFIG_INVALID` | `event-application.ts` Phase 2 |
| Write to retired entity | `ConfigError` | `CONFIG_INVALID` | `event-application.ts` Phase 2 |
| Same-time lifecycle conflict | `ConfigError` | `CONFIG_INVALID` | `event-application.ts`, `story-boundaries.ts` |
| Invalid canonical value | `ConfigError` | `CONFIG_INVALID` | `fact-value.ts` |
| Unknown/cyclic story-time reference | `ConfigError` | `CONFIG_INVALID` | `entity/timestamp.ts` (phase `timestamp`) |
| Unclaimed deterministic absence | `ConfigError` | `CONFIG_INVALID` | `graph-adapter.ts` (phase `narrative-graphs`) |
| value + narrativeHint together | Schema validation | custom | `primitives.ts` superRefine |

**Test:** `errors.test.ts` (all 17 error types), `contracts.test.ts` (schema validation)

---

## 3. YAML Causal Dependency Syntax

### 3.1 Preconditions (10 Operators)

| Operator | Requires value | Behavior |
|----------|---------------|----------|
| `eq` (default) | 仅当 operator 显式出现 | `stateValue === factValue` |
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

> **默认 `eq` 的宽松性**：`preconditionSchema` 只在显式写出非 existence operator 时才要求
> `value`。`{ entity, attribute }`（operator / value / narrativeHint 全部省略）能通过 Zod：
> `requirementFromFact()` 对无值 fact 不产生 graph read（返回 null），重放的
> `validatePreconditions()` 也会跳过它（非 exists / not_exists 且 `value === undefined`
> 直接 continue）。这是 schema 当前接受的 no-op，不是强制的相等检查。

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
  narrativeHint?: string;   // Pass 2 semantic description (不写 state.entities；
                            // hint-only postcondition 进入 state.facts 事实日志)
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

### 4.4 compareFact() — 严格相等比较器

`compareFact()` in `entity/compare.ts` implements strict `===` equality plus hint deferral (it is NOT the replay precondition validator — see below):

```typescript
type CompareOutcome = 'match' | 'mismatch' | 'deferred';

function compareFact(fact: Fact, stateValue: unknown): CompareOutcome
```

**Rules:**
- `'match'` — fact has a value and it equals the state value
- `'mismatch'` — fact has a value and it does NOT equal the state value
- `'deferred'` — fact has only `narrativeHint`; Pass 2 handles semantic inspection

**实际调用方**：causality / branch-merge 验证器（比较 precondition 与 queryState）与
`deferred-resolver.ts`（确认 hint 分类为 deferred）。重放前置条件校验不走它——
`validatePreconditions()` 用私有 `preconditionMatches()` 按全部 10 个 operator 分派，
失败抛 `PreconditionMismatchError`；`compareFact()` 只实现严格 `===` 相等与 hint deferral。

**Test:** `comparefact-deferred.test.ts`

### 4.5 Value Forms Summary

| Form | `value` | `narrativeHint` | `operation` | WorldState effect | Causal edge | Pass 2 effect |
|------|---------|-----------------|-------------|-------------------|-------------|---------------|
| Set | set | absent | `'set'` | Writes canonical value (+ appends `state.facts`) | Yes | None |
| Unset | absent | absent | `'unset'` | Deletes attribute (+ appends `state.facts`) | Yes (removes provider) | None |
| Hint | absent | set | omitted | 不写 `state.entities`，但追加到 `state.facts` 日志 | None | Analyzed |

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

A `BranchSet` (internal type) has four variants, shown here as internal object shapes — the field that carries one on a `NarrativeEvent` is `branchExistence`:

```ts
// Always visible (linear default)
{ type: 'all' }

// Explicit path list
{
  type: 'paths',
  paths: [
    {
      decisions: [
        { atEventId: 'E0', choiceId: 'trust_seraphine', narrativeOrder: 1 },
      ],
    },
  ],
}

// Condition variant — evaluated against the current BranchPath
{
  type: 'condition',
  condition: {
    type: 'equals',
    field: 'decisions.length',
    value: 1,
  },
}

// Exclusion
{
  type: 'except',
  branches: {
    type: 'paths',
    paths: [
      {
        decisions: [
          { atEventId: 'E0', choiceId: 'betray_seraphine', narrativeOrder: 1 },
        ],
      },
    ],
  },
}
```

> **这不是 EventFile 的 YAML 作者面**：`eventFileSchema` 是 strict 的，只暴露 event-local
> `choices`，没有 `existenceCondition` 或 `branchExistence` 字段，外部 branch-point scaffold
> 也不被加载。`BranchSet` 由 mapper 从 game-dialogue tree 派生并写到内部
> `NarrativeEvent.branchExistence` / Fact `validity.branches`。

**Core predicate:** `includesPath(branchSet, branchPath)` in `branch/set.ts`:
- `type: 'all'` → always `true`
- `type: 'paths'` → deep equality with any listed path
- `type: 'condition'` → `evaluateCondition(condition, branchPath)` — condition types `equals` / `not_equals` / `greater_than` / `less_than` / `contains` / `and` / `or` over a dot-notation `field` path (e.g. `decisions.length`, `decisions.0.choiceId`)
- `type: 'except'` → negates inner inclusion check
- Empty `BranchPath` (linear) → only matches `type: 'all'`

### 5.3 Graph Branch Filtering

`compileStoryRuntimeGraph()` filters events by `includesPath(event.branchExistence, branchPath)` before building compile nodes; `compileGraph()` then filters reads/outputs by the selected branch scope. Each concrete branch has its own StoryGraph, `StoryOrderIndex`, and replay state. The mapper derives per-event `BranchSet` scopes from the compiled game-dialogue tree (root keeps `{ type: 'all' }`; other events take descendant-leaf scopes).

**Test:** `diamond.test.ts` — Trunk → branch choice → lane A/B → rejoin; `branch/game-dialogue-tree.test.ts`

### 5.4 Merge Plan

Cross-branch reconciliation defines `MergePlan` with three `MergePolicy` discriminants, but **当前只是 policy/transaction 脚手架，不是操作性 reconciliation**：

| Policy | 现状 |
|--------|------|
| `requireEqual` | `applyPolicy()` 只返回 `applied: true` + 描述文本；不比较 incoming 值 |
| `selectBranch` | 只校验 `branchId` 非空；不真正选择/物化某 branch 的 state |
| `literal` | 变体本身不携带 literal 值（`{ type: 'literal' }`）；不物化任何 state |

`resolveIdentityLifecycleReference()` 与 `validateCrossDomainReadSets()` 都不检查 snapshot state（参数名 `_snapshots`，函数体只有注释占位）；`reconcileMergePlan()` 只是逐 policy 生成 `applied: true` 的事务并返回 `success`。跨分支的“选取相等/选择/literal”语义尚未实现。

**Test:** `merge-plan.test.ts`（覆盖 compile/reconcile 的脚手架行为）

### 5.5 Non-Rules

- `narrativeOrder` is NEVER used for causal ordering, state replay, or snapshot keying
- Linear narratives (empty `BranchPath`) NEVER include lane-scoped events
- Events with non-matching `branchExistence` are completely invisible
- Same-coordinate events are ordered only by explicit edges (`author_origin` / `same_coordinate_order` / `provider`); unordered pairs whose read/write keys overlap are rejected with `UnorderedStoryConflictError` (`UNORDERED_STORY_CONFLICT`) during commutativity validation

---

## 6. Error Examples

### 6.1 Graph Cycle

```yaml
# Story-time references that create a cycle (resolver-level)
events:
  - event: A
    storyTime: "B + 1 day"
  - event: B
    storyTime: "A + 1 day"
```

**Result:** `ConfigError: Cyclic story-time reference` (phase `timestamp`) at the resolver; graph-level cycles (explicit `causalPredecessors`, provider, or same-coordinate edges) surface as `EdgeOriginCycleError` / `DagCycleError` aggregated into a `ConfigError` with phase `narrative-graphs`.

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

Two **unordered** same-time events both write `hero.status` → overlapping write keys.

**Result:** `UnorderedStoryConflictError`（code `UNORDERED_STORY_CONFLICT`），由 `validateCommutativity()` 在 commutativity 阶段报告（aggregated into `ConfigError`, phase `narrative-graphs`）。

`DuplicateBranchProviderError` 只在**某个 read** 解析时有多个不可比 maximal provider 候选时出现（`findMaximalProvider()` 返回 null 而存在兼容输出），而不是由两个写者本身触发。

**Test:** `dag.test.ts`, `graph-compiler.test.ts`

### 6.5 Unclaimed Absence / Branch-Incompatible Read

Event on lane B expects a write from lane A's scoped event (or reads an exists/equals key with no visible write and no `absentApparatus` claim).

**Result:** absence resolution for a non-`not_exists` read without a valid claim → `ConfigError: Deterministic read ... resolved to absence but no valid absent predicate or absentApparatus claim covers it` (phase `narrative-graphs`).

**Test:** `diamond.test.ts`, `graph-adapter.test.ts`, `absence-resolver.test.ts`

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
| Graph compilation (12-stage compiler) | `graph-compiler.test.ts`, `graph-adapter.test.ts` |
| Story order index / cycle rejection | `dag.test.ts` |
| Story-time vs narrative order | `dag-tiebreaker.test.ts`, `dag-divergence.test.ts` |
| Timestamp resolution & resolver errors | `entity.test.ts`, `state/...` resolver tests |
| Story boundaries | `story-boundaries.test.ts`, `genesis-root.test.ts` |
| Replay set/unset | `replay-set-unset.test.ts` |
| Three postcondition forms | `fact-three-forms.test.ts` |
| 10 precondition operators | `presence-aware-preconditions.test.ts` |
| Entity lifecycle | `entity-lifecycle.test.ts` |
| Branch path filtering | `diamond.test.ts`, `branch/game-dialogue-tree.test.ts` |
| Absence semantics | `absence-resolver.test.ts`, `graph-adapter.test.ts` |
| Merge plan policies | `merge-plan.test.ts` |
| compareFact outcomes | `comparefact-deferred.test.ts` |
| Canonical fact value | `canonical-fact-value.test.ts` |
| Schema contract validation | `contracts.test.ts` |
| Error classes | `errors.test.ts` |
| Integration pipeline | `integration.test.ts` |
| Context compilation | `context.test.ts` |

---

*This document is the reference for STORY-SEMANTICS specification (TODO.md L896-914). Every rejection case references a schema or compiler fixture. Every support rule references replay, snapshot, cache, and boundary-oracle tests.*
