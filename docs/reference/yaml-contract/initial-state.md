# World Initial State YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/state-initial.ts` — `worldInitialStateSchema`
**Fixture files:** `fixtures/zhu-fu/definitions/state_initial.yaml`, `fixtures/arcane-aftermath/definitions/state_initial.yaml`

The `state_initial.yaml` file at `definitions/state_initial.yaml` describes the world at story-start: its historical context, temporal anchors, narrative threads, and established facts. It is a **required loader input**: `EntityMapper.loadProject()` reads it through `worldInitialStateSchema` (strict mode; a missing file is a `ConfigError`). The runtime derives the initial `WorldState` baseline from initial-introduction declaration states (see Normalized Target) and applies it before any authored event replays — there is no synthetic genesis event.

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `info` | `object` | **required** | — | Era and political context. Contains `currentEra` (string) and `politicalSituation` (string). |
| `info.currentEra` | `string` | required | — | The current historical era, e.g. `"1920s post-imperial China"`. |
| `info.politicalSituation` | `string` | required | — | Prose describing the political landscape. |
| `timeAnchors` | `array` | optional | `[]` | Named temporal reference points. Each anchor has `id` (string), locatable `at`, and optional `description` (string). |
| `timeAnchors[].id` | `string` | required | — | Unique anchor identifier referenced by event timestamps. Convention: `snake_case` narrative labels (`new_year_eve`, `spring_ahmao_death`). Avoid identifiers matching authored time syntax (`day_N`, `chapter_N`). |
| `timeAnchors[].at` | `AuthoredLocatableStoryTime` | required | — | A locatable authored timestamp: a legacy nonblank string, `{ at: string }`, `{ after: { ref, amount, unit } }`, `{ offset: { amount, unit } }`, or `{ chapter: number }`. Intentional indeterminacy is not valid for an anchor. |
| `timeAnchors[].description` | `string` | optional | — | Human-readable description of the temporal reference point. |
| `threads` | `array` | **required** | — | Initial narrative thread declarations. Each thread has `id`, `name`, `description`, `type`, `targetRevealChapter`, `initialProgress`. |
| `threads[].id` | `string` | required | — | Thread identifier (e.g. `T1`, `T2`). Referenced by events' `threadProgress`. |
| `threads[].name` | `string` | required | — | Human-readable thread name. |
| `threads[].description` | `string` | required | — | Prose description of the thread's narrative arc. |
| `threads[].type` | `string` | required | — | Thread type label (e.g. `primary`, `thematic`, `character_arc`, `primary_conflict`). |
| `threads[].targetRevealChapter` | `number` | required | — | The chapter number where this thread is expected to culminate. |
| `threads[].initialProgress` | `string` | required | — | 未经验证的起始进度元数据——schema 接受任意字符串（`z.string()`），`loadCanonicalProject()` 只把线程 `id` 复制进 `initialThreads`，重放从空的 goal/milestone 状态初始化基线，运行时从不读取该字段。 |
| `threads[].structuralFunction` | `enum` | optional | — | Propp structural function label (`structuralFunctionSchema` from `schemas/story-ir.ts`). |
| `worldFacts` | `array` | **required** | — | Established factual claims about the world. Each fact has `id` (string), `value` (unknown), `description` (string). |
| `worldFacts[].id` | `string` | required | — | Fact identifier. |
| `worldFacts[].value` | `unknown` | required | — | 事实内容——任意 YAML 值（string、number、object、array）。注意：`z.unknown()` 在 Zod 3 下接受缺失键（得到 `undefined`）；此时失败发生在 `InMemoryEntityRegistry.load()` 的 `canonicalizeFactValue(undefined)`（抛出 `ConfigError`），而不是带 `worldFacts.<index>.value` 路径的 schema 错误。 |
| `worldFacts[].description` | `string` | required | — | Short prose describing what this fact represents. |

## Closed Enums / IDs

