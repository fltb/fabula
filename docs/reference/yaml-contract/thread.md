# Thread YAML Contract

**Source Zod Schemas:** `packages/core/src/schemas/state-initial.ts` — `worldInitialStateSchema.threads` (author-facing declarations); `packages/core/src/schemas/primitives.ts` — `threadProgressEntrySchema` (event-level progress); `packages/core/src/schemas/thread.ts` — `threadTypeDefinitionSchema`, `threadDeclarationSchema`, `threadRuntimeStateSchema`, `threadTransactionSchema`, `threadMergeResultSchema` (internal/runtime IR)
**Replay:** `packages/core/src/state/thread-replay.ts` (`applyThreadTransaction`, `convertLegacyThreadProgress`, `mergeThreadStates`, `validateThreadTransition`)
**Fixture sources:** `fixtures/zhu-fu/definitions/state_initial.yaml` (threads), `fixtures/arcane-aftermath/definitions/state_initial.yaml` (threads), `fixtures/zhu-fu/chapters/*/E*.yaml` (threadProgress)

Threads model narrative arcs, character development tracks, mystery progressions, and thematic through-lines. Authors declare threads in `definitions/state_initial.yaml` (`threads` array) and progress them via event-level `threadProgress`. Runtime state, transactions, and merge results are compiler/replay-produced IR.

## Authoring / Runtime Boundary

Authors write two things:

1. `threads` in `definitions/state_initial.yaml` — initial thread declarations (fields below).
2. `threadProgress` in event YAML — scalar-progress entries that replay converts into thread transactions.

Everything in `packages/core/src/schemas/thread.ts` (`ThreadTypeDefinition`, `ThreadDeclaration`, `ThreadRuntimeState`, `ThreadTransaction`, `ThreadMergeResult`) is internal IR — none of it appears in author YAML. Event files use the legacy scalar `threadProgress` form; corpus ellipsis files use `threadTransactionSchema` directly for their `threadProgress` array.


## Fields
## Author Thread Declaration Fields (state_initial.yaml `threads`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **required** | — | Unique identifier (e.g. `T1`, `T2`). Referenced by events' `threadProgress`. Must be unique within the array — duplicates are rejected at graph compilation (`ConfigError`, phase `narrative-graphs`). |
| `name` | `string` | **required** | — | Human-readable name. |
| `description` | `string` | **required** | — | Prose describing the thread's narrative purpose. |
| `type` | `string` | **required** | — | Thread type label (e.g. `primary`, `thematic`, `character_arc`). |
| `targetRevealChapter` | `number` | **required** | — | Chapter number where the thread is expected to culminate. |
| `initialProgress` | `string` | **required** | — | Legacy progress label (e.g. `"0.00"`, `"0.15"`). Schema-validated as a plain string but currently **unvalidated and unused**: no decimal grammar is enforced, `loadCanonicalProject` (`entity/project-runtime.ts`) projects thread declarations to `{ id }` only, and replay baselines start from `status: "planned"` with empty goal/milestone state. |
| `structuralFunction` | `enum` | optional | — | Propp structural function (26 values: `absentation`, `interdiction`, `violation`, `departure`, `first_function_of_donor`, `hero_reaction`, `acquisition`, `spatial_translocation`, `villainy`, `mediation`, `beginning_counteraction`, `first_villainy`, `hero_departure`, `donor_test`, `hero_reaction_donor`, `receipt_of_agent`, `guidance`, `arrival`, `unrecognized_arrival`, `unfounded_claims`, `difficult_task`, `solution`, `recognition`, `exposure`, `punishment`, `wedding`). Accepted by the wire schema; not carried into the runtime `WorldInitialState` type. |

### ThreadProgressEntry (Event-Level, Legacy Scalar Form)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `thread` | `string` | **required** | — | Thread ID. |
| `advancement` | `string` | **required** | — | Prose description of advancement. |
| `progressAfter` | `number` | **required** | — | Numeric progress value after this event. |
| `progressTotal` | `number` | **required** | — | Maximum progress value. |

