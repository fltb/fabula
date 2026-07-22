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

4. **角色关联** — `CharacterDefinition` 中的 `faction` 字段建立角色到阵营的初始绑定。运行时通过关系事务和阵营 `membership` 属性的后置条件变更管理成员资格变化。

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
  leader: fourth_master_lu      # 错误：缺少 goals、alignment 等预期字段（仅为示意）
```

**预期错误：** Zod schema 验证失败：未知键 `membership` 被 `strict()` 模式拒绝。`membership` 应作为 `initialState` 中的条目传入。

## 规范化 IR

编译器将 `FactionDefinition` 映射为内部 `Entity` 对象：
- `id` 直接映射为实体 ID。
- `name` 存储为 `immutableMetadata.name`。
- `kind` 从 YAML 中的字符串转换为实体类型引用（`typeRef: { typeId: 'faction', schemaVersion: 1 }`）。
- `initialState` 展开——每个键值对变为实体的初始运行时属性。
- 验证通过 `factionDefinitionSchema.strict()` 执行，拒绝未知键。

## 生命周期

- **引入：** 通过事件的 `introduces` 后置条件数组引入新阵营。编译器在状态重放期间读取 `introduces` 条目，创建实体声明并在 `EntityRegistry` 中注册。
- **成员资格变更：** 阵营 `membership` 通过事件 `expectedPostconditions` 中的后置条件进行修改。`RelationshipTransaction`（关系事务）机制也可用于管理阵营内角色关系的二元体现。
- **退休：** 阵营在其解散时退休（例如 `status: dissolved`）。实体类型目录允许 `active ↔ inactive` 和 `active → retired` 的双向转换。
- **参考策略：** 阵营实体默认参考资格为 `live`（仅当前存在的实体可被引用）。
