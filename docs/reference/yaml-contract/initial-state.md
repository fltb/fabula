# World Initial State YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/state-initial.ts` — `worldInitialStateSchema`  
**Fixture files:** `fixtures/zhu-fu/definitions/state_initial.yaml`, `fixtures/arcane-aftermath/definitions/state_initial.yaml`

The `state_initial.yaml` file at `definitions/state_initial.yaml` describes the world at story-start: its historical context, temporal anchors, narrative threads, and established facts. This is the **root context** from which the compiler derives the initial `WorldState`.

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `info` | `object` | **required** | — | Era and political context. Contains `currentEra` (string) and `politicalSituation` (string). |
| `info.currentEra` | `string` | required | — | The current historical era, e.g. `"1920s post-imperial China"`. |
| `info.politicalSituation` | `string` | required | — | Prose describing the political landscape. |
| `timeAnchors` | `array` | optional | `[]` | Named temporal reference points. Each anchor has `id` (string), `day` (number), and optional `description` (string). |
| `timeAnchors[].id` | `string` | required | — | Unique anchor identifier referenced by `storyTime` fields in events. |
| `timeAnchors[].day` | `number` | required | — | Day offset from story-zero (day `0`). Negative for past, positive for future. |
| `timeAnchors[].description` | `string` | optional | — | Human-readable description of what happens on this day. |
| `threads` | `array` | **required** | — | Initial narrative thread declarations. Each thread has `id`, `name`, `description`, `type`, `targetRevealChapter`, `initialProgress`. |
| `threads[].id` | `string` | required | — | Thread identifier (e.g. `T1`, `T2`). Referenced by events' `threadProgress`. |
| `threads[].name` | `string` | required | — | Human-readable thread name. |
| `threads[].description` | `string` | required | — | Prose description of the thread's narrative arc. |
| `threads[].type` | `string` | required | — | Thread type label (e.g. `primary`, `thematic`, `character_arc`, `primary_conflict`). |
| `threads[].targetRevealChapter` | `number` | required | — | The chapter number where this thread is expected to culminate. |
| `threads[].initialProgress` | `string` | required | — | Starting progress value as a decimal string (e.g. `"0.00"`, `"0.15"`). |
| `worldFacts` | `array` | **required** | — | Established factual claims about the world. Each fact has `id` (string), `value` (unknown), `description` (string). |
| `worldFacts[].id` | `string` | required | — | Fact identifier. |
| `worldFacts[].value` | `unknown` | required | — | The factual content — any YAML value (string, number, object, array). |
| `worldFacts[].description` | `string` | required | — | Short prose describing what this fact represents. |

## Closed Enums / IDs

- `timeAnchors[].id`: Any non-empty string. Convention: `snake_case` narrative labels (`new_year_eve`, `spring_ahmao_death`).
- `threads[].id`: Any non-empty string. Convention: `T1`, `T2`, `T3`, etc.
- `threads[].type`: Open-ended string. Convention values: `primary`, `thematic`, `character_arc`, `primary_conflict`, `mystery`, `subplot`.

## Mutual Exclusions

- `worldFacts[].id` must be unique within the array — no duplicate fact IDs.
- `threads[].id` must be unique within the array.
- `timeAnchors[].id` must be unique within the array.

## Valid Example

```yaml
# From fixtures/zhu-fu/definitions/state_initial.yaml
info:
  currentEra: "1920s post-imperial China"
  politicalSituation: "Rural Zhejiang under residual feudal order"

timeAnchors:
  - id: new_year_eve
    day: 0
    description: "New Year's Eve — narrator meets Xianglin's Wife"
  - id: winter_five_years_ago
    day: -1825
    description: "Early winter — Xianglin's Wife first arrives at Lu's house"

threads:
  - id: T1
    name: "Xianglin's Wife's Survival Arc"
    type: primary
    description: "From escaped widow to beggar freezing in the street"
    targetRevealChapter: 1
    initialProgress: "0.00"

worldFacts:
  - id: zhu_fu_ritual
    value: "Annual blessing ritual — the grand ceremony of Lu-town"
    description: "The most important year-end ceremony"
```

## Invalid Example

```yaml
# ERROR: missing required 'name' field in thread, unknown key 'foo'
info:
  currentEra: "Present"
  politicalSituation: "Calm"
threads:
  - id: T1
    description: "Missing name field"
    type: primary
    targetRevealChapter: 1
    initialProgress: "0.00"
    foo: "unknown key"
worldFacts: []
```

**Expected error:**
```
ConfigError at definitions/state_initial.yaml:5:3
  path: /threads/0/name
  message: Required

ConfigError at definitions/state_initial.yaml:9:5
  path: /threads/0/foo
  message: Unrecognized key(s) in object: 'foo'
```

## Normalized Target

The compiler normalizes `state_initial.yaml` into the `WorldState` initializer:

- `info` → `WorldState.meta.era`, `WorldState.meta.politicalSituation`
- `timeAnchors` → `WorldState.timeAnchorIndex` (mapped by `id`)
- `threads` → `WorldState.threads` initial entry with `status: "planned"`, `currentRunId: "run_0"`
- `worldFacts` → `WorldState.worldFacts` with `assessment.type: "settled"`, `grade: "know"`

## Source-Map Diagnostic Format

```
ConfigError at definitions/state_initial.yaml:<line>:<col>
  path: <JSON pointer to offending field>
  message: <Zod validation error message>
```
