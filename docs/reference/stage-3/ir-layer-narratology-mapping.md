# IR层-叙事学映射审计

> 项目名称：Fabula（取自俄国形式主义 fabula/syuzhet 二分法）
> 本文档审计当前 IR 层设计状态，并将其映射到对应的叙事学传统。

---

## 概述

Fabula 系统的核心架构洞察来自**叙事学（Narratology）与编译器设计的交叉**。系统设计了类似 LLVM 的多层中间表示（IR），将小说创作工程化为可验证、可回放、可分支的流水线。本文档逐层审计当前实现状态，校正已过时的"仅 2/5 IR 层建成"的论断。

### IR 流水线设计

```
Idea IR → Story IR → Scene IR → Event IR → World State → Novel Text
```

以及一个 PROJECT.md 未明确命名但类型系统已构建的第 6 层：

**Syuzhet/Discourse 层**（与 World State 平行，独立于 Fabula 时间线）

---

## 逐层审计

### 1. Idea IR — 亚里士多德 Mythos（主题意图）

| 维度 | 状态 |
|------|------|
| **叙事学对应** | 亚里士多德《诗学》Mythos（情节灵魂——"这个故事表达什么"）。亚里士多德认为 Mythos 是悲剧六要素中**最重要的**。 |
| **设计状态** | PROJECT.md 第 §1 节命名了 Idea IR，描述为"灵感/需求 → 结构化叙事意图（LLM 解析）"。**无正式规格。** |
| **实现状态** | **ABSENT** — 无类型、无 schema、无映射器、无 fixture、无验证器 |
| **建模内容** | 这部作品的主题内核：它想表达什么（"革命吞噬它的孩子"、"傲慢导致毁灭"）、目标读者情感弧、核心冲突类型/主题。这决定了所有下层叙事选择。 |
| **缺口** | 完全缺失。系统没有任何方式表达"这个故事的 thematic intent 是什么"。现有的 `emotionalValence`、`conflictType`（在 NarrativeEvent 上）是逐场景的，不是整体层面的。需要以下类型：`ThematicIntent`（主题声明 + 子主题）、`TargetAudienceProfile`、`CoreConflictDeclaration`、`EmotionalArcDefinition`。 |

---

### 2. Story IR — 普罗普 31 功能 + 格雷马斯行动元（结构骨架）

| 维度 | 状态 |
|------|------|
| **叙事学对应** | 弗拉基米尔·普罗普《民间故事形态学》（31 种叙事功能）+ 阿尔吉达斯·格雷马斯《结构语义学》（行动元模型：主体/客体/发送者/接收者/帮助者/反对者）。这层处理的是事件的**结构功能**——不关心具体内容，只关心每个事件在宏观结构中的角色。 |
| **设计状态** | PROJECT.md 第 §1 节命名了 Story IR，描述为"整体结构 → 时间线 DAG + Thread 图（程序管理）"。**无正式规格。** |
| **实现状态** | **ABSENT** — 无 Propp/Greimas 类型、无结构功能 schema、无映射器、无 fixture、无验证器 |
| **建模内容** | 事件的抽象结构角色：当前事件是"英雄接受召唤"还是"与反派对决"？它推进了哪条叙事线（主 quest / 支线 / 人物弧）？故事总体是"英雄之旅"还是"陷入地狱"还是"追寻"？ |
| **部分覆盖** | 系统确实有部分邻近概念：`arcPosition`（opening/rising/climax/falling/denouement）跟踪弗莱塔格金字塔的位置；`ThreadProgressEntry` 跟踪剧情线程推进。但这**不是**结构功能分析——arcPosition 描述的是节奏位置，不是事件在结构中的语义角色。`Thread` 系统（`ThreadTransaction`、`ThreadLifecycle`）确实跟踪目标导向的叙事线，但缺少将线程建模为结构功能容器的能力（例如：Thread 可以携带 Propp 函数标签）。 |
| **缺口** | 需要：`StructuralFunction` 类型（Propp 31 函数的子集或扩展）、`ActantModel`（为每个事件/角色分配行动元角色）、`StoryArchetype`（英雄之旅/悲剧/追寻等的结构模板）。现有的 Thread 系统是一个**天然起点**——线程可以携带结构函数标签，但当前没有映射。 |

---

### 3. Scene IR — 热奈特话语单元（场景级话语元数据）

