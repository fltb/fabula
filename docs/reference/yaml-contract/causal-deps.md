# Causal Dependencies YAML Contract

**Source Zod Schemas:** `packages/core/src/schemas/graph.ts` — `storyGraphSchema`, `discourseGraphSchema`, `graphEdgeSchema`, `outputDescriptorSchema`, `readRequirementSchema`, `graphReadResolutionSchema`, `graphProviderOutputSchema`, `graphAbsenceWitnessSchema`, `graphBoundaryReferenceSchema`, `graphNarrativeEllipsisSchema`, `presencePredicateSchema`, `edgeClassSchema`, `effectiveCoordinateSchema`, `storyCoordinateSchema`, `sceneStoryCoordinateSchema`, `discourseCoordinateSchema`; `packages/core/src/schemas/event.ts` — `eventFileSchema` (`causalPredecessors`, `preconditions`, `expectedPostconditions`)
**Compilation entry points:** `packages/core/src/state/graph-compiler.ts` (`compileGraph`), `packages/core/src/state/graph-adapter.ts` (`compileStoryRuntimeGraph`, `compileNarrativeGraphs`)
**Fixture sources:** `fixtures/arcane-aftermath/chapters/chapter_01/E1a.yaml`, `E1b.yaml` (authored `causalPredecessors`); all event YAML files' `preconditions` / `expectedPostconditions` arrays (implicit reads and writes)

Causal dependencies model **why** one narrative state depends on another. The typed graph layer (GRAPH-1) captures read-after-write edges between events, provider resolution semantics, absence witnesses, and the overall story/discourse graph structure.

The graph structures are **compiler-produced**. Author-facing YAML never contains edges, reads, outputs, or resolutions; authors express causality through three event-file inputs only:

1. `preconditions` — deterministic reads of entity attributes (become `ReadRequirement`s with `origin: "precondition"`).
2. `expectedPostconditions` — deterministic writes of entity attributes (become `OutputDescriptor`s).
3. `causalPredecessors` — explicit predecessor event IDs (become `author_origin` edges; optional on any scene, principally useful when story time cannot order the pair).

Everything else — edges, reads, outputs, resolutions, hashes — is materialized at compile time by `compileGraph`/`compileStoryRuntimeGraph`. Replay does not consume the full graph: `ReplayEngine.buildFromCompiled` re-applies the original `NarrativeEvent`s in the compiled topological order, and never replays `OutputDescriptor`s or inspects `ReadRequirement`/`GraphReadResolution` records. Those structures drive compile-time validation and edge/order derivation; the projected adjacency and order are what drive replay.

## Fields

## EffectiveCoordinate (discriminated union)

| discriminator `type` | Kind | Fields | Description |
|----------------------|------|--------|-------------|
| `"storyTime"` | `"initial"` | — | The synthetic story root `system:initial`; initial facts and thread baselines. |
| `"storyTime"` | `"unlocated"` | — | A scene with no locatable story time (omitted or indeterminate `storyTime`). |
| `"storyTime"` | `"point"` | `clock`: `"story"` \| `"calendar"` \| `"chapter"`, `scalar`: number | A resolved story-clock position (e.g. story-clock ms offset, calendar ISO instant, chapter number). |
| `"discoursePosition"` | — | `value`: integer | Reader-order position in the discourse graph. |

`EffectiveCoordinate` is the union of `StoryCoordinate` (`"storyTime"`) and `DiscourseCoordinate` (`"discoursePosition"`). `SceneStoryCoordinate` = `unlocated | point`.

## GraphEdge Fields (Compiler-Produced)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `predecessor` | `string` | required | — | Source node ID (event ID, `system:initial`, or a discourse node ID). |
| `dependent` | `string` | required | — | Target node ID that depends on the predecessor. |
| `edgeClass` | `enum` | required | — | `"author_origin"`, `"provider"`, `"same_coordinate_order"`, `"internal"`. |
| `causalGroupId` | `string` | optional | — | Groups edges from one cause (e.g. `temporal:<clock>:<fromScalar>:<toScalar>` for derived temporal edges). |

