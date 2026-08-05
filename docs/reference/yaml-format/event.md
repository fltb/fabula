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
| `narrativeOrder` | `number` | 叙事/装配排序键；`eventFileSchema` 接受任意数字，mapper 原样拷贝，不要求从 1 开始（规范 fixture 使用 `0`） |
| `title` | `string` | 人类可读的标题 |
| `storyTime` | `AuthoredStoryTime`（可选） | 场景的故事时间；可省略，或显式声明时间不可确定 |
| `causalPredecessors` | `string[]`（可选） | author-origin 因果依赖：非空、去重、去除空白后非空；用于无法比较 story time 的场景的坐标顺序校验（`compileNarrativeGraphs()` 按所选 branch 验证可达性） |
| `sceneType` | `enum`（可选） | `linear`、`flashback`、`flashforward`、`dream` 或 `parallel`；省略时 mapper 默认 `linear` |
| `pov` | `{ character, type }` | 视角角色 ID 和视角类型（`first_person`、`third_person_limited`、`omniscient`） |
| `sceneBrief` | `string` | 描述场景中发生事件的散文概要 |
| `beats` | `[string, ...string[]]` | 有序、非空的场景节拍（动作/回合序列）；schema 要求至少一个非空字符串，事件文件必须提供 |
| `preconditions` | wire `Fact[]` | 此事件发生前必须为真的事实（wire 形式，见下方「Wire Fact 与 runtime Fact」） |
| `expectedPostconditions` | wire `Fact[]` | 事件发生后应为真的事实（wire 形式，见下方「Wire Fact 与 runtime Fact」） |
| `styleGuidance` | `StyleGuidance`（可选） | 供 LLM 使用的语调、氛围、角色声音、节奏指令 |

### Wire Fact 与 runtime Fact

`preconditions`、`expectedPostconditions` 与 choice `effects` 在 YAML 里是 **wire Fact**：
字段为 `entity`、`attribute`、`value`、`operator?`、`narrativeHint?`、`confidence?`
（后件另有 `operation?`）。它与运行时 `Fact`（`types/entity.ts`）不是同一表示：runtime Fact 携带生成的 `id`（`factIdFrom(entity, attribute)`，即
`"<entity>.<attribute>"`）、`entityId`、默认 `confidence`（后件取显式值或 `1.0`，前件
恒为 `1.0`）以及 `validity: { temporal: { start: 已解析的 storyTime, end: null },
branches }`。`EntityMapper.mapToNarrativeEvent()` 在加载时完成归一化：wire `entity`
映射为 `entityId`，初始 `branches` 为 `{ type: 'all' }`；game-dialogue 项目随后由
`loadAllEvents()` 按每个事件的 branch scope 覆盖 `validity.branches`。作者永远写 wire
形式——runtime 的 `id`/`entityId`/`validity` 字段不是 YAML 输入。

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
`operation: unset` 互斥校验。`targetEvent` 必须存在且不能指向自身；仅当目标在同一条 story clock 上被证明早于
decision 时才拒绝——坐标相等、未定位（unlocated）和跨 clock 的转移都允许。
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
| `narrationTime` | `AuthoredStoryTime`（可选） | 故事被讲述的时间；与 `storyTime` 使用同一时间语言和引用命名空间，不引入独立叙述时钟 |

### 时间戳写法

`storyTime` 与 `narrationTime` 都接受相同的 `AuthoredStoryTime` 联合。现有紧凑字符串完全兼容；结构化写法建议用于新 YAML。省略 `storyTime` 表示未定位的场景；也可以显式写出有意不可确定的时间。场景不需要规范的 `day_<number>` 标签。

```yaml
# Existing compact syntax remains valid.
storyTime: "arrival + 90 minutes"

# Delegate one nonblank string to the compact grammar.
narrationTime:
  at: "2024-12-01T09:00:00Z"

# Reference an event ID or named time anchor.
storyTime:
  after:
    ref: arrival
    amount: 90
    unit: minute

# Signed story-clock offset.
storyTime:
  offset:
    amount: -3
    unit: month

# Chapter clock.
storyTime:
  chapter: 4

# Deliberately unlocatable scene.
storyTime:
  type: indeterminate
  reason: "Chronology is deliberately unknowable"
```

