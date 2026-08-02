# 竞品分析 — 叙事引擎上下文与连续性方案对比

> 撰写日期：2026-07-19
> 对标范围：Novel Studio（宋致远，学术系统）、Sudowrite / NovelAI / Novelcrafter（商业工具）、Novel-OS / InkOS（开源多 Agent 系统）、Yarn Spinner / Ink（游戏叙事引擎）
>
> **历史记录（dated snapshot）**：本页是 2026-07-19 撰写的竞品快照分析，属于有日期的历史记录；文中“现状”描述的是撰写时的源码状态。当前系统状态以 [`docs/current-state.md`](../current-state.md) 为准，两者冲突时以当前源码为准。此后实现已改变的部分已就地标注（见 [⑦ 管线 Trace 系统](#⑦-管线-trace-系统orchestration-trace) 的 2026-08-02 更新）。

## 概述

本文件记录 Novalistically 的上下文编译与场景间连续性方案与业界的对比。核心关注问题是：**当渲染一个场景时，系统如何从之前场景中获取所需信息？**

所有竞品对此问题的答案可以分为四个阵营：

1. **扔散文原文** — 前文全文拼接进 prompt（Sudowrite）
2. **结构化摘要** — 用 LLM 或确定性手段生成每章摘要，以摘要代替原文（Novel Studio、Novelcrafter）
3. **纯结构化状态** — 完全不引用散文，只依赖结构化状态（Novel-OS）
4. **手动上下文** — 用户自己维护 context 条目（NovelAI、Ink）

---

## 阵营 1：扔散文原文

### 代表：Sudowrite（商业产品，百万用户）

**做法**：Chapter Continuity 功能。作者按顺序链接章节文档，Write 功能自动读入前文——最多 25 个文档、20,000 字原文文本，直接拼进 prompt。

**技术细节**：
- 串行写作：人写完一章 → AI 续写 → 人审 → 下一章。不存在并行问题
- 无缓存系统：每次点击 Write 重新编译 prompt，没有缓存层
- 双通道：Story Bible（结构化数据，放 prompt 头部） + 散文原文（放 prompt 尾部）。结构化数据在前，散文在后
- 作者控制链接：可以手动选择哪些前文被引用，支持非线性章节结构

**局限性（跟他们不冲突，跟你们冲突）**：

| Sudowrite 的条件 | Novalistically 是否满足 |
|---|---|
| 串行写作（无并行） | ❌ 批量并行渲染 |
| 无缓存系统（每次重新拼） | ❌ 哈希链缓存 |
| 人与 AI 交替（每章介入） | ❌ 自动管线 |

Sudowrite 能这样做是因为他们是**交互式写作工具**，不是批量管线。你们的架构约束完全不同。

**对"远处引用"的处理**：**最优**。散文原文在手，具体台词/氛围都能引用。但只覆盖最近 25 章/20,000 字——更远的历史同样丢失。

---

## 阵营 2：结构化摘要

### 代表：Novel Studio（学术系统）

> 仓库：https://github.com/songzhiyuan98/Novel-Studio
> 开发时间：2026 年 1 月至今
> 核心设计：https://www.zhiyuansong.dev/en/projects/novel-studio.html

**做法**：每章写完后由 Summarizer agent（LLM）生成 L0 摘要（每章一份）。每 ~100 章抽象为 L1 卷摘要（更高级别的概述）。Packet Compiler 按 P0-P4 优先级填充 token budget：

```
P0 — 硬约束（场景卡、章节目标、风格护栏、输出契约）
P1 — 当前状态（角色/关系/活跃线程）
P2 — 近期上下文（最近 3 章的 L0 摘要 + 当前卷的 L1 摘要）
P3 — 远处引用（历史卷摘要、完整世界规则）
P4 — 补充（开发链、历史 QA）
```

**关键设计点**：
- **Orchestrator 是确定性代码，不是 LLM**。路由、packet 组装、状态转换全是可测试的代码保证（和 Novalistically 一致）
- **不做 vector RAG**。MVP 阶段用场景卡标签做结构化的键值查询，L1 语义检索标记为 post-MVP
- **场景卡 metadata（characters, locations, threads, callbacks）驱动查询**，不是 embedding
- **分层摘要优先于全文回读**——这是他们的核心洞察："lean on layered summaries + state tables, not MVP-stage vectors"

**成本**：~$0.032 / 5 章（DeepSeek Writer + GPT-4o-mini Planner + GPT-4o-mini Chat）

**与 Novalistically 的对比**：

| 维度 | Novel Studio | Novalistically |
|---|---|---|
| 摘要生成 | LLM Summarizer agent | 确定性编译（`LogicalDisclosureSummaryCompiler` 已接入管线；`VolumeSummaryCompiler` 仅为已导出的独立工具） |
| 摘要层级 | L0（每章）+ L1（每 ~100 章） | 仅 per-scene（可扩展 L1） |
| 上下文编译 | Packet Compiler（P0-P4） | ContextCompiler（5 层优先级） |
| 信息源 | PostgreSQL Canon Store | Event Sourcing + YAML |
| 叙事模型 | 线性章节流 | DAG 因果边 + runtime/API branch primitives；authoring YAML 目前未接入 story branch |
| 渲染方式 | 串行（人审批→下一章） | 批量并行（滑动窗口） |
| 缓存 | 无 | 哈希链全依赖缓存 |
| 验证 | 单 QA agent（LLM） | 28 个内建 Validator + Pass 2 分析 |

### 代表：Novelcrafter（商业工具）

**做法**：用户为每个场景写 scene summary（不是 AI 生成的，是人写的）。这些摘要自动传给后续场景。'The system prompts use the scene summaries of the scenes prior to the beats you are working on.'

**特点**：**作者负担最大**——需要手动维护摘要质量。但作者控制力最强。

### 代表：Novel-OS（mrigankad，开源）

> 仓库：https://github.com/mrigankad/Novel-OS

**做法**：五个 Agent（Architect → Scribe → Editor → Guardian → Curator）依次执行。不扔散文。每个 agent 的输出包含结构化 `[STATE_UPDATE]` 块，被 Parse 后写入中央 JSON state。Continuity Engine 做确定性检查（线程宕置、伏笔未回收、角色消失等），结果喂给 LLM Guardian。

**完全不扔散文**。纯结构化状态。远处引用靠作者在 state 里写明——和 Novalistically 的哲学一致。

---

## 阵营 3：纯结构化状态

### 代表：InkOS（开源，10 Agent Pipeline）

> 作者：Dylan Brown
> 参考：https://dev.to/dylan_brown_4c803aefcfe51/

**做法**：10 个 Agent（Radar → Planner → Composer → Architect → Writer → Observer → Reflector → Normalizer → Auditor → Reviser）。维护 7 个 truth files（current_state.md、particle_ledger.md、pending_hooks.md、chapter_summaries.md、subplot_board.md、emotional_arcs.md、character_matrix.md）。

Composer agent 按相关性从 truth files 中检索内容，只拉取当前章节需要的事实。用 SQLite 做 temporal memory 数据库——不是全量注入，而是按相关度检索。

---

## 阵营 4：手动上下文

### 代表：NovelAI（商业产品）

**做法**：
- **Memory Box**：用户手动维护的"关键信息"，固定放在 prompt 最顶部
- **Author's Note**：强权重指令，放在 prompt 最底部
- **Lorebook**：关键字触发的 context entry。对当前文本中出现的实体名，自动插入对应的 lore 条目
- **Ephemeral Context**：基于 Story Step 的定时 context 条目（delay + duration + insertion position）

**关键差**：所有 context 控制权在用户。没有自动摘要或状态编译。

### 代表：Ink（Inkle Studios，游戏叙事语言）

**做法**：变量 + 条件分支。作者手动写 `if seen_already` 来判断是否需要引用前文。无自动上下文传递。**纯手工。**

### 代表：Yarn Spinner（游戏叙事引擎）

**做法**：Storylets + Saliency 系统。内容块附带 `when` 条件，系统在运行时按复杂度评分 + 最近使用惩罚选择最合适的块。**状态驱动的内容选择**，不是状态编译。

---

## 核心问题对比表

### 问题：单个场景如何获得前文信息？

| 方案 | 代表系统 | 信息源 | 可靠性 | 并行安全 | 缓存友好 |
|---|---|---|---|---|---|
| 扔散文原文 | Sudowrite | 文件系统读 prose | ⚠️ 有噪声但完整 | ❌ 有竞态 | ❌ 全链失效 |
| LLM 生成摘要 | Novel Studio | Summarizer agent | ⚠️ LLM 质量波动 | ✅ 不依赖渲染 | ⚠️ 摘要变则缓存变 |
| 确定性编译摘要 | Novalistically | 确定性编译（discourse 披露摘要已接入；L0 场景聚合未接线） | ✅ 100% 确定 | ✅ 预编译 | ✅ 与缓存正交 |
| 纯结构化状态 | Novel-OS | State JSON | ✅ 确定 | ✅ | ✅ |
| 人写摘要 | Novelcrafter | 用户输入 | ⚠️ 靠用户维护 | ✅ | ✅ |
| 手动上下文 | NovelAI | 用户维护的 lore | ❌ 靠用户维护 | ✅ | ✅ |

### 问题：如何解决"远处引用"（角色回忆三场前的具体台词）？

| 方案 | 能解决吗 | 原因 |
|---|---|---|
| 扔散文原文 | ⚠️ 部分 | 只在原文仍在 context window 内时有效 |
| LLM 生成摘要 | ❌ | 摘要是有损压缩，丢失具体措辞 |
| 确定性编译摘要 | ❌ | 只 diff 结构化 state，不捕获非 Fact 的台词 |
| 纯结构化状态 | ❌ | 同上有话必须写进 Fact |
| 人写摘要 | ⚠️ 部分 | 人可以精确记下具体台词，但靠自觉 |
| 手动上下文 | ✅ | 用户可以手动写"角色 A 记得 X说的话" |

**诚实结论：没有系统完美解决了"远处引用"。** Sudowrite 靠散文原文覆盖最近 25 章，更远的丢失。摘要派承认有损压缩。纯状态派要求作者把重要台词写进 Fact。NovelAI/Ink 把责任推给用户。

---

## Novalistically 的独创性

与上述所有系统对比后，以下组合是目前业界**唯一**的：

### ① DAG 因果边驱动的 State Replay

所有对标系统都是**线性写作流**（Novel Studio：逐章串行 → canonize；Novel-OS：5 agent 串行；Sudowrite：人→AI 交替）。Novalistically 通过 `compileStoryRuntimeGraph()`（`state/graph-adapter.ts`，postcondition↔precondition 匹配 + 分支选择 + 时间上下文解析）构建故事图，`compileStoryBoundaries()` 解析每事件状态边界，`ReplayEngine` 按因果序重放。这使以下结构成为可能：

```
闪回：E6 的 storyTime 在 E4 之前，但 causal edges 正确追溯因果前驱
并行线：E3a（camille 线）和 E3b（seraphine 线）共存于同一故事图
多前驱：E4 的 causalPredecessors = [E2, E3]（图自然支持）
```

### ② EventFile-local authoring-level game dialogue tree

`choices[] { id, label, description, targetEvent, effects? }` 现在直接属于严格的 `E*.yaml`
合同。compiler 要求单 root、无 merge、无 cycle、全可达树，并将 choice effects 编译为
branch-scoped synthetic transition；selected route replay 因而使用 canonical state，而不是 prose
或 session reducer。`renderGameDialogueTree()` 以 representative leaf path 渲染所有 node 一次，
再交付带 YAML mapping 与 target anchors 的 `output/dialogue-tree.md`。遗留
`branches.yaml` / `branch_points.yaml` 仍不解析。详见 [分支游戏对话](./yaml-format/branch.md)。

### ③ 批量并行渲染 + 哈希链缓存

- `ConcurrencyPool` 5 路并行渲染（默认 concurrency 5）
- `BatchRenderPipeline` 滑动窗口
- 缓存 key：`renderScene` 用 `buildLogicalKeyMaterial()` / `buildSurfaceKeyMaterial()` 计算两层 key 串，再以 `sha256Canonical({ logical, surface })` 作为实际存储查找 key；`buildValidationKeyMaterial()` / `buildAttemptKeyMaterial()` 在 Pass 2 阶段计算，只作为元数据随 `setCachedRender()` 写入。`computeFlatCacheKey()` 没有生产调用方（仅单测覆盖）
- `createCircuitBreaker()` 自动重试 + 熔断

所有对标系统都是串行（Novel Studio / Sudowrite / Novel-OS）。**目前没有其他叙事系统在场景间维持因果一致性的同时做批量并行渲染。**

### ④ 两轮渲染 + 确定性 Validator 体系

- Pass 1（temp 0.8，seed null）：prose
- Pass 2（temp 0.3, seed 42）：动态 JSON 模板——内建聚合 schema `analysisContentSchema`（`validator/index.ts`）共 20 个块（14 必选 + 6 可选：`checklistResults` + 5 个 Genette 维度块），提示中仅包含有活跃验证器消费者的块
- Zod schema 校验 Pass 2 输出 → 验证失败时带错误反馈重试
- 28 个内建 Validator（`ResultAggregator` 默认注册列表）；其中大多数通过 `getAnalysisRequirements()` 消费特定 analysis block，但 `BranchMergeValidator` 与 `ReachabilityValidator` 返回空需求、`DiscourseValidator` 不声明任何 analysis 需求——并非每个验证器都消费 Pass 2 块
- `compareFact()` 统一确定性比较入口
- 双重运行验证：`RenderPipelineOptions.doubleRunVerification`（默认 `false`），开启后对同一场景跑两次 Pass 2 并逐块比较 JSON。它不是 dev 环境默认，公共 `renderNovel` 路径未启用，需直接构造 `RenderPipeline` 时显式开启

对标系统的验证层深度不可比：Novel Studio 是单个 QA agent（一次 LLM 调用）、Novel-OS 是 ContinuityEngine（确定性）+ Guardian（LLM）、Sudowrite 没有独立验证层。

### ⑤ Fact 双重表示（value? + narrativeHint?）

`Fact.value` 用于确定性比较（`compareFact()` 返回 match/mismatch/deferred）；`Fact.narrativeHint` 用于 Pass 2 语义分析，不写入 WorldState。两者互斥（Zod schema 保证）。**这是原创的 schema 设计模式，未在其他系统见到。**

### ⑥ 确定性 SummaryCompiler（vs LLM Summarizer）

Novel Studio 的 Summarizer 是 LLM 调用（有成本、有质量波动、需等 L0 质量稳定后才上 L1）。Novalistically 的 `LogicalDisclosureSummaryCompiler`（`summary/logical-compiler.ts`，从 planned DiscourseState / scene contract / narrator projection 编译 hash-pinned 摘要）**确定性编译**——不调 LLM、0 token 成本、100% 可测试；它由 `editorial/render-service.ts` 在渲染前构造，摘要经 `logicalDisclosureSummary` 注入 Pass 1 提示并计入缓存身份。`VolumeSummaryCompiler`（`summary/volume-summary.ts`，确定性 L0 场景摘要聚合）已从 barrel 导出为独立工具，但**没有生产调用方**（仅单测覆盖），尚未接入任何渲染路径。

---

## 对标系统有而 Novalistically 少做的功能

### ① 交互式审批（Human-in-the-Loop）

**Novel Studio 有**：每章 Blueprint → 用户审批 → Write → QA → pass/block → 用户确认 → Canonize。每章 2-3 个人工介入点。

**Novalistically 的状态**：已接通。`renderNovel` 的发布决策走 `evaluateReleaseDecision()`（`pipeline/release-decision.ts`）+ `InteractionManager`（`pipeline/interaction-gate.ts`）：`RenderSceneResult.needsReview=true`（重试耗尽）的结果默认 blocked，`warning` 级发现可通过 `recordWaiver()` 预先记录豁免后被接受，`error` 级（S/X 失败）始终需要审批、不可豁免。这是同步 waiver 通道——调用方在 render 前声明豁免，而不是异步“通知用户→等待响应”。

### ② 项目级风格档案（Style Profile）

**Novel Studio 有**：`ProjectTemplate` 包含 `style_profile`，每章 packet 作为 P0 硬约束携带。

**Novalistically 有**：`NarrativeEvent.styleGuidance`（tone、characterVoice、atmosphere、scenePacing 等）per-scene，经 `PromptAssembler` 注入 Pass 1 prompt。**接线现状**：`nova.yaml` 的 `styleProfile` 字段虽被 `projectConfigSchema`（`schemas/project.ts`）接受，但公共 `renderNovel` 路径（`editorial/render-service.ts`）从不把该配置传给 `RenderPipeline`——场景合同的风格由 `compileSceneContract()` 从默认注册表（`DEFAULT_PROJECT_STYLE`）+ chapter/narrator 字符串提示解析，缓存 key 中的 `styleProfileHash` 哈希的正是这个默认解析结果。`RenderPipeline` 有直接的 `styleProfile` 选项（`StyleResolver`，`packages/core/src/style/`，project/chapter/narrator/scene 优先级 + `DEFAULT_STYLE_PROFILE` 回退），但仅直接构造管线时可用。**当前生效的只有 per-event `styleGuidance` 与直接管线选项，项目级 YAML 档案尚未接通。**

### ③ 变更影响分析

**Novel Studio 计划做**：Green/Yellow/Red 影响等级。用户修改 Canon Store 条目时自动评估"哪些已写/将写的章节受影响"。

**Novalistically 的现状**：改 YAML → 分层缓存 key 失效 → 下次渲染自动重跑。缓存层已提供 staleness 诊断 API（`verifyEvidenceChain()`，按事件返回 valid/stale/missing/corrupt + 原因），但尚未接入 CLI 或面向作者的影响报告——"这次改动影响了 X 个场景"仍需开发者自行调用该 API 得出。

### ④ 多层级摘要（L0 + L1）

**Novel Studio 有**：L0 per-chapter + L1 per-volume（~100 章）。P2 的 "recent context" 是 "last 3 chapter summaries + current volume summary"。

**Novalistically 有**：唯一接入的摘要路径是 `LogicalDisclosureSummaryCompiler` 的 hash-pinned 披露摘要（`editorial/render-service.ts` 在渲染前编译，经 `logicalDisclosureSummary` 注入 Pass 1）。`VolumeSummaryCompiler`（确定性 L0 场景摘要聚合）已导出但无生产调用；`ContextCompiler` 虽有 `volumeSummary` 选项，公共路径从未传入生成值。更高层抽象未规划。

**何时成为问题**：500+ 场景时，因果链可能跨越几十个事件。没有 L1 抽象，也没有任何 `previousSummaries` 累积结构（源码中不存在该符号），跨场景摘要只能靠现有披露摘要逐场拼接。

### ⑤ 多模型路由

**Novel Studio 有**：Planner → GPT-4o-mini（便宜），Writer → DeepSeek（强），QA → DeepSeek，Chat → GPT-4o-mini。

**Novalistically 有**：`AiSdkProviderOptions.routing` 已支持按任务路由模型——`default` / `pass1` / `pass2` / `summary` 四个槽位；`RenderPipeline` 在 provider 请求上带 `taskType: 'pass1' | 'pass2'`，provider 按 `request.taskType` 选择模型（`packages/core/tests/multi-model.test.ts` 覆盖该行为）。注入配置了 `routing` 的 `AiSdkProvider` 后，Pass 1 / Pass 2 / summary 即可使用不同模型。

**影响**：**声明式项目级路由仍缺失**——`nova.yaml` 无法声明路由，`render-service.ts` 构造 provider 时只传单一 `model`；跨 provider 路由（如 Pass 1 用 A 厂商、Pass 2 用 B 厂商）也不存在。这些是“尚未接入声明式配置”，不是“无法按任务路由”。

### ⑥ Agent 独立配置体系（Agent-as-Configurable-Unit）

**Novel Studio 有**：每个 Agent 是独立可配置的单元：

| 组件 | 含义 |
|---|---|
| `packages/prompts/` | 每个 Agent 有独立的 prompt 模板文件 + Zod 输出 schema |
| `packages/orchestrator/` | 状态机，按工作流阶段路由到指定 Agent |
| Agent config | 每个 Agent 配置：provider、model、temperature、token budget |
| Task-specific packet | Orchestrator 为每个 Agent 编译专有的 packet |

完整的独立 Agent 列表：Chat Agent（闲聊/意图路由）、Planner（蓝图）、Writer（正文）、QA（质量）、Summarizer（摘要）。每个 Agent 只做一件事，互不通信，Orchestrator 调度。

**Novalistically 的现状**：`RenderPipeline` 是唯一的"执行者"——它既做 Pass 1（写作）、又做 Pass 2（分析）、还驱动验证：

```
prompts/ 目录:
  scene-render.ts      — 给 LLM 写散文的 prompt
  render-analysis.ts   — Pass 2 分析 prompt
  prose-only.ts        — 散文模式（辅助）
  thread-status.ts     — 线程状态（辅助）

Agent API 脚手架已存在，但管线未消费：
  - `packages/core/src/agent/types.ts` 定义并导出了 `Agent<I, O>` 接口、`AgentPacket`（system + user prompt，可选输出 schema）与 `AgentConfig`（model、temperature、maxTokens、seed）
  - `packages/core/src/agent/registry.ts` 实现并导出了 `AgentRegistry`（按 `AgentRole`：pass1/pass2/summary/review 注册与查询）
  - `packages/core/tests/agent.test.ts` 覆盖全部角色
  - **真实缺口是集成**：生产 `RenderPipeline` 不查询 `AgentRegistry`、不使用 `Agent` 接口——Pass 1/Pass 2 提示构建与 provider 调用仍是管线直接 import 的硬编码函数
  - 没有 per-agent 输出 contract 集成（Pass 2 的聚合 Zod schema 由验证器 schema 聚合而来，见 `validator/index.ts`）
```

当前代码里提示词主体是静态 import 的硬编码函数调用（`buildSceneRenderPrompt(input)` → `Message[]`），但已有插件扩展口：`PluginHooksManager` 的 `onBuildPass1Prompt` / `onBuildPass2Prompt` 钩子返回 `PromptDecoration[]`，以非权威方式注入 prompt（插件名排序合并，每个 decoration 计入缓存身份）。

**影响**：

1. **插件可扩展，但不可替换内核**：插件可以追加 prompt 装饰段，但不能替换 Pass 1/Pass 2 的 prompt 构建函数本身
2. **测试需要 mock provider**：集成测试通过 mock `LLMProvider` 注入，而不是替换 Agent（`Agent` 接口存在但管线未使用）
3. **多模型路由由 provider 层提供**：按任务路由已通过 `AiSdkProvider.routing` + `request.taskType` 实现（见 ⑤）；`AgentRegistry` 的 role 路由键与 `TaskType` 并行，但管线不经过 registry 路由
4. **扩展能力受限**：想加一个新的 Worker（比如 Planner 或 Summarizer），不是向 `AgentRegistry` 注册一个类，而是改管线的 import 链

**这不是设计缺陷**——管线在当前阶段够用。但它是一个架构级的差异——Novel Studio 把"Agent"作为一等公民，Novalistically 把"Prompt"作为一等公民。当系统规模增长时，这个差异会影响可扩展性。

### ⑦ 管线 Trace 系统（Orchestration Trace）

**Novel Studio 有**：完整的 Orchestration Trace——shipped 功能。他们明确列为：

> "Orchestration Trace — see what each agent did"
> "Cost tracking, orchestration traces (per-agent visibility)"

每步执行记录：
- 哪个 Agent 在何时执行
- 用的是什么模型、多少 token
- 输入 packet 摘要、输出长度
- 耗时、缓存命中状态
- QA 决策和证据来源

**Novalistically 的现状**：**trace 只是内存中的不完整插桩**——`runtime.trace` 开启时 `render-service.ts` 会构造 `TraceCollector`（`observability/trace.ts`）并传给 `RenderPipeline`，由管线记录 pipeline / cache / pass1 / pass2 / validator / circuit 各阶段的 span 起止与耗时（`durationMs`）；`ResultAggregator` 也支持在构造时接收 collector 记录每个 validator 的 span。但**没有任何生产调用执行 `TraceCollector.write()` 或读取 `snapshot()`**——不会产出 `{projectDir}/.nova/traces/{jobId}.jsonl` 文件；`context` / `output` 两个声明阶段没有任何记录点；且 `render-service.ts` 构造的 `ResultAggregator` 未传入 collector，per-validator span 实际不会记录。

> **2026-08-02 更新（已落地部分）**：`render-service.ts` 现在**无条件**构造 `TraceCollector`（`observability/trace.ts`，phase 含 context/output 但 pipeline 只记录 pipeline / cache / pass1 / pass2 / validator / circuit 六类 span）并在每次执行结束时经 `persistTrace()` 把 `toJsonLines()` 结果通过 CAS 写入 Host execution repository（node-host `file-execution-repository.ts` 的 `compareAndSwapTrace()`，路径 `trace/{projectId}/{operationId}`）——**trace 已可落盘**，上文的“无 JSONL 落盘 / 无生产调用方”不再成立（落盘形式是 execution repository，而非 `{projectDir}/.nova/traces/` 文件）。仍成立的部分：`context` / `output` 阶段仍无记录点；`ResultAggregator` 构造签名已变为 `(customValidators?, entityTypeCatalog?)`，不再接收 collector（validator span 由管线自身 `phase: 'validator'` 记录，而非 aggregator 记录）；token 计量、RelevanceEngine 8 维评分、cache-key 追溯与 analysis 消费追踪仍未入 trace。

仍无法回答的问题：
- "这个场景为什么渲染了这些角色？" → RelevanceEngine 的 8 维评分没有暴露到 trace
- "缓存为什么没命中？" → 没有 cache key 层级的追溯
- "Pass 2 分析中哪些字段用了、哪些没用？" → 没有 analysis 消费追踪
- "每次调用花了多少 token？" → trace 记录耗时但不记录 token 用量

**影响**：

1. **阶段耗时仅限内存**：pipeline/pass1/pass2/validator/circuit 等 span 含 `durationMs`，但当前没有任何公开路径取回 `snapshot()`——需要调用方自行构造并读取 collector
2. **回归对比不可用**：无 JSONL 落盘，跨运行 diff 需先实现 `TraceCollector.write()` 的生产调用
3. **成本分析仍无依据**：token 消耗分布不在 trace 中，需要 provider 账本补充
4. **角色选择不可解释**：RelevanceEngine 的评分未入 trace，“为什么选了这些角色”仍要靠代码推演
5. **用户无法 debug**：最终用户（小说作者）碰到渲染结果不符合预期时，trace 是开发者工具，未暴露给最终用户

trace 目前只覆盖内存中的部分 span（context/output 阶段无记录、无落盘），不含 token 计量与决策理由——落盘、完整阶段与 token 计量都是缺口。

---

## 其他竞品中的有趣设计

以下设计不直接相关但值得记录：

- **Yarn Spinner Saliency**：内容选择算法（条件复杂度评分 + 最近使用惩罚 + 随机因子）。和 RelevanceEngine 的 8 维评分 + recency penalty 思路一致。但 Yarn Spinner 是做**运行时的内容选择**（选哪个 storylet 执行），RelevanceEngine 是做**编译时的实体排序**（选哪些角色进 context）。

- **Ink 的变量追踪 + 线程**：用 LIST + 条件变量 + 线程隧道做知识状态跟踪。手动模式，但证明了"结构化状态可以支撑远期引用"——如果作者愿意写。

- **NovelAI 的 Ephemeral Context**：基于 Story Step 的定时 context 条目（delay + duration + insertion position）。这是一个"临时记忆"的 UI——用户手动设定某条信息在 N 步后出现、持续 M 步。对你们的 batch 管线不直接适用，但可以作为"带时间窗口的 context 注入"的思路参考。

---

## 参考资料

- Novel Studio 设计规范：https://www.zhiyuansong.dev/en/projects/novel-studio.html
- Novel Studio 仓库：https://github.com/songzhiyuan98/Novel-Studio
- Novel-OS 仓库：https://github.com/mrigankad/Novel-OS
- InkOS 架构：https://dev.to/dylan_brown_4c803aefcfe51/
- Sudowrite Chapter Continuity 文档：https://docs.sudowrite.com/using-sudowrite/chapter-continuity/
- NovelAI 上下文构建：https://docs.novelai.net/en/text/editor/advancedsettings/
- Novelcrafter 场景摘要：https://www.novelcrafter.com/help/faq/plan/outline-impact
- Yarn Spinner Saliency：https://yarnspinner.dev/docs/yarn/advanced/storylets-and-saliency-a-primer/
- Ink 叙事技巧：https://deepwiki.com/inkle/ink-library/2-ink-narrative-techniques
- Lost in the Middle（Liu et al., 2023）：https://arxiv.org/abs/2307.03172
