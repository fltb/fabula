# 第一个项目

> ~350 字 — 从头开始创建你的第一个 Novalistically 叙事项目。

## 1. 创建项目目录

```bash
mkdir -p my-first-novel/definitions/characters \
  my-first-novel/definitions/locations \
  my-first-novel/chapters/chapter_01
cd my-first-novel
```

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

## 3. 定义角色

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

`role` 只接受 `minor` | `supporting` | `antagonist` | `background`；`initialState` 是自由键值映射（初始事实）。

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

## 4. 创建初始世界状态与话语账本

`EntityMapper.loadProject()` 会**无条件**加载这两个文件（缺少任一文件都会报错），因此项目必须先包含它们。

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

创建 `definitions/discourse-ledger.yaml`（`chapters[].sceneIds` 定义章节的读者顺序，必须包含 E0）：

```yaml
id: my_first_novel_ledger
chapters:
  - branch: main
    chapter: 1
    sceneIds:
      - E0
entries: []
```

## 5. 创建章节和事件

创建 `chapters/chapter_01/_chapter.yaml`：

```yaml
chapter: 1
title: "Arrival"
summary: "The traveler arrives in Strange Town on an autumn evening."
intent: "Establish the traveler's arrival and the town's unsettling atmosphere."
plannedScenes: 1
```

`intent` 是必填字段（每章的创作意图）。

创建 `chapters/chapter_01/E0_arrival.yaml`：

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

## 6. 运行验证

基准测试套件（`packages/bench/tests/bench.test.ts`）固定加载仓库内夹具（`fixtures/zhu-fu`，回退 `most-dangerous-game`），不会加载你的自定义项目。针对你自己的项目，构建后使用 CLI：

```bash
# 从 monorepo 根目录构建
npm run build
# 在项目目录内运行验证
npx nova validate
```

这会加载项目 YAML、构建 DAG、重放状态并运行全部 28 个内置验证器。`validate` 命令（`packages/cli/src/index.ts`）只把 `validateNovel()` 的结果**打印到终端**，不会写入 `output/validation.md`——验证报告文件由基准测试的回归阶段通过 `writeValidationReport()` 写入各夹具目录。

需要真实 LLM 渲染时，`render` 命令必须带一个选择器（事件 ID、`--scene`、`--chapter`、`--all` 四选一），且 CLI 不会自动读取 `.env`——需要把凭据导出到环境或显式传参：

```bash
# 导出凭据（CLI 不加载 .env）
export NOVALISTICALLY_AI_API_KEY=your_api_key_here
export NOVALISTICALLY_AI_MODEL=your_model_id
# 渲染整个分支（或 --chapter 1 / 事件 ID）
npx nova render --all
# 或显式指定模型
npx nova render --chapter 1 --model your_model_id
```

注意：`nova.yaml` 中的 `defaultModel` 只作为渲染作业的模型标签，**不会**被 CLI 的 provider 工厂用作回退——`--model` 与 `NOVALISTICALLY_AI_MODEL` 都缺失时会抛 “no model configured”（`packages/core/src/editorial/render-service.ts`）。`--provider mock-pass2` 需配合 `--reference-dir` 使用。

L2（后渲染）验证针对各夹具 `reference/` 中已审核的参考数据运行。`node packages/bench/scripts/generate-reference.mjs` 是实时冒烟脚本，但它**只接受仓库内夹具名**（脚本把参数拼为 `fixtures/<name>`，无参数时默认 `zhu-fu`），不会加载 `my-first-novel/`；它把候选输出写入对应夹具的 `.nova/smoke-candidates/`，不会生成已审核的 L2 参考数据。若要让自己的项目参与冒烟，需要先把它放到 `fixtures/` 下再以夹具名调用。

## 完整示例

请参阅 `fixtures/zhu-fu/` 以获取包含 7 个事件（E0–E6）、单章 `chapter_01` 的完整项目示例，其中包括：
- 8 个角色定义，包含详细的外貌、特质和背景故事
- 4 个地点定义
- 世界规则和状态转换
- 框架故事结构（非线性时间线）
- 所有 P0 字段：`discourseMode`、`arcPosition`、`emotionalValence`、`conflictType`、`resolutionType`、`tense`、`narrationTime`