| 维度 | 状态 |
|------|------|
| **叙事学对应** | 热拉尔·热奈特《叙事话语》——叙事话语分析的五范畴。Scene IR 主要负责**时长**（场景/概要/省略/停顿/拉伸）、**语式**（距离/聚焦）、**语态**（叙述层次、叙述者类型）、**时序**（顺叙/倒叙/预叙）。PROJECT.md 描述的"场景意图 → Scene Contract"接近热奈特的场景级话语契约。 |
| **设计状态** | PROJECT.md 第 §1 节命名了 Scene IR，描述为"场景意图 → Scene Contract（程序编译）"。有正式规格但未完全展开。 |
| **实现状态** | **schema-wired**（完整契约编译）+ **fixture-used**（场景元数据字段） |
| **已建成** | 两个层面的实现：<br/><br/>**(a) 场景元数据字段**（NarrativeEvent 上的内联字段）——faculty-used：<br/>- `sceneType`: `linear` / `flashback` / `flashforward` / `dream` / `parallel` —— **Genette 时序**<br/>- `discourseMode`: `action` / `dialogue` / `description` / `exposition` / `reflection` / `transition` —— **Genette 语式（距离）**<br/>- `arcPosition`: `opening` / `rising` / `climax` / `falling` / `denouement` —— **弗莱塔格金字塔（节奏）**<br/>- `tense`: `past` / `present` —— **叙事时态**<br/>- `pov.type`: `first_person` / `third_person_limited` / `omniscient` —— **Genette 聚焦**<br/><br/>这些字段在以下位置全面使用：<br/>- 类型定义：`packages/core/src/types/event.ts`<br/>- Schema 定义：`packages/core/src/schemas/event.ts`<br/>- 实体映射器：`packages/core/src/entity/mapper.ts`（从 YAML 映射到运行时类型）<br/>- API 变更跟踪：`packages/core/src/api.ts`<br/>- 渲染分析提示：`packages/core/src/ai/prompts/render-analysis.ts`<br/>- 五个验证器：`POVValidator`、`PacingValidator`、`TenseConsistencyValidator`、`DiscourseBalanceValidator`、`AliasValidator`<br/>- 三大 fixture：David Copperfield、四世同堂、祝福均有完整使用<br/><br/>**(b) CompiledSceneContract**（完整编译后的场景契约）——schema-wired：<br/>- 类型定义：`packages/core/src/types/render-surface.ts`<br/>- 编译器：`packages/core/src/render/scene-contract.ts`（`compileSceneContract()`）<br/>- Schema：`packages/core/src/schemas/render-surface.ts`<br/>- 消费者：`SurfacePlanner`、`LogicalDisclosureSummaryCompiler`<br/>- 测试覆盖：`surface-planner.test.ts`、`summary.test.ts` |
| **缺口** | **(a) 热奈特 Duration 缺失**：系统没有类型表示省略（ellipsis）、概要（summary）、停顿（pause）、拉伸（stretch）。注意：`NarrativeEllipsis` 是**语料库诊断类型**，不是热奈特话语省略——它标记不可渲染的叙事间隙，不参与话语时长分析。<br/><br/>(b) `CompiledSceneContract` 包含边界哈希但不包含时长类型或话语级焦点——它目前偏向编译/缓存基础设施而非纯叙事学建模。<br/><br/>(c) 热奈特 Frequency（单叙/反复/迭代）完全缺失。 |

---

### 4. Event IR — 俄国形式主义 Fabula（事件 + 因果链）

