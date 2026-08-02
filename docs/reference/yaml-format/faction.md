# 阵营 YAML 格式

**源类型：** `packages/core/src/types/character.ts` (FactionDefinition)
**Schema：** `packages/core/src/schemas/faction.ts` (factionDefinitionSchema)

阵营定义为 `definitions/factions/` 目录下的 YAML 文件。每个文件定义一个 `FactionDefinition`——故事中一个阵营或团体的完整规范，包括其叙述描述和初始成员信息。

> 本页为当前参考文档，与 [当前系统状态](../../current-state.md) 保持同步。

## Fields

| 字段 | 类型 | 描述 |
|---|---|---|
| `id` | `string` | 唯一标识符（例如 `lu_family`、`village_elders`） |
| `name` | `string` | 故事语言中的显示名称（例如 `鲁氏家族`、`乡绅会`） |
| `kind` | `string` | 阵营类型标签（例如 `family`、 `political_faction`、 `religious_group`、 `social_class`） |
| `description` | `string` | 阵营的完整散文描述（可多行） |
| `initialState` | `Record<string, unknown>` | 起始世界状态键值对——直接流入 `EntityRegistry`，决定该阵营在故事中的初始属性 |

### 运行时属性

阵营实体被加载到 `EntityRegistry` 后，会从 `initialState` 中提取属性。阵营实体的可写属性**不**由内置默认目录决定——`default-catalog.ts` 已移除；属性以项目自带的 `definitions/entity-types.yaml` 声明为准（`entityTypeCatalogSourceSchema`，运行时编译为 `EntityTypeCatalog`）。项目需要为阵营声明一个 `kind: faction` 的类型，列出该类型允许的属性：

| 属性声明字段 | 类型 | 描述 |
|---|---|---|
| `attributeId` | `string` | 属性名，例如 `membership`、`status` |
| `valueType` | `enum` | `string`、`number`、`boolean`、`string_list`、`string_map` |
| `requiredAt` | `enum` | `introduction`、`activation`、`never` |
| `writePolicy` | `enum` | `immutable`、`write_once`、`mutable`、`lifecycle_managed` |
| `unsetAllowed` | `boolean` | 是否允许 unset |
| `semanticRole` | `string`（可选） | 语义角色标记（如 `lifecycle`、`location`） |
| `typedReferenceConstraint` | `object`（可选） | 引用约束（`targetKind` / `targetTypeId`） |

ontology 预检（`validateProjectOntology`）会把阵营 `initialState` 导出的初始事实与事件前置/后置条件的写目标逐一对照声明属性：写未声明属性会以 `ConfigError`（phase `source`）拒绝。

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

> 注意：此示例假设项目的 `definitions/entity-types.yaml` 声明了 `kind: faction` 类型及 `status`、`membership`、`social_standing`、`influence` 属性。`membership` 不是内置属性——未在实体类型目录中声明的阵营属性不能写入。

## 无效示例

```yaml
id: lu_family
name: "鲁氏家族"
kind: family
description: "鲁镇的大户人家"
membership: fourth_master_lu   # 错误：membership 应通过 initialState 设置，而非顶级字段
initialState:
  status: active
  leader: fourth_master_lu      # Zod 层面允许（自由键值 Record），但 ontology 预检会要求该键在 entity-types.yaml 的 faction 类型中已声明
```

**预期错误：** Zod schema 验证失败：未知键 `membership` 被 `strict()` 模式拒绝。`membership` 应作为 `initialState` 中的条目传入（并且需要在 `definitions/entity-types.yaml` 中声明为 faction 类型的属性，才能通过 ontology 预检）。

## 规范化 IR

编译器将 `FactionDefinition` 映射为内部 `Entity` 对象：
- `id` 直接映射为实体 ID。
- `name` 映射为运行时 `Entity` 的顶层 `name` 字段；`definitionFile` 为 `definitions/factions/<id>.yaml`。
- `typeRef` 由定义目录决定，与 YAML 无关：`InMemoryEntityRegistry.load()` 无条件设置 `kind: 'faction'` 与 `typeRef: { typeId: 'faction', schemaVersion: 1 }`，从不读取 `fac.kind`；YAML 中必需的 `kind` 子类型标签目前只保留在原始定义里，不会体现在运行时 `Entity` 上。该 `typeRef` 需对应项目 `entity-types.yaml` 中声明的 `kind: faction` 类型，否则 ontology 预检报 `Unknown entity type`。
- `initialState` 展开——每个键值对变为实体的初始运行时属性（键必须在实体类型目录中声明）。
- 验证通过 `factionDefinitionSchema.strict()` 执行，拒绝未知键。

## 生命周期

- **引入：** 阵营只能通过 `definitions/factions/` 下的定义文件引入。事件的 `introduces` 数组仅支持 `character`、`location`、`item`、`concept` 四种类型，**不包含** `faction`。
- **成员资格变更：** 阵营 `membership` 通过事件 `expectedPostconditions` 中的后置条件进行修改（`membership` 需在项目 `entity-types.yaml` 中声明为可写属性）。`RelationshipTransaction`（关系事务）机制用于管理角色之间关系的二元体现，它独立更新 `WorldState.relationships`，不会同步阵营实体的 `membership`——两者是分离的模型。
- **退休：** 生命周期由项目 `definitions/entity-types.yaml` 驱动：`lifecycle` 属性使用 `writePolicy: lifecycle_managed`，重放器（`packages/core/src/state/event-application.ts`）要求 `lifecycle_managed` 属性只能命名为 `lifecycle`，先校验 `allowedLifecycleStates`，再按 `lifecyclePolicy.allowedTransitions` 校验 `current → next` 转换。`status: dissolved` 只是 `status` 属性上的普通领域值，不会产生派生生命周期转换——退休需要显式写 `lifecycle: retired` 后置条件。允许的转换集合由项目声明（zhu-fu 声明 `active ↔ inactive`、`active → retired`、`inactive → retired`；`retired` 是终态）。`typedInvariants` 在当前契约中始终为空（schema 已接受、运行时未执行）。
- **参考策略：** `referenceCapabilities.defaultEligibility`（`identity` | `live` | `historical`）由项目 `entity-types.yaml` 声明，属于目录元数据；运行时的 `validateParticipants` 只拒绝未激活（不在 `WorldState.entities`）或已 `retired` 的参与者。不要把该字段描述为强制的“仅可引用现有实体”契约。