结构化对象必须只采用一种形式：`at`、`after`、`offset`、`chapter` 或 `type: indeterminate`。`at` 与 `after.ref` 去除首尾空白后必须非空；`after.amount` 为有限非负数，`offset.amount` 为有限有符号数，`chapter` 为有限非负整数，`unit` 仅为 `minute`、`hour`、`day`、`week` 或 `month`。`at` 只能是字符串，不能嵌套时间对象；未知键、混合形式、数组和空白 `reason` 均无效。建议用引号包裹（quote）ISO 时间、数值形式标签（如 `day_3`、`123`）以及其他可能被 YAML 强制转换为 number/boolean 的值：schema 中 `at` 与 `after.ref` 必须是字符串，未加引号的数值会先被 YAML 解析为 number，并在 schema 验证时被拒绝。

`narrationTime` 复用与 `storyTime` 相同的 authored 时间语法和 event/anchor 引用命名空间。`resolveTemporalContext()` 会把每个事件的 `narrationTime` 解析进 `narrationCoordinatesByEventId`（与 story 的 `coordinatesByEventId` 并列），供调用方取用；目前该 map 没有 production 消费者。`TimelineValidator` 并不使用 `narrationCoordinatesByEventId`：它只检查 `event.narrationTime` 是否存在于非线性场景（`sceneType !== 'linear'` 且缺少 `narrationTime` 时给出 "no narration_time is set" 警告，`add_field: narration_time`），并用 `story.coordinatesByEventId` 做 story 坐标回跳校验。`narrationTime` 不改变 story 坐标、因果重放或 `narrativeOrder` 排序。

### 阶段一严格合同

- 所有 production YAML 只经严格 Zod compiler 加载；语法错误、缺必需文件以及**顶层**未知键均以带文件/YAML 路径的 `ConfigError` 失败，绝不静默跳过。嵌套例外：`cast`、`focalization` 及其 `characterSequence` 条目的对象 schema 未加 `.strict()`，这些对象内的未知键会被 Zod 静默剥离（stripped）而非报错。
- `expectedPostconditions` 与 choice `effects` 中的每个 Fact 必须采用三种互斥形式之一：提供 `value`（set，默认）、`operation: unset`（删除属性），或 `narrativeHint`（仅 Pass 2）；`operation` 仅接受 `set`/`unset`，后件不接受 `operator`。`preconditions` 是另一套合同：支持全部 10 种 `operator`（`eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`contains`、`not_contains`、`exists`、`not_exists`），省略时默认 `eq`；比较型运算符要求提供 `value`，而合法的 `operator: exists` / `operator: not_exists` 前件故意省略 `value`（此时也可省略 `narrativeHint`）。各运算符详见下方前件运算符表。
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

**形式 1——set（默认）：** 提供 `value` 字段，将规范化的值写入 `WorldState`。`operation: set` 可以显式指定，但为可选（省略时默认为 set）。重放写入还须通过项目 `definitions/entity-types.yaml` 目录的校验——未知声明/未知属性、value schema、writePolicy（immutable/write_once/mutable/lifecycle_managed）、lifecycle 转换与 `unsetAllowed` 均由 `validateCatalogWrite()`（`state/event-application.ts`）强制，不存在跨项目的默认属性集合。

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

**形式 3——narrativeHint：** 提供 `narrativeHint` 字段，省略 `value`。由 Pass 2 分析消费；它不会写入 `WorldState.entities`，但 `applyPostconditions()` 会把 hint-only Fact 原样追加到 `state.facts`（`WorldState.facts` 包含该数组），`ContextAssembler._buildWorldFacts()` 之后可将其投影进后续上下文。

```yaml
expectedPostconditions:
  - entity: xianglins_wife
    attribute: social_status
    narrativeHint: "捐门槛之后她以为自己赎了罪..."
```

三种形式**互斥**——`value` 和 `narrativeHint` 不能同时出现。`unset` 同时不得有 `value` 或 `narrativeHint`。

### Placeholder 值拒绝

以下占位符值会被 Zod schema 拒绝（大小写不敏感）：`changed`、`resolved`、`updated`、`affected`、`modified`、`altered`。这些值是历史遗留标记，不得在 production YAML 中使用。

```yaml
expectedPostconditions:
  - entity: hero
    attribute: status
    value: changed  # 错误：占位符值被拒绝
