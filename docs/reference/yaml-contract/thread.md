# Thread YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/thread.ts` — `threadTypeDefinitionSchema`, `threadDeclarationSchema`, `threadRuntimeStateSchema`, `threadTransactionSchema`, `targetGoalSchema`, `targetMilestoneSchema`, `threadMergeResultSchema`  
**Fixture sources:** `fixtures/zhu-fu/definitions/state_initial.yaml` (threads), `fixtures/zhu-fu/chapters/*/E*.yaml` (threadProgress)

Threads model narrative arcs, character development tracks, mystery progressions, and thematic through-lines. Each thread has a type (schema), declaration (instance), runtime state, and transaction log. Author-facing YAML declares threads in `state_initial.yaml` (`threads` array) and progresses them via event-level `threadProgress`.


## Fields
## ThreadDeclaration Fields (Author-Facing in state_initial.yaml)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `threadId` | `string` | **required** | — | Unique identifier (e.g. `T1`, `T2`). |
| `name` | `string` | **required** | — | Human-readable name. |
| `description` | `string` | **required** | — | Prose describing the thread's narrative purpose. |
| `typeId` | `string` | **required** | — | References a thread type definition in the catalog. |
| `initialPhase` | `string` | optional | — | Starting phase identifier. |
| `initialBindings` | `record` | optional | `{}` | Initial key-value bindings for parameterized threads. |
| `initialGoalStates` | `array` | optional | `[]` | Initial goals (see below). |
| `initialMilestoneStates` | `array` | optional | `[]` | Initial milestones (see below). |
| `provenance` | `string` | optional | — | Traceability reference. |

### GoalState / MilestoneState

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `goalId` / `milestoneId` | `string` | required | — | Unique identifier. |
| `status` | `enum` | required | — | See lifecycle enums below. |

## ThreadTypeDefinition Fields (Catalog)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `typeId` | `string` | required | — | Type identifier (e.g. `primary`, `thematic`, `character_arc`). |
| `description` | `string` | required | — | What threads of this type represent. |
| `allowedPhases` | `array` | required | — | Array of valid phase strings. |
| `lifecyclePolicy` | `object` | required | — | `reopenPolicy`: `"forbidden"`, `"allowed"`, or `"requiresExplicitReason"`. |
| `timeDomain` | `enum` | required | — | `"story"` or `"discourse"`. |
| `stableGoals` | `array` | required | — | Goals that must exist. |
| `stableMilestones` | `array` | required | — | Milestones that must exist. |
| `narrativeHints` | `array` | optional | — | Array of hint strings. |
| `provenance` | `string` | optional | — | Source reference. |

## ThreadRuntimeState Fields (Compiler-Produced)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `threadId` | `string` | required | — | Thread identifier. |
| `status` | `enum` | required | — | `"planned"`, `"active"`, `"blocked"`, `"completed"`, `"abandoned"`, `"retired"`. |
| `currentRunId` | `string` | required | — | Active run identifier (e.g. `run_0`, `run_1`). |
| `phase` | `string` | required | — | Current phase from the type's `allowedPhases`. |
| `bindings` | `record` | required | — | Current parameter values. |
| `goalStates` | `record` | required | — | Goal ID → lifecycle status map. |
| `milestoneStates` | `record` | required | — | Milestone ID → lifecycle status map. |
| `semanticStateHash` | `string` | required | — | Content hash for change detection. |

## ThreadTransaction Fields (Event-Level)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `thread` | `string` | **required** | — | Thread ID being progressed. |
| `runId` | `string` | **required** | — | Run identifier for this transaction. |
| `status` | `enum` | optional | — | New lifecycle status for the thread. |
| `phase` | `string` | optional | — | New phase identifier. |
| `bindingsAfter` | `record` | optional | — | Map of binding key → new value. |
| `goalSet` | `array` | optional | — | Goal state updates. |
| `milestoneSet` | `array` | optional | — | Milestone state updates. |
| `provenance` | `string` | **required** | — | Source trace. |
| `advancement` | `string` | optional | — | Prose describing what happened this transaction. |

