# 竞品分析 — 叙事引擎上下文与连续性方案对比

> 撰写日期：2026-07-19
> 对标范围：Novel Studio（宋致远，学术系统）、Sudowrite / NovelAI / Novelcrafter（商业工具）、Novel-OS / InkOS（开源多 Agent 系统）、Yarn Spinner / Ink（游戏叙事引擎）

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
| 摘要生成 | LLM Summarizer agent | 确定性 SummaryCompiler（WorldState diff） |
| 摘要层级 | L0（每章）+ L1（每 ~100 章） | 仅 per-scene（可扩展 L1） |
| 上下文编译 | Packet Compiler（P0-P4） | ContextCompiler（5 层优先级） |
| 信息源 | PostgreSQL Canon Store | Event Sourcing + YAML |
| 叙事模型 | 线性章节流 | DAG 因果边 + 分支叙事 |
| 渲染方式 | 串行（人审批→下一章） | 批量并行（滑动窗口） |
| 缓存 | 无 | 哈希链全依赖缓存 |
| 验证 | 单 QA agent（LLM） | 18 Validator + Pass 2 分析 |

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
| 确定性编译摘要 | Novalistically | WorldState diff | ✅ 100% 确定 | ✅ 预编译 | ✅ 与缓存正交 |
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

所有对标系统都是**线性写作流**（Novel Studio：逐章串行 → canonize；Novel-OS：5 agent 串行；Sudowrite：人→AI 交替）。Novalistically 通过 `buildCausalEdges()`（postcondition↔precondition 匹配）构建事件 DAG，`ReplayEngine` 按拓扑排序重放。这使以下结构成为可能：

```
闪回：E6 的 storyTime 在 E4 之前，但 causal edges 正确追溯因果前驱
并行线：E3a（camille 线）和 E3b（seraphine 线）共存于同一 DAG
分支汇聚：E4 的 causalPredecessors = [E2, E3]（多前驱自然支持）
```

### ② 原生分支叙事

从 schema 层（`BranchSet` / `BranchPath`）到 replay 层（`filterScenesByBranchPath()`）到 validator 层（`BranchMergeValidator`）完整实现。对标系统中**不存在**。

### ③ 批量并行渲染 + 哈希链缓存

- `ConcurrencyPool` 5 路并行渲染
- `BatchRenderPipeline` 滑动窗口
- `computeCacheKeys()` SHA256 哈希链，缓存依赖全自动追踪
- `CircuitBreaker` 自动重试 + 熔断

所有对标系统都是串行（Novel Studio / Sudowrite / Novel-OS）。**目前没有其他叙事系统在场景间维持因果一致性的同时做批量并行渲染。**

### ④ 两轮渲染 + 确定性 Validator 体系

- Pass 1（temp 0.8）：prose
- Pass 2（temp 0.3, seed 42）：12-block 结构化 analysis JSON
- Zod schema 校验 Pass 2 输出 → 验证失败时带错误反馈重试
- 18 个独立 Validator，每个消费特定 analysis block
- `compareFact()` 统一确定性比较入口
- Dev-only 双重运行验证（两次 Pass 2 比较 JSON）

对标系统的验证层深度不可比：Novel Studio 是单个 QA agent（一次 LLM 调用）、Novel-OS 是 ContinuityEngine（确定性）+ Guardian（LLM）、Sudowrite 没有独立验证层。

### ⑤ Fact 双重表示（value? + narrativeHint?）

`Fact.value` 用于确定性比较（`compareFact()` 返回 match/mismatch/deferred）；`Fact.narrativeHint` 用于 Pass 2 语义分析，不写入 WorldState。两者互斥（Zod schema 保证）。**这是原创的 schema 设计模式，未在其他系统见到。**

### ⑥ 确定性 SummaryCompiler（vs LLM Summarizer）

Novel Studio 的 Summarizer 是 LLM 调用（有成本、有质量波动、需等 L0 质量稳定后才上 L1）。Novalistically 的 `SummaryCompiler.compileAll()` 从 WorldState diff **确定性编译**——不调 LLM、0 token 成本、100% 可测试、并行渲染前一次跑完。

---

## 对标系统有而 Novalistically 少做的功能

### ① 交互式审批（Human-in-the-Loop）

**Novel Studio 有**：每章 Blueprint → 用户审批 → Write → QA → pass/block → 用户确认 → Canonize。每章 2-3 个人工介入点。

**Novalistically 的状态**：`RenderSceneResult.needsReview` 字段已在类型中，`CircuitBreaker` 可标记 `BLOCKED` 状态、`human_arbitration` 占位符已在 plugin resolver 中——但**未接通**到实际的通知用户→等待响应的通道。Pipeline 是全自动的，render 完直接写文件。

