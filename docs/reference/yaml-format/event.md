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
- `Fact` 必须且只能给出 `value` 或 `narrativeHint`。确定性比较仅支持 `operator: eq`（省略等同 `eq`）；`neq`、`gt`、`lt`、`contains` 是阶段一拒绝输入。
- `linear` 与 `flashback` 事件必须写出 `storyTime` 和 `narrationTime`。其他 scene type 不是阶段一 author-facing capability。
- 项目键使用 camelCase；例如 `defaultModel`、`defaultLanguage`、`snapshotInterval`、`defaultSceneTextTarget`。旧 snake_case 不再兼容。

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
