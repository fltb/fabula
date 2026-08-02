# TODO.md - 系统的整体计划

> **前身**: `docs/archive/TODO-stage-1-1.5.md` (1420 lines, stage 1 + 1.5 complete)
> **阶段 2 部分验收**: `docs/audits/stage-2-corpus-audit-2026-07-24.md`
> **基准项目（历史快照）**: `fixtures/dream-of-red-chamber/` — 12 events, 40 characters, 8 locations, 5 rules（旧快照数字，不代表当前夹具；现状见下方「基准项目现状」校正）
> **历史状态**: 本文档是阶段 1–3 的规划与审查记录（2026-07-23 起），保留为历史规划，不作为 current reference。当前事实以 [`docs/current-state.md`](./current-state.md)（2026-08-02 源码核验基线）为准。
> **基准项目现状（2026-08-02 校正）**: `fixtures/dream-of-red-chamber/` 当前为四章 E01–E36（每章 9 个事件）；本页各处 "12 events / 20 events" 均为旧快照数字，不代表当前夹具。

---

## 阶段 2 审查分析记录 (2026-07-24)

> 基于 fixtures/zhu-fu/output/validation.md (2026-07-22) + validator 源码审计 + docs/archive/PROJECT.md 初始目标对照。此节为分析记录，不是任务条目。

### zhu-fu 79 个 validation issue 实证分类

实际数字（非用户笔误的"48"）：0 L1 + 78 L2 warning + 1 L2 info = 79。

| 类别 | 数量 | 判定 | 证据 |
|------|------|------|------|
| POV pronoun check | 7 | 误报（validator bug） | pov.ts:83 正则纯英文，中文 prose 永远不匹配 |
| alias 代词 | 10 | 误报（validator bug） | Pass 2 characterReferences.namesUsed 已标"她"为 known，alias.ts 未过滤代词 |
| thread_progress "not advanced" | 15 | 误报（validator bug） | Pass 2 threadProgressAchieved 已标推进，thread-progress.ts:49 用裸 ID 查 Set 中带后缀字符串 |
| causality "not covered" | 39 | 混合：约 10-15 真信号 + 约 24-29 误报 | 真信号：fixture YAML postcondition 与 prose 不一致。误报：Pass 2 narrativeChecks 未标 attribute 时全报 |
| foreshadowing | 1 | 误报 | Pass 2 foreshadowingDeployed 空 |
| conflict type mismatch | 1 | 真信号（info 级） | E2 声明 person_vs_society，Pass 2 识别 person_vs_fate |
| thread_progress 部分待审 | 7 | 需全文审计 | 引文可能是 brief 同义复述 |

修正后 TP 估计：≥11 条真信号（1 conflict + 约 10 causality），假阳性率约 80-86%。

### 三个 validator bug 性质判定

| 文件 | 行数 | bug | 修复量 | 性质 |
|------|------|-----|--------|------|
| thread-progress.ts | 72 | Pass 2 输出 "T1: desc"，validator 用 "T1" 查 Set | 约 1 行 | 集成迁移遗留 |
| alias.ts | 125 | 未过滤 Pass 2 标入 namesUsed 的代词 | 约 5 行 | 集成迁移遗留 |
| pov.ts | 135 | 残留迁移前英文正则 fallback | 约 10 行 | 集成迁移遗留 |

Git 历史：三个文件均经历 ver1 → stage-1.5(Pass 2 集成) → stage-1.5v2。Pass 2 消费在 stage-1.5 加入（架构方向正确），比较逻辑细节未对齐真实 Pass 2 输出。

判定：改善，通过架构对齐修复。不是缓解，不是 prompt 工程。合计约 16 行。

### IR 层级缺口

PROJECT.md 设计 5 层 IR：Idea IR → Story IR → Scene IR → Event IR → World State → Novel Text。实际只建了后 2 层（Event IR + World State）。上层 3 层从未实现：

 - Idea IR（主题意图）：未建。系统无法表达"这本书要表达什么"
 - Story IR（结构 DAG + Thread 图）：未建。系统无法追踪跨事件意象演化（草蛇灰线）
 - Scene IR（场景契约）：未建。系统无法表达"这个 scene 为什么存在"

信息丢失的根因是 IR 层级建少了（2/5），不是 YAML 表达力不足。

