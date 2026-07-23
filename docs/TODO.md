# TODO.md - 系统的整体计划

> **前身**: `docs/archive/TODO-stage-1-1.5.md` (1420 lines, stage 1 + 1.5 complete)
> **阶段 2 部分验收**: `docs/audits/stage-2-corpus-audit.md`
> **基准项目**: `fixtures/dream-of-red-chamber/` — 12 events, 40 characters, 8 locations, 5 rules

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

### [ ] S1 — narrativeChecklist: 自检查大纲系统

每 event 携带 `narrativeChecklist` 字段——从原文分析提取的必须覆盖维度清单（诗词、对话个性、反讽距离、草蛇灰线等）。Pass 1 作为风格约束输入，Pass 2 逐项评估覆盖率，新增 `ChecklistValidator` 检查 `must_include` 项。

**产出**: `narrativeChecklistSchema`, `ChecklistValidator`, `checklistResults` in `AnalysisResult`, context compiler 增加 checklist 段

**依赖**: 当前 schema 可扩展，向后兼容

### [ ] S2 — greyLines: 草蛇灰线多点追踪

替代 `foreshadowing` 的二元模型（种子→应验）。`greyLines` 为多点结构——同一意象在多个事件中反复出现、每次累积不同语义。节点列表持续增长，不要求闭合。

**产出**: `greyLines` schema 字段，跨事件追踪逻辑，`GreyLineValidator`

### [ ] S3 — 现代小说结构建模层

Schema 为最一般情况（现代小说）设计，传统小说是约束子集（不填这些字段）。S3 字段是一等公民，不是 optional extension。没有 novelType 分支——传统小说只是碰巧不填。

**⚠️ 字段集为 provisional draft——以下 6 个字段从《审判》单文本提取，未经系统推导。三层 survey（见下方 S3-research）完成前不可锁定。**

6 个字段分两类验证路径：

A 类——结构元数据（deterministic check）：
- `uncloseableThread` — 线程不收敛。验证：该线程在最终 WorldState 里未达 resolved/concluded
- `antiCausalEdge` — 事件不产生后果。验证：该事件 postconditions 不被任何后续事件 preconditions 引用
- `chapterOrder: contested` — 章节顺序不可决定。验证：metadata 标注存在，Assembler 按 chosen rendering 排序

B 类——语义效果（Pass 2 对照作者透传 prompt 检查）：
- `suspension` — Fact value 不可决定。验证：Pass 2 对照 narrativeChecklist 透传 prompt
- `absenceProfile` — 实体通过缺失定义。验证：同上
- `voiceDissonance` — 语气与内容裂隙。验证：同上

B 类依赖 S1（narrativeChecklist）的 Pass 2 通道。S1 是 S3 B 类的前置依赖。

**产出**: unified schema 扩展（S3 字段为一等公民），A 类 deterministic validator，B 类复用 S1 Pass 2 通道

### [ ] S3-research — 现代小说结构字段系统推导（S3 前置）

S3 字段集锁定前必须完成三层 survey。产出为理论文档，不是代码。

**第 1 层——叙事学 survey**：
Genette《叙事话语》(order/duration/frequency/mood/voice)、Chatman、Bal、Rimmon-Kenan。确定叙事学的结构维度全集，对照现有 schema 标注已覆盖/缺失。已知缺口：
- Frequency（singulative/repeating/iterative）——Beckett 迭代静止需要
- Narrative level（extradiegetic/intradiegetic/metadiegetic）——故事中的故事需要

**第 2 层——现代主义/后现代批评 survey**：
Eco《开放的作品》(open/closed work)、Iser《隐含的读者》(gaps/Leerstellen)、Barthes S/Z (readerly/writerly)、Derrida "Before the Law" (deferral as structure)、Deleuze & Guattari《卡夫卡》(生产装置 vs 缺席实体)。确定现代主义特有的结构属性。已知问题：
- `suspension` 暗示"暂时悬置"，Derrida 的 différance 是"悬置即终态"
- `absenceProfile` 把法庭建模为缺席实体，D&G 认为法庭是生产装置——两个不同结构概念