### ThreadProgressEntry (Event-Level Shortcut)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `thread` | `string` | **required** | — | Thread ID. |
| `advancement` | `string` | **required** | — | Prose description of advancement. |
| `progressAfter` | `number` | **required** | — | Numeric progress value after this event (0–100). |
| `progressTotal` | `number` | **required** | — | Maximum progress (100 for percentage). |

### ThreadMergeStrategy (Branch Merge)

| Strategy | Description |
|----------|-------------|
| `"requireEqual"` | Both branches must have identical state |
| `"selectBranch"` | One branch's state wins (paired with `branchId`) |
| `"literal"` | Merge is rejected if states diverge |
| `"newRun"` | Creates a new run ID with merged state |

## Closed Enums / IDs

- `threadLifecycle`: `"planned"`, `"active"`, `"blocked"`, `"completed"`, `"abandoned"`, `"retired"` (6 values)
- `goalLifecycle`: `"pending"`, `"active"`, `"achieved"`, `"failed"`, `"waived"` (5 values)
- `milestoneLifecycle`: `"pending"`, `"achieved"`, `"failed"`, `"waived"`, `"invalidated"` (5 values)
- `timeDomain`: `"story"`, `"discourse"` (2 values)
- `reopenPolicy`: `"forbidden"`, `"allowed"`, `"requiresExplicitReason"` (3 values)
- `threadMergeStrategy`: `"requireEqual"`, `"selectBranch"`, `"literal"`, `"newRun"` (4 values)

## Mutual Exclusions

- In a `threadTransaction`, `status` and `phase` are independent — either, both, or neither may change in a transaction.
- `goalSet` and `milestoneSet` can coexist in the same transaction.
- `bindingsAfter` is a full replace, not a merge — all bindings must be specified.
- `threadMergeStrategy` values `"requireEqual"` and `"literal"` must NOT have a `branchId`; `"selectBranch"` MUST have one; `"newRun"` SHOULD NOT.

## Valid Example

```yaml
# From fixtures/zhu-fu/definitions/state_initial.yaml
threads:
  - id: T1
    name: "Xianglin's Wife's Survival Arc"
    type: primary
    description: "From escaped widow to beggar freezing in the street"
    targetRevealChapter: 1
    initialProgress: "0.00"
```

```yaml
# Event-level threadProgress (from fixtures/zhu-fu/chapters/chapter_01/E5_threshold_rejection.yaml)
threadProgress:
  - thread: T1
    advancement: "Liu Ma's hell threats → Xianglin's Wife donates threshold → banned from winter solstice ritual"
    progressAfter: 90
    progressTotal: 100
```

## Invalid Example

```yaml
# ERROR: invalid lifecycle status, progressAfter > progressTotal, missing required thread field
threads:
  - id: T1
    name: "Bad Thread"
    description: "Missing required type field"
    targetRevealChapter: 1
    initialProgress: "0.00"
    extraField: "unknown"
```

**Expected error:**
```
ConfigError at definitions/state_initial.yaml:3:5
  path: /threads/0/type
  message: Required

ConfigError at definitions/state_initial.yaml:8:5
  path: /threads/0/extraField
  message: Unrecognized key(s) in object: 'extraField'
```

## Normalized Target

The compiler produces:

- `ThreadTypeCatalog` — indexed by `typeId`, with lifecycle policies, allowed phases, and stable goals/milestones.
- `ThreadDeclarationCatalog` — indexed by `threadId`, with resolved type references.
- `ThreadRuntimeState` per thread, initialized from declaration defaults and advanced through `threadTransaction` entries.
- Event `threadProgress` entries are normalized into `threadTransaction` records during compilation, with `advancement` prose preserved.
- On branch merge, `ThreadMergeResult` records the strategy, merged state, and new run ID.

## Source-Map Diagnostic Format

```
ConfigError at definitions/state_initial.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
