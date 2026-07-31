# NarrativeEllipsis + DiscourseBridge YAML Contract

**Source Zod Schemas:** `packages/core/src/schemas/corpus.ts` — `narrativeEllipsisFileSchema` (authored wire format), `narrativeEllipsisSchema` (corpus runtime), `narrativeNodeSchema` (corpus discriminated union), `narrativeEventSchema` (corpus structural overlap), `ellipsisProvenanceSchema`; `packages/core/src/schemas/graph.ts` — `graphNarrativeEllipsisSchema` (plus `sceneStoryCoordinateSchema`, `storyGraphSchema.ellipses`); `packages/core/src/schemas/integration.ts` — `narrativeEllipsisSchema`, `narrativeNodeSchema`, `scenePresentationSchema`, `discourseBridgeSchema`, `discourseNodeSchema`, `coverageManifestSchema`, `excerptDisclosureCheckpointSchema`, `fullWorkContextSchema`, `sparseRunDeclarationSchema`; `packages/core/src/schemas/discourse.ts` — `sparseRunDeclarationSchema` (discriminated-union variant)

This contract covers **omitted content** (narrative ellipses) and **disclosure gaps** (discourse bridges). Four distinct schema families exist, and they must not be conflated:

1. **Corpus runtime** (`corpus.ts::narrativeEllipsisSchema`, type `NarrativeEllipsis`) — a declared, mappable runtime shape that is **not integrated with replay**: discriminated on `kind: 'ellipsis'` with branch scope, a runtime `StoryTimestamp`, wire-shaped pre/postconditions (see table), five transaction arrays, and atomic provenance. Produced by `mapToNarrativeEllipsis()` from the wire format. `computeStateBefore()` (`state/corpus-replay.ts`) treats ellipsis node IDs as ordering constraints in the causal graph but applies none of an ellipsis's effects (non-event nodes are skipped), and the standard replay/graph entry points — `ReplayManager` (`state/replay.ts`) and `compileStoryRuntimeGraph()` (`state/graph-adapter.ts`) — accept only `NarrativeEvent` objects. An ellipsis's effects exist in the data model, not in replay behavior; at most its ID can serve as an externally supplied ordering reference.
2. **Corpus wire** (`corpus.ts::narrativeEllipsisFileSchema`, type `NarrativeEllipsisFile`) — the YAML-on-disk authored shape: `storyTime` is the authored timestamp union (omitted → `{ type: 'indeterminate', mode: 'unspecified' }` at runtime). **Standard loading does not load ellipsis files**: `EntityMapper.loadProject()` reads no ellipsis path; this schema is currently exercised only as a wire schema with its type guard (`isNarrativeEllipsisFile`) and in tests.
3. **Graph stub** (`graph.ts::graphNarrativeEllipsisSchema`) — a schema-level entry on `storyGraphSchema.ellipses` (optional array). `StoryGraph.ellipses` has no producer or consumer in the codebase; it is schema-level only. Graph ellipses use a **story coordinate** (`sceneStoryCoordinateSchema`), not the legacy `storyTime.type/value` object.
4. **Integration stubs** (`integration.ts`) — structural overlap records for `coverageManifestSchema`: `narrativeEllipsisSchema`, `scenePresentationSchema`, `discourseBridgeSchema`, and the `NarrativeNode`/`DiscourseNode` unions. They are declared contracts with no runtime producer; they are currently exercised only as type-only fixtures in `packages/core/tests/state/merge-plan.test.ts` — that test imports the integration TypeScript types and constructs plain objects, and never imports or parses the integration Zod schemas, so it provides no schema-validation coverage.

## NarrativeEllipsis Fields (Corpus Runtime)

