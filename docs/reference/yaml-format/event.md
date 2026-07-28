# 事件 YAML 格式

**源类型：** `packages/core/src/types/event.ts` (NarrativeEvent, EventFile)  
**Schema：** `packages/core/src/schemas/event.ts` (eventFileSchema)

事件是 Novalistically 中叙事的基本原子单元。每个事件代表一个场景——一个连续的时间框架、单一地点、稳定角色群和统一的戏剧单元。位于 `chapters/chapter_NN/` 目录中的 YAML 事件文件既定义了叙事规范，也定义了驱动整个渲染管线的元数据。

## EventFile（YAML 输入）

`EventFile` 接口描述了磁盘上的 YAML 格式。它由 `EntityMapper` 加载，通过 `eventFileSchema`（Zod）验证，并映射为 `NarrativeEvent`——引擎使用的运行时类型。

### 核心字段

| 字段 | 类型 | 描述 |
|---|---|---|
| `event` | `string` | 事件标识符，例如 `"E0"`、`"E1"` |
| `narrativeOrder` | `number` | 在故事中的位置（从 1 开始） |
| `title` | `string` | 人类可读的标题 |
| `storyTime` | `string` | 引用时间锚点的故事时间戳（例如 `new_year_eve`、`day_5`） |
| `sceneType` | `enum` | `linear`、`flashback`、`flashforward`、`dream` 或 `parallel` |
| `pov` | `{ character, type }` | 视角角色 ID 和视角类型（`first_person`、`third_person_limited`、`omniscient`） |
| `sceneBrief` | `string` | 描述场景中发生事件的散文概要 |
| `preconditions` | `Fact[]` | 此事件发生前必须为真的事实 |
| `expectedPostconditions` | `Fact[]` | 事件发生后应为真的事实 |
| `styleGuidance` | `StyleGuidance`（可选） | 供 LLM 使用的语调、氛围、角色声音、节奏指令 |

### 玩家选择与游戏对话树

`choices?` 直接写在 decision event 上；无 `choices` 的 event 是终端。显式 choices 必须非空且
同 event 内 `id` 唯一。每个 choice 是 strict object：

```yaml
choices:
  - id: accept_hunt
    label: "Accept the hunt"
    description: "Enter the jungle with a knife and three hours' head start."
    targetEvent: E1a
    effects:
      - entity: hero
        attribute: chose_hunt
        value: true
```

`effects` 默认 `[]`，完全复用 `expectedPostconditions` 的 value / `narrativeHint` /
`operation: unset` 互斥校验。`targetEvent` 必须存在且其 `storyTime` 严格晚于 decision；
所有 choices 合成单 root、无 cycle、无 merge、全可达的 tree。`branchPoint`、`condition`、
snake_case key 以及外部 `branches.yaml` / `branches/branch_points.yaml` 都不是支持的 alias。
完整游戏树、derived `BranchPath`、synthetic transition 与交付格式见
[分支游戏对话](./branch.md)。

### 新增字段（P0c/P0g）

| 字段 | 类型 | 描述 |
|---|---|---|
| `tense` | `"past" \| "present"`（可选） | 本场景的时态覆盖 |
| `discourseMode` | `enum`（可选） | `action`、`dialogue`、`description`、`exposition`、`reflection`、`transition` |
| `arcPosition` | `enum`（可选） | `opening`、`rising`、`climax`、`falling`、`denouement` |
| `conflictType` | `string`（可选） | 冲突类型（例如 `person_vs_society`、`person_vs_self`） |
| `resolutionType` | `string`（可选） | 冲突解决方式（例如 `negative_resolution`） |
| `emotionalValence` | `string`（可选） | 场景的情感基调 |
| `targetAudience` | `string`（可选） | 影响散文风格的目标受众（例如 `adult_literary`） |
| `narrationTime` | `string`（可选） | 故事被讲述的时间（用于非线性时间线） |

### 阶段一严格合同