| 维度 | 状态 |
|------|------|
| **叙事学对应** | 俄国形式主义（什克洛夫斯基、托马舍夫斯基）的 **fabula**——按时间顺序排列的事件，附带因果逻辑关系。PROJECT.md 将其描述为"叙事事件 → Definition→Event→Rule→State 四元组"。这是系统的核心强度所在。 |
| **设计状态** | PROJECT.md 第 §1 节详细描述。PROJECT.md 的"五层领域模型"（Definition→Event→Rule→State→Knowledge）本质上就是这个 Event IR 加上独立的 Knowledge 层。 |
| **实现状态** | **fixture-used**（完全建成并接入） |
| **已建成** | `NarrativeEvent` 类型包含：id、event 名称、narrativeOrder、storyTime、narrationTime、preconditions（前置条件 Fact 数组）、postconditions（后置条件 Fact 数组）、threadProgress、foreshadowing、relationshipEffects、ruleEffects、branchExistence（分支集合）、participants、cast、status、styleGuidance。完整 schema 验证（`eventFileSchema`）。Event File 到运行时的映射器（`entity/mapper.ts`）。变更跟踪（`api.ts`）。DAG 图导出（`dag-export.ts`）。五套 fixture 使用事件文件（David Copperfield 20 事件、四世同堂 20 事件、祝福 7 事件、红楼梦 17+ 事件、最危险的游戏）。 |
| **验证器覆盖** | 十个+ 验证器操作 Event IR 数据：时间线验证器（`TimelineValidator`）、因果验证器（`CausalValidator`）、伏笔验证器（`ForeshadowValidator`）、POV 验证器、节奏验证器（`PacingValidator`）、时态一致性验证器（`TenseConsistencyValidator`）、话语平衡验证器（`DiscourseBalanceValidator`）、分支合并验证器、世界规则验证器、角色状态验证器、知识验证器。 |
| **缺口** | 当前 Event IR 将场景元数据（sceneType、discourseMode 等）作为事件字段嵌入。这在概念上是正确的（场景是话语事件），但应该与纯 fabula 字段（preconditions、postconditions、causal edges）更清晰地分离，以便 discourse 和 story 时钟可以独立运行。 |

---

### 5. World State — 查特曼存在物（角色与设定状态）

| 维度 | 状态 |
|------|------|
| **叙事学对应** | 西摩·查特曼《故事与话语》中的**存在物（existents）**——角色（character）与环境（setting）。这是"故事世界在任意时刻的当前状态"。PROJECT.md 描述为"Definition→Event→Rule→State→Knowledge"四元组中的 State 层。 |
| **设计状态** | PROJECT.md 第 §1 节详细描述。PROJECT.md 的整个"五层领域模型"都围绕这一层。 |
| **实现状态** | **fixture-used**（完全建成并接入） |
| **已建成** | 完整的实体管理系统（角色、地点、关系）定义在 YAML fixture 中，支持运行时 replay。Entity 注册表、状态快照、状态回放引擎。知识层（Knowledge）作为一等实体——独立的 InformationAct 类型（Learn/Forget/Misbelieve/Deceive/Reveal）。关系系统（RelationshipTransaction）支持 n 元关系、维度写入、身份转换。线程系统（ThreadTransaction）跟踪叙事进程。规则系统（RuleTransaction）处理世界规则变迁。每个 fixture 目录包含 `definitions/` 子目录及 `state_initial.yaml`。 |
| **验证器覆盖** | CharacterStateValidator、WorldRuleValidator、KnowledgeValidator |
| **缺口** | 最小。PROJECT.md 中描述的"五层领域模型"（Definition→Event→Rule→State→Knowledge）已经完全实现并 fixture-verified。 |

---

### 6. Syuzhet / Discourse 层 — 热奈特叙事话语（如何讲述故事）