One predecessor per dependency. Multiple causes of the same dependent produce multiple edges, optionally sharing a `causalGroupId`.

### Edge Class Provenance

| `edgeClass` | Produced from | Notes |
|-------------|---------------|-------|
| `"author_origin"` | Authored `causalPredecessors` (event YAML) or trusted compiler-injected predecessors (`NarrativeEvent.causalPredecessors`, e.g. branch-point and `system:introduction` transitions) | Validated: predecessor must be a reachable event on the branch (`ConfigError`, phase `narrative-graphs`); the initial root can never be an `author_origin` predecessor. |
| `"provider"` | Maximal-provider resolution during compilation | Edge from the provider node to the reader node; skipped when an event reads its own `stateAfter` output. |
| `"same_coordinate_order"` | Explicit equal-coordinate ordering | Only valid between two equal `point` story coordinates; the initial root can never be a predecessor. |
| `"internal"` | Derived temporal edges | Complete bipartite edges between adjacent same-clock scalar buckets; `causalGroupId` = `temporal:<clock>:<fromScalar>:<toScalar>`. Transitivity makes any earlier point reach any later one. |

## OutputValue / OutputDescriptor Fields (Compiler-Produced)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `outputId` | `string` | required | Stable effect ID, e.g. `<eventId>:fact:<index>`, `thread:<threadId>`, `<eventId>:relationship:<index>`, `<eventId>:rule:<index>`, `system:initial:fact:<index>`. |
| `canonicalKey` | `string` | required | Canonical state key written, e.g. `<entityId>.<attribute>` (entity facts), `thread:<threadId>`, `relationship:<relationshipId>`, `rule:<ruleId>`. |
| `value` | `OutputValue` | required | `{ type: "set", data: <value> }` or `{ type: "unset" }` (reversion/removal). |
| `branchScope` | `string` | required | Branch path string this output belongs to (initial root uses `""`). |
| `effectiveCoordinate` | `EffectiveCoordinate` | required | The owning node's resolved coordinate. |
| `provenanceHash` | `string` | required | Deterministic hash of effect identity, key, value, and branch scope. |

## PresencePredicate / ReadRequirement Fields (Compiler-Produced)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `readId` | `string` | required | Stable read ID, e.g. `<eventId>:precondition:<index>`. |
| `canonicalKey` | `string` | required | The exact key being read, e.g. `<entityId>.<attribute>`. |
| `predicate` | `PresencePredicate` | required | Discriminated union on `type`: `{ type: "exists" }`, `{ type: "absent" }`, `{ type: "equals", value }`, `{ type: "matches", pattern }`. The runtime predicate type additionally includes value-bearing `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains` — full operator semantics are enforced at replay by `applyNarrativeEvent`, not at graph compile time. |
| `phase` | `enum` | required | `"stateBefore"` or `"stateAfter"`. |
| `branchScope` | `string` | required | Branch path string for this read. |
| `origin` | `enum` | required | `"precondition"`, `"source"`, `"rule"`, `"scope"`, `"lifecycle"`, `"merge"`. |

### Precondition → ReadRequirement Mapping

For each event `precondition` fact (author YAML): `readId = "<eventId>:precondition:<index>"`, `canonicalKey = "<entityId>.<attribute>"`, `phase = "stateBefore"`, `origin = "precondition"`. The predicate derives from the fact's `operator`:

- `operator: eq` (default) → `{ type: "equals", value }`
- `operator: exists` → `{ type: "exists" }`
- `operator: not_exists` → `{ type: "absent" }`
- any other operator (`neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`) → `{ type: <operator>, value }`

A precondition with only a `narrativeHint` (no `value`) produces **no** read requirement.

## GraphReadResolution Fields (Compiler-Produced)

Exactly one resolution per read per branch scope. Discriminated union on `type`:

