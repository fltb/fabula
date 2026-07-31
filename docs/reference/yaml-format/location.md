# 地点 YAML 格式

**源类型：** `packages/core/src/types/location.ts` (LocationDefinition)
**Schema：** `packages/core/src/schemas/location.ts` (locationDefinitionSchema)

地点定义为 `definitions/locations/` 目录下的 YAML 文件。每个文件定义一个 `LocationDefinition`——故事中一个位置的完整规范，包括其叙述描述、容器层次和可运行时演变的初始世界状态。

## Fields

| 字段 | 类型 | 描述 |
|---|---|---|
| `id` | `string` | 唯一标识符（例如 `luchen_town`、`fourth_master_lu_house`） |
| `name` | `string` | 故事语言中的显示名称（例如 `鲁镇`、`鲁四老爷家`） |
| `kind` | `string` | 位置类型标签（例如 `town`、`residence`、`religious_site`、`wilderness`） |
| `parent` | `string`（可选） | 父级位置 ID（例如 `fourth_master_lu_house` 的父级是 `luchen_town`）；schema 接受该字段，但目前没有源码消费它（见下文「规范化 IR」） |
| `description` | `string` | 位置的完整散文描述（可多行） |
| `initialState` | `Record<string, unknown>` | 起始世界状态键值对——经 `InMemoryEntityRegistry` 成为该位置在故事中的初始属性 |
| `notableFeatures` | `string[]`（可选） | 该位置值得注意的特征列表；仅保留在 `ProjectData.locations` 上，不投影进注册表 `state` 或任何上下文 |

### 运行时属性

位置实体被加载到 `EntityRegistry` 后，会从 `initialState` 中提取属性。实体类型目录（`default-catalog.ts`）为 location 种类定义了以下可写属性：

| 属性 | 类型 | 写策略 | 语义角色 | 描述 |
|---|---|---|---|---|
| `access` | `unknown` | mutable | `lifecycle` | 位置的通行状态（例如 `open`、`closed`、`restricted`） |
| `containment` | `unknown` | mutable | `structural` | 位置约束实体的方式（例如 `confines`、`shelters`） |
| `time_period` | `unknown` | mutable | `temporal` | 位置活跃的时间段（用于闪回/多时间线叙事） |

## 地点的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadProject()` 读取 `definitions/locations/` 下的所有 YAML 文件，并通过 `locationDefinitionSchema`（Zod）验证每个文件，返回解析后的 `LocationDefinition` 对象；`InMemoryEntityRegistry.load()` 再把这些定义注册为 `kind: 'location'` 的 `Entity`（`typeRef: { typeId: 'location', schemaVersion: 1 }`），`initialState` 的值成为注册表中实体的初始 `state`。

2. **EntityRegistry → WorldState** — 在编译期，`buildInitialState()`（`packages/core/src/api.ts`）把每个注册实体的 `state` 键值对转成初始事实（`entityId.attribute`），`applyInitialFacts()`（`packages/core/src/state/event-application.ts`）在事件重放前将这些基线写入 `WorldState.entities`。

3. **WorldState 持久化** — 当 `StateManager` 重放事件时，`WorldState.entities` 中位置的属性通过后置条件解析进行更新。后置条件可以修改 `access`、`containment`、`time_period` 等可写属性。

4. **上下文使用** — `ContextPackage` 没有位置投影；上下文编译器只投影角色快照与活动规则。位置的 `initialState` 属性可经其他路径被引用，但 `parent`、`notableFeatures` 等字段不进入任何上下文包。

## 示例（来自 zhu-fu 测试夹具: luchen_town.yaml）