| 维度 | 状态 |
|------|------|
| **叙事学对应** | 俄国形式主义的 **syuzhet** 与热奈特的《叙事话语》——不是"发生了什么"，而是"故事如何被讲述"。这包括叙述者选择揭示什么、何时揭示、从谁的视角、用什么权威说话。这是整个话语控制系统。 |
| **设计状态** | **PROJECT.md 未命名**——这不属于原文中"5 层 IR 流水线"的一部分。系统在 PROJECT.md 外部（通过 `docs/todos/graph-discourse-render.md` DISCOURSE-1 规范）开发了这一层。但**类型系统已经构建了一个完整但未接入的 Syuzhet 层**。 |
| **实现状态** | **schema-wired + replay engine + tested**（但 fixture-dead） |
| **已建成（惊人的完整）** | 这可能是代码库中最令人惊讶的审计结果——系统有一个完整但未接入的话语层：<br/><br/>**(a) 类型系统**（`types/discourse.ts`）：<br/>- `DiscourseState`：完整的话语状态（位置、reveals、开放声明、撤回、修正、提示、扣留策略、叙述者档案、主张目录）——明确声明"NOT part of WorldState"<br/>- `NarratorProfile`：4 种类型（focalizer_bound、retrospective_entity、explicit_ledger、omniscient），每种具有独立的能力（access、truth、fidelity、sincerity）——这是**热奈特语态 + 语式（聚焦）**<br/>- `DisclosureAction`：7 种类型（reveal、claim、hint、retraction、correction、withhold_start、withhold_end）——这是**话语控制原语**<br/>- `Hint`：6 状态生命周期（planned→planted→reinforced→fulfilled/subverted→retracted）——**叙事伏笔管理**<br/>- `PlannedDiscourseLedger`：计划的话语揭示的规范分类账——**在事件发生前决定话语策略**<br/>- `DiscourseContextProjection`：Pass 1 编译上下文，按叙述者能力区分<br/>- `DiscoursePosition`：话语排序的内建基数类型（类似 narrativeOrder 但用于话语时间）<br/><br/>**(b) Schema 系统**（`schemas/discourse.ts`）：每个上述类型都有对应的 Zod schema。全部从 `schemas/index.ts` 导出。<br/><br/>**(c) 回放引擎**（`state/discourse-replay.ts`）：<br/>- `replayDiscourseState()`：将 PlannedDiscourseLedger 回放到给定 DiscoursePosition，输出不可变的 DiscourseState。强制执行所有 19 条 DISCOURSE-1 约束。<br/>- `projectDiscourseContext()`：从 DiscourseState 构建 Pass 1 上下文投影<br/>- `areProjectionsIdentical()`、`canReveal()` 等辅助函数<br/><br/>**(d) 编译器**（`summary/logical-compiler.ts`）：<br/>- `LogicalDisclosureSummaryCompiler`：从 DiscourseState + CompiledSceneContract + DiscourseContextProjection 生成安全摘要，确定性（无 LLM 调用）。<br/><br/>**(e) 测试**（`discourse-replay.test.ts`）：完整覆盖——边界检查、reveal/claim/hint/retraction/correction/withhold 生命周期、提示状态转移、错误处理。<br/><br/>**(f) 集成类型**（`schemas/integration.ts`）：`DiscourseSnapshot`、`scenePresentationSchema`、`discourseBridgeSchema`、`discourseNodeSchema`——映射到 CoverageManifest。 |
| **未建成** | **(a) 零个 fixture 使用 PlannedDiscourseLedger**：没有 YAML 文件（在 fixtures/ 下）声明 discourse ledger 条目、NarratorProfile 或 DisclosureAction。所有 David Copperfield 事件文件使用简单的 `pov.type: first_person` 而非丰富的 NarratorProfile 系统。所有 100+ 事件文件使用 `tense`、`discourseMode` 等场景元数字段，但 DiscoursePosition 链从未在 fixture 中编码。<br/><br/>(b) 回放引擎未从 fixture 加载：虽然有 `replayDiscourseState()`，但系统管道中没有任何部分从已解析的 YAML 调用它。 DiscourseState 仅通过 `LogicalDisclosureSummaryCompiler` 在测试中创建。<br/><br/>(c) 没有 Pass 2 观察消费：`DisclosureObservation` 类型和 schema 存在，但从 prose 提取话语观察的回环未实现。<br/><br/>(d) `PlannedDiscourseLedger` 在 DiscourseState 中引用 `hash`，但没有从源 YAML 生成该哈希的映射器。 |
| **"死类型"问题** | 整个 Syuzhet 层是一个**接线缺口，而非设计缺口**。设计已经完成（19 条约束、4 种叙述者类型、7 种揭示行动、6 种提示状态），类型、schema、回放引擎和测试都已就位。缺少的只是：从 YAML fixture 加载 PlannedDiscourseLedger 并沿着 discourse position 回放的管道。这是一个**实现任务**——不是设计任务。 |

---

## 更正"2/5 建成"的论断

TODO.md 当前声称 5 层 IR 中仅 2 层已建成。以下是精确状态：

