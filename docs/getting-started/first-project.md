# 第一个项目

> ~350 字 — 从头开始创建你的第一个 Novalistically 叙事项目。

## 1. 创建项目目录

```bash
mkdir my-first-novel
cd my-first-novel
```

## 2. 创建 nova.yaml

根配置文件：

```yaml
project: my-first-novel
title: "My First Novel"
author: "You"
default_model: mock
default_language: en
genre: "literary"
synopsis: "A short story about a traveler arriving in a strange town."
tense: past
snapshot_interval: 3
```

## 3. 定义角色

创建 `definitions/characters/traveler.yaml`：

```yaml
id: traveler
name: "The Traveler"
type: protagonist
archetype: wanderer
role: main
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

同时创建 `definitions/locations/strange_town.yaml`：

```yaml
id: strange_town
name: "Strange Town"
type: settlement
description: "A small town with dusty streets and shuttered windows."
initialState:
  season: autumn
  timeOfDay: dusk
```

## 4. 创建章节和事件

创建 `chapters/chapter_01/_chapter.yaml`：

```yaml
chapter: 1
title: "Arrival"
summary: "The traveler arrives in Strange Town on an autumn evening."
plannedScenes: 1
```

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
postconditions:
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

## 5. 运行验证

从 monorepo 根目录，针对你的项目运行基准测试套件：

```bash
npx vitest run packages/bench/tests/bench.test.ts
```

对于 L2 验证（使用 Pass 2 的后渲染验证），首先生成参考数据：

```bash
# 需要在 .env 中设置 NOVALISTICALLY_AI_API_KEY
node packages/bench/scripts/generate-reference.mjs my-first-novel
```

## 完整示例

请参阅 `fixtures/zhu-fu/` 以获取包含 7 个事件、多章节的完整项目示例，其中包括：
- 8 个角色定义，包含详细的外貌、特质和背景故事
- 4 个地点定义
- 世界规则和状态转换
- 框架故事结构（非线性时间线）
- 所有 P0 字段：`discourseMode`、`arcPosition`、`emotionalValence`、`conflictType`、`resolutionType`、`tense`、`narrationTime`