- 所有 production YAML 只经严格 Zod compiler 加载；未知键、语法错误、缺必需文件均以带文件/YAML 路径的 `ConfigError` 失败，绝不静默跳过。
- `Fact` 必须采用三种互斥形式之一：提供 `value`（set，默认）、`operation: unset`（删除属性），或 `narrativeHint`（仅 Pass 2）。所有 10 种运算符（`eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`contains`、`not_contains`、`exists`、`not_exists`）均受支持；`eq` 为默认值。各运算符详见下方前件运算符表。
- `linear` 与 `flashback` 事件必须写出 `storyTime` 和 `narrationTime`。其他 scene type 不是阶段一 author-facing capability。
- 项目键使用 camelCase；例如 `defaultModel`、`defaultLanguage`、`snapshotInterval`、`defaultSceneTextTarget`。旧 snake_case 不再兼容。


### 前件运算符

前件使用 `operator` 字段来指定事实值的比较方式：

| 运算符 | 描述 | 需要 `value` | 示例 |
|--------|------|-------------|------|
| `eq` | 等于（默认） | 是 | `operator: eq, value: "alive"` |
| `neq` | 不等于 | 是 | `operator: neq, value: "dead"` |
| `gt` | 大于 | 是（数值） | `operator: gt, value: 5` |
| `gte` | 大于或等于 | 是（数值） | `operator: gte, value: 0` |
| `lt` | 小于 | 是（数值） | `operator: lt, value: 100` |
| `lte` | 小于或等于 | 是（数值） | `operator: lte, value: 100` |
| `contains` | 字符串包含或数组包含 | 是 | `operator: contains, value: "keyword"` |
| `not_contains` | 字符串/数组不包含 | 是 | `operator: not_contains, value: "forbidden"` |
| `exists` | 属性存在 | **否**——必须省略 `value` | `operator: exists` |
| `not_exists` | 属性不存在 | **否**——必须省略 `value` | `operator: not_exists` |

#### 存在性感知规则

使用 `exists` 和 `not_exists` 时，前件检查的是属性的存在性而非其值：

- `operator: exists` 在实体具有该属性（不论值为何）时满足。
- `operator: not_exists` 在实体完全缺少该属性时满足。
- 使用 `neq` 比较一个缺失的属性会失败（不满足），因为缺失的属性不等于任何值。
- `exists` 和 `not_exists` 均要求省略 `value` 字段——提供 `value` 会导致 schema 验证错误。

### 事实后件形式

`expectedPostconditions` 中每个 `Fact` 条目必须采用以下三种互斥形式之一：

**形式 1——set（默认）：** 提供 `value` 字段，将规范化的值写入 `WorldState`。`operation: set` 可以显式指定，但为可选（省略时默认为 set）。

```yaml
expectedPostconditions:
  - entity: xianglins_wife
    attribute: spiritual_state
    value: broken
```

**形式 2——unset：** 设置 `operation: unset`，从实体中删除属性。`value` 字段必须 **不** 存在。如果属性已不存在则失败。

```yaml
expectedPostconditions:
  - entity: xianglins_wife
    attribute: temporary_flag
    operation: unset
```

**形式 3——narrativeHint：** 提供 `narrativeHint` 字段，省略 `value`。仅由 Pass 2 分析消费。**永不** 写入 `WorldState`。

```yaml
expectedPostconditions:
  - entity: xianglins_wife
    attribute: social_status
    narrativeHint: "捐门槛之后她以为自己赎了罪..."
```

三种形式**互斥**——`value` 和 `narrativeHint` 不能同时出现。`unset` 同时不得有 `value` 或 `narrativeHint`。

### Placeholder 值拒绝

以下占位符值会被 Zod schema 拒绝：`changed`、`resolved`、`updated`。这些值是历史遗留标记，不得在 production YAML 中使用。

```yaml
postconditions:
  - entityId: hero
    attribute: status
    value: changed  # 错误：占位符值被拒绝
```

### narrativeHint 字段

`narrativeHint` 为 Pass 2 分析提供语义属性。它包含人类可读的散文，供 LLM 驱动的 Pass 2 分析使用，以推导语义状态变化。

- 与 `value` **互斥**——不能同时设置两者。
- 常用值示例：`"subtle_hint"`、`"implicit_reveal"`、`"ambient_tone"`。
- `narrativeHint` **永不** 写入 `WorldState`；它仅影响 Pass 2 的叙事分析。

### 叙事元数据字段

- **`threadProgress`** — 追踪叙事线程进度的数组，每项包含 `{ thread, advancement, progressAfter, progressTotal }`。
- **`foreshadowing`** — 为埋设未来揭示内容而设的数组，每项包含 `{ id, hint, targetRevealChapter, thread? }`。
- **`relationshipEffects`** — 关系演变的数组，每项包含 `{ participants: [EntityId, EntityId], effect, direction, newState? }`。
- **`ruleEffects`** — 世界规则影响的数组，每项包含 `{ rule, effect: "reinforce" | "weaken" | "introduce_exception" | "nullify", evidence }`。
- **`introduces`** — 引入新实体的数组，每项包含 `{ type, id, initialState }`。
- **`cast`** — 对象，包含 `onScreen: string[]`（物理上在场的角色）和 `affected: string[]`（受影响的幕后角色）。

## 示例（来自 zhu-fu 测试夹具: E5_threshold_rejection.yaml）

```yaml
event: E5
title: "捐门槛与致命喝止——你放着罢"
narrativeOrder: 6
sceneType: flashback
storyTime: winter_solstice
tense: past
discourseMode: description
arcPosition: climax
emotionalValence: "terror_hopeful_collapse"
conflictType: "person_vs_society"
resolutionType: "negative_resolution"
pov:
  character: narrator
  type: first_person
sceneBrief: "祥林嫂反复讲述阿毛的故事..."

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
    confidence: 1.0
  - entity: xianglins_wife
    attribute: social_status
    narrativeHint: "捐门槛之后她以为自己赎了罪..."

threadProgress:
  - thread: T1
    advancement: "柳妈的地狱恐吓→祥林嫂捐门槛→冬至祭祀被喝止"
    progressAfter: 90
    progressTotal: 100

foreshadowing:
  - id: her_inevitable_expulsion
    hint: "四婶开始觉得她越来越不像样..."
    targetRevealChapter: 1

ruleEffects:
  - rule: widow_purity
    effect: reinforce
    evidence: "四婶冬至祭祀时的喝止——'你放着罢，祥林嫂！'"
```