- `timeAnchors[].id`: Schema 要求非空字符串（`z.string().min(1)`）；此外 `resolveTemporalContext()`（`entity/timestamp.ts`）在运行时拒绝匹配裸时长语法（`OFFSET_PATTERN`，如 `3 days`、`-90 minute`）的锚点 ID，并拒绝与事件 ID 冲突的锚点 ID。约定：`snake_case` 叙事标签（`new_year_eve`、`spring_ahmao_death`）。
- `threads[].id`: Schema 仅要求字符串（`z.string()`）——空字符串同样被接受，重放会创建对应的空键线程；约定 `T1`、`T2`、`T3` 等。
- `threads[].type`: Open-ended string. Convention values: `primary`, `thematic`, `character_arc`, `primary_conflict`, `mystery`, `subplot`.
- `threads[].structuralFunction`: `absentation`, `interdiction`, `violation`, `departure`, `first_function_of_donor`, `hero_reaction`, `acquisition`, `spatial_translocation`, `villainy`, `mediation`, `beginning_counteraction`, `first_villainy`, `hero_departure`, `donor_test`, `hero_reaction_donor`, `receipt_of_agent`, `guidance`, `arrival`, `unrecognized_arrival`, `unfounded_claims`, `difficult_task`, `solution`, `recognition`, `exposure`, `punishment`, `wedding` (26 values, Propp morphology).

## Mutual Exclusions

- `worldFacts[].id`：schema 没有唯一性精化。重复 ID 会在 `InMemoryEntityRegistry.load()` 中覆盖同一个 concept 键；`compileStoryRuntimeGraph()`（`state/graph-adapter.ts`）对操作与值相同的同键事实去重（编译成功），只有**冲突的重复写入**（同键、不同操作或值）才报错。
- `threads[].id` 必须在数组内唯一——由 `compileStoryRuntimeGraph` 在构建根效果前拒绝重复 ID。
- `timeAnchors[].id` 必须在数组内唯一——由 `resolveTemporalContext()` 拒绝重复锚点 ID。

## Anchor timestamps

Anchors accept the locatable subset of the event timestamp language. Compact strings remain supported; structured forms make the clock and reference explicit. A `day_<number>` label is not required, but its existing numeric story-clock meaning is preserved. Anchor and event IDs are references resolved by the temporal context, never lexical sort keys.

```yaml
timeAnchors:
  - id: story_origin
    at:
      offset:
        amount: 0
        unit: day
  - id: recruitment
    at:
      after:
        ref: story_origin
        amount: 120
        unit: day
  - id: chapter_four
    at:
      chapter: 4
```

`at` and `after.ref` must be nonblank after trimming. `after.amount` is finite and nonnegative; `offset.amount` is finite and may be signed; `chapter` is a finite nonnegative integer; and `unit` is one of `minute`, `hour`, `day`, `week`, or `month`. Objects are strict and mutually exclusive: unknown or mixed keys, arrays, nested `at` objects, and `{ type: indeterminate }` fail validation. Quote ISO values, numeric-looking labels, and other YAML-coercible tokens.

## Valid Example

```yaml
# From fixtures/zhu-fu/definitions/state_initial.yaml (compact anchors retained)
info:
  currentEra: "1920年代民国初期，辛亥革命后的浙江农村"
  politicalSituation: "辛亥革命推翻帝制，但农村封建秩序基本未变。鲁镇由地主乡绅实际统治，宗族制度、礼教规范仍然是社会运行的底层逻辑。新文化运动正在城市兴起，但乡村几乎未受影响。"

timeAnchors:
  - id: new_year_eve
    at: day_0
    description: "除夕 — 叙述者'我'在鲁镇过年，遇见祥林嫂，当晚她死去，次日清晨祝福仪式开始。"
  - id: winter_five_years_ago
    at: day_-1825
    description: "初冬 — 祥林嫂第一次到鲁四老爷家做帮工，由卫老婆子介绍。约五年前。"

threads:
  - id: T1
    name: "祥林嫂的生存轨迹"
    type: primary
    description: "祥林嫂从逃婚寡妇→勤快帮工→被卖改嫁→丧夫失子→再回鲁镇→精神崩溃→沦为乞丐→冻死街头的完整生命轨迹。"
    targetRevealChapter: 1
    initialProgress: "0.00"
    structuralFunction: villainy

worldFacts:
  - id: zhu_fu_ritual
    value: "祝福是鲁镇年终的大典，致敬尽礼，迎接福神，拜求来年一年中的好运。杀鸡、宰鹅、买猪肉，用心细细的洗，女人的臂膊都在水里浸得通红。"
    description: "鲁镇最重要的年终仪式，由男人主持，女人准备。"
```