### `{ type: "output" }` — GraphProviderOutput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"output"`. |
| `outputId` | `string` | required | The provider output satisfying the read. |
| `canonicalKey` | `string` | required | Key of the resolved output. |
| `coordinate` | `EffectiveCoordinate` | required | The provider output's coordinate. |
| `provenanceHash` | `string` | required | The provider output's provenance hash. |

### `{ type: "absence" }` — GraphAbsenceWitness

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"absence"`. |
| `readId` | `string` | required | The read that has no provider. |
| `canonicalKey` | `string` | required | The read's canonical key. |
| `coordinate` | `EffectiveCoordinate` | optional | Coordinate of the read's owning node when known. |
| `reason` | `string` | required | Why no compatible write exists (e.g. `No compatible write for "<key>" in branch "<scope>"`). |

## StoryGraph Fields (Compiler-Produced)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `literal` | required | — | Must be `"story"`. |
| `edges` | `array` | required | — | Array of `GraphEdge`. |
| `outputs` | `array` | required | — | Array of `OutputDescriptor`. |
| `reads` | `array` | required | — | Array of `ReadRequirement`. |
| `resolutions` | `array` | required | — | Array of `GraphReadResolution` (one per read per branch). |
| `hash` | `string` | required | — | Content hash over nodes, edges, outputs, and resolutions. |
| `ellipses` | `array` | optional | — | Array of `GraphNarrativeEllipsis` (story graph only). |

## DiscourseGraph Fields (Compiler-Produced)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `literal` | required | — | Must be `"discourse"`. |
| `edges` | `array` | required | — | Array of `GraphEdge`. |
| `outputs` | `array` | required | — | Array of `OutputDescriptor`. |
| `hash` | `string` | required | — | Content hash. |
| `boundaryReferences` | `array` | optional | — | Array of `GraphBoundaryReference` (discourse graph only). |
| `sceneSequence` | `array` | required | — | Array of `DiscourseSceneSequenceEntry` (`sceneId`, `sequence`, `chapter`, optional `actionInterval`). |

## GraphNarrativeEllipsis Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `outputId` | `string` | required | Output ID of the ellipsis node. |
| `storyCoordinate` | `SceneStoryCoordinate` | required | The ellipsis's story coordinate. |
| `requiredOutputHash` | `string` | required | Hash of the output the ellipsis requires. |

## GraphBoundaryReference Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"boundary"`. |
| `snapshotHash` | `string` | required | Hash of the pinned upstream snapshot. |
| `sourceGraph` | `enum` | required | `"story"` or `"discourse"`. |
| `targetGraph` | `enum` | required | `"discourse"` or `"story"`. |
| `pinnedOutputs` | `array` | required | Output IDs pinned across the boundary. |

Boundary references are hash-pinned, one-way, read-only links between graphs — they never create cross-graph causal/provider edges.

## Author-Facing Input

### `causalPredecessors` (event YAML)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `causalPredecessors` | `array` | optional | — | Explicit predecessor event IDs. Each entry must be nonblank after trimming; entries must be unique; when present, at least one entry is required. |

Semantics: an optional explicit dependency on any scene; it is principally useful when timestamps cannot order the pair (unlocated, indeterminate, or cross-clock scenes), but the wire schema and compiler do not restrict it to those — the document's own E1a/E1b fixture is a same-story-clock example. `graph-compiler.ts::validateCoordinateOrder` accepts an explicit `author_origin` edge whenever the predecessor is earlier, equal, or incomparable with the dependent, and rejects only a strictly later comparable predecessor. `causalPredecessors` is the only author-facing spelling of an explicit dependency edge. At graph compilation, `graph-adapter.ts` converts them to `author_origin` edges and rejects predecessors that are not reachable events on the selected branch (`ConfigError`, phase `narrative-graphs`).

