# 物品 YAML 格式

**源类型：** `packages/core/src/types/location.ts` (ItemDefinition)
**Schema：** `packages/core/src/schemas/item.ts` (itemDefinitionSchema)

物品定义为 `definitions/items/` 目录下的 YAML 文件。每个文件定义一个 `ItemDefinition`——故事中一个物品的完整规范，包括其叙述描述、归属关系和可随时间演变的物理状态。

## Fields

| 字段 | 类型 | 描述 |
|---|---|---|
| `id` | `string` | 唯一标识符（例如 `threshold_donated`、`blue_bordered_bowl`） |
| `name` | `string` | 故事语言中的显示名称（例如 `捐门槛`、`蓝边碗`） |
| `kind` | `string` | 物品类型标签（例如 `ritual_item`、`household_item`、`weapon`、`document`） |
| `description` | `string` | 物品的完整散文描述（可多行） |
| `initialState` | `Record<string, unknown>` | 起始世界状态键值对——直接流入 `EntityRegistry`，决定该物品在故事中的初始属性 |

### 运行时属性

物品实体被加载到 `EntityRegistry` 后，会从 `initialState` 中提取属性。实体类型目录（`default-catalog.ts`）为 item 种类定义了以下可写属性：

| 属性 | 类型 | 写策略 | 语义角色 | 描述 |
|---|---|---|---|---|
| `quantity` | `unknown` | mutable | `lifecycle` | 物品的数量（适用于可计数物品，例如 `1`、`12`） |
| `condition` | `unknown` | mutable | `lifecycle` | 物品的物理状态（例如 `intact`、`damaged`、`destroyed`） |
| `ownership` | `unknown` | mutable | `relational` | 当前持有者或拥有者的实体 ID |
| `location` | `unknown` | mutable | `location` | 物品当前所在的实体位置 ID |

## 物品的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadProject()` 读取 `definitions/items/` 下的所有 YAML 文件，并通过 `itemDefinitionSchema`（Zod）验证每个文件。每个物品被注册为 `kind: 'item'` 的 `Entity`。`initialState` 值成为注册表中实体的初始属性。

2. **EntityRegistry → WorldState** — 在状态初始化期间，通过 `InMemoryEntityRegistry.load()` 将物品投影到 `WorldState.entities` 中。

3. **WorldState 持久化** — 当 `StateManager` 重放事件时，`WorldState.entities` 中物品的属性通过后置条件解析进行更新。后置条件可以修改 `condition`、`ownership`、`quantity`、`location` 等运行时属性。

4. **上下文使用** — `ContextCompiler` 将相关物品实体纳入上下文包，为 LLM 提供物品状态意识。

## 示例

```yaml
id: threshold_donated
name: "捐门槛"
kind: ritual_item
description: "土地庙前的一条木门槛，祥林嫂用十二元鹰洋捐的。按柳妈的说法，这条门槛将被千人踏万人跨，作为祥林嫂的替身，替她赎清一世罪名。然而即使捐了门槛，四婶仍然喝止她触碰祭品——'你放着罢，祥林嫂！'"
initialState:
  condition: intact
  ownership: earth_god_temple
  location: earth_god_temple
  status: donated
```

## 无效示例

```yaml
id: threshold_donated
name: "捐门槛"
kind: ritual_item
description: "土地庙前的一条木门槛"
initialState:
  - condition: intact            # 错误：initialState 必须是 Record，而非数组
  - ownership: earth_god_temple
notableFeatures:                  # 错误：item 没有 notableFeatures 字段
  - "木制"
```

**预期错误：** Zod schema 验证失败：`initialState` 应为 `object`，收到 `array`；未知键 `notableFeatures` 被 `strict()` 模式拒绝。

## 规范化 IR

编译器将 `ItemDefinition` 映射为内部 `Entity` 对象：
- `id` 直接映射为实体 ID。
- `name` 映射为运行时 `Entity` 的顶层 `name` 字段；`definitionFile` 为 `definitions/items/<id>.yaml`。
- `typeRef` 由定义目录决定，与 YAML 无关：`InMemoryEntityRegistry.load()` 无条件设置 `kind: 'item'` 与 `typeRef: { typeId: 'item', schemaVersion: 1 }`，从不读取 `item.kind`；YAML 中必需的 `kind` 子类型标签（如 `ritual_item`）目前只保留在原始定义里，不会体现在运行时 `Entity` 上。
- `initialState` 展开——每个键值对变为实体的初始运行时属性。
- 验证通过 `itemDefinitionSchema.strict()` 执行，拒绝未知键。

## 生命周期

- **引入：** `introduces` 是 EventFile 的独立字段（每项 `{ type, id, initialState }`），不是 `expectedPostconditions` 数组。注册时机依赖入口路径：`api.initializeProject()` 在 replay 前一次性注册所有 introductions（`name` = id、`definitionFile` = `definitions/introduces/<id>.yaml`）；`renderNovel()` 的 `loadProjectData()` 只调用 `InMemoryEntityRegistry.load()`，不注册 introductions。
- **状态变更：** 物品的 `condition`、`ownership`、`quantity`、`location` 通过事件 `expectedPostconditions` 中的后置条件进行修改。例如，`condition: destroyed` 表示物品被摧毁；`ownership` 变更表示物品易手。
- **退休：** `condition: destroyed` 或 `quantity: 0` 都不会改变物品的生命周期——`validateLifecycle()` 只处理属性恰好为 `lifecycle` 的后置条件，condition/quantity 只是普通状态键。需要显式写 `lifecycle: retired` 后置条件来描述真正退休。实体类型目录允许 `active ↔ inactive` 双向转换，以及 `active → retired`、`inactive → retired` 单向转换；`retired` 是终态——没有离开 `retired` 的转换。
- **参考策略：** 物品实体默认参考资格为 `live`（仅当前存在的实体可被引用）。