Structured anchors are equivalent input; `fixtures/arcane-aftermath/definitions/state_initial.yaml` demonstrates the `{ offset: ... }` form (e.g. `seraphine_recruitment.at` is `offset: { amount: -120, unit: day }`, resolving to the same `day_-120` story-clock scalar as the compact string).

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

**Expected error:** the strict loader reports the first issue with a dot-path into the offending node:

```
ConfigError (CONFIG_INVALID)
  message: YAML schema validation failed at threads.0.name: Required
  path:    definitions/state_initial.yaml:threads.0.name
```

## Normalized Target

The compiler does **not** project `state_initial.yaml` fields 1:1 onto `WorldState`. The normalization path is:

- **`info`** — validated and carried on `ProjectData.worldInitialState.info`. There is no `WorldState.meta`; the era/political prose is not projected into runtime state.
- **`timeAnchors`** — each `at` is parsed by `parseStoryTimestamp()` (`entity/timestamp.ts`) into a `LocatableStoryTimestamp` (absolute/relative/chapter/offset). An indeterminate result is rejected (anchors must be locatable). The result is `ProjectData.timeAnchors: TimeAnchor[]`, consumed by `resolveTemporalContext()` to build story-clock coordinates.
- **`threads`** — carried on `ProjectData.worldInitialState.threads`. `loadCanonicalProject()` (`entity/project-runtime.ts`) extracts the thread IDs into `initialThreads` as `{ id }` entries; replay and boundary compilation (`state/replay.ts`, `state/story-boundaries.ts`) initialize each `WorldState.threads[id]` baseline entry with `status: "planned"`, `currentRunId: "init-<threadId>"`, empty `phase`/`bindings`/`goalStates`/`milestoneStates`, and empty `semanticStateHash`.
- **`worldFacts`** — normalized three ways (no synthetic genesis event):
  1. `buildDeclarationCatalog()` (`entity/project-runtime.ts`) registers each fact as a `concept` declaration with `definitionFile: 'definitions/state_initial.yaml'` and `introduction: { type: 'initial' }`.
  2. `InMemoryEntityRegistry.load()` registers each fact as a `concept` entity with state `{ value, description }` (values canonicalized via `canonicalizeFactValue`).
  3. `buildInitialFacts()` folds initial-introduction declaration states into `initialFacts` — `lifecycle: 'active'` unless the authored state declares one (author wins) — with validity `{ temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } }`. Equal duplicate keys dedupe; conflicting duplicates throw `ConfigError` (phase `introductions`). `applyInitialFacts()` (`state/event-application.ts`) writes them into `WorldState.entities[entityId][attribute]` and appends them to `WorldState.facts` as the baseline before any authored event replays.

Authored chapter events replay on top of this baseline in topological/causal order. Initial facts are baseline inputs applied directly to the initial root (`compileStoryRuntimeGraph` in `state/graph-adapter.ts`), never replayed as authored events; event-introduced entities instead enter through injected `system:introduction:<targetId>:<entityId>` transition events placed immediately before their host events.

## Source-Map Diagnostic Format

Schema failures surface as `ConfigError` (code `CONFIG_INVALID`) from `readYamlFile`:

```
ConfigError (CONFIG_INVALID)
  message: YAML schema validation failed at <dot-path>: <Zod message>
  path:    definitions/state_initial.yaml:<dot-path>
```

The `<dot-path>` is the Zod issue path joined with `.` (e.g. `threads.0.name`, `timeAnchors.0.at`) — not a JSON pointer and not a line/column.
