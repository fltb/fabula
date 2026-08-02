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
| `initialState` | `Record<string, unknown>`（可选） | 起始世界状态键值对——经 `InMemoryEntityRegistry` 成为该物品在故事中的初始属性；省略时实体只携带空 state（外加重放写入的属性） |

### 运行时属性

物品实体的可写属性**不是内置或跨项目通用的**：每个项目在 `definitions/entity-types.yaml`
的 `types.item.attributes` 中声明（例如 dream-of-red-chamber 的 item 类型声明 `lifecycle`
（`lifecycle_managed`）与项目自有属性 `fate`；不存在跨项目的 `quantity`/`condition`/
`ownership`/`location` 默认集合）。每条属性声明 `valueType`、`requiredAt`、`writePolicy`
（`immutable`/`write_once`/`mutable`/`lifecycle_managed`）、`unsetAllowed` 等；重放写入经
`validateCatalogWrite()`（`state/event-application.ts`）强制校验——未知声明/未知属性、
value schema、writePolicy、lifecycle 转换与 `unsetAllowed` 不满足即抛 `ConfigError`。
`lifecycle` 属性（若声明为 `lifecycle_managed`）是唯一能改变实体生命周期状态的写入通道。

## 物品的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadProject()` 读取 `definitions/items/` 下的所有 YAML 文件，并通过 `itemDefinitionSchema`（Zod）验证每个文件。每个物品被注册为 `kind: 'item'` 的 `Entity`（`typeRef: { typeId: 'item', schemaVersion: 1 }`），`initialState` 值成为注册表中实体的初始 `state`。

2. **EntityRegistry → WorldState** — 在编译期，规范内核 `loadCanonicalProject()`（`entity/project-runtime.ts`）的 `buildInitialFacts()` 把**初始激活**（`introduction.type === 'initial'`）声明的实体 `state` 键值对转成初始事实（`entityId.attribute`，值经 `canonicalizeFactValue` 归一化），`applyInitialFacts()`（`state/event-application.ts`）在事件重放前写入 `WorldState.entities` 并追加到 `WorldState.facts`。`InMemoryEntityRegistry.load()` 本身只构建 `Entity` 对象，不写 `WorldState`。

3. **WorldState 持久化** — 当 `StateManager` 重放事件时，`WorldState.entities` 中物品的属性通过后置条件解析进行更新。可写属性集合由项目 `definitions/entity-types.yaml` 的 item 类型声明决定，写入按 `validateCatalogWrite()` 校验（见上文「运行时属性」）。

4. **上下文使用** — `ContextPackage` 没有物品投影：`ContextAssembler` 只把角色快照与活动规则纳入提示上下文（与 location 相同），物品状态不进入 Pass 1 提示；`initialState`/后件写入的物品属性只存在于 `WorldState` 与注册表，可经其他路径引用。

## 示例（示意，非夹具文件）

下列定义是示意性的：它使用了 zhu-fu 世界观中的物品（捐门槛），但 zhu-fu 项目未声明
`definitions/items/` 目录或 `item` 实体类型；`initialState` 为可选字段，本示例用于演示其写法。

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

- **引入：** `introduces` 是 EventFile 的独立字段（每项 `{ type, id, initialState }`），不是 `expectedPostconditions` 数组。规范内核 `loadCanonicalProject()` 的 `collectIntroductions()` 收集全部 introduces：同一实体只能由恰好一个事件引入（重复 → `ConfigError`）；若该实体已有定义文件且仍声明非空 `initialState`，同样报错（初始状态必须移到引入边界）。definition-less 的引入物品由内核按引入数据注册（`kind: 'item'`、`typeRef`、`initialState`），并为每个引入合成 `system:introduction:<hostEvent>:<entityId>` transition——置于宿主事件之前并加入其 `causalPredecessors`，重放时写入 `lifecycle: active` + `initialState` 各键。`compileProject()` 的投影只暴露分离的规范化数据与只读 `EntityLookup`，不暴露 registry。
- **状态变更：** 物品属性通过事件 `expectedPostconditions` 中的后置条件修改，可写属性集合由项目 item 类型目录声明（如 dream-of-red-chamber 的 `fate`）。例如某项目声明 `condition` 时，`condition: destroyed` 表示物品被摧毁；`ownership` 变更表示物品易手——但这些属性存在与否取决于项目目录，不是通用默认。
- **退休：** `condition: destroyed` 或 `quantity: 0` 都不会改变物品的生命周期——`validateCatalogWrite()` 只对 `lifecycle_managed` 的 `lifecycle` 属性校验生命周期（`allowedLifecycleStates` + `lifecyclePolicy.allowedTransitions`），condition/quantity 只是普通状态键。需要显式写 `lifecycle: retired` 后置条件来描述真正退休。转换集合由项目目录声明——例如 dream-of-red-chamber 的 item 类型允许 `active ↔ inactive`、`active → retired`、`inactive → retired`；`retired` 是终态——没有离开 `retired` 的转换，且 retired 实体的非 lifecycle 写入被拒。
- **参考策略：** `referenceCapabilities.defaultEligibility` 是项目 `definitions/entity-types.yaml` 中 item 类型**必填**的元数据（dream-of-red-chamber 声明 `live`），但重放路径不读取它——参与资格由 `validateParticipants()` 强制（参与者必须已 live 或由同一事件引入，retired 拒绝），`validatePreconditions()` 拒绝引用未 live 实体的前件。不要把 `defaultEligibility` 描述为运行时强制契约。
