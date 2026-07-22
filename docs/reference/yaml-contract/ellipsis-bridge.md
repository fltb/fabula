# NarrativeEllipsis + DiscourseBridge YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/graph.ts` — `graphNarrativeEllipsisSchema`; `packages/core/src/schemas/integration.ts` — `narrativeEllipsisSchema`, `discourseBridgeSchema`, `scenePresentationSchema`, `narrativeNodeSchema`, `discourseNodeSchema`, `coverageManifestSchema`  

This contract covers two related constructs for **omitted content** and **disclosure gaps**:

- **NarrativeEllipsis** — a gap in the story timeline where events occurred but are not depicted
- **DiscourseBridge** — a gap in the discourse where text is omitted but its disclosure function is documented

Both are compiler-produced, derived from event data and discourse planning. Author-facing YAML indirectly creates ellipses when events are skipped or when discourse planning chooses to bridge over scenes.

## Fields

## NarrativeEllipsis Fields (Graph-Level)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `outputId` | `string` | **required** | — | The output ID of the ellipsis record in the graph. |
| `storyTime` | `object` | **required** | — | Story coordinate where the ellipsis occurs. |
| `storyTime.type` | `literal` | required | Must be `"storyTime"`. |
| `storyTime.value` | `string` | required | Story time anchor ID (e.g. `spring_ahmao_death`). |
| `requiredOutputHash` | `string` | **required** | — | Hash of the preceding output that this ellipsis depends on. |

## NarrativeEllipsis Fields (Integration-Level)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **required** | — | Unique ellipsis identifier. |
| `sourceRange` | `object` | **required** | — | The span of omitted content. |
| `sourceRange.start` | `string` | required | — | Starting event ID or coordinate. |
| `sourceRange.end` | `string` | required | — | Ending event ID or coordinate. |
| `omittedContent` | `string` | **required** | — | Prose description of what was omitted. |
| `provenance` | `string` | **required** | — | Traceability reference (e.g. `"event_bridge T1→T2"`). |

## DiscourseBridge Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **required** | — | Unique bridge identifier. |
| `position` | `number` | **required** | — | Discourse position where the bridge occurs. |
| `plannedActs` | `array` | **required** | — | Array of planned disclosure action IDs that the bridge replaces. |
| `provenance` | `string` | **required** | — | Traceability reference. |

## ScenePresentation Fields (Related)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **required** | — | Unique presentation identifier. |
| `sceneId` | `string` | **required** | — | The scene being presented. |
| `discoursePosition` | `number` | **required** | — | Position in the discourse sequence. |
| `plannedActs` | `array` | **required** | — | Disclosure actions planned for this scene. |
| `provenance` | `string` | **required** | — | Traceability reference. |

## CoverageManifest Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `narrativeNodes` | `array` | required | — | Union of `NarrativeEvent` and `NarrativeEllipsis`. |
| `discourseNodes` | `array` | required | — | Union of `ScenePresentation` and `DiscourseBridge`. |

## NarrativeNode Union

```typescript
type NarrativeNode =
  | { id: string; event: string; title: string }  // NarrativeEvent (passthrough)
  | NarrativeEllipsis;                             // NarrativeEllipsis
```

## DiscourseNode Union

```typescript
type DiscourseNode =
  | ScenePresentation   // Full scene presentation
  | DiscourseBridge;    // Omitted-text bridge
```

## SparseRunDeclaration Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `literal` | required | — | `"isolated_excerpt"` or `"full_work_context"`. |
| `bridgeIds` | `array` | required (excerpt) | — | IDs of discourse bridges defining the excerpt boundaries. |
| `precedingBridgeCompleteness` | `boolean` | required (full_work) | — | Whether all preceding bridges' disclosures are complete. |

## Closed Enums / IDs

- `narrativeNode` discriminator: `NarrativeEvent` (passthrough `{ id, event, title }`) or `NarrativeEllipsis` (2 variants)
- `discourseNode` discriminator: `ScenePresentation` or `DiscourseBridge` (2 variants)
- `sparseRunDeclaration.type`: `"isolated_excerpt"`, `"full_work_context"` (2 values)
- `storyTime.type`: must be `"storyTime"` (1 literal value)

## Mutual Exclusions

- A `NarrativeEllipsis` replaces one or more `NarrativeEvent` nodes in the coverage manifest — they are not co-present for the same story range.
- A `DiscourseBridge` replaces one or more `ScenePresentation` nodes in the discourse coverage — they are not co-present for the same discourse position.
- `sparseRunDeclaration` is a discriminated union: either `isolated_excerpt` (with `bridgeIds`) or `full_work_context` (with `precedingBridgeCompleteness`), never both.
- `requiredOutputHash` in a graph-level ellipsis must resolve to a real output in the same story graph.

## Valid Example

```yaml
# Graph-level narrative ellipsis
ellipses:
  - outputId: ellipsis_T1_T2
    storyTime:
      type: storyTime
      value: spring_ahmao_death
    requiredOutputHash: "a1b2c3d4e5f6"
```

```yaml
# Integration-level discourse bridge
discourseBridges:
  - id: bridge_E4_E6
    position: 42
    plannedActs:
      - reveal_xianglins_wife_return
      - claim_xianglins_wife_state
    provenance: "bridge_across_E5_details_not_required_for_chapter_1_context"
```

## Invalid Example

```yaml
# ERROR: isolated_excerpt without bridgeIds, invalid storyTime type
ellipses:
  - outputId: bad_ellipsis
    storyTime:
      type: discoursePosition   # must be 'storyTime'
      value: 5
    requiredOutputHash: "abc123"
```

**Expected error:**
```
ConfigError at <file>.yaml:5:12
  path: /ellipses/0/storyTime/type
  message: Invalid literal value, expected 'storyTime'
```

## Normalized Target

The compiler produces:

- `StoryGraph.ellipses` — array of graph-level narrative ellipsis references, each describing a gap in story-time with a required output hash for dependency tracking.
- `NarrativeEllipsis` records in the coverage manifest — each with a source range (start/end event IDs) and prose description of omitted content.
- `DiscourseBridge` records in the coverage manifest — each documenting a discourse position where text is bridged over, with planned acts that the bridge replaces.
- `CoverageManifest` — dual (narrative × discourse) coverage snapshot, used for sparse-run excerpt disclosure and branch merge reconciliation.
- Together, ellipses and bridges enable the sparse-run mode: readers can consume excerpted scenes without reading every event, because the discourse bridges document what disclosures were planned for the omitted sections.

## Source-Map Diagnostic Format

```
ConfigError at <file>.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