> **2026-07-26 校正**：以上"IR 层级缺口"分析已过期（写于 wave1 提交之前）。直接对源码校验（非文档信任）：Idea IR（`types/idea-ir.ts` + `schemas/idea-ir.ts`，已接入 `schemas/project.ts`，`fixtures/zhu-fu/nova.yaml` 有真实 `thematicIntent` 内容）和 Story IR（`ThreadDefinition.structuralFunction`/`actantModel`，zhu-fu fixture 的 4 条 Thread 有真实 Propp 标签）均已建成并接入真实 fixture。Scene IR（Genette `sceneType`/`discourseMode`/`arcPosition` 等元数据字段）已广泛使用。真实剩余缺口：PROJECT.md 未命名的第 6 层 Discourse/Syuzhet（`types/discourse.ts`：`DiscourseState`/`NarratorProfile`/`PlannedDiscourseLedger`，类型+回放引擎+测试齐全，但 fixtures 下零使用，是死代码路径）。另外，`docs/report/stage-3-audit-2026-07-24.md` 声称的 S6（Duration/Frequency/Mood/Voice/Order 五维度）"5/5 ✅"同样过期——五个字段在 `NarrativeEvent` 上确实存在，但 grep 全仓库找不到任何消费者（无 validator、无 context compiler、无 prompt assembler 读取），是与 Discourse/Syuzhet 同类的"死类型"。详见 `docs/todos/stage-3-2026-07-27.md`、`docs/todos/base-narratology-2026-07-26.md`。
>
> zhu-fu + 5 个变种 fixture（layer-minimal/pov-switch/branch-A/branch-B/discourse-reorder）已用真实 LLM（DeepSeek `deepseek-v4-flash`）跑通全链路验证（YAML → EntityMapper → StateManager → ContextCompiler → RenderPipeline Pass1+Pass2 → PostRenderValidation → Assembler）：5/6 全部成功（含 branch-A 之前用复用参考数据触发的误报，真实生成后已消失），branch-B 的 E5 被 PronounValidator + ConflictAnalysis 交叉校验正确拒绝（叙述者应为第一人称但 prose 未使用第一人称代词）——证明 release gate 在真实内容上确实生效，不只是理论机制。过程中发现并修复两个真实 bug：`api.ts` 的模型解析从不读取 `NOVALISTICALLY_AI_MODEL` 环境变量（硬编码回退到一个 Claude 模型名，导致对 DeepSeek 端点发起必然失败的请求）；`render.ts` 的 Pass 1 catch 块吞掉了真实失败原因，不像 Pass 2 catch 块那样正确写入 `errors[]`（导致 CLI 只显示"1 words"而看不到真实错误文本）。另外发现一个可观测性缺口：`render --all` 在多事件运行中没有增量进度输出，只能靠轮询 `.nova/render-cache/` 或等待整批结束才知道卡在哪个事件。

### Discovery Layer 缺口

PROJECT.md 设计了 Discovery Layer（聊天→YAML 渐进结构化）。从未实现。影响：YAML 生成只能靠手动写或 batch LLM 调用。红楼梦 25% schema 合规率是反向工程固有难度，前向创作成本模型从未测试。

### 一期 MUST HAVE 实现状态

| 模块 | 设计 | 实现 |
|------|------|------|
| Event + State | 已设计 | 已实现，schema 工作 |
| Validators (11→18) | 已设计 | 已实现，架构对，实现层 3 个 bug |
| Context Compiler | 已设计 | 已实现，未测试质量 |
| Assembler | 已设计 | 已实现，genre 硬编码已知 |
| Git/branch | 已设计 | 已实现 replay.ts, merge-plan.ts |
| Plugin system | 已设计 | 已实现 src/plugin/ |
| Review entity | 已设计 | 已实现 src/review/ |
| Knowledge entity | 已设计 | 类型存在，未确认接入 validator |
| Idea/Story/Scene IR | 已设计 | 从未实现 |
| Discovery Layer | 已设计 | 从未实现 |

### 综合判断

 - "系统只是 RAG + 手工 YAML"：部分对。Context Compiler = 固定 YAML 图替代不确定召回，但 conflict/causality 校验是 RAG 做不到的，被噪声淹没。
 - "信息丢失过于严重"：对，但根因是 IR 层级建少了（2/5），不是 YAML 表达力不足。
 - "YAML 成本超过 prose 创作成本"：对，但在反向工程场景下才成立。前向创作 + Discovery Layer 的成本模型从未测试。
 - "系统是否有意义"：目前无法判定。三个前提条件都未满足：validators 小于 90% precision / 上层 IR 未建 / Discovery Layer 未建。

### 修改优先级

1. 修 3 个 validator bug（约 16 行）—— 立刻可做，0 风险，假阳性从约 80% 降到约 30%
2. 修完后再跑 zhu-fu validation —— 看真实 precision，决定是否有更多 validator bug
3. 然后决定：建上层 IR / 建 Discovery Layer / 做修订场景测试

### 架构决策：分层验证 + 现代小说为一般情况 (2026-07-24 讨论)

经讨论确认的架构声明：

**YAML 层**：现代小说是最一般情况，传统小说是约束子集。Schema 为最一般情况设计——S3 字段是一等公民，传统小说不填（默认空），现代小说填。不是 base + extension，是 unified schema。没有 novelType 分支。传统小说只是碰巧不填 S3 字段。

