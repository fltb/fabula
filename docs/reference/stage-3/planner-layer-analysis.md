# Fabula Planner Layer Analysis

> 撰写日期：2026-07-24
> 分析范围：Fabula 系统的叙事规划（Narrative Planning）层——TODO.md 中完全缺失的前向事件生成层
> 项目名：Fabula（仓库 github.com/fltb/fabula）

---

## 目录

1. [什么是叙事规划（Narrative Planning）](#1-什么是叙事规划narrative-planning)
2. [在管线中的位置](#2-在管线中的位置)
3. [与 Discovery Layer 的关系](#3-与-discovery-layer-的关系)
4. [系统已有的 Planner 可消费资产](#4-系统已有的-planner-可消费资产)
5. [Planner 缺失的部分](#5-planner-缺失的部分)
6. [方案提案：3 种模式](#6-方案提案3-种模式)
7. [为什么这关乎「核心问题」](#7-为什么这关乎核心问题)

---

## 1. 什么是叙事规划（Narrative Planning）

### 问题定义

叙事规划解决的问题是：给定当前故事世界状态 + 人物目标 + 故事弧约束，**下一个应该发生什么事件？**

在 Fabula 系统的完整管线中，这是「Fabula（发生了什么）」的输入侧——规划器决定事件候选集，然后作者（或系统）从中选择并写入 YAML。

### 学术与实践基础

#### GOAP（Goal-Oriented Action Planning）

源自游戏 AI（Jeff Orkin, F.E.A.R., 2006）。核心思想：智能体拥有目标（Goal）和一组可用行动（Action），每个行动有前置条件（preconditions）和效果（effects）。规划器搜索行动序列使目标达成。

```
Goal: 消除威胁
├── Action: 寻找掩体（pre: 附近有掩体，effect: 防御力↑）
├── Action: 射击（pre: 武器已上膛 ∧ 敌人可见，effect: 敌人生命值↓）
└── Action: 呼叫支援（pre: 通讯设备可用，effect: 援军到达）
```

**对叙事规划的意义**：角色的目标可以直接驱动事件选择。一个角色想要复仇（goal），就需要一系列故事事件来实现这个目标。

#### HTN（Hierarchical Task Networks）

Dana Nau 等人（UMD, 1999-2004）。将复杂任务分解为子任务，直到原子行动。在叙事中表现为「故事节拍」的层次化分解：

```
Act I (Opening)
├── Establish Status Quo (E1: 展示主角日常生活)
├── Inciting Incident (E2: 冲突触发)
└── Response (E3: 主角反应)
```

**对叙事规划的意义**：故事弧本身就是 HTN 的天然表达——「高潮」不是一个原子事件，而是一系列子事件的完成。

#### 节拍（Beat）规划器

**Facade（Mateas & Stern, 2005）**：首个 AI 驱动的交互式戏剧。使用 drama manager + beat system。每个 beat 有一个「期望的弧」（desired arc），drama manager 根据玩家行为实时选择下一个 beat 来推进故事。Beat 之间有转换条件（transition），触发条件由世界状态变化决定。

**Portia（BEST PAPER, ICIDS 2015, Riedl 组）**：基于故事世界模型和角色目标的叙事规划器。将故事规划表达为因果链搜索——给定初始状态和期望终态，搜索事件序列使因果链闭合。

#### 叙事规划 vs. 对话生成

需要区分：Fabula 缺少的是**事件级**规划器（决定下一个场景的结构和因果内容），不是对话/文字生成的规划器。LLM 负责后者（prose generation），前者是结构性的、可确定性验证的。

---

## 2. 在管线中的位置

### Fabula 完整叙述管线

```
World Model → Character State → Fabula → Planner → Syuzhet → Surface Realization
```

在 Fabula 系统中，具体映射为：

```
definitions/ (角色/地点/规则)
    ↓
WorldState (实体状态 + 关系 + 知识 + 线程 + 规则)
    ↓
[Planner] ← 缺失
    ↓
NarrativeEvent (带 preconditions/postconditions 的 YAML 事件)
    ↓
Event DAG (buildCausalEdges → 因果边)
    ↓
Assembler (narrativeOrder 排序 → Syuzhet)
    ↓
RenderPipeline (Pass 1 散文 + Pass 2 分析)
```

### Planner 确切位置

Planner 位于 **WorldState 之上，NarrativeEvent 之前**：

```
WorldState (当前是什么状态)
    ↓
Planner (计算：下一步应该发生什么？)
    ↓
候选事件 (NarrativeEvent 建议)
    ↓
作者选择 / 系统确认
    ↓
写入 events/ 目录 YAML
    ↓
EntityMapper 载入 → Event DAG → 后续管线
```

### 当前系统实际现状

当前代码库的管线是**断裂的**。验证：

- `packages/core/src/render/surface-planner.ts` 是 SURFACE 层规划器——它把「已写好的事件」分组成渲染批次（parallel/serial_surface），完全不涉及「下一个事件应该是什么」。它的 `PlannerMode`（manual/suggest/auto）指渲染分组策略，不是叙事事件规划。
- `packages/core/src/ai/prompts/thread-status.ts` 有一个 LLM prompt 做「suggest 1-3 immediate next narrative actions」，但它是**文本输出、一次性诊断工具**，不是结构化、可验证的规划器。它只接收 `{thread.id, name, progress, lastEvent}`，不访问 WorldState、character goals、arc constraints。
- 所有 `fixtures/zhu-fu/` 和 `fixtures/dream-of-red-chamber/` 的事件都是手写 YAML——没有生成过程，只是手动编辑。

**结论**：没有代码、没有类型、没有 schema、没有 fixture 涉及前向事件生成。

---

## 3. 与 Discovery Layer 的关系

### 核心区分

| 维度 | Discovery Layer（反向） | Planner（前向） |
|------|------------------------|------------------|
| 方向 | 散文 → YAML（输入侧） | YAML → 下一个 YAML（输出侧） |
| 解决谁的问题 | 已有草稿 → 系统格式 | 系统格式 → 下一个事件 |
| 输入 | 非结构化散文（人类草稿） | WorldState + character goals + arc |
| 输出 | 结构化事件（NarrativeEvent） | 候选事件建议 |
| AI 角色 | 从文本抽取结构化信息 | 从状态推演下一步叙事 |
| TODO 状态 | S5（schema-aware generation）+ Discovery Layer 未命名 | **完全缺失** |

### TODO.md 中的盲区

TODO.md 的「核心问题」章节详细讨论了 YAML 创建成本过高的问题：

> YAML 的工作量过于巨大，甚至超过了故事本身的创作成本

但解决方案只讨论了 Discovery 方向——如何从人类草稿（散文）生成 YAML。它没有讨论 Planner 方向——如何从已有 YAML + state 自动化生成**下一个** YAML。

这造成了**单向解决**：即使 Discovery Layer 完美工作，作者也只需要写草稿而不是 YAML。但当草稿写完后，创作下一个事件仍然需要全新的草稿。Planner 打破了这种「每个事件都需要外部输入」的依赖。

### 两者的关系

```
                            Discovery Layer
                    人类草稿 ────────────────→ 初始 YAML
                                                   │
                                                   │ Planner
                                                   ↓
                   人类草稿 ────────────────→ 下一个 YAML ←── 候选事件建议
                        ↑                                │
                        └─────────────────────────────────┘
                            作者选择 / 修改
```

两者不是替代关系，而是互补关系。Discovery Layer 解决「第一次导入」问题，Planner 解决「连续创作」问题。

---

## 4. 系统已有的 Planner 可消费资产

以下类型的代码/数据已被验证存在于代码库中，Planner 可以直接消费：

### 4.1 WorldState（完整状态表示）

```typescript
// packages/core/src/types/world.ts
interface WorldState {
  entities: Record<EntityId, Record<string, unknown>>;     // 实体属性
  relationships: Record<RelationshipId, RelationshipRuntimeState>; // 关系状态
  knowledge: Record<EntityId, { knownFacts: FactId[] }>;   // 人物知识
  epistemicLedger?: EpistemicLedger;                        // 知识态度
  propositionCatalog?: PropositionCatalog;                  // 命题目录
  threads: Record<string, ThreadRuntimeState>;              // 线程运行时状态
  rules: Record<string, RuleRuntimeState>;                  // 规则运行时
  facts: Fact[];                                            // 事实集合
}
```

**Planner 用法**：这是规划器的核心输入——当前所有实体、关系、线程、规则的状态快照。

### 4.2 线程系统（ThreadRuntimeState）——候选目标系统

```typescript
// packages/core/src/types/thread.ts
interface ThreadRuntimeState {
  threadId: ThreadId;
  status: ThreadLifecycle;         // planned | active | blocked | completed | abandoned | retired
  currentRunId: ThreadRunId;
  phase: string;                    // 当前阶段（由 ThreadTypeDefinition.allowedPhases 定义）
  bindings: Record<string, string>; // 角色绑定
  goalStates: Record<string, GoalLifecycle>;  // 目标状态（pending/active/achieved/failed/waived）
  milestoneStates: Record<string, MilestoneLifecycle>; // 里程碑状态
}
```

**Planner 用法**：
- `goalStates` 中的 `active` 目标是规划器的直接输入——未完成的目标驱动事件生成
- `status` 和 `phase` 告诉规划器线程当前的生命周期位置
- `ThreadTypeDefinition.allowedPhases` 提供了阶段转换的序列约束

**关键发现**：线程系统已经有目标（goal）和里程碑（milestone）的 schema，但它们是**被动追踪**的——只在事件载入后被检查（achieved/failed/waived），不主动用于驱动事件选择。

### 4.3 弧位置（arcPosition）

```typescript
// packages/core/src/types/event.ts (NarrativeEvent)
arcPosition?: 'opening' | 'rising' | 'climax' | 'falling' | 'denouement';
```

**Planner 用法**：这本身就是弧规划数据。规划器可以根据当前弧位置决定下一个事件的合理弧位置（例如：opening → rising, 不应 opening → denouement）。

### 4.4 事件模板（NarrativeEvent 结构）

```typescript
// packages/core/src/types/event.ts
interface NarrativeEvent {
  preconditions: Fact[];           // 前置条件——事件发生前必须为真的条件
  postconditions: Fact[];          // 后置条件——事件发生后会为真的条件
  threadProgress: ThreadProgressEntry[]; // 线程推进
  conflictType?: string;           // 冲突类型
  resolutionType?: string;         // 解决类型
  sceneType: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel';
  discourseMode: 'action' | 'dialogue' | ... ;
  participants: { entities: EntityId[] };
}
```

**Planner 用法**：每个已有事件的 `preconditions` 和 `postconditions` 构成了因果链知识。规划器可以学习：给定相同的 state 配置，类似的事件需要满足哪些条件。
- 事件之间的 causal edges（`buildCausalEdges()` 匹配 precondition ↔ postcondition）告诉规划器已完成的事件支持的因果路径。
- `conflictType`/`resolutionType` 提供冲突弧的追踪数据。

### 4.5 规则系统（RuleRuntimeState）

```typescript
// packages/core/src/types/rule.ts
interface RuleRuntimeState {
  activation: RuleActivation;      // dormant | enabled | suspended | revoked
  effectiveness: RuleEffectiveness; // full | limited | nullified
}
```

**Planner 用法**：规则定义了世界中「必须成立」或「不能发生」的条件。规划器在生成事件时必须使候选事件不违反当前有效的规则。

### 4.6 竞争系统参考（外部）

来自 `docs/reference/competitive-analysis.md` 的**InkOS Planner Agent**：

> 10 个 Agent（Radar → **Planner** → Composer → Architect → Writer → ...）。Composer agent 按相关性从 truth files 中检索内容，只拉取当前章节需要的事实。

**关联性**：Fabula 可以借鉴 InkOS 的分层 planner agent 结构，但将其从 LLM prompt 驱动的软系统升级为确定性 + LLM 辅助的硬规划系统。

**Yarn Spinner 的 Storylets + Saliency 系统**：

> 内容块附带 `when` 条件，系统在运行时按复杂度评分 + 最近使用惩罚选择最合适的块。

**关联性**：这本质上是状态驱动的事件选择——每一个 `storylet` 相当于一个候选事件。Saliency 评分是最简单的规划器形式。

---

## 5. Planner 缺失的部分

### 5.1 无目标表示（Beyond Thread Progress）

当前线程的 `goalStates` 只是 `Record<string, GoalLifecycle>`——一个被动状态标签。Planner 需要：

```
interface NarrativeGoal {
  goalId: string;
  threadId: string;          // 所属线程
  description: string;       // 自然语言描述
  type: 'achieve' | 'maintain' | 'avoid' | 'resolve';
  priority: number;          // 优先级（多个 active goal 时决策）
  preconditions?: Fact[];    // 此目标可触发的前置条件
  successCondition: {        // 成功条件（WorldState predicate）
    entity: string;
    attribute: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'exists';
    value: unknown;
  };
  suggestedEvents?: string[]; // 可达成此目标的事件类型/模板
}
```

### 5.2 无动作空间定义（Action Space）

规划器需要知道「在当前状态下，有哪些类型的事件是可能的」。当前系统没有任何事件类型目录或动作空间定义：

```
// 缺失的类型：ActionDefinition（动作定义）
interface ActionDefinition {
  actionId: string;
  name: string;
  description: string;
  preconditions: Precondition[];     // 执行此事件必须满足的状态条件
  effects: Effect[];                  // 执行后状态变化
  narrativeTags: string[];           // 叙事标签（romance, conflict, revelation...）
  typicalDuration: number;           // 典型持续时间（story time）
  typicalArcPositions: string[];     // 通常出现在哪些弧位置
  conflictTypes?: string[];          // 通常关联的冲突类型
  resolutionTypes?: string[];        // 通常关联的解决类型
  relatedThreadTypes?: string[];     // 通常推进的线程类型
}
```

### 5.3 无弧约束执行（Arc Constraint Enforcement）

```
// 缺失的断言：弧转换约束
// 例如：
// - "opening 阶段不得出现 denouement 类型的冲突解决"
// - "climax 必须在章节 N 之前到达"
// - "从 rising 到 climax 至少需要 3 个事件"
```

当前系统只在事件层面标记 `arcPosition`，不做弧间转换约束。

### 5.4 无分支感知规划（Branch-Aware Planning）

当前系统支持 branching（`BranchSet`, `BranchPath`），但规划器无法回答：

- 不同分支是否需要不同的事件序列？
- 分支合并点如何规划？
- 分支 A 的第 3 个事件和分支 B 的第 3 个事件是否应不同？

### 5.5 无候选评分/排序

当有多个候选事件时，规划器需要排序标准：

- **Thread Priority**：哪些线程当前优先级最高？
- **Arc Progress**：当前弧阶段需要推进到什么程度？
- **Pacing**：节奏要求（情感高潮后需要缓和场景）
- **Novelty**：避免重复相同模式的事件

### 5.6 验证确认

经过代码库搜索（`packages/core/src/`），**没有任何类型、函数、模块、schema 或 fixture** 实现以下功能：

| 能力 | 是否存在 | 证据 |
|------|----------|------|
| 前向事件生成 | ❌ | 所有事件是固定 YAML |
| Goal 驱动的规划 | ❌ | goalStates 是被动追踪 |
| 动作空间 | ❌ | 无 ActionDefinition 类型 |
| 弧约束 | ❌ | 仅有 arcPosition 标签 |
| 候选事件排序 | ❌ | 无评分/排序代码 |
| 状态→事件接口 | ❌ | 无 consume(state) → event[] |

---

## 6. 方案提案：3 种模式

建议采用与现有 `PlannerMode`（`'manual' | 'suggest' | 'auto'`）一致的 3 模式架构，但应用于**叙事事件规划**而不是渲染分组。

### 模式定义

```typescript
export type NarrativePlannerMode = 'manual' | 'suggest' | 'auto';
```

### 6.1 Manual 模式（作者手动写事件）

**现况**：当前系统的唯一模式。作者手写 YAML 事件文件。

**增强建议**：增加**前置条件验证**——在作者写完事件后，系统检查该事件的 preconditions 是否满足当前 WorldState。如果 preconditions 不成立，发出警告（类似系统已有的 validator，但针对性检查前向事件的可执行性）。

```
流程：
作者写事件 YAML → 前置条件验证 → 通过则加入事件 DAG
                   ↓ 不通过
                 警告 + 建议修复
```

### 6.2 Suggest 模式（系统建议 + 作者选择）

**新增**。系统根据当前 WorldState + active goals + arc position，生成 1-5 个候选事件建议。

```
流程：
WorldState + goals + arc → 规划器 → 候选事件列表（NarrativeEvent[]）
                                       ↓
                                   作者选择 / 修改 / 重生成
                                       ↓
                                   确认的事件 → 写入 YAML
```

**规划器内部**：

```
1. 查询所有 active goal（thread.goalStates[goalId] === 'active'）
2. 对每个 active goal，查找可推进该 goal 的事件模板
3. 验证候选事件的 preconditions 是否满足当前 WorldState
4. 按权重排序候选事件：
   - arcPosition 匹配度（当前是 rising → 推荐 rising 事件）
   - thread 优先级（高优先级 thread 的候选优先）
   - 时间连续性（storyTime 自然推进）
5. 返回 top-K 候选事件（含: event brief, preconditions, expected postconditions, thread advancement）
```

**首个实现版本的建议**：

- 不需要 LLM。确定性规则即可实现 suggest 模式（基于已有事件的 precondition/postcondition 模式匹配）。
- LLM 作为后期增强选项（为候选事件生成 sceneBrief 自然语言描述）。

### 6.3 Auto 模式（系统自动生成事件链）

**纯研究级**。系统自动生成完整事件链，作者只需审核修改。

```
流程：
WorldState + goals + arc constraints → 规划器
    ↓
规划器生成事件链（预测后 N 个事件）
    ↓
每个事件生成时验证：
   - 前置条件是否满足
   - 弧约束是否合规
   - 线程推进是否合理
    ↓
完整事件链 → 作者审核 → 修改/确认
```

**注意**：Auto 模式不是「LLM 自动写所有 YAML」——它是结构化规划器驱动的自动生成。LLM 只在 sceneBrief 文本生成和异常事件推荐时参与。

### 开发路线图

| 阶段 | 模式 | 内容 | 复杂度 |
|------|------|------|--------|
| 1 | Manual 增强 | preconditions 验证 | 低（复用现有 validator） |
| 2 | Suggest 确定性 | 基于模式的候选生成 + 排序 | 中（新增 ActionDefinition schema） |
| 3 | Suggest LLM 辅助 | LLM sceneBrief 生成 | 中（新增 prompt） |
| 4 | Auto 确定性 | 目标驱动的规划器 | 高（GOAP/HTN 算法） |
| 5 | Auto 全量 | 弧约束 + 分支感知 | 非常高 |

### 与 SurfacePlanner 的关系

| SurfacePlanner（已有） | NarrativePlanner（提案） |
|------------------------|--------------------------|
| 输入：已写好的场景 | 输入：WorldState + goals |
| 输出：渲染分组（RenderGroupManifest） | 输出：候选事件（NarrativeEvent[]） |
| 管线位置：Render 层 | 管线位置：Fabula 层 |
| 不修改事件/YAML | 生成新事件 → 写入 YAML |
| 3 种模式（manual/suggest/auto） | 3 种模式（manual/suggest/auto） |

SurfacePlanner 不影响 NarrativePlanner 的设计。两者可以共存：NarrativePlanner 决定「写什么事件」→ 作者确认 → YAML → Event DAG → SurfacePlanner 决定「如何分组渲染」。

---

## 7. 为什么这关乎「核心问题」

### TODO.md 的创作成本问题

由 TODO「核心问题」引述：

> YAML 的工作量过于巨大，甚至超过了故事本身的创作成本
> ...
> 作者写草稿的时候虽然要整理各种设定和各种规则和事件，但是他们可以用非结构化的方式记录

TODO 只诊断了一个方向的问题（散文→YAML 转换成本高），只提出了一个方向的解决方案（Discovery Layer/S5 schema-aware generation）。但「创作成本」有两个面：

1. **初始导入**：已有草稿/构思 → YAML（Discovery Layer 解决）
2. **持续创作**：写完 E3 → 写 E4（Planner 解决）

### Planner 如何降低持续创作成本

| 场景 | 无 Planner | 有 Suggest Planner |
|------|-----------|-------------------|
| 写 E4（开篇后第一个冲突） | 找纸/找文件 → 回忆状态 → 写 YAML | 查看系统建议 → 选择/修改 → 确认 |
| 管理 3 个并行故事线 | 手动检查每个线程进度 → 回想上次写到哪 → 写事件 | 系统提示 active goals → 选择推进哪个线程 → 确认 |
| 确保弧位置正确 | 自己判断是否到了 climax 位置 | 系统警告「当前 climx 条件未达」 |
| 多分支叙事 | 手动追踪分支 A vs 分支 B 差异 | 系统按分支状态分别建议 |

### 量化估计

基于 `fixtures/zhu-fu/`（6 events）和 `fixtures/dream-of-red-chamber/`（12 events）的数据：

- **手写一个事件 YAML**（含 preconditions/postconditions/threadProgress/关系效果）：约 30-80 行 YAML，含 5-15 个结构化约束
- **Manual 模式增强**（验证 preconditions 是否满足）：减少 30% 的调试时间（错误的前置条件被实时捕获）
- **Suggest 模式**（作者选择并修改建议）：作者只需改 2-5 行（sceneBrief、调整 1-2 个 postconditions），减少 70-80% 的写作工作量
- **Auto 模式**：只需审核事件链，确认/修改

### 对项目意义的回答

TODO 作者自问：

> 这也意味着我们的系统更有野心：他实际上是要把现在的小说辅助系统全做一遍...这可能会对系统的工作量产生巨大考验，甚至还威胁到项目是否有意义

Planner 层是回答这个问题的关键：

- 如果 Fabula 只是一个**结构化存储+YAML→散文管线**，它确实只是「多了一个校验的提示词工程」
- 如果 Fabula 加上 Planner 层，它成为一个**叙事决策系统**——不仅能存储和渲染故事，还能**基于状态和约束推荐下一步叙事决策**。这是当前任何商业化产品（Sudowrite、NovelAI、Novelcrafter）都没有的系统化能力

> **Planner 是 Fabula 从「YAML 编辑器 + 散文渲染器」进化为「叙事操作系统」的缺失环节。**

---

## 附录 A：代码扫描确认

以下搜索确认当前代码库无前向事件生成代码：

| 搜索项 | 包范围 | 结果 |
|--------|--------|------|
| `plan` (叙事级) | `packages/core/src/` | 仅 surface-planner（渲染分组） |
| `next.*event` | `packages/core/src/` | 仅 batch-renderer（渲染批处理索引） |
| `forward.*plan` | `packages/` | 无 |
| `suggest.*narrative` | `packages/core/src/` | 仅 thread-status prompt（诊断用） |
| `candidate` | `packages/core/src/` | 无 |
| `propose.*event` | `packages/core/src/` | 无 |
| `generate.*event` | `packages/core/src/` | 无 |

## 附录 B：术语对照

| 中文 | English | 本文件含义 |
|------|---------|-----------|
| 叙事规划 | Narrative Planning | 从状态+目标推演下一个事件 |
| 发现层 | Discovery Layer | 从散文反推结构化 YAML |
| 动作空间 | Action Space | 当前状态下可能的事件类型集合 |
| 弧约束 | Arc Constraint | 故事弧阶段的转换规则 |
| 节拍 | Beat | 叙事的最小节奏单元（比事件更细粒度） |
| 因果链 | Causal Chain | 事件间的因果依赖（Fabula DAG） |
