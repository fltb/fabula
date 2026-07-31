# 阵营 YAML 格式

**源类型：** `packages/core/src/types/character.ts` (FactionDefinition)
**Schema：** `packages/core/src/schemas/faction.ts` (factionDefinitionSchema)

阵营定义为 `definitions/factions/` 目录下的 YAML 文件。每个文件定义一个 `FactionDefinition`——故事中一个阵营或团体的完整规范，包括其叙述描述和初始成员信息。

## Fields

| 字段 | 类型 | 描述 |
|---|---|---|
| `id` | `string` | 唯一标识符（例如 `lu_family`、`village_elders`） |
| `name` | `string` | 故事语言中的显示名称（例如 `鲁氏家族`、`乡绅会`） |
| `kind` | `string` | 阵营类型标签（例如 `family`、 `political_faction`、 `religious_group`、 `social_class`） |
| `description` | `string` | 阵营的完整散文描述（可多行） |
| `initialState` | `Record<string, unknown>` | 起始世界状态键值对——直接流入 `EntityRegistry`，决定该阵营在故事中的初始属性 |

### 运行时属性

阵营实体被加载到 `EntityRegistry` 后，会从 `initialState` 中提取属性。实体类型目录（`default-catalog.ts`）为 faction 种类定义了以下可写属性：

| 属性 | 类型 | 写策略 | 语义角色 | 描述 |
|---|---|---|---|---|
| `membership` | `unknown` | mutable | `relational` | 阵营成员列表或成员资格描述（例如 `[xianglins_wife, fourth_master_lu]`） |

## 阵营的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadProject()` 读取 `definitions/factions/` 下的所有 YAML 文件，并通过 `factionDefinitionSchema`（Zod）验证每个文件。每个阵营被注册为 `kind: 'faction'` 的 `Entity`。`initialState` 值成为注册表中实体的初始属性。

2. **EntityRegistry → WorldState** — 在状态初始化期间，通过 `InMemoryEntityRegistry.load()` 将阵营投影到 `WorldState.entities` 中。

3. **WorldState 持久化** — 当 `StateManager` 重放事件时，`WorldState.entities` 中阵营的属性通过后置条件解析进行更新。后置条件可以修改 `membership` 等运行时属性。

4. **角色关联** — `CharacterDefinition` 中的 `faction` 字段**不**建立任何运行时绑定：`buildCharacterState()` 不会把它拷贝进实体状态，mapper 也没有消费者读取它。成员资格目前只能来自阵营自己的 `initialState` / 后置条件数据（`membership` 属性）；`applyRelationshipTransaction()` 独立更新 `WorldState.relationships`，不会同步阵营实体的 `membership`——两者是分离的模型。

## 示例

```yaml
id: lu_family
name: "鲁氏家族"
kind: family
description: "鲁镇的四老爷一族，是镇上的大户人家。鲁四老爷是书房挂着'事理通达心气和平'对联的理学信徒，四婶主持家务。这个家族代表着封建礼教的正统——他们雇佣祥林嫂，但始终将她视为外人。家族通过祝福祭祀维系社会地位，而祥林嫂的'不洁'身份被严格排斥在祭祀仪式之外。"
initialState:
  status: active
  membership:
    - fourth_master_lu
    - fourth_aunt
  social_standing: gentry
  influence: local
```

## 无效示例

```yaml
id: lu_family
name: "鲁氏家族"
kind: family
description: "鲁镇的大户人家"
membership: fourth_master_lu   # 错误：membership 应通过 initialState 设置，而非顶级字段
initialState:
  status: active
  leader: fourth_master_lu      # 允许：initialState 是自由键值 Record，自定义键不会被拒绝
```

**预期错误：** Zod schema 验证失败：未知键 `membership` 被 `strict()` 模式拒绝。`membership` 应作为 `initialState` 中的条目传入。

## 规范化 IR

编译器将 `FactionDefinition` 映射为内部 `Entity` 对象：
- `id` 直接映射为实体 ID。
- `name` 映射为运行时 `Entity` 的顶层 `name` 字段；`definitionFile` 为 `definitions/factions/<id>.yaml`。
- `typeRef` 由定义目录决定，与 YAML 无关：`InMemoryEntityRegistry.load()` 无条件设置 `kind: 'faction'` 与 `typeRef: { typeId: 'faction', schemaVersion: 1 }`，从不读取 `fac.kind`；YAML 中必需的 `kind` 子类型标签目前只保留在原始定义里，不会体现在运行时 `Entity` 上。
- `initialState` 展开——每个键值对变为实体的初始运行时属性。
- 验证通过 `factionDefinitionSchema.strict()` 执行，拒绝未知键。

## 生命周期

- **引入：** 阵营只能通过 `definitions/factions/` 下的定义文件引入。事件的 `introduces` 数组仅支持 `character`、`location`、`item`、`concept` 四种类型，**不包含** `faction`。
- **成员资格变更：** 阵营 `membership` 通过事件 `expectedPostconditions` 中的后置条件进行修改。`RelationshipTransaction`（关系事务）机制也可用于管理阵营内角色关系的二元体现。
- **退休：** `validateLifecycle()` 只在后置条件属性恰好是 `lifecycle` 时识别状态转换；`status: dissolved` 只是普通实体属性，不会产生派生转换。需要显式写 `lifecycle: retired` 后置条件；`status: dissolved` 只能作为独立的领域状态呈现。实体类型目录允许 `active ↔ inactive` 双向转换，以及 `active → retired`、`inactive → retired` 单向转换；`retired` 是终态——没有离开 `retired` 的转换。
- **参考策略：** 阵营实体默认参考资格为 `live`（仅当前存在的实体可被引用）。
