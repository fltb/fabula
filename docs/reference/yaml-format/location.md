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
| `parent` | `string`（可选） | 父级位置 ID，用于构建嵌套的位置层次结构（例如 `fourth_master_lu_house` 的父级是 `luchen_town`） |
| `description` | `string` | 位置的完整散文描述（可多行） |
| `initialState` | `Record<string, unknown>` | 起始世界状态键值对——直接流入 `EntityRegistry`，决定该位置在故事中的初始属性 |
| `notableFeatures` | `string[]`（可选） | 该位置值得注意的特征列表（供 LLM 参考，不直接进入 WorldState 属性） |

### 运行时属性

位置实体被加载到 `EntityRegistry` 后，会从 `initialState` 中提取属性。实体类型目录（`default-catalog.ts`）为 location 种类定义了以下可写属性：

| 属性 | 类型 | 写策略 | 语义角色 | 描述 |
|---|---|---|---|---|
| `access` | `unknown` | mutable | `lifecycle` | 位置的通行状态（例如 `open`、`closed`、`restricted`） |
| `containment` | `unknown` | mutable | `structural` | 位置约束实体的方式（例如 `confines`、`shelters`） |
| `time_period` | `unknown` | mutable | `temporal` | 位置活跃的时间段（用于闪回/多时间线叙事） |

## 地点的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadProject()` 读取 `definitions/locations/` 下的所有 YAML 文件，并通过 `locationDefinitionSchema`（Zod）验证每个文件。每个位置被注册为 `kind: 'location'` 的 `Entity`。`initialState` 值成为注册表中实体的初始属性。

2. **EntityRegistry → WorldState** — 在状态初始化期间，通过 `InMemoryEntityRegistry.load()` 将位置投影到 `WorldState.entities` 中。含有 `parent` 字段的位置建立容器层次结构。

3. **WorldState 持久化** — 当 `StateManager` 重放事件时，`WorldState.entities` 中位置的属性通过后置条件解析进行更新。后置条件可以修改 `access`、`containment`、`time_period` 等运行时属性。

4. **上下文使用** — `ContextCompiler` 将相关位置实体纳入上下文包，为 LLM 提供空间意识。

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

**预期错误：** Zod schema 验证失败：`initialState` 应为 `object`，收到 `string`；`id` 应为 `string`，收到 `number`；`notableFeatures` 应为 `array`，收到 `string`。

## 规范化 IR

编译器将 `LocationDefinition` 映射为内部 `Entity` 对象：
- `id` 直接映射为实体 ID。
- `name` 存储为 `immutableMetadata.name`。
- `kind` 从 YAML 中的字符串转换为实体类型引用（`typeRef: { typeId: 'location', schemaVersion: 1 }`）。
- `initialState` 展开——每个键值对变为实体的初始运行时属性。
- `parent` 保留为结构引用，用于位置层次遍历。
- `notableFeatures` 保留在定义中供 LLM 上下文使用，不直接写入 WorldState。
- 验证通过 `locationDefinitionSchema.strict()` 执行，拒绝未知键。

## 生命周期

- **引入：** 通过事件的 `introduces` 后置条件数组引入新位置。编译器在状态重放期间读取 `introduces` 条目，创建实体声明并在 `EntityRegistry` 中注册。
- **停用：** 位置可通过运行时属性的后置条件更改标记为 `inactive` 或 `retired`。实体类型目录允许 `active ↔ inactive` 和 `active → retired` 的双向转换。退休通常发生在位置被永久关闭或摧毁时（例如 `status: destroyed`）。
- **参考策略：** 位置实体默认参考资格为 `live`（仅当前存在的实体可被引用）。
