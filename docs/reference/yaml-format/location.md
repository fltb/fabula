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
| `initialState` | `Record<string, unknown>`（可选） | 起始世界状态键值对——经 `InMemoryEntityRegistry` 成为该位置在故事中的初始属性；省略时实体只携带空 state（外加重放写入的属性） |
| `notableFeatures` | `string[]`（可选） | 该位置值得注意的特征列表；仅保留在 `ProjectData.locations` 上，不投影进注册表 `state` 或任何上下文 |

### 运行时属性

位置实体的可写属性**不是内置或跨项目通用的**：每个项目在 `definitions/entity-types.yaml`
的 `types.location.attributes` 中声明（例如 zhu-fu 的 location 类型声明 `lifecycle`、
`atmosphere`、`season`、`social_mood`、`status`、`threshold_available` 等；dream-of-red-chamber
另有 `cost`、`population`、`household_state`、`ritual_purity` 等）。每条属性声明
`valueType`、`requiredAt`、`writePolicy`（`immutable`/`write_once`/`mutable`/
`lifecycle_managed`）、`unsetAllowed` 等；重放写入经 `validateCatalogWrite()`
（`state/event-application.ts`）强制校验——未知声明/未知属性、value schema、writePolicy、
lifecycle 转换与 `unsetAllowed` 不满足即抛 `ConfigError`。`lifecycle` 属性（若声明为
`lifecycle_managed`）是唯一能改变实体生命周期状态的写入通道。

## 地点的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadProject()` 读取 `definitions/locations/` 下的所有 YAML 文件，并通过 `locationDefinitionSchema`（Zod）验证每个文件，返回解析后的 `LocationDefinition` 对象；`InMemoryEntityRegistry.load()` 再把这些定义注册为 `kind: 'location'` 的 `Entity`（`typeRef: { typeId: 'location', schemaVersion: 1 }`），`initialState` 的值成为注册表中实体的初始 `state`。

2. **EntityRegistry → WorldState** — 在编译期，规范内核 `loadCanonicalProject()`（`entity/project-runtime.ts`）的 `buildInitialFacts()` 把**初始激活**（`introduction.type === 'initial'`）声明的实体 `state` 键值对转成初始事实（`entityId.attribute`，值经 `canonicalizeFactValue` 归一化），`applyInitialFacts()`（`state/event-application.ts`）在事件重放前写入 `WorldState.entities` 并追加到 `WorldState.facts`；由事件 `introduces` 激活的位置不在初始事实中，其激活发生在对应的 `system:introduction:*` transition。

3. **WorldState 持久化** — 当 `StateManager` 重放事件时，`WorldState.entities` 中位置的属性通过后置条件解析进行更新。可写属性集合由项目 `definitions/entity-types.yaml` 的 location 类型声明决定，写入按 `validateCatalogWrite()` 校验（见上文「运行时属性」）。

4. **上下文使用** — `ContextPackage` 没有位置投影；上下文编译器只投影角色快照与活动规则。位置的 `initialState` 属性可经其他路径被引用，但 `parent`、`notableFeatures` 等字段不进入任何上下文包。

## 示例（来自 zhu-fu 测试夹具: luchen_town.yaml）

```yaml
id: luchen_town
name: "鲁镇"
kind: town
description: "鲁镇是浙江的一个水乡小镇，有河，有桥，有瓦房和石板路。年终时全镇都在准备'祝福'——杀鸡、宰鹅、买猪肉，女人们的手臂在水里浸得通红。空气中弥漫着幽微的火药香（爆竹）。镇东头是河边，祥林嫂被绑架的地方；镇西头有土地庙。鲁镇是一个封闭的传统社会——每个人互相认识，消息通过卫老婆子这样的中间人流通，社会等级分明。镇上的'看客'文化是故事的重要背景：人们对祥林嫂的悲剧从同情到厌烦再到嘲弄，最终遗忘。"
notableFeatures:
  - "镇东头的河边——祥林嫂淘米被绑架处，也是她沦为乞丐后与'我'相遇处"
  - "镇西头的土地庙——祥林嫂捐门槛的地方"
  - "各家门前的祝福祭祀——年终大典，男人主持，女人准备"
```

示例与 `fixtures/zhu-fu/definitions/locations/luchen_town.yaml` 一致：该夹具**未声明**
`initialState` 与 `parent`（均为可选字段），`notableFeatures` 在夹具中有 5 条，此处节略。

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

- **引入：** 通过事件的 `introduces` 数组引入新位置（`introduceEntrySchema`：`type: location` + `id` + `initialState`）。规范内核 `loadCanonicalProject()` 的 `collectIntroductions()` 收集全部 introduces：同一实体只能由恰好一个事件引入（重复 → `ConfigError`）；若该实体已有定义文件且仍声明非空 `initialState`，同样报错（初始状态必须移到引入边界）。definition-less 的引入位置由内核按引入数据注册（`kind: 'location'`、`typeRef`、`initialState`），并为每个引入合成 `system:introduction:<hostEvent>:<entityId>` transition——置于宿主事件之前并加入其 `causalPredecessors`，重放时写入 `lifecycle: active` + `initialState` 各键。`compileProject()` 的投影只暴露分离的规范化数据与只读 `EntityLookup`，不暴露 registry。
- **停用：** 位置的运行时生命周期通过写 `lifecycle` 属性（`active`/`inactive`/`retired`）的后置条件改变；`validateCatalogWrite()`（`state/event-application.ts`）对 `lifecycle_managed` 的 `lifecycle` 属性校验 `allowedLifecycleStates` 与类型目录的 `lifecyclePolicy.allowedTransitions`，并拒绝同一 story 坐标上的重复 lifecycle 变更与对 retired 实体的非 lifecycle 写入。转换集合由项目目录声明——zhu-fu 的 location 类型允许 `active ↔ inactive`、`active → retired`、`inactive → retired`，`retired` 是终态，不可恢复。`status: destroyed` 等只是普通状态键，不改变生命周期；真正退休需要显式写 `lifecycle: retired`。
- **参考策略：** `referenceCapabilities.defaultEligibility` 是项目 `definitions/entity-types.yaml` 中每个类型**必填**的元数据（zhu-fu 的 location 类型声明 `live`），但重放路径不读取它——参与资格由 `validateParticipants()` 强制：参与者必须已 live 或由同一事件的后置条件引入（缺席实体 → `ConfigError`「not live」），已退休（`retired`）实体不能参与；`validatePreconditions()` 对引用未 live 实体的前件直接报错。后置条件对未 live 实体的首次写入会创建该实体（激活），但这不是“任意引用未知实体”的通道——写入本身仍受目录的未知声明/未知属性校验。不要把 `defaultEligibility` 描述为运行时强制契约。