| 层 | 叙事学映射 | 精确实现状态 | TODO 状态 |
|----|-----------|-------------|-----------|
| Idea IR | 亚里士多德 Mythos | **ABSENT** | 正确标记为缺失 |
| Story IR | 普罗普 31 功能 + 格雷马斯行动元 | **ABSENT**（但 Thread 系统是天然起点） | 正确标记为缺失 |
| Scene IR | 热奈特话语单元 | **SCHEMA-WIRED（契约编译）+ FIXTURE-USED（元数据字段）** | 错误标记为"缺失"——场景元数据字段全面使用，CompiledSceneContract 已编译并测试 |
| Event IR | 俄国形式主义 Fabula | **FIXTURE-USED**（完全建成并活跃） | 正确标记为已建成 |
| World State | 查特曼存在物 | **FIXTURE-USED**（完全建成并活跃） | 正确标记为已建成 |
| **Syuzhet/Discourse**（PROJECT.md 未命名） | 热奈特叙事话语 | **SCHEMA-WIRED + REPLAY ENGINE + TESTED**（但 fixture-dead） | TODO 完全未提及此层 |

**更正后的论断**：
- 5 层中的 **2 层**完全建成并活跃（Event IR、World State）— 正确
- 5 层中的 **1 层**（Scene IR）部分建成，比 TODO 承认的更完整——元数据字段 fixture-used，完整契约 schema-wired
- **1 个未设计层**（Syuzhet/Discourse）存在于类型系统、schema、回放引擎和测试中，但未接入 fixture — 这是接线缺口，非设计缺口
- 5 层中的 **2 层**确实缺失（Idea IR、Story IR）— 正确

---

## 更正后的 IR 层总表

| # | 层 | 叙事学映射 | 叙事学理论家/传统 | 实现状态 | 缺口 |
|---|-----|-----------|------------------|----------|------|
| 1 | **Idea IR** | 主题意图（Mythos） | 亚里士多德（《诗学》） | **ABSENT** | 完全缺失。需要整体主题意图类型（ThematicIntent、EmotionalArcDefinition） |
| 2 | **Story IR** | 结构骨架 | 普罗普（31 功能）+ 格雷马斯（行动元） | **ABSENT** | 无结构功能类型。Thread 系统是天然起点（可携带 Propp 函数标签）。arcPosition 提供节奏位置但非功能语义 |
| 3 | **Scene IR** | 场景级话语元数据 | 热奈特（时序/语式/语态/时长/频率） | **SCHEMA-WIRED + FIXTURE-USED** | 热奈特 Duration（场景/概要/省略/停顿/拉伸）缺失；Frequency 完全缺失；CompiledSceneContract 偏向编译缓存而非纯叙事学建模 |
| 4 | **Event IR** | 时间顺序事件 + 因果链（Fabula） | 俄国形式主义（什克洛夫斯基、托马舍夫斯基） | **FIXTURE-USED** | 最小。场景元数据字段嵌入在 NarrativeEvent 中，应逐步分离为独立话语层字段 |
| 5 | **World State** | 存在物（角色 + 设定） | 查特曼（《故事与话语》） | **FIXTURE-USED** | 最小。五层领域模型已实现 |
| 6 | **Syuzhet / Discourse** | 叙事话语控制（如何讲述） | 热奈特（《叙事话语》）| **SCHEMA-WIRED + REPLAY ENGINE + TESTED（但 fixture-dead）** | **接线缺口**：PlannedDiscourseLedger 未从 YAML fixture 加载；NarratorProfile（4 类型）定义了但未使用——pov.type 简易字段取而代之；话语回放未接入生产管道。设计完整但未集成 |

---

## 关键发现

1. **TODO 低估了 Scene IR 的完成度**。场景元数据字段（sceneType、discourseMode、arcPosition、tense、pov.type）在类型、schema、映射器、验证器和 fixture 中全面使用。完整 `CompiledSceneContract` 已编译并测试。

2. **TODO 完全未提及 Syuzhet/Discourse 层**。代码库中有一个完整但未接入的话语控制系统——4 种叙述者类型、7 种揭示行动、6 种提示状态、完整回放引擎、104+ 测试用例。这块存在的代码代表了数周的设计+开发工作，在当前 TODO 中不可见。

3. **TODOs 优先级需要重新评估**。将 Syuzhet 层接入 fixture（从 YAML 加载 PlannedDiscourseLedger、连接话语回放）可能比从零构建 Idea IR 或 Story IR 更高效，因为所有基础设施类型和逻辑已就位。

4. **Story IR 有一个自然起点**。现有的 Thread 系统（`ThreadTransaction`、`ThreadLifecycle`、`ThreadTypeDefinition`）已经跟踪目标导向的叙事进程。将结构功能标签（Propp 函数的子集）添加到 Thread 声明中是 Story IR 的低成本第一步。