```

### narrativeHint 字段

`narrativeHint` 为 Pass 2 分析提供语义属性。它包含人类可读的散文，供 LLM 驱动的 Pass 2 分析使用，以推导语义状态变化。

- 与 `value` **互斥**——不能同时设置两者。
- 常用值示例：`"subtle_hint"`、`"implicit_reveal"`、`"ambient_tone"`。
- `narrativeHint` 不写入 `WorldState.entities`（不改变任何实体属性）；它被保留在 `WorldState.facts` 中，除 Pass 2 叙事分析外，`_buildWorldFacts()` 还可将其纳入后续上下文。

### 叙事元数据字段

- **`threadProgress`** — 追踪叙事线程进度的数组，每项包含 `{ thread, advancement, progressAfter, progressTotal }`。
- **`knowledgeTransactions`** — canonical knowledge effects: `claim_write` updates an actor’s assessment of a declared proposition, `information_act` records proposition disclosure, and `common_ground` establishes a shared proposition. See [knowledge YAML contract](../yaml-contract/knowledge.md).
- **`foreshadowing`** — 为埋设未来揭示内容而设的数组，每项包含 `{ id, hint, targetRevealChapter, thread? }`。
- **`relationshipEffects`** — canonical relationship effects: either a `{ type: relationship_transaction, effectId, relationshipId, membershipAfter, ... }` transaction or an `{ type: identity_transition, oldEpochClosures, newTransactions, ... }` group. See [relationship YAML contract](../yaml-contract/relationship.md).
- **`ruleEffects`** — canonical `{ type: rule_transaction, ruleId, operation, evidence, ... }` transactions. See [rule YAML contract](../yaml-contract/rule.md); the retired `{ rule, effect, evidence }` form is not accepted.
- **`introduces`** — 独立于 `expectedPostconditions` 的 EventFile 字段：引入新实体的数组，每项包含 `{ type, id, initialState }`；`type` 仅限 `character`、`location`、`item`、`concept`（不包含 `faction` 与 `rule`）。规范内核 `loadCanonicalProject()`（`entity/project-runtime.ts`）的 `collectIntroductions()` 收集全部 introduces：同一实体只能由恰好一个事件引入（重复引入 → `ConfigError`）；若该实体已有定义文件且仍声明非空 `initialState`，同样报错（初始状态必须移到引入边界）。definition-less 的引入实体由内核按引入数据注册（kind/typeRef/`initialState`），并为每个引入合成 `system:introduction:<hostEvent>:<entityId>` transition——置于宿主事件之前并加入其 `causalPredecessors`，重放时激活实体（`lifecycle: active` + `initialState` 各键）。`compileProject()` 的投影只暴露分离的规范化数据与只读 `EntityLookup`，不暴露 registry；editorial `renderNovel()` 同样经 `executeEditorialRender()` → `loadCanonicalProject()` 走这套引入激活，而不是把该数组原样透传。
- **`cast`** — 对象，包含 `onScreen: string[]`（物理上在场的角色）和 `affected: string[]`（受影响的幕后角色）。

### 进阶字段（S1/S4/S6 叙事契约）

以下字段全部可选。`greyLines`、`narrativeChecklist`、`sourceContext`、`duration`、`frequency`、
`anachrony`、`voice` 与下方 8 个叙事技巧字段的 schema 均为 strict object；`focalization`（与
`cast` 一样）在 `eventFileSchema` 内内联定义、未加 `.strict()`，其内部未知键会被静默剥离。
schema 位于 `packages/core/src/schemas/{narrative-checklist,source-context,duration,frequency,discourse,narrative-techniques,grey-line}.ts`。

| 字段 | 类型 | 描述 |
|---|---|---|
| `greyLines` | `GreyLine[]`（可选） | 灰色主题（motif）多点追踪条目；每项 `{ id, imagery, nodes }`，`nodes` 至少 1 项，每项 `{ eventId, semanticAccumulation, narrativeOrder }`。由 `GreyLineValidator` 消费 |
| `narrativeChecklist` | `NarrativeChecklist`（可选） | 散文必须覆盖的叙事维度清单（S1）：`{ items: [{ dimension, description, required }] }` |
| `sourceContext` | `SourceContext`（可选） | 源文本风格锚点（S4）：`{ entries: [{ excerpt, classification: "STYLE" \| "FACT" \| "MIXED", styleNote? }] }`，`entries` 至少 1 项 |
| `duration` | `DurationProfile`（可选） | Genette 时距（S6a）：`{ type: "scene" \| "summary" \| "ellipsis" \| "pause" \| "stretch", storyDuration?, narrativeLength?, ellipsisClarity?, compressionRatio? }` |
| `frequency` | `FrequencyProfile`（可选） | Genette 频率（S6b）：`{ type: "singulative" \| "repeating" \| "iterative", sourceEventCount?, occurrenceCount?, iterationScope?, otherOccurrences? }` |
| `anachrony` | `Anachrony`（可选） | Genette 时间倒错（S6e）：`{ type: "analepsis" \| "prolepsis", scope: "internal" \| "external" \| "mixed", function: "completing" \| "repeating", distance, amplitude?, anchorEventId? }` |
| `voice` | `VoiceProfile`（可选） | Genette 叙述声音（S6d）：`{ level: "extradiegetic" \| "intradiegetic" \| "metadiegetic" \| "hypodiegetic", relation: "heterodiegetic" \| "homodiegetic", nestingDepth?, embeddedStory? }` |
| `narratorProfileRef` | `string`（可选） | 引用项目 discourse 配置中定义的 NarratorProfile（S6c） |
| `focalization` | `object`（可选） | Genette 聚焦（S6c）：`{ type: "zero" \| "internal" \| "external", variation?: "fixed" \| "variable" \| "multiple", characterSequence?: [{ character, scope }] }` |

图解析的叙事技巧契约（graph-resolved narrative technique contracts，全部可选且 strict）：

| 字段 | 类型 | 描述 |
|---|---|---|
| `causalDiscontinuity` | `object`（可选） | strict；`{ predecessor: string, dependent: string, instruction: string, requiredEvidence: string }`（均非空） |
| `surfaceMode` | `object`（可选） | strict；`{ instruction: string, requiredEvidence: string }`（均非空） |
| `causalMultiplicity` | `object`（可选） | strict；`{ minimumOutgoingEdges: number（整数 ≥ 2）, instruction: string, requiredEvidence: string }` |
| `irresolvableIndeterminacy` | `object`（可选） | strict；`{ assertionIds: string[]（≥ 1 项、去重、均非空）, instruction: string, requiredEvidence: string }` |
| `absentApparatus` | `object`（可选） | strict；`{ readId: string, instruction: string, requiredEvidence: string }`（均非空） |
| `voiceDissonance` | `object`（可选） | strict；`{ assertionId: string, storyOutputId: string, instruction: string, requiredEvidence: string }`（均非空） |
| `multiplicity` | `object`（可选） | strict；`{ assertionIds: string[]（≥ 2 项、去重、均非空）, instruction: string, requiredEvidence: string }` |
| `metanarrativeLevel` | `object`（可选） | strict；`{ instruction: string, requiredEvidence: string }`（均非空） |
| `authorNotes` | `string[]`（可选） | 自由形式作者注记，原样透传给 Pass 1 prompt（纯 pass-through） |

## 示例（来自 zhu-fu 测试夹具: E5_threshold_rejection.yaml，节略）

下例为节略版本：`beats` 仅摘取数条（完整文件含 12 条），`narrationTime`、`threadProgress`、`styleGuidance`、S1/S4/S6 字段等从略；结构字段（`event`/`title`/`narrativeOrder`/`pov`/`sceneBrief`/`beats`/`preconditions`/`expectedPostconditions`）均保持与夹具一致。

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
beats:
  - "祥林嫂反复讲述阿毛的故事，但鲁镇人从掉泪到厌烦到嘲弄——他们开始故意逗她说'祥林嫂，你们的阿毛如果还在，不是也就有这么大了么？"
  - "柳妈来做帮工，一日问她额角上的伤疤来历，随后告诉她：到了阴司，两个死鬼男人会争她，阎罗王只好把她锯成两半分给他们。"
  - "但冬至祭祀时，当她坦然伸手去拿酒杯和筷子时，四婶慌忙大叫：'你放着罢，祥林嫂！'她像被炮烙似的缩了手，脸色同时变成灰黑——连捐了门槛也洗不清她的'污秽'。"

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
    targetRevealChapter: 3

ruleEffects:
  - type: rule_transaction
    ruleId: widow_purity
    operation: enable
    evidence: "四婶冬至祭祀时的喝止——'你放着罢，祥林嫂！'"
    epochId: widow_purity:epoch-1
    specificationId: widow_purity:specification-1
```
