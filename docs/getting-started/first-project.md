# 第一个项目

> ~350 字 — 从头开始创建你的第一个 Novalistically 叙事项目。

> 本文为当前参考文档，与 [当前系统状态](../current-state.md) 保持同步。

## 1. 创建项目目录

```bash
mkdir -p my-first-novel/definitions/characters \
  my-first-novel/definitions/locations \
  my-first-novel/chapters/chapter_01
cd my-first-novel
```

> 提示：也可以直接用 `npx nova project init my-first-novel` 生成一个等效的、可直接加载的最小拓扑（含 `entity-types.yaml`、`state_initial.yaml` 与带 `beats` 的 `E1.yaml`），再按下面的说明扩展。

## 2. 创建 nova.yaml

根配置文件：

```yaml
project: my-first-novel
title: "My First Novel"
author: "You"
defaultModel: mock
defaultLanguage: en
genre: "literary"
synopsis: "A short story about a traveler arriving in a strange town."
tense: past
snapshotInterval: 3
```

注意：键名均为 camelCase（`defaultModel`、`defaultLanguage`、`snapshotInterval`），由 `projectConfigSchema` 严格校验。

不要添加 `schemaVersion` 或 `outputDir` 键——它们不是合法的项目配置键，`projectConfigSchema` 是 strict 模式，出现即被拒绝。

## 3. 创建实体类型目录

创建 `definitions/entity-types.yaml`——这是 loader **必需**的文件：它声明每个实体类型允许的属性（`attributeId`、`valueType`、`requiredAt`、`writePolicy`、`unsetAllowed`），ontology 预检会拒绝写未声明属性的前/后置条件与初始事实。每个初始激活的实体都会自动获得 `lifecycle: active` 初始事实，因此每个类型都必须声明 `lifecycle` 属性：

```yaml
types:
  character:
    typeId: character
    kind: character
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates: [active, inactive, retired]
        unsetAllowed: false
        semanticRole: lifecycle
      location:
        attributeId: location
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: location
      status:
        attributeId: status
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
      emotionalState:
        attributeId: emotionalState
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
        semanticRole: emotional
      traits:
        attributeId: traits
        valueType: string_list
        requiredAt: never
        writePolicy: immutable
        unsetAllowed: true
      appearance:
        attributeId: appearance
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
    lifecyclePolicy:
      allowedTransitions:
        - [active, inactive]
        - [active, retired]
        - [inactive, active]
        - [inactive, retired]
    referenceCapabilities:
      defaultEligibility: live
    typedInvariants: []
  location:
    typeId: location
    kind: location
    attributes:
      lifecycle:
        attributeId: lifecycle
        valueType: string
        requiredAt: introduction
        writePolicy: lifecycle_managed
        allowedLifecycleStates: [active, inactive, retired]
        unsetAllowed: false
        semanticRole: lifecycle
      season:
        attributeId: season
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
      timeOfDay:
        attributeId: timeOfDay
        valueType: string
        requiredAt: never
        writePolicy: mutable
        unsetAllowed: true
    lifecyclePolicy:
      allowedTransitions:
        - [active, inactive]
        - [active, retired]
        - [inactive, active]
        - [inactive, retired]
    referenceCapabilities:
      defaultEligibility: live
    typedInvariants: []
```

`kind` 取值：`character` | `location` | `item` | `concept` | `faction` | `rule`。`lifecyclePolicy.allowedTransitions` 定义生命周期转换（`retired` 是终态）；`typedInvariants` 当前契约中始终为空。

## 4. 定义角色

创建 `definitions/characters/traveler.yaml`：

```yaml
id: traveler
name: "The Traveler"
type: protagonist
archetype: wanderer
role: supporting
description: "A weary traveler arriving in an unfamiliar town."
appearance: "Worn leather coat, mud-stained boots, tired eyes."
traits:
  - curious
  - cautious
  - observant
initialState:
  location: great_road
  status: journeying
  emotionalState: weary_but_alert
```

`role` 只接受 `minor` | `supporting` | `antagonist` | `background`。`initialState` 是自由键值映射（初始事实），但其中的键**必须**在 `definitions/entity-types.yaml` 的 `character` 类型中已声明，否则 ontology 预检会拒绝。

同时创建 `definitions/locations/strange_town.yaml`：

```yaml
id: strange_town
name: "Strange Town"
kind: settlement
description: "A small town with dusty streets and shuttered windows."
initialState:
  season: autumn
  timeOfDay: dusk
```

## 5. 创建初始世界状态（必需）与话语账本（可选）

`EntityMapper.loadProject()` 会**无条件**加载 `definitions/state_initial.yaml`（缺少该文件会报错）；`discourse-ledger.yaml` 与 `_chapter.yaml` **可缺省**。这里两者都创建，便于演示。

创建 `definitions/state_initial.yaml`：

```yaml
info:
  currentEra: "a quiet autumn in an unnamed country"
  politicalSituation: "no active politics; the town keeps to itself"
timeAnchors:
  - id: arrival_day
    at: day_0
    description: "The evening the traveler arrives in Strange Town."
threads: []
worldFacts: []
```