```yaml
id: luchen_town
name: "鲁镇"
kind: town
description: "鲁镇是浙江的一个水乡小镇，有河，有桥，有瓦房和石板路。年终时全镇都在准备'祝福'——杀鸡、宰鹅、买猪肉，女人们的手臂在水里浸得通红。空气中弥漫着幽微的火药香（爆竹）。镇东头是河边，祥林嫂被绑架的地方；镇西头有土地庙。鲁镇是一个封闭的传统社会——每个人互相认识，社会等级分明。"
initialState:
  status: active
  season: deep_winter
  atmosphere: new_year_preparation
  social_mood: festive_busy
notableFeatures:
  - "镇东头的河边——祥林嫂淘米被绑架处，也是她沦为乞丐后与'我'相遇处"
  - "镇西头的土地庙——祥林嫂捐门槛的地方"
  - "各家门前的祝福祭祀——年终大典，男人主持，女人准备"
```

## 无效示例

```yaml
id: 12345                     # 错误：id 必须是字符串
name: "无名之地"
kind: wilderness
description: "某处荒野"
initialState: "active"        # 错误：initialState 必须是对象（Record），而非字符串
notableFeatures: "single"     # 错误：notableFeatures 必须是数组，而非字符串
```

**预期错误：** `readYamlFile`（`entity/yaml-loader.ts`）只报告第一个验证失败（`parsed.error.issues[0]`），而 `locationDefinitionSchema` 按 `id` 在前求值，因此该输入在 `id` 处即被拒绝，`initialState` 与 `notableFeatures` 的问题不会出现在加载器错误中：

```
ConfigError (CONFIG_INVALID)
  message: YAML schema validation failed at id: Expected string, received number
  path:    definitions/locations/<id>.yaml:id
```

（若要观察另外两个字段的诊断，需要把 `id` 修正为字符串后单独输入。）

## 规范化 IR

`InMemoryEntityRegistry.load()` 将 `LocationDefinition` 映射为内部 `Entity` 对象：
- `id` 直接映射为实体 ID。
- `name` 存储为运行时 `Entity.name`；`definitionFile` 固定为 `definitions/locations/<id>.yaml`（运行时 `Entity` 没有 `immutableMetadata` 字段——那是内部 `EntityDeclaration` 目录的形状）。
- `kind` 并未取自 YAML 字符串——注册器硬编码 `kind: 'location'`，类型引用为 `typeRef: { typeId: 'location', schemaVersion: 1 }`（`makeTypeRef`）。
- `initialState` 展开——每个键值对经 `canonicalizeFactValue` 归一化后变为实体的初始 `state`。
- `parent` 与 `notableFeatures` 仅保留在 `ProjectData.locations`（解析后的定义对象）上；目前没有任何源码消费它们——不做层次遍历，也不投影进注册表 `state` 或任何提示上下文。
- 验证通过 `locationDefinitionSchema.strict()` 执行，拒绝未知键。

## 生命周期

- **引入：** 通过事件的 `introduces` 数组引入新位置（`introduceEntrySchema`：`type: location` + `id` + `initialState`）。当前实现是基线注册而非事件时引入：`initializeProject()`（`api.ts`）在重放开始前就把每个 introduction 注册进 `EntityRegistry`（`kind: location`，`definitionFile: definitions/introduces/<id>.yaml`），`buildInitialState()` 随后把注册表 `state` 键值对折叠进基线 `initialFacts`，因此这些位置从初始基线起就存在于 `WorldState.entities`；`applyNarrativeEvent`/`applyPostconditions` 从不消费 `event.introduces`。
- **停用：** 位置的运行时生命周期通过写 `lifecycle` 属性（`active`/`inactive`/`retired`）的后置条件改变；`validateLifecycle` 按类型目录的 `lifecyclePolicy.allowedTransitions` 校验转换。location 种类的允许转换恰好是 `active ↔ inactive`、`active → retired`、`inactive → retired`——`retired` 是终态，不可恢复。退休通常发生在位置被永久关闭或摧毁时（例如 `status: destroyed`）。
- **参考策略：** `default-catalog.ts` 为 location 种类声明 `referenceCapabilities.defaultEligibility: 'live'`，但这只是目录元数据，没有任何运行时代码消费它：`validateParticipants` 只拒绝已退休（`retired`）的参与者并允许缺席参与者，后置条件还可以自动创建未知实体。不要把该字段描述为强制的“仅可引用现有实体”契约。