At replay, each entry is converted by `convertLegacyThreadProgress` into a `ThreadTransaction`: `runId` `legacy-<thread>`, `status` `completed` when `progressAfter >= progressTotal` else `active`, `goalSet` `[{ goalId: "progress", status: achieved | active }]`, `provenance` = the event ID, `advancement` preserved.

## ThreadTypeDefinition Fields (Internal Catalog IR)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `typeId` | `string` | required | — | Type identifier. |
| `description` | `string` | required | — | What threads of this type represent. |
| `allowedPhases` | `array` | required | — | Array of valid phase strings. |
| `lifecyclePolicy` | `object` | required | — | `reopenPolicy`: `"forbidden"`, `"allowed"`, or `"requiresExplicitReason"`. |
| `timeDomain` | `enum` | required | — | `"story"` or `"discourse"`. |
| `stableGoals` | `array` | required | — | Goals that must exist (`{ goalId, status }`). |
| `stableMilestones` | `array` | required | — | Milestones that must exist (`{ milestoneId, status }`). |
| `narrativeHints` | `array` | optional | — | Array of hint strings. |
| `provenance` | `string` | optional | — | Source reference. |
| `structuralFunction` | `enum` | optional | — | Propp structural function. |
| `actantModel` | `object` | optional | — | `{ subject, object, sender, receiver, helper, opponent }` (all strings). |

## ThreadDeclaration Fields (Internal Catalog IR — not author YAML)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `threadId` | `string` | required | — | Thread identifier. |
| `name` | `string` | required | — | Human-readable name. |
| `description` | `string` | required | — | Prose description. |
| `typeId` | `string` | required | — | References a thread type definition. |
| `initialPhase` | `string` | optional | — | Starting phase identifier. |
| `initialBindings` | `record` | optional | — | Initial key → string value bindings. |
| `initialGoalStates` | `array` | optional | — | Array of `{ goalId, status }`. |
| `initialMilestoneStates` | `array` | optional | — | Array of `{ milestoneId, status }`. |
| `provenance` | `string` | optional | — | Traceability reference. |

## ThreadRuntimeState Fields (Replay-Produced)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `threadId` | `string` | required | — | Thread identifier. |
| `status` | `enum` | required | — | `"planned"`, `"active"`, `"blocked"`, `"completed"`, `"abandoned"`, `"retired"`. |
| `currentRunId` | `string` | required | — | Active run identifier. |
| `phase` | `string` | required | — | Current phase. |
| `bindings` | `record` | required | — | Current parameter values (key → string). |
| `goalStates` | `record` | required | — | Goal ID → lifecycle status map. |
| `milestoneStates` | `record` | required | — | Milestone ID → lifecycle status map. |
| `semanticStateHash` | `string` | required | — | Content hash for change detection. |

Each declared thread gets a baseline runtime state with `status: "planned"`, `currentRunId: "init-<threadId>"`, and empty `phase`/`bindings`/`goalStates`/`milestoneStates`. The story graph additionally emits root outputs `thread:<threadId>` (value `{ id, status: "planned" }`).

## ThreadTransaction Fields (Replay IR)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `thread` | `string` | **required** | — | Thread ID being progressed. |
| `runId` | `string` | **required** | — | Run identifier for this transaction. |
| `status` | `enum` | optional | — | New lifecycle status for the thread. |
| `phase` | `string` | optional | — | New phase identifier. |
| `bindingsAfter` | `record` | optional | — | Map of binding key → new string value (merged over current bindings at replay). |
| `goalSet` | `array` | optional | — | Goal state updates. |
| `milestoneSet` | `array` | optional | — | Milestone state updates. |
| `provenance` | `string` | **required** | — | Source trace. |
| `advancement` | `string` | optional | — | Prose describing what happened this transaction. |

Lifecycle transitions are validated at replay by `validateThreadTransition`. The transitions it actually permits are: `planned → active` and `planned → retired`, `active → blocked/completed/abandoned/retired`, `blocked → active/completed/abandoned/retired`, and `completed → planned/active` / `abandoned → planned/active`. There is no `active → planned` transition, and although `completed → retired` / `abandoned → retired` appear in the underlying transition table, an early reopen guard rejects them (completed/abandoned can go only to `planned` or `active`). `retired` is terminal — any transition out of it is rejected. Invalid transitions throw with the provenance recorded.