**验证层**：能被建模就能被验证。S3 每个字段都要有验证路径，不能是 dead storage。

**Pass 2 机制**：Pass 2 不独立判断文学效果——它对照作者在 narrativeChecklist 里写的透传 prompt 检查 prose。验证标准来自作者意图，不是系统的文学判断。

S3 的 6 个字段分两类验证路径：

| 类别 | 字段 | 验证方式 |
|------|------|---------|
| A 类——结构元数据（deterministic） | uncloseableThread, antiCausalEdge, chapterOrder:contested | compareFact() 级硬验证 |
| B 类——语义效果（author-intent-aligned Pass 2） | suspension, absenceProfile, voiceDissonance | Pass 2 对照 narrativeChecklist 透传 prompt 检查 |

S1（narrativeChecklist）和 S3 B 类字段共享验证基础设施：narrativeChecklist 既是 Pass 1 的意图透传，又是 Pass 2 的检查标准。一个字段两个用途。

实现顺序依赖：S3 A 类可独立先做。S3 B 类必须等 S1 建好验证基础设施。S1 是 S3 B 类的前置依赖。

X 列表更新：卡夫卡/现代主义建模从 X 移到 S——用分层验证处理，不是"当前范式不适用"。

**S3 字段集为 provisional draft**：当前 6 个字段从《审判》单文本第一性阅读提取，未经叙事学/现代主义批评系统推导。字段集在三层 survey（见 S3 段）完成前不可锁定。

## 叙事学理论框架 (2026-07-24)

项目命名为 **Fabula**（取自俄国形式主义 fabula/syuzhet 二分：fabula = 故事真正发生的顺序，syuzhet = 作者讲述的顺序）。这个命名锚定了系统的核心定位：**Fabula 层是系统的核心创新**——event sourcing + causal DAG + topological sort 做对了。但 Fabula 只是叙事学 8 层中的 1 层。本节用叙事学谱系校正 TODO 的理论定位。

### 系统层 ↔ 叙事学层映射

| 叙事学层 | 系统组件 | 状态 |
|---------|---------|------|
| World Model / Storyworld | `definitions/`（角色、地点、规则） | ✅ 建好 |
| World State | StateManager + WorldState | ✅ 建好 |
| Existents | EntityMapper → EntityRegistry | ✅ 建好 |
| **Fabula**（事件 + 因果链） | Event IR + DAG causal edges + Event Sourcing | ✅ **核心，建好** |
| Planner（下一步发生什么） | — | ❌ 完全缺失（见 S8） |
| **Syuzhet**（怎么讲） | `DiscourseState` + `NarratorProfile` + `PlannedDiscourseLedger`（types/discourse.ts） | ⚠️ **死类型**——完整设计但零 fixture 接线 |
| Surface Realization | RenderPipeline Pass 1 | ✅ 建好 |
| Narrative Constraints | 18+ validators | ✅ 建好（3 个集成迁移 bug） |

### Genette 五维度 → base schema（不是 S3）

**关键校正**：Genette《叙事话语》的五维度（Order/Duration/Frequency/Mood/Voice）描述**任何叙事**，不是现代小说扩展。红楼梦同时使用全部五维度。它们属于 base schema 审计，不应在 S3 内。详见 `docs/reference/stage-3/narratology-dimension-audit.md`。

| 维度 | 系统状态 | 归属 |
|------|---------|------|
| Order（时序：analepsis/prolepsis） | `sceneType` 部分覆盖，缺 temporal distance + anachrony 分类 | **Base** |
| Duration（时距：scene/summary/ellipsis/pause/stretch） | **完全缺失**——最大盲区 | **Base**（见 S6） |
| Frequency（频率：singulative/repeating/iterative） | **完全缺失** | **Base**（见 S6） |
| Mood（聚焦：zero/internal/external） | `NarratorProfile` 4 类型完整存在但**死类型**——fixture 仅用 crude `pov.type` | **Base**（见 S6） |
| Voice（叙事声音：extra/intra/metadiegetic） | `NarratorProfile` 建模能力但非层级；`NarrativeLevel` 枚举不存在；死类型 | **Base**（见 S6） |

### IR 层级精确状态（校正"2/5 建成"）

TODO 此前声称 5 层 IR 中仅 2 层建成——**过时**。精确状态见 `docs/reference/stage-3/ir-layer-narratology-mapping.md`：