Validated by `corpus.ts::narrativeEllipsisSchema`. Discriminated on `kind`; strict — POV, cast, sceneBrief, styleGuidance, narrationTime, narrativeOrder, and other event/scene fields are rejected.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `literal` | **required** | Must be `"ellipsis"`. |
| `id` | `string` | **required** | Unique ellipsis identifier (min length 1). |
| `branchScope` | `object` | **required** | Branch path (`decisions: [{ atEventId, choiceId, narrativeOrder }]`). |
| `storyTime` | `object` | required (defaulted) | Runtime `StoryTimestamp` AST; defaults to `{ type: 'indeterminate', mode: 'unspecified' }`. Exactly one — multiple incompatible story times must be split into separate ellipses. |
| `summary` | `string` | optional | Source-grounded diagnostic text only — NEVER creates claim/provider, Fact, causal edge, WorldState change, or DiscourseState change; never enters the logical prompt. |
| `preconditions` | `array` | required | Wire-shape precondition records (`preconditionSchema`: `entity`/`attribute`/`value`/`operator`/`narrativeHint`), **not** runtime `Fact` objects. `mapToNarrativeEllipsis()` produces runtime Facts carrying `id`, `entityId`, and `validity`, which this strict schema rejects — the schema reuses the authored wire form. |
| `postconditions` | `array` | required | Wire-shape postcondition records (`postconditionSchema`: `entity`/`attribute`/`value`/`operation`/`narrativeHint`), **not** runtime `Fact` objects (same mismatch as `preconditions`). |
| `relationshipEffects` | `array` | required | Relationship transactions. |
| `knowledgeTransactions` | `array` | required | InformationAct transactions. |
| `threadProgress` | `array` | required | Thread transactions. |
| `ruleEffects` | `array` | required | Rule transactions. |
| `provenance` | `object` | **required** | `ellipsisProvenanceSchema`: `sourceHash` (required, min 1), `sourceRange` `{ start, end }` nonnegative integers with `end >= start` (required), `reviewerId`/`reviewTimestamp` (optional). |

## NarrativeEllipsis Fields (Corpus Wire — YAML-on-Disk)

Validated by `corpus.ts::narrativeEllipsisFileSchema`. Not loaded by standard loading; declared for a future loader. `preconditions`/`postconditions` use the same wire Fact format as event files; the transaction arrays reuse the runtime-compatible schemas.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **required** | EllipsisFile identity (min length 1). |
| `branchScope` | `object` | optional | Defaults to empty/trunk path. |
| `storyTime` | `string \| object` | optional | Authored story time (`authoredStoryTimeSchema`); omitted maps to `{ type: 'indeterminate', mode: 'unspecified' }` at runtime. Single value only — arrays and multiple story times are rejected. |
| `summary` | `string` | optional | Diagnostic-only, as above. |
| `preconditions` | `array` | optional (default `[]`) | Wire Fact preconditions. |
| `postconditions` | `array` | optional (default `[]`) | Wire Fact postconditions. |
| `relationshipEffects` | `array` | optional (default `[]`) | Relationship transactions. |
| `knowledgeTransactions` | `array` | optional (default `[]`) | InformationAct transactions. |
| `threadProgress` | `array` | optional (default `[]`) | Thread transactions. |
| `ruleEffects` | `array` | optional (default `[]`) | Rule transactions. |
| `provenance` | `object` | **required** | `ellipsisProvenanceSchema`, as above. |

## NarrativeNode (Corpus)

Corpus `narrativeNodeSchema` is a **discriminated union on `kind`** of the corpus runtime `narrativeEventSchema` (`kind: 'event'`; structural overlap: `id`, `event`, `title`, `narrativeOrder`, `storyTime`) and `narrativeEllipsisSchema` (`kind: 'ellipsis'`). The two branches are mutually exclusive by schema.

## NarrativeEllipsis Fields (Graph-Level Stub)

Validated by `graph.ts::graphNarrativeEllipsisSchema`; referenced only by `storyGraphSchema.ellipses` (optional array). Schema-level only — nothing in the codebase produces or consumes these records.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `outputId` | `string` | **required** | Output ID of the ellipsis record in the graph (min length 1). |
| `storyCoordinate` | `object` | **required** | `sceneStoryCoordinateSchema` — a story coordinate, see below. |
| `requiredOutputHash` | `string` | **required** | Preceding-output hash this ellipsis depends on (min length 1). No cross-graph resolution is enforced. |

### Story Coordinate (Graph Ellipsis)

Graph ellipses use the story-coordinate shape (`sceneStoryCoordinateSchema`), with `kind` selecting between the unlocated and point variants. There is no `storyTime.type/value` form:

```yaml
storyCoordinate:
  type: storyTime
  kind: point
  clock: story        # 'story' | 'calendar' | 'chapter'
  scalar: 3.6e6       # finite number
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"storyTime"`. |
| `kind` | `literal` | required | `"unlocated"` (no clock/scalar) or `"point"` (requires `clock` and `scalar`). |
| `clock` | `enum` | required for `point` | `"story"`, `"calendar"`, `"chapter"`. |
| `scalar` | `number` | required for `point` | Finite number on the coordinate's clock. |

## NarrativeEllipsis Fields (Integration-Level Stub)