**这不是设计缺陷，是未完成的接口。** 原始设计（PROJECT.md §六-B）明确了"Circuit Breaker + BLOCKED → 等人工裁决"的机制，但 api.ts 未实现。

### ② 项目级风格档案（Style Profile）

**Novel Studio 有**：`ProjectTemplate` 包含 `style_profile`，每章 packet 作为 P0 硬约束携带。

**Novalistically 有**：`NarrativeEvent.styleGuidance`（tone、characterVoice、atmosphere、scenePacing 等）per-scene。没有项目级全局风格定义。

**影响**：100 场景时需要在每个 YAML 文件里写风格参数。应该有一个全局 fallback + per-scene override 的机制。

### ③ 变更影响分析

**Novel Studio 计划做**：Green/Yellow/Red 影响等级。用户修改 Canon Store 条目时自动评估"哪些已写/将写的章节受影响"。

**Novalistically 无**：改 YAML → 缓存静默失效 → 下次渲染自动重跑。作者得不到"这次改动影响了 X 个场景"的报告。

### ④ 多层级摘要（L0 + L1）

**Novel Studio 有**：L0 per-chapter + L1 per-volume（~100 章）。P2 的 "recent context" 是 "last 3 chapter summaries + current volume summary"。

**Novalistically 有**：仅 per-scene summary（计划中的 Summarizer 组件）。更高层抽象未规划。

**何时成为问题**：500+ 场景时，因果链可能跨越几十个事件。没有 L1 抽象则 `previousSummaries` 列表会很长。

### ⑤ 多模型路由

**Novel Studio 有**：Planner → GPT-4o-mini（便宜），Writer → DeepSeek（强），QA → DeepSeek，Chat → GPT-4o-mini。

**Novalistically 有**：所有任务走同一个 `provider.complete()`。不能按任务需求路由模型。

**影响**：不能把消耗 token 多的任务（如 Pass 1 写作）放便宜模型，把需要精确度的任务（如 Pass 2 分析）放强模型。

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

没有 agent 概念：
  - 没有 formal 的 Agent 类型或接口
  - 没有 Agent 注册表
  - 没有 per-agent 输出 contract（Pass 2 有一个共享的 Zod schema，但不属于某个 Agent）
  - 没有 per-agent token budget 或 model 配置
  - Orchestrator/Pipeline 直接 import 这些文件
```

当前代码里提示词是静态 import 的硬编码函数调用（`buildSceneRenderPrompt(input)` → `Message[]`），不可配置、不可替换。

**影响**：

1. **插件支持受限**：如果一个用户想"换掉 Pass 1 的写作 prompt，但保持 Pass 2 分析不变"——当前做不到。所有 prompt 是编译时 import 的
2. **测试困难**：不能 inject mock Agent 来做集成测试——因为根本没有 Agent 接口，只有直接函数调用
3. **多模型路由无法落地**：没有 Agent 这个概念，就没办法按"当前在写散文" vs "当前在做分析"路由到不同 model/provider
4. **扩展能力受限**：想加一个新的 Worker（比如 Planner 或 Summarizer），不是加一个类注册，而是改 import 链

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

**Novalistically 的现状**：**零 trace。** 整个核心代码里只有零散的 `console.log` / `console.warn`（assembler 有 7 处、plugin loader 有 4 处、replay 有 1 处）。没有任何结构化 trace，没有 span 树，没有 timing，没有层级上下文。

开发者目前无法回答以下基本问题：
- "这个场景为什么渲染了这些角色？" → RelevanceEngine 的 8 维评分没有暴露
- "缓存为什么没命中？" → 没有 cache key 追溯
- "Pass 2 分析中哪些字段用了、哪些没用？" → 没有 analysis 消费追踪
- "管线瓶颈在哪？" → 每步耗时没有记录
- "这个 bug 是哪步引入的？" → 没有事件链

**影响**：

1. **调试成本极高**：遇到 bug 只能加临时 log 重跑。每次重跑也是 LLM 调用——既慢又贵
2. **回归测试不可靠**：没有一个"这是上一次管线的 trace"的基线。改了一个模块后，你不知道它改变了什么行为
3. **性能分析靠猜**：不知道 Pass 1 / Pass 2 / RelevanceEngine / Validator 各占总时间的比例
4. **成本分析无依据**：不知道每个场景、每条故事线、每个角色的 token 消耗分布
5. **用户无法 debug**：最终用户（小说作者）碰到渲染结果不符合预期时，没有任何办法知道"为什么 LLM 写成了这样"

**这不是一个"等以后再做"的功能**——它是基础设施层的第一性问题。没有 trace 的系统，在管线复杂度增长到当前规模后，**调试时间会超过实现时间**。

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