| 层 | 叙事学映射 | 实现状态 |
|----|-----------|---------|
| Idea IR | 亚里士多德 Mythos（主题意图） | **ABSENT**（见 S7） |
| Story IR | 普罗普 31 功能 + 格雷马斯行动元 | **ABSENT**——Thread 系统是天然起点（见 S7） |
| Scene IR | 热奈特话语单元 | **SCHEMA-WIRED + FIXTURE-USED**（元数据字段全面使用，CompiledSceneContract 已编译；缺 Duration/Frequency） |
| Event IR（Fabula） | 俄国形式主义 Fabula | **FIXTURE-USED**（核心，完全活跃） |
| World State | 查特曼存在物 | **FIXTURE-USED**（完全活跃） |
| Syuzhet/Discourse（PROJECT.md 未命名） | 热奈特叙事话语 | **SCHEMA-WIRED + REPLAY + TESTED 但 fixture-dead**——接线缺口，非设计缺口 |

**校正后**：5 层中 2 层完全建成（Event IR、World State），1 层部分建成（Scene IR，比此前承认的更完整），1 个未设计层（Syuzhet）完整存在但未接线，2 层确实缺失（Idea IR、Story IR）。

### Planner 完全缺失

叙事学谱系第 8-9 层（Interactive/AI Narrative）有一个层当前 TODO 未覆盖：**Planner——决定下一步发生什么**。当前事件全手写 YAML，无 forward planning。TODO "核心问题" 担心前向创作成本，但只讨论 Discovery Layer（草稿→YAML 输入侧）。Planner（YAML→下一个事件，输出侧）完全缺失。详见 `docs/reference/stage-3/planner-layer-analysis.md`。

### A↔D 边界声明

- **A（`docs/reference/stage-3/narratology-dimension-audit.md`）**：Genette 五维度 → base。Duration/Frequency 完全缺失；Mood/Voice 死类型；Order 部分。
- **D（`docs/reference/stage-3/modern-novel-structure-survey.md`）**：S3 字段重分类。`uncloseableThread` → base（thread 层）；5 个保留 S3（含 2 个更名）；4 个新字段。S3-research 重定范围为第 2-3 层（第 1 层移至 base audit）。
- 两份报告边界一致：A 处理 Genette 五维度（任何叙事），D 处理现代特有结构字段。D 的 `metanarrativeLevel` 正确标注扩展 Genette narrative level 但"结构性自指是现代特有的"——这是正确的边界处理。

## 核心问题

### 人工审查发现

**这部分是我亲自发现的问题，不要动，可以在核心问题上面加其他补充，但是这一节都不能动**

目前系统遇到红楼梦这个大型项目的时候，我发现系统的完备程度正在遭受严重考验，我们列举具体的问题和需要分析的点

#### 系统的能力边界受到考验

我们希望得到一个类似“小说中间语言”的格式，在这个格式上面做尽可能多的工作，辅助 llm 或者人类作者进行文档可靠的创作：

- 比大纲更完整的描述，能直接控制成品，即使是不同作者接手也能保证稳定
- 确定性建模和检查，检查是否存在本身的错误
- scene 级别的故事分片创作，上下文管理，即使单独写一个单元也能放进整个故事
- 创作辅助提示，对于无法建模的部分，提供提示来约束，并且还能通过提示对产物做后检查

我们的目标是在这套格式上面能够完整表述出我们想要创作什么样的作品，为作品创作提供完整的指导，即使是另一个作者也能接手这个项目进行创作，并且产出预期的成果。

但是我们在这个格式上面遇到了大问题。

yaml 的工作量过于巨大，甚至超过了故事本身的创作成本：作者写草稿的时候虽然要整理各种设定和各种规则和事件，但是他们可以用非结构化的方式记录和人工做方式管理。但是我们系统强制要求作者写规范，那么使用的话就会远超纯人工写作的成本，得到的编辑提升是非常小的——人类总是可以记住自己创作的东西，不需要系统画蛇添足。

所以说他这个格式如果要有辅助创作的意义，必须使用工具生成，而现有的草稿文本转我们系统认识的格式化文本的方式只有 LLM, 那么我们就还需要一个能让作者和 yaml 之间的类似 user interface 的层面，他还要确保大部分情况稳定，这也就意味着我们的系统更有野心：他实际上是要把现在的小说辅助系统全做一遍，还要把最后的输出变成我们的 yaml 而不是正式 prose ，再去给我们的 yaml 渲染成 prose. 这可能会对系统的工作量产生巨大考验，甚至还威胁到项目是否有意义。

上面只是从使用上考虑，它的内部也是灾难：他现在的格式还远远不够完善，远没有达到最初的目标。我们期望他是“规范的小说中间语言”，能对应“稳定的小说成品”——但是他的信息丢失过于严重了，先不要说卡夫卡这种现代的反结构的小说，就是红楼梦这种古典小说，也会丢失信息。所以 yaml 本身还需要拓展功能，确保他能做好一个大纲——小说中间的桥梁。这部分会涉及非常多无法建模的部分，还会退化成 prompt engineering, 他们的边界目前也没有定义。