### ThreadMergeStrategy (Branch Merge)

| Strategy | Replay behavior (`mergeThreadStates`) |
|----------|----------------------------------------|
| `"requireEqual"` | Auto-converges when both branches' `semanticStateHash` match; otherwise throws a merge conflict. |
| `"selectBranch"` | The right branch's state wins. |
| `"literal"` | Left state as base, bindings merged, goal/milestone states unioned, hash recomputed. |
| `"newRun"` | New run ID `merge-<leftRunId>-<rightRunId>` with the merged state. |

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
- `threadMergeResultSchema` carries `strategy`, `mergedState`, and optional `newRunId` (set only for `"newRun"`). A `branchId` does not exist on thread merge results; the `selectBranch` variant of the integration `mergePolicySchema` is a separate snapshot-merge policy that does carry one.

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
# Event-level threadProgress (structure of fixtures/zhu-fu/chapters/chapter_01/E5_threshold_rejection.yaml)
threadProgress:
  - thread: T1
    advancement: "Liu Ma's hell threats → Xianglin's Wife donates threshold → banned from winter solstice ritual"
    progressAfter: 90
    progressTotal: 100
```

## Invalid Example

```yaml
# ERROR: missing required 'type' field, unknown key
info:
  currentEra: "Test era"
  politicalSituation: "Test situation"
threads:
  - id: T1
    name: "Bad Thread"
    description: "Missing required type field"
    targetRevealChapter: 1
    initialProgress: "0.00"
    extraField: "unknown"
```

**Expected error (standard loader — first issue only):**
```
error.message:      YAML schema validation failed at threads.0.type: Required
error.context.path: definitions/state_initial.yaml:threads.0.type
```

## Normalized Target

- Declared threads become baseline `ThreadRuntimeState`s (`status: "planned"`, `currentRunId: "init-<threadId>"`, empty `phase`/`bindings`/`goalStates`/`milestoneStates`, empty `semanticStateHash`) and root graph outputs `thread:<threadId>`. Only the thread `id` reaches the runtime baseline: `name`/`description`/`type`/`targetRevealChapter`/`initialProgress` exist on the `WorldInitialState` IR type but are dropped by the `{ id }`-only projection, and the context `ThreadStatus` builder falls back to `name: id` with `description` taken from the current event's `threadProgress.advancement`. The thread-level `targetRevealChapter` has no runtime consumer (the foreshadowing validator's `targetRevealChapter` is a separate event-level field).
- `ThreadTypeCatalog` / `ThreadDeclarationCatalog` (`threadTypeCatalogSchema`, `threadDeclarationCatalogSchema`) are schema-only IR with no authored YAML surface, no loader, and no production consumer: `initializeThreadRuntimeState` — the only initializer that consumes declarations plus type definitions — is exercised only in tests, and the `timeDomain`/`reopenPolicy`/`allowedPhases`/`stableGoals`/`stableMilestones` type fields are never consulted at runtime (`getThreadTimeDomain` has no production callsite and defaults to `"story"`; `assertClockCompatibility` is an explicit no-op hook, so no clock-domain enforcement exists).
- Event `threadProgress` entries are converted to `ThreadTransaction`s at replay (`convertLegacyThreadProgress`) and applied by `applyThreadTransaction` (lifecycle transitions validated).
- On branch merge, `mergeThreadStates` produces a `ThreadMergeResult` (strategy, merged state, optional new run ID).

## Source-Map Diagnostic Format

`readYamlFile` reports only the **first** validation issue, as two separate properties on the `ConfigError`:

- `error.message` — `YAML schema validation failed at <dot-joined path | <root>>: <Zod message>`
- `error.context.path` — the project-relative file path, suffixed with the dot-joined Zod path when the issue is not at the root

Zod issue paths are joined with dots (`threads.0.type`), not JSON Pointer syntax; a root-level issue reports `<root>` in the message and stores only the file path in `error.context.path`. No second `path:` line is rendered. Replay-time transition violations throw with the provenance recorded.