**第 3 层——多作品 survey**：
Kafka/Beckett/Borges/Robbe-Grillet/Pynchon/Calvino。确保字段不只在 Kafka 上 work。已知错位：
- Beckett：需要 frequency=repeating + antiCausal 组合（反复无后果），当前只有 antiCausalEdge
- Borges：需要 multiplicity（多个值同时合法），不是 suspension（单一不可决定）
- Robbe-Grillet：需要 depthRefusal/surfaceMode（结构性拒绝心理深度），不是 voiceDissonance
- Pynchon：需要 causalOverload（因果过载），和 antiCausalEdge 相反方向
- Calvino：需要 selfReflexivity/metanarrativeLevel（元叙事自指），不是 voiceDissonance

**产出**: `docs/reference/modern-narrative-structure-survey.md`——三层 survey 结果 + 最终字段集提案 + 每个字段的理论出处和作品验证

### [ ] S4 — sourceContext: 风格透传

每 event 携带 `sourceContext`——从原文摘取的风格锚点（氛围描写、句式片段、诗词原文），经事实/风格分离过滤后作为 Pass 1 的风格参考。不进入 Fact 比较，不和 validator 冲突。

**产出**: `sourceContext` schema, context compiler 扩展, LLM 预处理器（标注 STYLE/FACT/MIXED）

### [ ] S5 — schema-aware generation pipeline

LLM 生成 YAML 后立即 schema 验证，失败则重试（最多 3 次）。首次通过率从 ~25% 提升到 >80%。

**产出**: 生成脚本增加 `YAML.parse → schema.validate → retry` 循环

---

## C: 测量能力 (Measured)

### [ ] C1 — 红楼梦 80 事件覆盖度基准

用 `narrativeChecklist` 系统重新评估 12 个现有事件 + 扩展到 20 个。报告 per-dimension 覆盖率和信息丢失率。

**产出**: `output/checklist-coverage.md`

### [ ] C2 — 人类标注：12 事件的 precondition/postcondition

对现有 12 个事件进行人工标注精确的前置/后置条件。与 LLM 生成的比较 F1。用作 `compareFact()` 的 ground truth。

**产出**: 标注数据 + F1 报告

### [ ] C3 — 人类标注：双轮标注（标注规范已有）

按 `docs/reference/annotation-guidelines.zh-CN.md` 执行 ≥120 问题级 + ≥50 场景级标注，7-14 天后盲法复标。产出 Cohen's kappa + Spearman rho。

**产出**: 标注数据集 + 信度报告

---

## X: 明确拒绝 (Explicitly Rejected)

| 条目 | 原因 |
|------|------|
| David Copperfield 项目 | 红楼梦作为阶段收尾，资源集中 |
| 四世同堂项目 | local_external，文本已获取但待后续 |
| 103章回译 | 用户明确放弃 |
| 全文 LLM 自动提取 | 质量不可靠（~25% schema 合规），需人工标注 |
| ~~卡夫卡/现代主义建模~~ | **已移至 S3**——分层验证：A 类 deterministic + B 类 Pass 2 对照作者透传 prompt。不是"当前范式不适用" |
| 诗词结构化建模 | 诗词本质不兼容 state machine，用 sourceContext 透传 |
| 全量 400+ 人物建模 | 投入产出比低，按 mention count 取 top 40 足够 |

---

## 阶段 3 验收标准

**S 能力**: S1-S5 全部实现 + 测试通过。S3-research 完成后字段集锁定，S3 须标注 A 类（deterministic validator）和 B 类（依赖 S1 Pass 2 通道）各自的完成度。S3 字段集在 S3-research 完成前保持 provisional
**C 能力**: C1 覆盖报告完成 + C2 F1 ≥ 0.70 + C3 Cohen's kappa ≥ 0.60
**项目**: `fixtures/dream-of-red-chamber/` 20 events 通过全量 validation（含 ChecklistValidator + GreyLineValidator）

---

*基于 stage-2-corpus-audit.md 发现。2026-07-23*