更可怕的是拓展 yaml 定义还会拓展系统本身的建模，这是下一个灾难部分。不过我们先讨论能力问题。目前我们使用 fixture/zhufu 产出的成品质量一言难尽：模型本身就知道祝福的原文，所以他拿到任务直接开始背原文，但是背一半发现要创作，就自己编造，这导致我们根本无法判断我们整个系统是否真正具有 yaml -> 稳定小说成品的能力。而且就目前来说，我们的整套系统也就是多了一个校验的提示词工程——我们通过系统计算提取的 scene 上下文直接塞给系统，然后得到正文，这和 RAG 在行为上差不多，只不过我们用**固定的 yaml 数据算出来的图**替代了不确定的 RAG 罢了，代价却是从 RAG 的几乎全自动变成了我们全手工（或者全 LLM 正确与否全看脸）的 yaml。我们最多加了一个提示词本身的校验，他甚至也依赖提示词工程——他最关键的部分独创部分还是依赖魔法的！他在目前也有体现：zhufu 报告了整整几十个 warning，他才 6 个 scene！

目前系统原型质量完全不可接受，他甚至让我怀疑这个系统是否有意义。

#### 系统的规模和维护成本失控

我们的代码库已经有了两万行 ts 代码，包括功能代码和测试代码，其中 95% 以上的代码缺乏人工审计——我只是采取系统的报告，并且无条件相信他是真确的。

但是这根本不可能，他出现了很多 fatal error 导致我有好几次让 agents 打回重做，或者使用我所知道的软件工程标准，devops 标准，以及各种标准去要求他。

问题却没有消失，他隐藏起来了：测试覆盖率，结构，linter 等等传统对人类有效的部分对 AI 没有效果，他处理这些指标非常快速，但是对真实系统需求却无法做到任何保证，反而是让人工排查变的困难。最开始我还能发现大量 dummy code 和反模式，因此我能快速指出。但是随着指标上来，他变成了一个很"漂亮"的软件项目。对人类程序员人工写出的代码来说，漂亮的代码=正确，因为他显然通过了大量的思考和验证。但是 AI 只是反复抛光一个逻辑，无法根本判断。

这就导致维护成本失控：我根本没看过这个系统大部分的代码，我都是依赖 AI 帮我找代码修改 bug 等等。以至于目前我都无法判断系统本身到底的边界。

## S: 确定性能力 (Deterministic)

### [x] S1 — narrativeChecklist: 自检查大纲系统

每 event 携带 `narrativeChecklist` 字段——从原文分析提取的必须覆盖维度清单（诗词、对话个性、反讽距离、草蛇灰线等）。Pass 1 作为风格约束输入，Pass 2 逐项评估覆盖率，新增 `ChecklistValidator` 检查 `must_include` 项。

**产出**: `narrativeChecklistSchema`, `ChecklistValidator`, `checklistResults` in `AnalysisResult`, context compiler 增加 checklist 段

**依赖**: 当前 schema 可扩展，向后兼容

**2026-08-02 校正**: 此条目现已在默认管线中——`ChecklistValidator` 是 28 个 built-in validators 之一（`packages/core/src/validator/builtins.ts`），从当前 AnalysisResult envelope（`eventId`/`protocol`/`observations`/`analysis`）的 `analysis.analysis.checklistResults` 读取 Pass 2 结果；`docs/report.md` 曾记载的 envelope 未对齐缺口已修复。

### [x] S2 — greyLines: 草蛇灰线多点追踪

替代 `foreshadowing` 的二元模型（种子→应验）。`greyLines` 为多点结构——同一意象在多个事件中反复出现、每次累积不同语义。节点列表持续增长，不要求闭合。

**产出**: `greyLines` schema 字段，跨事件追踪逻辑，`GreyLineValidator`

**2026-08-02 校正（诚实标注）**: `GreyLineValidator` 已导出但**不在**默认 built-in 集合中（`packages/core/src/validator/builtins.ts` 未注册）——属 opt-in 能力，不是默认管线行为；`ForeshadowingValidator` 仍为默认项。上方 `[x]` 仅表示类型/验证器存在，不代表已接入默认管线。

### [x] S3 — 现代小说结构建模层

Schema 为最一般情况（现代小说）设计，传统小说是约束子集（不填这些字段）。S3 字段是一等公民，不是 optional extension。没有 novelType 分支——传统小说只是碰巧不填。

**⚠️ 字段集经 `docs/reference/stage-3/modern-novel-structure-survey.md` 三层 survey 重分类。Genette 五维度已移至 S6（base schema）——它们描述任何叙事，不是现代小说扩展。S3 仅保留真正现代主义/后现代特有的结构。**

修正后字段集（9 个，详见 survey 文档修正后总表）：