Validated by `integration.ts::narrativeEllipsisSchema` — the structural overlap record used by `coverageManifestSchema.narrativeNodes`. Distinct from the corpus runtime schema (no `kind`, `branchScope`, or transactions).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **required** | Unique ellipsis identifier. |
| `sourceRange` | `object` | **required** | Span of omitted content. |
| `sourceRange.start` | `string` | required | Starting event ID or coordinate. |
| `sourceRange.end` | `string` | required | Ending event ID or coordinate. |
| `omittedContent` | `string` | **required** | Prose description of what was omitted. |
| `provenance` | `string` | **required** | Traceability reference (e.g. `"event_bridge T1→T2"`). |

## NarrativeNode Union (Integration)

Structural `z.union` — variants are distinguished by their required field sets, not a shared discriminator field (the event passthrough requires `event`/`title`, the ellipsis record requires `sourceRange`/`omittedContent`/`provenance`). A mismatch surfaces as a generic `Invalid input` union diagnostic at the node path.

```typescript
type NarrativeNode =
  | { id: string; event: string; title: string }  // NarrativeEvent structural passthrough
  | NarrativeEllipsis;                             // integration narrativeEllipsisSchema
```

## ScenePresentation Fields (Integration)

Validated by `integration.ts::scenePresentationSchema`; used by `discourseNodeSchema` and `coverageManifestSchema.discourseNodes`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **required** | Unique presentation identifier. |
| `sceneId` | `string` | **required** | The scene being presented. |
| `discoursePosition` | `number` | **required** | Position in the discourse sequence. |
| `plannedActs` | `array` | **required** | Disclosure action IDs planned for this scene. |
| `provenance` | `string` | **required** | Traceability reference. |

## DiscourseBridge Fields (Integration)

Validated by `integration.ts::discourseBridgeSchema`; used by `discourseNodeSchema` and `coverageManifestSchema.discourseNodes`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **required** | Unique bridge identifier. |
| `position` | `number` | **required** | Discourse position where the bridge occurs. |
| `plannedActs` | `array` | **required** | Planned disclosure action IDs that the bridge replaces. |
| `provenance` | `string` | **required** | Traceability reference. |

## DiscourseNode Union

Structural `z.union` — `ScenePresentation` requires `sceneId`/`discoursePosition`/`plannedActs`; `DiscourseBridge` requires `position`; there is no discriminator field.

```typescript
type DiscourseNode =
  | ScenePresentation   // Full scene presentation
  | DiscourseBridge;    // Omitted-text bridge
```

## CoverageManifest Fields (Integration)

Validated by `integration.ts::coverageManifestSchema` — a dual (narrative × discourse) coverage snapshot type. Schema-level only: no runtime producer exists; exercised only as constructed fixtures.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `narrativeNodes` | `array` | required | Union of `NarrativeEvent` (passthrough) and `NarrativeEllipsis` (integration stub). |
| `discourseNodes` | `array` | required | Union of `ScenePresentation` and `DiscourseBridge`. |

## SparseRunDeclaration Fields

Declared twice with identical members: `discourse.ts::sparseRunDeclarationSchema` (discriminated union on `type`) and `integration.ts::sparseRunDeclarationSchema` (plain union). Schema-level declaration types only — no authored YAML surface and no runtime consumer.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | `"isolated_excerpt"` or `"full_work_context"`. |
| `bridgeIds` | `array` | required (excerpt) | IDs of discourse bridges defining the excerpt boundaries. |
| `precedingBridgeCompleteness` | `boolean` | required (full_work) | Whether all preceding bridges' disclosures are complete. |

## Closed Enums / IDs

- `corpus narrativeNode.kind`: `"event"`, `"ellipsis"` (2 values, discriminated union)
- `integration narrativeNode` union variant: NarrativeEvent passthrough (`{ id, event, title }`) or NarrativeEllipsis (2 variants; a structural `z.union` — variants are distinguished by their required field sets, not a shared discriminator field)
- `discourseNode` union variant: `ScenePresentation` or `DiscourseBridge` (2 variants; a structural `z.union` — no discriminator field)
- `sparseRunDeclaration.type`: `"isolated_excerpt"`, `"full_work_context"` (2 values)
- `storyCoordinate.type`: `"storyTime"` (1 literal value)
- `storyCoordinate.kind`: `"unlocated"`, `"point"` (2 values)
- `storyCoordinate.clock`: `"story"`, `"calendar"`, `"chapter"` (3 values)

## Mutual Exclusions

