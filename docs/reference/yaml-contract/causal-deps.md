# Causal Dependencies YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/graph.ts` — `storyGraphSchema`, `graphEdgeSchema`, `graphNarrativeEllipsisSchema`, `readRequirementSchema`, `graphReadResolutionSchema`, `graphProviderOutputSchema`, `graphAbsenceWitnessSchema`; `packages/core/src/schemas/integration.ts` — `providerOutputSchema`, `absenceWitnessSchema`, `boundaryReferenceSchema`, `narrativeEllipsisSchema`  
**Fixture sources:** All event YAML files' `preconditions` and `expectedPostconditions` arrays (implicit causal edges)

Causal dependencies model **why** one narrative state depends on another. The contract captures read-after-write edges between events, provider resolution semantics, absence witnesses, and the overall story/discourse graph structure. Author-facing YAML primarily expresses causal dependencies implicitly through event `preconditions` and `expectedPostconditions`; the compiler materializes them into explicit graph edges.


## Fields
## GraphEdge Fields (Compiler-Produced)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from` | `string` | required | — | Source output ID. |
| `to` | `string` | required | — | Target read requirement ID. |
| `class` | `enum` | required | — | `"author_origin"`, `"provider"`, `"same_coordinate_order"`, `"internal"`. |
| `effectiveCoordinate` | `effectiveCoordinate` | required | — | Story or discourse coordinate. |

### EffectiveCoordinate (discriminated union)

| discriminator `type` | Value | Description |
|---------------------|-------|-------------|
| `"storyTime"` | `value: string` | Story-time coordinate (e.g. `day_0`, `winter_solstice`) |
| `"discoursePosition"` | `value: number` | Discourse position integer |

## ProviderOutput Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `outputId` | `string` | **required** | — | Unique output identifier. |
| `provider` | `string` | **required** | — | Provider module name (e.g. `narrator`, `state_engine`). |
| `eventId` | `string` | **required** | — | Event that produced this output. |
| `branch` | `object` | **required** | — | Branch context. `decisions`: array of `{ atEventId, choiceId, narrativeOrder }`. |
| `temporalPrefix` | `string` | **required** | — | Temporal coordinate prefix for ordering. |
| `content` | `unknown` | **required** | — | The produced content value. |
| `resolutionHash` | `string` | **required** | — | Deterministic content hash. |
| `causality` | `literal` | **required** | Must be `"provider_edge"`. |

## AbsenceWitness Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `branch` | `object` | **required** | — | Branch context (same structure as ProviderOutput). |
| `temporalPrefix` | `string` | **required** | — | Temporal coordinate prefix. |
| `basis` | `enum` | **required** | — | `"never_written"`, `"pre_introduction"`, `"after_unset"`, `"branch_local"`. |
| `latestUnsetOutput` | `string` | optional | — | Last output ID that was unset, if relevant. |
| `resolutionHash` | `string` | **required** | — | Deterministic hash. |

## ReadRequirement Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `outputId` | `string` | required | — | The output being read. |
| `targetEvent` | `string` | required | — | Event that requires this read. |
| `targetField` | `string` | required | — | Field path being read (e.g. `preconditions/0/value`). |
| `phase` | `enum` | required | — | `"stateBefore"` or `"stateAfter"`. |
| `origin` | `enum` | required | — | `"precondition"`, `"source"`, `"rule"`, `"scope"`, `"lifecycle"`, `"merge"`. |

## StoryGraph Fields (Compiler-Produced)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `literal` | required | — | Must be `"story"`. |
| `edges` | `array` | required | — | Array of `GraphEdge`. |
| `outputs` | `array` | required | — | Array of `OutputDescriptor`. |
| `reads` | `array` | required | — | Array of `ReadRequirement`. |
| `resolutions` | `array` | required | — | Array of resolved reads (provider output or absence witness). |
| `hash` | `string` | required | — | Content hash. |
| `effectiveCoordinate` | `storyCoordinate` | required | — | The story coordinate for this graph. |
| `ellipses` | `array` | optional | `[]` | Narrative ellipses in this graph. |

## BoundaryReference Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sourceSnapshotHash` | `string` | required | — | Hash of the upstream snapshot. |
| `branch` | `object` | required | — | Branch decision context. |
| `propositions` | `array` | required | — | Proposition IDs carried across the boundary. |
| `truthValues` | `record` | required | — | Proposition ID → boolean truth value map. |

## Closed Enums / IDs

- `edgeClass`: `"author_origin"`, `"provider"`, `"same_coordinate_order"`, `"internal"` (4 values)
- `coordinate.type`: `"storyTime"`, `"discoursePosition"` (2 values)
- `absenceBasis`: `"never_written"`, `"pre_introduction"`, `"after_unset"`, `"branch_local"` (4 values)
- `readPhase`: `"stateBefore"`, `"stateAfter"` (2 values)
- `readOrigin`: `"precondition"`, `"source"`, `"rule"`, `"scope"`, `"lifecycle"`, `"merge"` (6 values)
- `causality` (for provider output): `"provider_edge"` (1 literal value)

## Mutual Exclusions

- `ProviderOutput` and `AbsenceWitness` are alternative resolutions for a read — exactly one applies per read requirement.
- `AbsenceWitness.latestUnsetOutput` is meaningful only when `basis === "after_unset"`; otherwise it's absent.
- `ellipses` array is present only for `storyGraph`, never for `discourseGraph`.
- `boundaryReferences` array is present only for `discourseGraph`, never for `storyGraph`.

## Valid Example

```yaml
# Story graph edges (compiler-produced from event preconditions)
edges:
  - from: E1_output_location
    to: E2_read_location
    class: provider
    effectiveCoordinate:
      type: storyTime
      value: winter_five_years_ago

# Provider output for a deterministic read
resolutions:
  - outputId: E1_output_location
    provider: state_engine
    eventId: E1
    branch:
      decisions:
        - atEventId: E0
          choiceId: main
          narrativeOrder: 1
    temporalPrefix: "-1825"
    content: "fourth_master_lu_house"
    resolutionHash: "abc123def456"
    causality: provider_edge
```

## Invalid Example

```yaml
# ERROR: invalid edgeClass enum, missing required from/to, mismatch type
edges:
  - from: E1
    class: unknown   # invalid enum
    effectiveCoordinate:
      type: storyTime
      value: day_0
```

**Expected error:**
```
ConfigError at <file>.yaml:2:5
  path: /edges/0/to
  message: Required

ConfigError at <file>.yaml:3:11
  path: /edges/0/class
  message: Invalid enum value 'unknown'. Expected one of 'author_origin', 'provider', 'same_coordinate_order', 'internal'
```

## Normalized Target

The compiler produces:

- `StoryGraph` — all causal edges between event outputs and reads, with resolved provider outputs or absence witnesses.
- `DiscourseGraph` — disclosure-order edges, outputs, and boundary references to upstream story snapshots.
- Each `ReadRequirement` is resolved to exactly one `ReadResolution` (either a `ProviderOutput` with `causality: "provider_edge"` or an `AbsenceWitness`).
- The graph is the foundation for branch merge, sparse-run excerpt disclosure, and coverage manifests.

## Source-Map Diagnostic Format

```
ConfigError at <file>.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