A 类——结构元数据（deterministic check）：
- `antiCausalEdge` — 事件不产生后果（保留，附加阈值：系统级规模 >50% 才标注为 S3，单个由 base 管理）
- `chapterOrder: contested` — 章节顺序不可决定（保留，与 Genette Order base 的关系：base 允许多 order 时，contested 标记"无作者意图"）
- `surfaceMode` — 结构性拒绝心理深度，叙事只描述表面（新增，Robbe-Grillet；验证：scene metadata 标注，检验是否存在内部视角）
- `causalOverload` — 因果过载，事件产生过多可能后果（新增，Pynchon；与 antiCausalEdge 对立；验证：thread branching factor 阈值）

B 类——语义效果（Pass 2 对照作者透传 prompt 检查）：
- `irresolvableIndeterminacy` — Fact value 不可解决（更名自 `suspension`——Derrida différance 证明 deferral 是终态结构，不暗示"临时悬置"）
- `absentApparatus` — 实体通过缺席产生结构性效果（更名自 `absenceProfile`——D&G 纠偏：修正"通过缺失定义"为"缺席装置"）
- `voiceDissonance` — 叙事者语气与所叙内容的结构性裂隙（保留但缩窄定义，Kafka 模式；不覆盖 Robbe-Grillet/Calvino）
- `multiplicity` — 多个有效值同时合法，系统不要求选择单一（新增，Borges + Barthes S/Z）
- `metanarrativeLevel` — 叙事以自身建构为对象的结构性自指（新增，Calvino；扩展 Genette narrative level 但"结构性自指是现代特有的"）

`uncloseableThread` 已移出 S3 → base schema（thread 层，更名 `unresolvedThread`）——传统小说也有未闭合线程，非现代专属。

B 类依赖 S1（narrativeChecklist）的 Pass 2 通道。S1 是 S3 B 类的前置依赖。

**产出**: unified schema 扩展（S3 字段为一等公民），A 类 deterministic validator，B 类复用 S1 Pass 2 通道

### [x] S3-research — 现代小说结构字段系统推导（S3 前置）— 已完成

S3 字段集锁定的理论推导。产出为理论文档，不是代码。**已完成**——见 `docs/reference/stage-3/modern-novel-structure-survey.md`。

**重定范围**：原设计三层，现两层——第 1 层（Genette 叙事学 survey）已移至 S6（base schema audit），因 Genette 五维度描述任何叙事不是现代小说扩展。S3-research 只保留真正现代主义/后现代特有的部分。

**第 1 层——叙事学 survey**：❌ **已移除**——移至 S6（`docs/reference/stage-3/narratology-dimension-audit.md`）。Genette Order/Duration/Frequency/Mood/Voice 是 base schema，不是 S3。

**第 2 层——现代主义/后现代批评 survey**：✅ **已完成**。Eco《开放的作品》、Iser《隐含的读者》、Barthes S/Z、Derrida "Before the Law"、Deleuze & Guattari《卡夫卡》。产出：`suspension` → `irresolvableIndeterminacy`（Derrida différance），`absenceProfile` → `absentApparatus`（D&G 生产装置纠偏）。

**第 3 层——多作品 survey**：✅ **已完成**。Kafka/Beckett/Borges/Robbe-Grillet/Pynchon/Calvino。产出 4 新字段：`multiplicity`（Borges）、`surfaceMode`（Robbe-Grillet）、`causalOverload`（Pynchon）、`metanarrativeLevel`（Calvino）。原 5 个已知错位全部解决。

**产出**: `docs/reference/stage-3/modern-novel-structure-survey.md`——第 2-3 层 survey 结果 + 修正后字段集提案（9 字段）+ 理论-字段对照矩阵 + 作品-字段对照矩阵

### [x] S4 — sourceContext: 风格透传

每 event 携带 `sourceContext`——从原文摘取的风格锚点（氛围描写、句式片段、诗词原文），经事实/风格分离过滤后作为 Pass 1 的风格参考。不进入 Fact 比较，不和 validator 冲突。

**产出**: `sourceContext` schema, context compiler 扩展, LLM 预处理器（标注 STYLE/FACT/MIXED）

### [x] S5 — schema-aware generation pipeline

LLM 生成 YAML 后立即 schema 验证，失败则重试（最多 3 次）。首次通过率从 ~25% 提升到 >80%。

**产出**: 生成脚本增加 `YAML.parse → schema.validate → retry` 循环

### [x] S6 — base-narratology: Genette 五维度补全（base schema 审计）

Genette 五维度是任何叙事的基础，不属于 S3（现代小说扩展）。详见 `docs/reference/stage-3/narratology-dimension-audit.md`。当前状态：Order 部分覆盖、Duration/Frequency 完全缺失、Mood/Voice 死类型（`NarratorProfile` 完整存在但零 fixture 接线）。