- Corpus runtime `NarrativeNode` is a discriminated union on `kind`: the ellipsis branch is strict and rejects event/scene fields (`pov`, `cast`, `sceneBrief`, `styleGuidance`, `narrationTime`, `narrativeOrder`, …). The event branch is `.strict().passthrough()`: it validates its required overlap fields (`kind`, `id`, `event`, `title`, `narrativeOrder`, `storyTime`) and passes arbitrary extra keys through, so an object with `kind: 'event'` plus all required overlap fields and ellipsis-only fields validates.
- A corpus ellipsis holds exactly one `storyTime` (schema is a single value, not an array); multiple incompatible story times must be split into separate ellipses.
- `summary` is diagnostic-only: it can never create claims/providers, facts, causal edges, WorldState changes, or DiscourseState changes.
- `sparseRunDeclaration` is a discriminated union: either `isolated_excerpt` (with `bridgeIds`) or `full_work_context` (with `precedingBridgeCompleteness`), never both.
- Graph-level ellipses (`StoryGraph.ellipses`), integration coverage records, and sparse-run declarations have no enforced cross-record constraints — no consumer exists to resolve `requiredOutputHash` or `bridgeIds`.

## Valid Examples

```yaml
# Graph-level narrative ellipsis (schema-level; StoryGraph.ellipses)
ellipses:
  - outputId: ellipsis_T1_T2
    storyCoordinate:
      type: storyTime
      kind: point
      clock: story
      scalar: 1296000000
    requiredOutputHash: "a1b2c3d4e5f6"
```

```yaml
# Corpus wire ellipsis file (declared; not loaded by standard loading)
id: ellipsis_bridge_travel
storyTime:
  offset:
    amount: -3
    unit: day
preconditions:
  - entity: hero
    attribute: location
    value: village
postconditions:
  - entity: hero
    attribute: location
    value: city
provenance:
  sourceHash: "abc123"
  sourceRange:
    start: 100
    end: 250
```

```yaml
# Integration-level coverage manifest (constructed fixture shape)
narrativeNodes:
  - id: ellipsis_T1_T2
    sourceRange:
      start: T1
      end: T2
    omittedContent: "travel between locations"
    provenance: "event_bridge T1→T2"
discourseNodes:
  - id: bridge_E4_E6
    position: 42
    plannedActs:
      - reveal_xianglins_wife_return
      - claim_xianglins_wife_state
    provenance: "bridge_across_E5_details_not_required_for_chapter_1_context"
```

A bare bridge (without the manifest wrapper) is what `discourseBridgeSchema` itself validates; the manifest key is `discourseNodes`, not `discourseBridges`.

## Invalid Example

```yaml
# ERROR: storyCoordinate must match a scene-story-coordinate union member
# (a complete story-graph input — a partial object would instead fail on the
# first missing top-level field)
type: story
edges: []
outputs: []
reads: []
resolutions: []
hash: "a1b2c3d4e5f6"
ellipses:
  - outputId: bad_ellipsis
    storyCoordinate:
      type: discoursePosition   # must be 'storyTime'
      kind: point
      clock: story
      scalar: 5
    requiredOutputHash: "abc123"
```

**Expected error** (dot-path, no line/column): `sceneStoryCoordinateSchema` is a plain `z.union` of two strict object schemas, so the failure surfaces at the union path, not at the inner `type` key:

```
ConfigError (code CONFIG_INVALID)
  message: YAML schema validation failed at ellipses.0.storyCoordinate: Invalid input
  context.path: <file>:ellipses.0.storyCoordinate
```

The missing-`bridgeIds` case belongs to `sparseRunDeclaration` (`isolated_excerpt`), a separate schema — it cannot be triggered by graph ellipsis input.

## Normalized Target

- Corpus runtime `NarrativeEllipsis` — a non-renderable narrative gap shape with branch scope, a single runtime story timestamp, wire-shaped pre/postconditions, five transaction arrays, and atomic provenance; `summary` never enters the logical pipeline. Declared and mappable, but **not integrated with replay**: ellipsis node IDs participate in causal ordering, while no replay/graph entry point applies an ellipsis's effects.
- `StoryGraph.ellipses` — optional array of graph-level ellipsis records with story coordinates; schema-level only (no producer/consumer).
- `CoverageManifest` — dual (narrative × discourse) coverage snapshot type; integration-level records are declared structural contracts with no runtime producer.
- `SparseRunDeclaration` — schema-level declaration type for excerpt disclosure checkpoints; no authored surface or runtime consumer.

## Source-Map Diagnostic Format

The YAML compiler reports schema failures as a `ConfigError` with `code = "CONFIG_INVALID"` and a **dot-path** (the first failing Zod issue's `path.join('.')`) — not a JSON pointer, and without line/column numbers:

```
ConfigError (code CONFIG_INVALID)
  message: YAML schema validation failed at <dot-path>: <Zod message>   # <dot-path> is '<root>' when empty
  context.path: <file>:<dot-path>
```