创建 `definitions/discourse-ledger.yaml`（**可选**；`chapters[].sceneIds` 定义章节的读者顺序，缺省时编译器使用空的默认 ledger）：

```yaml
id: my_first_novel_ledger
chapters:
  - branch: main
    chapter: 1
    sceneIds:
      - E0
entries: []
```

## 6. 创建章节和事件

创建 `chapters/chapter_01/_chapter.yaml`（**可选**章节元数据）：

```yaml
chapter: 1
title: "Arrival"
summary: "The traveler arrives in Strange Town on an autumn evening."
intent: "Establish the traveler's arrival and the town's unsettling atmosphere."
plannedScenes: 1
```

`intent` 是必填字段（每章的创作意图）。

创建 `chapters/chapter_01/E0_arrival.yaml`（事件文件是 strict `EventFile`：`beats` 至少需要一个非空条目）：

```yaml
event: E0
title: "Arrival at Dusk"
narrativeOrder: 1
sceneType: linear
storyTime: day_1
tense: past
arcPosition: opening
pov:
  character: traveler
  type: third_person_limited
sceneBrief: "The traveler walks the last mile into town as the sun sets. Dust-covered and tired, they pass the first houses — dark windows, drawn curtains. A dog barks somewhere. The town feels wrong, but turning back isn't an option."
beats:
  - "The traveler walks the last mile into town as the sun sets."
  - "They pass the first houses — dark windows, drawn curtains — and hear a dog bark."
  - "The town feels wrong, but turning back isn't an option."
preconditions:
  - entity: traveler
    attribute: location
    value: great_road
  - entity: traveler
    attribute: status
    value: journeying
expectedPostconditions:
  - entity: traveler
    attribute: location
    value: strange_town
  - entity: traveler
    attribute: status
    value: arrived
  - entity: traveler
    attribute: emotionalState
    narrativeHint: "The traveler senses something is off — unease mixed with determination."
```

## 7. 运行验证

基准测试套件（`packages/bench/tests/bench.test.ts`）固定加载仓库内夹具（`fixtures/zhu-fu`，回退 `most-dangerous-game`），不会加载你的自定义项目。针对你自己的项目，构建后使用 CLI：

```bash
# 从 monorepo 根目录构建
npm run build
# 在项目目录内运行验证
npx nova validate
```

这会加载项目 YAML、构建 DAG、重放状态并运行全部 28 个内置验证器。`validate` 命令（`packages/cli/src/index.ts`）只把 `validateNovel()` 的结果**打印到终端**，不持久化任何输出（不会写入 `output/validation.md`）。验证报告文件由基准测试的回归阶段（`packages/bench/src/regression.ts`）直接创建 `ReportWriter(...)` 并调用 `.toMarkdown()` 生成 Markdown，再用 Node `fs` 写入各夹具目录的 `output/validation.md`；若要在自己的代码中以编程方式持久化验证报告，使用 `@novalistically/node-host` 的 `writeFileValidationReport`。

需要真实 LLM 渲染时，`render` 命令必须带一个选择器：事件 ID 位置参数、`--all` 或 `--chapter <n>` 三选一。CLI 不会自动读取 `.env`——需要把凭据导出到环境：

```bash
# 导出凭据（CLI 不加载 .env）
export NOVALISTICALLY_AI_API_KEY=your_api_key_here
export NOVALISTICALLY_AI_MODEL=your_model_id
# 渲染全部场景（或 --chapter 1 / 单个事件 ID）
npx nova render --all
```

`render`/`revise` 没有 `--model` 选项：provider 的实际模型由 `NOVALISTICALLY_AI_MODEL` 决定（`AiSdkProvider` 默认 `deepseek-v4-flash-free`），`API_KEY` 缺失时 `AiSdkProvider` 构造即抛错。`nova.yaml` 的 `defaultModel` 只是渲染作业的模型标签（参与缓存身份），不决定 provider 模型。`--provider mock-pass2` 需配合 `--reference-dir <directory>` 使用；`render --dry-run` 可预览请求而不调用 LLM。

L2（后渲染）验证针对各夹具 `reference/` 中已审核的参考数据运行。`node packages/bench/scripts/generate-reference.mjs` 是实时冒烟脚本，但它**只接受仓库内夹具名**（脚本把参数拼为 `fixtures/<name>`，无参数时默认 `zhu-fu`），不会加载 `my-first-novel/`；它把候选输出写入对应夹具的 `.nova/smoke-candidates/`，不会生成已审核的 L2 参考数据。若要让自己的项目参与冒烟，需要先把它放到 `fixtures/` 下再以夹具名调用。

## 完整示例

请参阅 `fixtures/zhu-fu/` 以获取包含 7 个事件（E0–E6）、单章 `chapter_01` 的完整项目示例，其中包括：
- 8 个角色定义，包含详细的外貌、特质和背景故事
- 4 个地点定义
- 世界规则和状态转换
- 框架故事结构（非线性时间线）
- 事件级字段：`discourseMode`、`arcPosition`、`emotionalValence`、`conflictType`、`resolutionType`（E2–E6）、`tense`、`narrationTime`