子项：
- **S6a — Duration**：新增 `DurationProfile`（scene/summary/ellipsis/pause/stretch）类型 + schema。**最大盲区**——整个系统无任何 Duration 概念。注意 `NarrativeEllipsis` 是语料诊断类型，不是 Genette 省略。
- **S6b — Frequency**：新增 `FrequencyProfile`（singulative/repeating/iterative）类型 + schema。完全缺失。
- **S6c — Mood 接线**：打通 `NarratorProfile`（focalizer_bound/retrospective_entity/explicit_ledger/omniscient）的 YAML 加载路径，使 fixture 可引用 NarratorProfile 而非退化到 crude `pov.type`。新增 external focalization 类型。
- **S6d — Voice 叙事层**：新增 `NarrativeLevel`（extradiegetic/intradiegetic/metadiegetic）+ `DiegeticRelation`（homo/heterodiegetic）枚举，补全 `NarratorProfile` 的层级维度（当前只建模能力，非层级）。
- **S6e — Order 细化**：新增 `Anachrony` 接口（type/scope/function/distance/amplitude）细化 `sceneType: flashback/flashforward` 的错时分类。

**产出**: 5 个 Genette 维度的类型 + schema + fixture 接线。Mood/Voice 从死类型转为 wired。

### [x] S7 — Idea IR + Story IR: 上层 IR 层（缺失）

两个上层 IR 从未实现。详见 `docs/reference/stage-3/ir-layer-narratology-mapping.md`。

- **S7a — Idea IR**（亚里士多德 Mythos）：新增整体主题意图类型——`ThematicIntent`（主题声明 + 子主题）、`EmotionalArcDefinition`。亚里士多德认为 Mythos 是悲剧六要素中最重要的，当前系统无此层。现有的 `emotionalValence`/`conflictType` 是逐场景的，不是整体层面。
- **S7b — Story IR**（普罗普 31 功能 + 格雷马斯行动元）：新增 `StructuralFunction`（Propp 函数子集）、`ActantModel`（主体/客体/发送者/接收者/帮助者/反对者）、`StoryArchetype`。**Thread 系统是天然起点**——`ThreadTransaction`/`ThreadLifecycle` 已跟踪目标导向叙事进程，可携带 Propp 函数标签。`arcPosition` 提供节奏位置但非功能语义。

**产出**: 两个上层 IR 的类型 + schema + Thread 系统扩展（携带结构功能标签）。

### [x] S8 — Planner: 前向事件生成层（完全缺失）

Planner 是叙事学谱系第 8-9 层（Interactive/AI Narrative）——WorldState → Planner → 候选事件 → Fabula。当前事件全手写 YAML，无 forward planning。详见 `docs/reference/stage-3/planner-layer-analysis.md`。

**关键区分**：Discovery Layer（草稿→YAML，输入侧）已在"核心问题"讨论。Planner（YAML→下一个事件，输出侧）完全缺失。TODO 此前只单向解决创作成本问题——Planner 打破"每个事件都需外部输入"的依赖，是前向创作成本的真正解。

**代码现状验证**：`render/surface-planner.ts` 的 `PlannerMode`（manual/suggest/auto）是 SURFACE 渲染分组策略，不是叙事事件规划。`ai/prompts/thread-status.ts` 有"suggest 1-3 immediate next actions"的 LLM prompt 但是一次性诊断工具，不访问 WorldState/goals/arc，不是结构化规划器。**零代码、零类型、零 schema、零 fixture 涉及前向事件生成。**

Planner 可消费的现有资产：WorldState（实体/关系/知识/线程/规则）、`ThreadRuntimeState.goalStates`（active 目标是规划器输入）、`arcPosition`（弧规划数据）、`NarrativeEvent` preconditions/postconditions（因果链知识）、`RuleRuntimeState`（约束）。

3 模式匹配现有 `PlannerMode` 模式：
- **manual**：作者写下一事件，系统验证 preconditions
- **suggest**：系统基于 state + goals 提候选事件，作者选
- **auto**：系统生成事件链（research-grade）

缺失的规划器原语：`NarrativeGoal`（目标表示，超越 thread progress 的被动标签）、`ActionDefinition`（动作空间——当前状态下哪些事件可能）、arc 约束执行（必须第 N 章到高潮）、branch-aware 规划。

**产出**: `NarrativeGoal` + `ActionDefinition` 类型 + schema，manual/suggest 模式实现，WorldState→候选事件管线。

> **2026-07-24 设计修正**: S8 的原始假设（前向事件生成）与当前系统架构不兼容。本系统的 Novel IR 输入是已完成的小说——事件全部已发生，不存在"下一步该写什么"。Planner 是面向生成式写作工具（Novel OS、Sudowrite）的设计，不是面向已完成小说的结构化建模系统。如果未来需要此方向的能力，应该是独立的 **YAML 编辑器模块**（利用 LLM 辅助人工将小说原文写成稳定的 YAML），而不是 core 管线内的前向规划器。现有类型定义和 18 个测试保留作为参考实现。