`NarrativeEvent.causalPredecessors` may also be injected by trusted internal compilation (e.g. branch-point transition edges from the game-dialogue tree and `system:introduction:<targetId>:<entityId>` entity-introduction transitions, which copy their host event's predecessor list); the runtime type does not distinguish authored from injected provenance.

## Closed Enums / IDs

- `edgeClass`: `"author_origin"`, `"provider"`, `"same_coordinate_order"`, `"internal"` (4 values)
- `readPhase`: `"stateBefore"`, `"stateAfter"` (2 values)
- `readOrigin`: `"precondition"`, `"source"`, `"rule"`, `"scope"`, `"lifecycle"`, `"merge"` (6 values)
- `coordinate.type`: `"storyTime"`, `"discoursePosition"` (2 values)
- `pointStoryCoordinate.clock`: `"story"`, `"calendar"`, `"chapter"` (3 values)
- `outputValue.type`: `"set"`, `"unset"` (2 values)
- `graphReadResolution.type`: `"output"`, `"absence"` (2 values)
- `graph.type`: `"story"`, `"discourse"` (2 values)

## Mutual Exclusions / Semantics

- `GraphProviderOutput` and `GraphAbsenceWitness` are alternative resolutions for a read — exactly one `GraphReadResolution` applies per read per branch scope.
- Absence is legal **only** for reads whose predicate is `absent` (the `not_exists` operator) or reads claimed by a valid `absentApparatus` contract of the owning event (`readId` must begin with `<eventId>:precondition:`). This hard rule is enforced by the closure loop in `compileNarrativeGraphs` (the project-pipeline entry point), which rejects any other deterministic read that resolves to absence with a `ConfigError` (phase `narrative-graphs`). The story-only entry point `compileStoryRuntimeGraph` does not reject: it returns absence witnesses as resolutions, and `ReplayEngine` (which calls the story-only path) fails the precondition at replay time instead — see `packages/core/tests/branch/diamond.test.ts`, where compilation succeeds before replay fails the precondition.
- `ellipses` appears only on `storyGraph`; `boundaryReferences` appears only on `discourseGraph`.
- Edges never cross clock domains: a story node cannot be a predecessor of a discourse node and vice versa.
- A `same_coordinate_order` edge requires equal `point` coordinates and a non-initial predecessor.
- Compile-time validation rejects: unknown predecessors, self-predecessors, cycles, `author_origin`/`same_coordinate_order` edges out of the initial root, predecessors strictly later than their dependents, and commutativity conflicts (unordered node pairs with overlapping read/write keys).

## Valid Example

```yaml
# From fixtures/arcane-aftermath/chapters/chapter_01/E1b.yaml (authored input)
event: E1b
narrativeOrder: 2
storyTime:
  offset:
    amount: 1
    unit: hour
causalPredecessors: [E1a]
preconditions:
  - entity: camille
    attribute: location
    value: piltover_enforcer_headquarters
    confidence: 1.0
expectedPostconditions:
  - entity: camille
    attribute: has_accepted_case
    value: true
    confidence: 1.0
```

The compiler derives (illustrative, branch `root`; edges are a non-exhaustive excerpt — see below for the derived temporal edge):

```yaml
# StoryGraph structures (compiler-produced, not authored)
edges:
  - predecessor: E1a            # from causalPredecessors: [E1a]
    dependent: E1b
    edgeClass: author_origin
  - predecessor: E1a            # derived: E1a (story scalar 0) → E1b (story scalar 3600000)
    dependent: E1b
    edgeClass: internal
    causalGroupId: "temporal:story:0:3600000"
  - predecessor: system:initial # initial fact write that satisfies the read
    dependent: E1b
    edgeClass: provider
reads:
  - readId: E1b:precondition:0
    canonicalKey: camille.location
    predicate:
      type: equals
      value: piltover_enforcer_headquarters
    phase: stateBefore
    branchScope: root
    origin: precondition
outputs:
  - outputId: E1b:fact:0
    canonicalKey: camille.has_accepted_case
    value:
      type: set
      data: true
    branchScope: root
    effectiveCoordinate:
      type: storyTime
      kind: point
      clock: story
      scalar: 3600000
    provenanceHash: "<sha256>"
resolutions:
  - type: output
    outputId: system:initial:fact:<n>  # see note below on root fact indices
    canonicalKey: camille.location
    coordinate:
      type: storyTime
      kind: initial
    provenanceHash: "<sha256>"
```

Note on root fact indices: initial-root outputs come from `initialFacts`, built by `buildInitialFacts()` (`entity/project-runtime.ts`) from initial-introduction declaration states — in declaration-catalog order (characters, locations, items, factions, rules, then `state_initial.yaml` world facts, then definition-less introductions). `graph-adapter.ts` assigns `system:initial:fact:<index>` in that array order (branch-filtered, with equal same-key facts deduplicated). This fixture has multiple `worldFacts`, so `system:initial:fact:0` is the first declaration fact (e.g. a character's `lifecycle`), **not** necessarily `camille.location`. Thread baselines are separate outputs (`thread:<threadId>` with `status: "planned"`). Use a symbolic placeholder (`system:initial:fact:<n>`) or look up the actual generated index rather than attaching `camille.location` to fact zero.

## Invalid Example

```yaml
# ERROR: blank causalPredecessor entry is rejected by eventFileSchema
# (other required fields shown so the blank entry is the first issue)
event: E9
title: "Example"
narrativeOrder: 9
pov:
  character: narrator
  type: third_person_limited
sceneBrief: "Example scene."
preconditions: []
expectedPostconditions: []
causalPredecessors:
  - ""
```

**Expected error (standard loader — first issue only; the event must otherwise satisfy `eventFileSchema`):**
```
error.message:      YAML schema validation failed at causalPredecessors.0: causalPredecessors must be nonblank
error.context.path: chapters/chapter_01/E9.yaml:causalPredecessors.0
```

Compilation-time violations (authored predecessor not reachable on the branch, cycles, ambiguous providers, and — under `compileNarrativeGraphs` — deterministic reads resolving to absence without an `absent` predicate or `absentApparatus` claim) surface as `ConfigError` with phase `narrative-graphs`, carrying the offending event ID.

## Normalized Target

The compiler produces, per branch:

- `StoryGraph` — all typed edges between event outputs and reads (`author_origin`, `provider`, `same_coordinate_order`, `internal`), with exactly one `GraphReadResolution` per read per branch (provider output or absence witness).
- `DiscourseGraph` — discourse nodes with their disclosure outputs (`disclosure:<sceneId>:<entryId>`), the computed `sceneSequence`, and a content hash. The adapter currently supplies no explicit edges (temporal edge derivation excludes discourse coordinates), so the produced discourse graph has no reader-order disclosure edges, and `boundaryReferences` is never assigned anywhere in source — both fields are schema-only optional IR until producers exist.
- `StoryOrderIndex` — topological replay order built from all four edge classes plus resolved coordinates; causal predecessors provide explicit ordering where story time cannot.
- Event-to-event adjacency (`storyAdjacency`) including all edge classes, used by replay, branch merge, sparse-run excerpt disclosure, and coverage manifests.

The story root is the synthetic node `system:initial` (`INITIAL_STORY_ROOT_ID`), whose outputs come from the selected initial facts (built by `buildInitialFacts()` from initial-activation declarations and `state_initial.yaml` world facts — initial facts are baseline inputs, never replayed as authored events) and thread baselines (`thread:<threadId>` with `status: "planned"`).

## Source-Map Diagnostic Format

`readYamlFile` reports only the **first** validation issue, as two separate properties on the `ConfigError`:

- `error.message` — `YAML schema validation failed at <dot-joined path | <root>>: <Zod message>`
- `error.context.path` — the project-relative file path, suffixed with the dot-joined Zod path when the issue is not at the root

Zod issue paths are joined with dots (`causalPredecessors.0`), not JSON Pointer syntax; a root-level issue reports `<root>` in the message and stores only the file path in `error.context.path`. No second `path:` line is rendered. Compilation-time graph errors use `ConfigError` with `phase: "narrative-graphs"` and include the offending event ID in the message.