> **2026-08-02 校正（supersedes 上一段）**: 上段 "现有类型定义和 18 个测试保留作为参考实现" 已过期——S8 类型与测试随后被删除（`docs/report.md` 记载其于 2026-07-24 从 `packages/core/src/types/index.ts` 移除并注明 "S8 removed (design incompatible with Novel IR)"，`modern-novel.test.ts` / `narrative-planner.test.ts` 亦不再存在）。Planner 不是当前能力，见 [`docs/current-state.md`](./current-state.md) 已知限制表。上方标题的 `[x]` 与正文 "完全缺失" 的矛盾由此澄清：S8 从未实现、已移除。

## C: 测量能力 (Measured)

### [x] C1 — 红楼梦 80 事件覆盖度基准

用 `narrativeChecklist` 系统重新评估 12 个现有事件 + 扩展到 20 个。报告 per-dimension 覆盖率和信息丢失率。

**产出**: `output/checklist-coverage.md`

**2026-08-02 校正**: 规划标题 "80 事件" 与正文 "12→20 事件" 均为规划期数字，未按此规模完成。当前夹具为四章 E01–E36；`output/checklist-coverage.md`/`.json` 保留为 20 事件时期的**历史快照**（Pre-run，未含 LLM Pass 2 实测），生成它的 `checklist-coverage.ts` 脚本已不在当前源码中——旧数字无法由当前源码重新生成。

### [x] C2 — (scaffolds ready, awaiting human annotation) 人类标注：12 事件的 precondition/postcondition

对现有 12 个事件进行人工标注精确的前置/后置条件。与 LLM 生成的比较 F1。用作 `compareFact()` 的 ground truth。

**产出**: 标注数据 + F1 报告

**2026-08-02 校正**: "现有 12 个事件" 为旧夹具数字——当前夹具为四章 E01–E36；该任务仍待人工完成（scaffold 现状见 `docs/report.md` C2 节）。

### [x] C3 — (scaffolds ready, awaiting human annotation) 人类标注：双轮标注（标注规范已有）

按 `docs/reference/stage-3/annotation-guidelines.zh-CN.md` 执行 ≥120 问题级 + ≥50 场景级标注，7-14 天后盲法复标。产出 Cohen's kappa + Spearman rho。

**产出**: 标注数据集 + 信度报告

---

## X: 明确拒绝 (Explicitly Rejected)

| 条目 | 原因 |
|------|------|
| David Copperfield 项目 | 红楼梦作为阶段收尾，资源集中 |
| 四世同堂项目 | local_external，文本已获取但待后续 |
| 103章回译 | 用户明确放弃 |
| 全文 LLM 自动提取 | 质量不可靠（~25% schema 合规），需人工标注 |
| ~~卡夫卡/现代主义建模~~ | **已分层至 S3+S6**——S3 现代特有结构（分层验证：A 类 deterministic + B 类 Pass 2 对照作者透传 prompt），S6 base 叙事学（Genette 五维度）。不是"当前范式不适用" |
| 诗词结构化建模 | 诗词本质不兼容 state machine，用 sourceContext 透传 |
| 全量 400+ 人物建模 | 投入产出比低，按 mention count 取 top 40 足够 |

---

## 阶段 3 验收标准

**S 能力**: S1-S8 全部实现 + 测试通过。S3-research 已完成（字段集 9 个锁定）。S3 须标注 A 类（deterministic validator）和 B 类（依赖 S1 Pass 2 通道）各自的完成度。S6（base-narratology Genette 五维度）须标注 Duration/Frequency/Mood-wiring/Voice 各子项完成度。S7（Idea IR + Story IR）+ S8（Planner）须标注各子项完成度。
**C 能力**: C1 覆盖报告完成 + C2 F1 ≥ 0.70 + C3 Cohen's kappa ≥ 0.60
**项目**: `fixtures/dream-of-red-chamber/` 20 events 通过全量 validation（含 ChecklistValidator + GreyLineValidator + S6 Genette 维度 validator）

> **2026-08-02 校正（验收标准已部分失效）**: 本节为阶段 3 规划期验收标准（页脚日期 2026-07-23）。"S1-S8 全部实现" 已不成立——S8（Planner）是移除而非实现；"20 events 通过全量 validation" 为旧夹具数字，当前夹具为四章 E01–E36，该验收项未按原数字完成。当前已核验事实（28 个默认 built-in validators、GreyLine opt-in、`npm test` 根 2,881 + Host 367 + Client 36、lint 0 errors/630 warnings/236 infos）以 [`docs/current-state.md`](./current-state.md) 为准。

---

*基于 stage-2-corpus-audit.md 发现。2026-07-23*
