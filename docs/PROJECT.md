# 项目：叙事工程系统 (Narrative Engineering System)

> 让人和 LLM 在同一套可靠规则下协作；让小说变成可管理的工程对象；让写作像开发一样可分支、可回滚、可审查、可缓存、可调试；让 LLM 负责创造，让系统负责稳定。

## 一、项目定义

### 要解决的问题

现有所有 AI 写作工具（Sudowrite、NovelAI、Novelcrafter、SillyTavern）的共同缺陷：

| 问题 | 现状 | 我们要做的 |
|------|------|-----------|
| 一致性检查 | 只提供"参考"（story bible），不主动验证 | **确定性检查器**：每次 AI 输出后自动检测冲突 |
| 状态管理 | 无持久化角色/世界状态，每次手动贴设定 | **Event Sourcing + Snapshot**：状态可追溯、可回滚 |
| 版本控制 | 无 Git 式 branch/diff/rollback | **Git 原生集成**：分支、合并、回退 |
| 上下文 | 上下文窗口浪费，长篇小说断裂 | **上下文编译器**：按 Scene 需要智能组装最小 Context |
| 复杂叙事 | 无多线剧情/伏笔/POV知识隔离 | **Event + Plot Thread 模型**：原生支持复杂叙事结构 |
| 可扩展性 | 硬编码功能，无法适配不同小说类型 | **Plugin 系统**：Genre/Technique/Agent 三层插件架构 |

### 系统架构：三层模型

基于成品愿景的完整架构。用户交互 → 工程流水线 → 反馈闭环。

```
┌─────────────────────────────────────────────────────────┐
│  DISCOVERY LAYER（发现层）                               │
│  用户通过 AI Interface（opencode/claude/codex 等）       │
│  自由聊天讨论灵感、人设、世界观、同人参考...              │
│                                                         │
│  AI 渐进式地将讨论结果结构化：                           │
│    聊到角色 → AI 生成 character.yaml                    │
│    聊到世界观 → AI 生成 world.yaml                       │
│    聊到剧情 → AI 生成 outline.yaml                       │
│                                                         │
│  技术手段：任何能读写文件的 AI 工具都可充当发现层        │
│  Core 定义了标准文件格式（YAML schema），发现层只需      │
│  产出符合格式的文件即可                                  │
└────────────────────────┬────────────────────────────────┘
                         │ 结构化 YAML/MD 文件
                         ▼
┌─────────────────────────────────────────────────────────┐
│  CORE LAYER（核心引擎层）                                │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐      │
│  │ State    │  │ Version  │  │ Validator (11种) │      │
│  │ Manager  │  │ Control  │  │                  │      │
│  │          │  │  (Git)   │  │ Timeline         │      │
│  │ Event    │  │          │  │ CharacterState   │      │
│  │ Sourcing │  │ branch   │  │ Knowledge        │      │
│  │          │  │ diff     │  │ WorldRule        │      │
│  │ Snapshot │  │ rollback │  │ Causal           │      │
│  │          │  │ merge    │  │ Foreshadow       │      │
│  │ DAG      │  │          │  │ POV              │      │
│  └──────────┘  └──────────┘  │ FactualDetail    │      │
│                               │ VoiceDrift       │      │
│  ┌──────────────────────┐    └──────────────────┘      │
│  │ Context Compiler     │                               │
│  │ + Relevance Engine   │    ┌──────────────────┐      │
│  │ + TKG Indexer        │    │ Plugin System    │      │
│  └──────────────────────┘    │ + Arbitration    │      │
│                               └──────────────────┘      │
│                                                         │
│  Proposal → Validate → Commit → Update State            │
│  LLM 和人提交的修改走同一条路径                          │
└────────────────────────┬────────────────────────────────┘
                         │ Scene Draft + Context + State
                         ▼
┌─────────────────────────────────────────────────────────┐
│  REVIEW LAYER（审阅反馈层）                               │
│                                                         │
│  用户通过 AI Interface 反馈：                            │
│    "这段风格出戏" "节奏太赶" "Alice 这句不像她"         │
│                                                         │
│         ↓                                               │
│  ReviewComment（审阅评论）                               │
│    - 关联到具体 Scene/Chapter/Line                      │
│    - 状态: open → addressed → resolved                  │
│    - 严重度: nit / suggestion / blocking                │
│         ↓                                               │
│  Patch（修改补丁）                                       │
│    - 用户或 LLM 根据 Review 生成修改建议                 │
│    - 走 Proposal → Validate → Commit                    │
│         ↓                                               │
│  重新渲染 / 重新生成                                    │
│                                                         │
│  审阅评论本身也进入版本历史，可追溯                      │
└─────────────────────────────────────────────────────────┘
```

**关键设计原则**：
- **Discovery Layer 与 Core 解耦**：不写死 AI 工具。opencode、claude code、cursor、甚至手写 YAML 都可以。Core 只定义文件格式
- **LLM 和人走同一条管线**：LLM 写的东西 ≡ 人写的东西，都要通过 Validator
- **文件是唯一的权威接口**：用户或 AI 编辑 YAML/MD 文件。Core 是纯函数——被调用时读取文件、验证、返回结果。`nova validate`（或 MCP tool）执行一次完整流程。FileWatcher daemon（`nova watch`）是可选便利层——openode 等 agent 不需要它，直接调用函数即可
- **引擎与创作项目分离**：系统引擎是独立安装的工具（类似 Git），创作项目是独立目录（类似 Git 仓库）。AI agent 的工作目录是创作项目根目录，无权访问引擎源码。引擎通过 FileWatcher daemon 监控创作目录。和 Git 的模式完全一致——`git` 在 PATH，`.git` 在仓库里，操作命令永远在仓库目录运行
- **最终产出是书，不是数据集**：所有 YAML、Event、Validator、Context Compiler 都是手段。最终产出是一个可读的 markdown 文件（或 EPUB/DOCX），由 Assembler 将已 committed 的 Scene prose 按 narrativeOrder 拼接而成。用户不需要导出脚本——系统自带组装
- **Review 是有状态的一等对象**：不是临时的聊天记录，而是项目资产的一部分

**UX 两阶段策略**：
- **一期（CLI + AI chat agent）**：引擎负责确定性验证，反馈通过 `PROJECT_STATUS.md`（自动更新的项目状态文件，用故事语言写验证结果而非技术 ID）+ CLI `nova status`。opencode 等 AI agent 作为自然语言前端——小说家聊天，agent 翻译为 YAML，验证结果由 agent 用人类语言报告
- **二期（可视化）**：分支树图、时间线可视化、知识状态面板、编辑器插件（行内错误标记）

### 核心理念：Proposal-Commit 模式

```
Human/LLM → Proposal（修改提案）
              ↓
         Validator（一致性检查 + 规则验证）
              ↓ 通过
         Commit（写入状态 + 记录事件）
              ↓ 失败
         Reject（回退，给出冲突报告）
```

这借鉴了软件工程中 **PR → Code Review → CI checks → Merge** 的流程。

### 五层领域模型

基于论文交叉验证和抽象分析的修正。Knowledge 和 Relationship 从附属提升为一等实体。

```
Definition（静态定义：角色设定、世界规则、关系类型定义）
    ↓
Event（叙事事件：Alice 救了 Bob）
    ↓
Rule（变化规则：save_life → trust 提升 / betrayal → trust 不可逆崩塌）
    ↓
State（当前状态：Alice 信任 Bob = 80，Alice 位置 = 王城）
    ↓
Knowledge（知识状态：世界真相 / 各角色知道什么 / 读者知道什么 / 叙述者知道什么）
```

五者严格分离。Knowledge 和 State 是平行的当前状态层，但 Knowledge 需要独立的 Event 类型和验证规则，因为它描述的不是"世界是什么样的"而是"谁以为世界是什么样的"。

**Knowledge 的 Event 类型**：
- `Learn(character, fact)` — 角色获知某个事实
- `Forget(character, fact)` — 角色遗忘/忽略某个事实
- `Misbelieve(character, false_fact, true_fact)` — 角色误信某信息
- `Deceive(target, false_fact, deceiver)` — 角色被另一角色故意误导
- `Reveal(fact, audience)` — 某个事实对特定受众（角色/读者）揭示

**Relationship 作为一等实体**（不附属于 Character）：
- 关系有独立的 `Definition`（关系类型、初始状态）、`State`（当前信任度/亲密度/权力关系）、`Event`（关系变化事件）
- 关系是**双向独立**的：Alice 对 Bob 的信任 ≠ Bob 对 Alice 的信任
- 关系类型：familial（家族）、romantic（恋爱）、power（权力）、trust（信任）、rivalry（竞争）等，由 Plugin 扩展

**Rule 层的定性转换语义**（修正游戏机制倾向）：
- `irreversible`：某些状态变化不可逆（死亡、重大背叛后的信任崩塌）
- `conditional`：状态变化有前提条件（只有在特定条件下才会触发）
- `gradual`：状态变化需要多次事件积累（信任缓慢建立）
- `threshold`：累积到阈值后触发质变（多次怀疑 → 彻底不信任）
- 定量值（trust +20）仅作为内部追踪辅助，对外暴露为定性描述

### 核心创新：Novel IR + Story/Discourse 分离

这是整个项目最具原创性的架构洞察，来自叙事学（Narratology）和编译原理的交叉。

> ⚠️ **当前状态：概念设计阶段。** Novel IR 的洞察方向正确，但缺乏正式规格（schema、grammar、transformation pipeline）。以下描述的是目标形态，具体 schema 需要在开发中演进定义。

**1. Novel IR（小说中间语言）**

类似 LLVM 之于编程语言。LLM 不直接"写小说"，而是**把 Novel IR 渲染成自然语言**。传统软件负责维护 IR 的一致性、版本、依赖和验证。

对话中探索了 IR 的多层次结构（对话 §4）：
```
Idea IR → Story IR → Scene IR → Event IR → World State → Novel Text
```

每层有不同粒度和用途：
- **Idea IR**：灵感/需求 → 结构化叙事意图（LLM 解析）
- **Story IR**：整体结构 → 时间线 DAG + Thread 图（程序管理）
- **Scene IR**：场景意图 → Scene Contract（程序编译）
- **Event IR**：叙事事件 → Definition→Event→Rule→State 四元组（程序验证）
- **Rendered Text**：自然语言正文（LLM 生成）

Novel IR 的核心四类对象：
- **世界状态（State）**：角色、地点、物品、规则、时间等所有可验证的事实
- **叙事事件（Event）**：谁在什么条件下做了什么，带来了哪些状态变化
- **剧情线程（Thread）**：主线、支线、伏笔、人物成长线等跨场景持续演化的目标
- **场景意图（Scene Intent）**：这一场为什么存在，推进哪条线，改变哪些状态

+ **知识（Knowledge）**：一等实体 — 世界真相、角色知识、读者知识、叙述者知识（§7.2）

**2. Story vs Discourse（叙事学经典二分）**

> 叙事学研究了 100 年，AI 社区几乎完全没利用。

- **Story**：真正发生的事情，按时间顺序排列 → 一棵 DAG（有向无环图）
- **Discourse**：小说怎么写出来的，叙事顺序 → 相当于 **Render** 层

类比 React：Story = Virtual DOM，Discourse = Render。这是一个非常精确的工程类比。

**3. 最小叙事单元**

一个小说，在"不考虑文字表达"的情况下，最小不可再分的叙事单元不是 Chapter、Paragraph 或 Event，而是 **"叙事状态变迁（Narrative State Transition）"** — 它描述**为什么世界发生了变化，以及这种变化对故事意味着什么**。

### Scene 生成渲染流程

这是系统的核心工作流。LLM 不是拿数据库 JSON 直接写，而是拿 **经过编译器组装的 Narrative Context Package**：

```
用户定义 Scene Intent（why this scene exists, what it advances）
              ↓
    Context Compiler 从 State 组装 Context Package：
      ├── System Context（genre, style, narrative rules）
      ├── Scene Specification（goal, POV, conflict, expected outcome）
      ├── Character Snapshot（仅当前 Scene 相关角色 + 当前状态）
      ├── Relationship Context（相关关系 + 当前状态 + 未解决的张力）
      ├── World Facts（仅相关世界观片段 + Knowledge Boundary）
      ├── Knowledge Boundary（谁此时知道什么，不知道什么）
      ├── Active Threads（当前活跃的剧情线）
      └── Previous Scene Summary（不是全文，是摘要）
              ↓
         LLM 渲染为 Draft 正文
              ↓
    Validator 检查（连续性、角色、风格、知识边界等）
              ↓
    Accept / Reject / Patch（人工或 AI 审稿）
              ↓
         Commit（写入事件 + 更新状态）
```

**关键设计原则**：
- **不要直接把数据库给 LLM** — 数据库是给程序看的，LLM 需要"编译后"的自然语言 Context
- **Beat 用于规划，Scene 用于生成，Chapter 用于审核** — 三级粒度各司其职
- **固定 Constraint，开放 Creative Space** — 类似游戏设计：Boss 必须死，但玩家怎么打自由。Scene 的目标/结局固定，写法自由
- **Context 不是固定的** — 类似 IDE 只加载附近代码，不是加载整个项目

## 二、参考项目与研究基础

### 最直接相关的开源项目

| 项目 | 关键启发 |
|------|---------|
| **[Novel OS](https://github.com/andrewbiro/novelos)** | Agent pipeline（Planner → Writer → Editor → Guardian）+ 确定性 continuity engine |
| **[write_ai_agent](https://github.com/rareloto/write_ai_agent)** | KG 反馈循环 + 增量状态更新 + 3 路上下文召回 |
| **[StoryState](https://github.com/YuZhenyuLindy/StoryState)** | 局部状态编辑，最小化修改影响 |
| **[mcp-writing](https://github.com/hannasdev/mcp-writing)** | 元数据优先 + Git 历史 + Scrivener 集成 + MCP |
| **[Narrative Canon](https://github.com/project-89/narrative-canon)** | 完整的 Git-like 叙事版本控制（分支、合并、时序悖论解决） |
| **[SillyTavern Director](https://github.com/luisbrandao/SillyTavern-Director)** | 双模型（planner + writer）pipeline |

### 关键学术进展

| 论文/系统 | 核心贡献 |
|-----------|---------|
| **DOME** (NAACL 2025) | 时间KG + 事件驱动增量提纲，冲突减少87.61% |
| **FactTrack** (NAACL 2025) | 带有效期的定向原子事实 |
| **CreAgentive** (ICLR 2026 sub) | 双重知识图谱 + 角色受限认知（Limited Cognition） |
| **Amory** (EACL 2026) | 按叙事层级组织的记忆，plot→subplot 树状结构 |
| **Zep/Graphiti** | 双时态知识图谱，支持"第7章时角色知道什么"的精确查询 |
| **ComoRAG** (AAAI 2026) | 200K+ token 叙事理解，迭代推理 |

### 已确认的技术路径（来自学术共识）

1. **增量 Diff 更新优于全量重建** — DOME、write_ai_agent 都证明了逐章增量更新的有效性
2. **LLM 忽略中间上下文** — "Lost in the Middle"效应，需要分层上下文优先注入
3. **分层缓存是必须的** — Context Cache / Snapshot Cache / Embedding Cache 三层
4. **MCP 是正确的集成协议** — 社区已形成 MCP 生态共识

## 三、MVP 范围

### 第一期 MUST HAVE

| 模块 | 功能 |
|------|------|
| **项目管理 + Entity 管理** | 项目 CRUD，人物/世界观/时间线/地点的 YAML 定义管理 |
| **Event** | Narrative Event（叙事事件）建模，含 pre/post-conditions + **分支条件**（BranchSet） | 借鉴 FactTrack 的定向事实分解；每个 Event 携带前置/后置条件 + 可选的分支存在性约束 |
| **版本管理 (Git)** | 所有数据文件纳入 Git，branch/diff/commit/rollback |
| **分支叙事 (Branch)** | **一期在 Event Sourcing 层面原生支持**。BranchPoint + BranchPath + 分支感知 replay + 合并冲突检测 | 线性叙事是默认（`BranchSet: all`），分支是可选扩展。Event Sourcing 的 replay 加一个过滤步骤即实现 |
| **上下文编译器** | 根据 Scene 需求组装 Context Package，分层优先级注入；支持按当前 BranchPath 过滤上下文 |
| **一致性检查器** | 时间线 / 角色状态 / 知识 / 世界观 / 因果 / 伏笔 / POV / 事实细节 / 分支合并冲突（共 10 种） |
| **Assembler（组装器）** | ★ 将已 committed 的 Scene prose 按 narrativeOrder 拼接，输出完整可读的小说文件 | 纯机械操作。支持 BranchPath 过滤（分支叙事中指定路径）。输出 `output/novel.md`。用户不需要自己导出——改完文件，书自动已存在 |

### 一致性检查完整覆盖（基于 ConStory-Bench 19 种错误分类）

| 检查器 | 覆盖的错误类型 | 确定性/LLM混合 |
|--------|--------------|---------------|
| TimelineValidator | 绝对时间矛盾、时长矛盾、同时性矛盾 | 确定性 |
| CharacterStateValidator | 记忆矛盾、技能/力量波动、被遗忘的能力 | 确定性 |
| KnowledgeValidator | 知识矛盾（角色知道不该知道的） | 确定性 + LLM 辅助 |
| WorldRuleValidator | 核心规则违反、社会规范违反、地理矛盾 | 确定性 |
| CausalValidator | 因果逻辑违反、无因之果 | 确定性 + LLM 辅助 |
| ForeshadowValidator | 被放弃的情节元素、过早揭示 | 确定性 |
| POVValidator | 视角泄露、视角混淆 | 确定性 |
| FactualDetailValidator | 外貌不匹配、命名混淆、数量不匹配 | 确定性 |
| BranchMergeValidator | 分支汇合点的前置条件在任何输入分支上都不满足 | 确定性 |
| VoiceDriftDetector | 语气不一致、风格转变 | LLM 辅助（软检查） |
| **LLM 提案式接入** | Proposal → Validate → Commit/Rollback 完整闭环 |
| **Plugin 系统** | 插件注册/能力声明/冲突检测，支持 Schema 扩展 |

### 第一期 NOT NOW → 转入二期

以下能力在系统设计中已有明确的扩展路径，一期不做，二期按需启用：

#### 领域模型扩展（二期）

| 扩展项 | 动机 | 影响范围 | 已有基础 |
|--------|------|---------|---------|
| **Narrator + 不可靠叙述者** | 第一人称/限制视角叙述者向读者说谎或隐藏信息的场景。当前所有 prose 默认为客观叙述，Validator 用 world_truth 检查 | 新增 Narrator 类型（独立的 Entity，不是 Character）；新增 `narrator_reality` 与 `world_truth` 双 reality 并行；Validator 需区分客观 prose 和叙述者发声 prose；Context Compiler 需双份上下文 | §7.4.10 已预留完整类型定义 |
| **Relationship 情感弧光** | 恋爱小说需要的 `emotional_state`、`relationship_stage`、`misunderstanding_stack`、`power_dynamic` 维度 | Relationship 模型扩展 + Romance Plugin + relationship_contradiction Validator 变体 | Relationship 已是一等实体，Plugin schema 扩展已支持 |
| **CanonSource 建模** | 同人/跨媒体需要区分 canon（官方原作）和 fanon（同人设定），标记 canon 偏离声明 | Knowledge 层新增 `CanonSource` variant（canon-primary/secondary/author-interview/fan-interpretation）；新增 `canon_violation` Validator；新增 `deviation_from_canon` 声明 | KnowledgeSource 类型已有 `direct_experience \| told_by \| inferred \| deceived_by`，加 variant 即可 |
| **Canon Hierarchy** | 跨媒体（小说版 vs 动画版 vs 电影版）的多源冲突仲裁 | Definition 层之上新增优先级系统（CSS specificity 式的多源裁决）。八个类型中唯一需要新概念的扩展 | Proposal-Commit 溯源是基础，但"外部不可修改源"vs"内部决策"的区分是全新概念 |

#### 基础设施与体验（二期）

| 扩展项 | 说明 |
|--------|------|
| **Web UI** | 一期 CLI 先行，核心库纯逻辑（与 UI 解耦），Web 能力架构已预留 |
| **多人协作 / Writer's Room** | 多作者同项目，分支+合并工作流 |
| **可视化** | 情感曲线图、叙事热力图、分支树可视化（游戏叙事标配） |
| **自动修复建议** | Validator ERROR 时 LLM 自动生成修复 Proposal（需 Circuit Breaker 机制保护） |
| **Plugin Marketplace** | 社区插件分发和发现 |
| **性能优化** | 大规模项目（100+ 章 × 多分支）基准测试和优化；分支感知 Context Compiler 缓存策略 |
| **export/publish** | 导出为 EPUB/DOCX/HTML 等出版格式

### 第一个可运行的原型

> **创建一个项目 → 定义角色和世界观 → LLM 辅助写一个 Scene → 自动检查一致性 → 通过后提交 → Assembler 自动生成可读小说 `output/novel.md`。**

完整走通 Proposal → Validate → Commit → Assemble 闭环。

## 四、技术决策

### 技术栈

| 层面 | 选型 | 理由 |
|------|------|------|
| **语言** | **TypeScript（已确认）** | 全栈统一类型；CLI/MCP/Web 共享核心库；MCP SDK 原生 TS |
| **运行时** | Bun（优先）/ Node.js | 性能、生态；Bun 原生支持 TS 无需编译 |
| **存储** | YAML/MD 文件 + SQLite 索引 | 文件可 Git 版本控制，SQLite 做结构化查询 |
| **版本控制** | Git (isomorphic-git 或直接 shell) | 原生 Git 支持所有 diff/branch/merge |
| **LLM 接入** | MCP Server | 标准化协议，可被 opencode/claude code 等所有 MCP client 调用 |
| **Plugin 系统** | 文件系统扫描 + TS 动态 import | YAML manifest 声明能力，核心加载并检测冲突 |
| **配置格式** | YAML（角色/世界/场景定义） | 人类可读，Git diff 友好 |
| **CLI 框架** | Commander.js 或 Clipanion | 子命令结构清晰 |
| **Web 预留** | 核心逻辑作为纯库，CLI 和 Web 共享 | 不写死到 CLI |

### 架构原则

1. **Core 不依赖 LLM（单一例外）** — 核心引擎（状态管理、版本控制、一致性检查）的主体是纯逻辑。11 个 Validator 中 8 个完全不调用 LLM，2 个 LLM 辅助。VoiceDriftDetector 是唯一必须 LLM 的例外（可选启用，默认 WARNING 级别）
2. **LLM 是可插拔的能力层** — 通过 MCP 或 adapter 模式接入
3. **Plugin 不能直接修改状态** — 只能通过 Proposal → Validate → Commit 路径
4. **文件是唯一的权威接口** — 所有数据是 YAML/MD 文件。Core 是纯函数库——被调用时读取文件、计算、返回结果。`nova validate` 执行一次即返回。FileWatcher daemon（`nova watch`）是可选的便利模式，对 agent 工作流不需要
5. **任何 AI 工具都可以是前端** — 系统不绑定 AI 工具。任何能读写 YAML 文件的 AI agent 都可以操作项目
6. **引擎与创作项目物理分离** — 引擎是独立安装的工具，创作项目是独立目录。AI agent 的工作目录 = 创作项目根目录，无权访问引擎源码。和 Git 的模式完全一致——`git` 在 PATH，`.git` 在仓库里

## 五、项目结构（初步）

```
novalistically/
├── packages/
│   ├── core/               # ★ 核心引擎（唯一必须精确实现的包）
│   │   ├── src/
│   │   │   ├── models/     # Character, World, Scene, Event, Thread, Knowledge, Relationship
│   │   │   ├── entities/   # Character, Relationship, Knowledge 等一等实体
│   │   │   ├── state/      # StateManager, EventStore, SnapshotEngine, EventSourcing
│   │   │   ├── validator/  # TimelineValidator, CharacterStateValidator, KnowledgeValidator,
│   │   │   │               # WorldRuleValidator, CausalValidator, ForeshadowValidator,
│   │   │   │               # POVValidator, FactualDetailValidator, VoiceDriftDetector
│   │   │   ├── compiler/   # ContextCompiler, RelevanceEngine, TKGIndexer
│   │   │   ├── assembler/  # SceneAssembler（narrativeOrder 排序 + BranchPath 过滤 + 拼接输出）
│   │   │   ├── graph/      # DependencyGraph, ImpactAnalyzer, ThreadTracker
│   │   │   ├── branch/     # BranchPath, BranchPoint, BranchSet, replay filter, merge detector
│   │   │   ├── cache/      # SnapshotCache, ContextCache, EmbeddingCache
│   │   │   ├── review/     # ReviewComment, ReviewPatch, ReviewStatus
│   │   │   ├── plugin/     # PluginLoader, ManifestParser, ConflictResolver, ArbitrationEngine
│   │   │   └── schemas/    # ★ 标准文件格式（YAML schema 定义）
│   │   └── tests/
│   ├── cli/                # CLI 工具（操作项目/entity/scene/validate/compile）
│   │   └── src/commands/
│   ├── mcp/                # MCP Server（让 opencode 等 AI agent 调用叙事能力）
│   │   └── src/tools/      # create_character, write_scene, check_continuity, review_scene ...
│   └── discovery/          # ★ Discovery Layer 辅助（标准 YAML 模板 + schema 文档）
│       └── templates/      # character.yaml.tmpl, world.yaml.tmpl, scene.yaml.tmpl ...
├── plugins/                # 内置插件
│   ├── mystery/            # 推理小说插件（Clue, RevealControl, SuspenseAnalysis）
│   ├── romance/            # 恋爱小说插件（RelationshipStage, EmotionalArc）
│   └── fantasy/            # 玄幻小说插件（PowerSystem, LevelConsistency）
├── docs/                   # 文档
│   ├── beginning.md        # 原始 GPT 讨论
│   └── PROJECT.md          # 本文档
└── fixtures/               # 测试用示例项目
```

**创作项目模板**（引擎与创作项目物理分离）。`nova project init` 生成：

```yaml
arcane-aftermath/          # ← AI agent 的工作目录（只看得到这个）
├── nova.yaml              # 项目配置
├── PROJECT_STATUS.md      # ★ 系统自动维护的项目状态（人类语言）
│
├── definitions/           # ★ 静态定义（作者/AI 写一次，偶尔改）
│   ├── characters/        # camille.yaml, orianna.yaml, npcs/npc_gear.yaml
│   ├── relationships/     # camille_seraphine.yaml（初始关系定义）
│   ├── rules/             # hextech.yaml, shimmer.yaml
│   └── state_initial.yaml # ★ 世界起始状态（全部动态状态的起点）
│
├── chapters/              # ★ 叙事事件，一章文件夹，一个事件一个文件
│   ├── chapter_01/
│   │   ├── _chapter.yaml   # 章节元数据：标题、摘要、意图
│   │   ├── E1a.yaml
│   │   └── E1b.yaml
│   ├── chapter_02/
│   │   ├── _chapter.yaml
│   │   └── E2.yaml
│   └── chapter_03/
│       ├── _chapter.yaml
│       ├── E3a.yaml       # 每个事件文件 7 个字段，只描述"这个场景发生了什么"
│       ├── E3b.yaml       # thread/foreshadow/relationship — 在文件里声明，系统自动追踪
│       └── E3c.yaml
│
├── scenes/                # ★ 渲染产物（LLM 生成，不手动编辑 prose）
│   ├── chapter-01/
│   │   ├── E1a_render_request.yaml
│   │   ├── E1a.md
│   │   └── E1a.yaml       # 场景元数据: prose_source, edit_history
│   └── chapter-03/
│       ├── E3b_render_request.yaml
│       ├── E3b.md
│       └── E3b.yaml
│
├── notes/                 # ★ 非结构化创作笔记（系统不读，给作者和 AI agent 做上下文）
│   ├── chapter_03_plan.md # 章节意图、节奏设计、想营造的感觉
│   └── character_arc_camille.md
│
├── reference/             # ★ 外部参考材料（系统不读，原始 lore、Wiki、对话记录）
│   ├── arcane_s1_basic_notes.txt
│   ├── camille_lol_bio.txt
│   └── piltover_zaun_wiki_summary.md
│
├── output/                # ★ Assembler 自动生成
│   └── novel.md            # 每次 commit 后更新
│
├── rejected_proposals/    # 被拒绝的修改
├── reviews/               # Review 评论
│
├── branches/              # 分支定义（可选）
│   └── branch_points.yaml
│
└── .nova/                 # 系统运行时
    ├── responses/          # ★ LLM 原始响应（git 追踪）
    ├── derived/            # ★ 系统自动生成的追踪文件（线程进度/伏笔状态/关系演变/规则证据链）
    ├── snapshots/          # 快照（重建，git 忽略）
    └── index.sqlite        # 索引（重建，git 忽略）
```

**目录职责表**：

| 目录 | 谁写 | 谁读 | 格式 | 可删？ |
|------|------|------|------|--------|
| `definitions/` | 作者/AI | EntityMapper → 系统 | YAML schema | 不可 |
| `chapters/` | 作者/AI | EntityMapper → 系统 | YAML schema | 不可 |
| `scenes/` | LLM 生成 | Assembler → 拼接 | prose `.md` + 元数据 `.yaml` | 不可 |
| `notes/` | 作者/AI | 作者 + AI agent（系统不读） | 自由 markdown | 可 |
| `reference/` | 作者/粘贴 | 作者 + AI agent（系统不读） | 任意文本 | 可 |
| `output/` | Assembler | 人类阅读 | markdown | 可重建 |
| `.nova/` | 系统 | 系统 | JSON/SQLite | 缓存可重建，审计不可 |

AI agent 只编辑 `definitions/`、`chapters/`、`notes/`。写 `chapters/chapter_03/E3b.yaml` 时声明 `thread_progress` 和 `foreshadowing`——系统在 commit 后自动将这些声明提取到 `.nova/derived/`，AI 不需要管理跨场景的追踪文件。

## 六、关键风险

| 风险 | 缓解 |
|------|------|
| **复杂度失控** | MVP 严格限范围，不做 Web UI，不做美化 |
| **LLM 一致性检查本身不可靠** | 检查器主体是确定性规则（SQL/逻辑），LLM 只用于模糊判断 |
| **Validator 阻断写作流** | 两级分级：确定性硬错误自动 ERROR 阻断 commit；其余全部 WARNING 不阻断。用户在项目配置中可覆盖任何级别。LLM Editor Agent 可建议升级但不自动执行 |
| **Plugin 冲突解决困难** | Plugin Manifest 声明 authority dimensions + priority + 四种仲裁策略（priority/human/merge/first-writer） |
| **YAML 规模和查询性能** | SQLite 做索引层，不直接扫描文件 |
| **作者不买账 Git 工作流** | CLI 封装常用操作，未来 Web UI 隐藏 Git 细节 |
| **分支爆炸（大量分支时）** | 全局遍历（"所有路径是否免于死胡同"）复杂度随分支点数指数增长 | 大多数操作为单路径 O(N)；全局分析明确标记为构建时一次性的离线任务；实际游戏中分支点数有限（10-30 而非 100+）；超出此范围的项目不适合用此系统 |

## 六-A. 系统边界定义

> 诚实定义：这个系统能做到什么、大部分情况能做到什么、最好情况能做到什么、一定做不到什么。

### 保证能做到的（Tier 1 — 纯软件工程，不依赖 LLM）

| 能力 | 确定性 | 说明 |
|------|--------|------|
| YAML 项目管理（角色/世界/场景/关系 CRUD） | 100% | 五层领域模型全覆盖 |
| Event Sourcing + 完整溯源 | 100% | 任意时刻回放完整世界状态 |
| 分支路径感知 replay | 100% | `replay(events, branchPath)` — 从同一事件流重放任意分支的完整状态，O(N) 而非 O(2^N) |
| Git 版本控制（branch/diff/merge/rollback） | 100% | 与 Git 分支（代码）正交的分支叙事（故事） |
| 11 种 Validator（8 确定性 + 2 LLM 辅助 + 1 必须 LLM） | 99%+（确定性部分） | Timeline / CharacterState / Knowledge / WorldRule / Causal / Foreshadow / POV / FactualDetail / BranchMerge / VoiceDrift（确定性部分）/ Reachability。VoiceDrift 的 LLM 软检查在 Tier 2 |
| 依赖图 + 修改影响分析 | 95% | 只追踪显式引用（被 overtly 引用的 Entity/Event/Thread/Knowledge） |
| Context Package 组装 | 100% 组装 / 70-85% 相关性 | 组装是确定的；相关性评分有退化（见 Tier 2） |

**下限 = 一个带 Git + 一致性 Linter + 分支叙述能力的结构化 Scrivener。** 即使没有 LLM，这也是一个能管理复杂分支叙事的小说项目工具——在所有现有同类工具中唯一提供此能力。

### 大部分情况能做到的（Tier 2 — 基础设施可靠但边缘情况退化）

| 能力 | 可靠性 | 主要退化场景 |
|------|--------|------------|
| Context Compiler 相关性评分 | 70-85% | 间接/主题级关联无法检测（Alice提到Bob→Bob关联Thread X→Thread X涉及Carol，算法看不到Carol）。跨分支路径的主题关联不捕捉（分支A上的主题对分支B上的Context Compiler透明） |
| LLM 辅助一致性检查（因果合理性、人物行为可信度等） | 60-80% | 假阳性+假阴性。百章小说积累约 20-30 次误报，削弱信任 |
| Scene 生成（LLM 渲染） | 70-85% 事实正确 | 散文质量不统一、长距离回调遗漏、对话过于直白、多模型切换风格不一致 |
| 散文提取为结构化事件 | 60-80% | 丢失隐含意义。Alice 摔门 → 系统知道她离开了，但不知道她生气了 |
| 分支感知 Context Compiler | 70-85%（与线性 Context Compiler 相同） | 仅在当前 BranchPath 上组装上下文。跨分支的主题/伏笔关联不传递——这是设计选择，不是缺陷：分支 B 上的 Context 不应被分支 A 上的事实污染 |

### 最好情况能做到的（Tier 3 — 需要优质 LLM + 好输入 + 合适类型）

| 能力 | 天花板 | 断在哪里 |
|------|--------|---------|
| Discovery Layer（聊天→结构化YAML） | 依赖外部 AI 质量 | 弱模型产生"语义正确但无用"的 YAML（`traits: [conflicted]` 无法用于检查） |
| 多 Plugin 跨类型小说（推理+恋爱） | 依赖仲裁策略 | Mystery 要隐藏线索，Romance 要分享秘密 — 这是叙事设计冲突，不是 Plugin 协调问题 |
| 多章节连锁修订 | 结构依赖可追踪，风格/主题不可追踪 | 漏掉隐含引用（重写第1章后系统标记14个受影响场景，但错过墓地对话里隐含的"孤儿"设定） |
| 大分支空间的全路径分析 | 10-30 分支点可行，100+ 不可行 | 所有叶子路径的遍历是 O(2^N)，但大多数操作是单路径 O(N)。全局死胡同检测限定为"构建时离线任务"，实际可处理范围约 8-10 个独立二元分支点（~1024 路径） |
| 不可靠叙述者 | BranchSet 建模客观事实路径，不建模主观谎言 | 需要平行的"谎言层"——系统知道真相，但叙述者在某条路径上说谎。这个维度未被建模 |

### 按作品类型的适配评级

> 从系统设计角度评估：每种类型的创作能否在现有架构上工作。

| 类型 | 适配度 | 最关键组件 | 尚需扩展 |
|------|--------|-----------|---------|
| **奇幻/科幻** | ✅ 原生适配 | Rule 层（4 种转换语义） | 无 |
| **推理** | ✅ 原生适配 | Knowledge 层（信息分发时序）+ ForeshadowValidator（dangling clue 变体） | Clue/RedHerring 需定义 Plugin |
| **历史** | ✅ 原生适配 | Knowledge（历史 ground truth）+ 确定性 anachronism/geography Validator | Validator 实现即可 |
| **游戏叙事/分支叙事** | ✅ 一期原生支持 | BranchPath + BranchSet + 分支 replay + BranchMergeValidator（全部已在 §7.4.7-7.4.8 定义） | 无架构层面需求。大分支空间的全路径分析有计算天花板（Tier 3） |
| **恋爱** | ⚠️ 需 Plugin 扩展 | Relationship（一等实体）+ Plugin schema 扩展 | `emotional_state`、`relationship_stage`、`misunderstanding_stack`、`power_dynamic` 维度 |
| **同人** | ⚠️ 需二项扩展 | Knowledge 层已有 `KnowledgeSource` 类型；加 `canon_source` variant + `canon_violation` Validator | CanonSource 建模（canon-primary/secondary/author-interview/fan-interpretation）+ canon 偏离声明 |
| **跨媒体/扩展宇宙** | ⚠️ 需架构级扩展 | Definition 层 + Proposal-Commit 溯源 | `canon_hierarchy`（CSS 优先级式的多源仲裁）— 现有模型无原型，是唯一需要新概念的 |
| **连载** | ✅ 原生适配 | Context Compiler + ImpactAnalyzer 前向检查 | 无（性能要求在实现层面而非架构层面） |
| **文学小说** | ❌ 不适合 | — | 暧昧因果、不可知情感、反伏笔、刻意开放结局与一致性检查直接冲突。系统会将歧义标记为错误 |

**核心结论**：8 种类型中 5 种在现有架构上原生适配，2 种需要 Plugin 或 Validator 扩展，1 种需要新概念（跨媒体），1 种根本上不适合。系统不是万能工具，但在它针对的类型范围内覆盖了绝大多数创作场景。

### 一定做不到的（Tier 4 — 不在范围或原则上不可能）

| 做不到的 | 为什么 |
|---------|--------|
| **保证文学质量** | 系统保证事实正确 ≠ 保证动人。一致性 ≠ 深度。正确对话 ≠ 有潜台词。散文正确 ≠ 有风格。节奏（张弛比例）不被建模。潜台词（未说出的意义）不被建模 |
| **处理文学小说为主场景** | 文学小说的特征 — 暧昧因果、不可知情感、反伏笔、刻意开放结局 — 与一致性检查原则直接冲突。系统会将歧义标记为错误 |
| **替代作者的创意判断** | Proposal-Commit 通过 = 事实一致，不等于"这场是否应该存在""是否有趣""是否动人"。这些判断永远需要人 |
| **跨小说连续性（系列/共享宇宙）** | 系统是单 Project 范围。三部曲 = 三个 Project。跨书角色弧光、跨书世界规则需要手动维护 |
| **实时协作** | Git 是异步的，非 Google Docs。分支+合并可行，但非实时 |

### 上限总结

> **上限 = 一篇结构正确但需要人类编辑实质性重写的类型小说初稿。**
>
> **新能力**：系统是唯一在开源领域原生支持分支叙事的写作工具——单一事件流通过 BranchPath 过滤即可获得多个平行故事线的完整一致的世界状态。这对游戏叙事、视觉小说、选择驱动的交互式故事是独一无二的能力。没有其他写作工具（Sudowrite/NovelAI/Scrivener）提供这个。
>
> **未改变的根本限制**：系统消除的是"事实错误"（time to fix: seconds），但不触及"文学价值"（distance to publishable: all the work that matters）。从空白到结构合理稿件的效率远超现有工具。从结构合理稿件到可出版小说的距离 — 这个系统完全无法缩短。这 30-40% 的距离恰恰是所有文学创作的灵魂所在。

## 六-B. UX 风险与缓解

> 从 @designer 的 UX 分析中提取的 5 个关键用户体验风险及其应对方案。

| 风险 | 场景描述 | 发生条件 | 缓解方案 |
|------|---------|---------|---------|
| **"我刚写的东西去哪了"** | 用户直接编辑 Discovery Layer 的 YAML 文件，Validator 拒绝修改。文件被回滚到上一个 commit 状态 | Commit 时任一 Validator 返回 ERROR | 拒绝时不丢弃用户的原始编辑。存为 `rejected_proposals/<timestamp>.yaml`，明确告知"你的修改已保存但因 [冲突原因] 未应用。解决后执行 `nova commit --retry` 重新提交" |
| **Context 不透明** | 用户发现 Scene 生成质量差，怀疑是 Context Compiler 没有给对上下文，但无法确认 | 长距离依赖未被 5 维评分算法捕获（Tier 2 的 15-30% 退化区间） | **Context Inspector** 已在设计中：每个 Scene → 渲染前输出 `context_package.json`（精确列出哪些 Entity/Event/Knowledge 被注入，各自的 RelevanceScore 是多少，哪些被截断），用户可人工补充缺失的 context |
| **两个 AI 循环卡死** | Writer Agent 生成 prose → Guardian Agent (Validator) 拒绝 → Writer Agent 重写 → 又拒绝 → 死循环 | 某个场景存在深层叙事矛盾无法通过重写解决 | **Circuit Breaker**：最多 3 轮 Writer→Validator 循环。超过 3 轮 → 自动升级为 **Human Arbitration**（标记为 `BLOCKED`，生成完整上下文摘要，等待人工指令） |
| **文件爆炸** | 100 章小说项目产生上千个 YAML/JSON/markdown/git 文件，CLI 用户在文件系统中迷失 | 大规模项目 + 裸文件系统访问 | CLI 提供结构化导航命令（`nova scene list --chapter 42`、`nova entity search --type character --alive`），MCP 提供语义查询接口。不依赖用户直接浏览文件系统 |
| **Review 积压** | 写了 50 章后积累了 200 个 blocking review comment，新章节无法推进 | ReviewComment 的 `blocking: true` 默认永久有效 | **Review 时效机制**：① blocking review 默认 3 章后自动降级为 `suggestion`（用户可在项目配置中调整阈值）；② `nova review summary` 只显示过去 5 章的 blocking；③ 提供 `nova review history` 查询完整历史但默认不阻断 |

### Circuit Breaker 流程图

```
Writer Agent 生成 prose
        │
        ▼
Guardian Agent 运行 Validator
        │
   ┌────┴────┐
   │ 通过？   │
   └────┬────┘
   是   │   否 — 有 ERROR
    │   │   retry_count++
    │   │       │
    │   │   retry_count > 3?
    │   │       │
    │   │   是   │   否
    │   │    │   │
    │   │    ▼   ▼
    │   │ BLOCKED  返回 Writer（附带
    │   │ 等待人工   Validator 反馈）
    │   │ 裁决
    │   │
    ▼   │
 Commit  │
 成功    │
```

## 七、学术论文交叉验证

### 7.1 已验证的设计决策

| 我们的设计 | 论文验证 |
|-----------|---------|
| 双时间模型（valid_time + transaction_time） | ✅ 超越 FactTrack 的单时间线；FactTrack 使用 `[t_begin, t_end)` 有效区间，与我们 valid_time 对齐，我们多了修订历史 |
| Knowledge Boundary（知识边界） | ✅ CreAgentive 的 Limited Cognition 原则完全一致 |
| Event Sourcing 优于双 KG | ✅ CreAgentive 的双 KG 是其架构需求；统一 Event Sourcing 无同步问题，天然 Git 支持 |
| 不检查文风/语气 | ✅ ConStory-Bench 确认这类检查对确定性规则太模糊，MVP 不做是正确的 |
| Plugin → Proposal → Core Validator → Commit | ✅ 符合学术共识：外部输入不可信，需要验证层 |
| Scene 为最小生成单元 | ✅ Fabula（2026）使用 Idea→Story Plan→Scenes→Beats→Script 的层级，与我们 Beat/Scene/Chapter 三级一致 |

### 7.2 需要修正的关键缺口

以下缺口基于六篇论文的架构对比和 @oracle 的抽象分析交叉验证得出。

| 优先级 | 缺口 | 证据来源 | 修正方向 |
|--------|------|---------|---------|
| **P0** | Knowledge 不是一等实体 | @oracle: "Knowledge 作为 Context Compiler 附属是分类错误"；CreAgentive: 知识隔离是多角色叙事的核心 | 提升 Knowledge 为第五层领域实体，有独立的 Event 类型（Learn/Forget/Misbelieve/Deceive）和验证规则 |
| **P0** | Relationship 不是一等实体 | @oracle: "建模为 Character 属性会产生同步问题"；Amory: 关系需要独立的状态演化 | Relationship 应为独立实体，有自己的 Definition/State/Event，双向追踪 |
| **P1** | 一致性检查器覆盖不足 | ConStory-Bench: 5类19种子类型，我们只覆盖10-11种 | 新增：CausalValidator、CharacterTraitValidator、FactualDetailValidator、NumericalValidator |
| **P1** | Event 模型缺少 narration_time | @oracle: "非线性叙事需要核心模型字段支持"；Story/Discourse 分离要求区分故事时间和叙事顺序 | Event 增加 `narration_time` 和 `narrative_order` 字段 |
| **P1** | Plugin 运行时冲突解决未定义 | @oracle: "多 Genre Plugin 同时响应同一事件时优先级未定义" | 增加 Plugin 优先级系统 + 运行时冲突仲裁策略 |
| **P2** | Context Compiler 相关性算法未定义 | @oracle: "没有相关性算法就是模板引擎" | 在 Event Sourcing 之上构建 DOME 式的 TKG 查询视图；用字符参与度 + Thread 关联度 + 时空邻近度做三层相关性排序 |
| **P2** | Rule 层过度量化 | @oracle: "save_life→trust+20 是游戏机制，文学需要定性转换" | Rule 支持定性和定量两种模式；提供 `irreversible`、`conditional`、`gradual` 等转换语义 |
| **P2** | Event 缺少 pre/post-conditions | FactTrack: 定向事实分解（前事实+后事实）正式化了事件→状态转换 | Event schema 增加 `preconditions` 和 `postconditions` 字段 |

### 7.3 采纳的论文技术

| 论文 | 采纳的技术 | 集成方式 |
|------|----------|---------|
| DOME | TKG 四元组 `<s, a, o, chapter>` 作为查询视图 | 在 Event Sourcing 之上构建 TKGIndexer，用 SQLite 存储，加速冲突检测 |
| FactTrack | 定向事实分解（pre/post conditions） | 纳入 Event schema，每个 Narrative Event 自动携带前置/后置事实 |
| Amory | 语义化（Semanticization） | 作为 Context Compiler 的可选层，将松散关联的事实提取到辅助记忆，保持主 Context Package 精简 |
| ComoRAG | 迭代验证循环 | Validator 拒绝时触发重编译，纳入更广泛的 State 扫描；不替代单次编译，作为 fallback |
| ConStory-Bench | 19 种错误分类法 | 直接作为一致性检查器的需求文档，逐项对应检查规则 |

---

## 7.4 核心类型定义与算法规格（TypeScript）

基于上述修正，以下是核心抽象的具体类型定义。

### 7.4.1 Narrative Event（叙事事件）

```typescript
// 借鉴 FactTrack：每个事件携带 pre/post-conditions
// 支持非线性叙事：区分 storyTime（故事时间）和 narrativeOrder（叙事顺序）
// 一期原生支持分支叙事：branchExistence 控制事件在哪些分支上存在
interface NarrativeEvent {
  id: string
  storyTime: StoryTimestamp         // 故事内发生时间（valid_time）
  narrationTime?: StoryTimestamp    // 叙事中讲述位置（discourse time — 倒叙/插叙时需要）
  narrativeOrder?: number           // 叙事顺序号
  branchExistence: BranchSet        // ★ 此事件在哪些分支路径上存在；默认 { type: "all" }
  
// NarrativeEvent 是系统内部类型（EntityMapper 从 EventFile YAML 解析后构建）
// 与 EventFile（§7.4.11）的关系：EventFile 是人写的 YAML，NarrativeEvent 是解析后的内部表示

interface NarrativeEvent {
  // —— 标识（从 EventFile 直接映射）——
  event: EventId
  narrativeOrder: number
  title: string
  storyTime: StoryTimestamp          // 解析后的时间（§7.4.15）
  sceneType: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel'

  // —— POV（从 EventFile 直接映射）——
  pov: {
    character: EntityId
    type: 'first_person' | 'third_person_limited' | 'omniscient'
  }

  // —— 叙事内容（从 EventFile 直接映射）——
  sceneBrief: string

  // —— 状态变化（从 EventFile 直接映射）——
  preconditions: Fact[]
  postconditions: Fact[]

  // —— 追踪声明（从 EventFile 解析后归一化）——
  threadProgress: ThreadProgressEntry[]     // EventFile.thread_progress[*]
  foreshadowing: ForeshadowEntry[]          // EventFile.foreshadowing[*] — 完整声明，不仅仅是 ID
  relationshipEffects: RelationshipChange[] // EventFile.relationship_effects[*] — 方向性变化
  ruleEffects: RuleEffectEntry[]            // EventFile.rule_effects[*]

  // —— 风格指导（从 EventFile 直接映射）——
  styleGuidance?: StyleGuidance

  // —— 事件类型（系统推导，不在 YAML 中）——
  source: 'genesis' | 'event_file' | 'branch_point' | 'system'

  // —— 分支存在性（系统默认，不在 YAML 中）——
  branchExistence: BranchSet        // 默认 { type: "all" }

  // —— 参与实体（系统自动从 preconditions + 追踪声明推导，不在 YAML 中）——
  participants: {
    entities: EntityId[]             // 从 preconditions + relationshipEffects 提取
  }
}

// ——— 与 EventFile 的映射 ———
// EventFile.preconditions → NarrativeEvent.preconditions（直接映射）
// EventFile.expected_postconditions → NarrativeEvent.postconditions（直接映射）
// EventFile.thread_progress → NarrativeEvent.threadProgress（直接映射）
// EventFile.foreshadowing → NarrativeEvent.foreshadowing（完整映射，不仅仅是 ID）
// EventFile.relationship_effects → NarrativeEvent.relationshipEffects
//   格式：{ participants: [a, b], effect: 'establish', direction: 'a → b' }
//   内部使用：EntityMapper 将其解析为独立的 Relationship 实体状态变更
// EventFile.rule_effects → NarrativeEvent.ruleEffects
// EventFile.style_guidance → NarrativeEvent.styleGuidance
// source/branchExistence/participants → 系统自动推导，不在 YAML 中声明
```

### 7.4.2 Knowledge（知识实体 — 一等实体）

```typescript
interface KnowledgeState {
  worldTruth: Fact[]                       // 世界的客观事实
  characterKnowledge: Record<EntityId, {
    knownFacts: KnowledgeEntry[]           // 角色知道什么
    unknownFacts: FactId[]                 // 角色不知道什么
    misbeliefs: KnowledgeEntry[]           // 角色误以为真什么（不可靠叙述者）
  }>
  readerKnowledge: FactId[]               // 读者知道什么（由系统从 reader-facing events 计算）
  narratorKnowledge: FactId[]              // 叙述者声明了什么（二期暂不用）
}

// 知识更新路径：
// 1. 作者在 EventFile.postconditions 中声明 camille.knows = X
//    → StateManager commit 后自动更新 characterKnowledge["camille"]
// 2. EventFile 中隐式的信息获取（角色目睹/听说事件）
//    → EntityMapper 从 participants + pre/postconditions 自动推导
//    → 规则：如果 event 的 participants 中包含角色 A，A 得知了 postcondition 中的新 fact
// 3. 读者知识：当 prose 中出现读者可见的揭示，LLM 在 newFacts 中标记 is_reader_facing: true
//    → StateManager 更新 readerKnowledge

interface KnowledgeEntry {
  fact: Fact
  acquiredAt: StoryTimestamp
  source: KnowledgeSource
  confidence: number
}

type KnowledgeSource =
  | { type: 'direct_experience'; eventId: string }
  | { type: 'told_by'; characterId: EntityId; eventId: string }
  | { type: 'inferred'; basis: FactId[] }
  | { type: 'deceived_by'; characterId: EntityId; actualFact: FactId }
```

### 7.4.3 Relationship（关系实体 — 一等实体）

```typescript
// 关系不附属于 Character，是独立实体，双向独立建模
interface Relationship {
  id: string
  participants: [EntityId, EntityId]
  definition: RelationshipDef      // 关系类型定义
  state: RelationshipState         // 每方向独立的状态
  history: NarrativeEvent[]        // 导致状态变化的事件序列
}

// EventFile.relationship_effects 映射到 RelationshipChange：
// YAML: { participants: [camille, npc_gear], effect: 'establish', direction: 'camille → npc_gear' }
// 系统内部: EntityMapper 找到或创建 Relationship 实体，更新对应方向的 state

interface RelationshipChange {
  participants: [EntityId, EntityId]     // 从 YAML 直接映射
  effect: 'establish' | 'change' | 'dissolve' | 'reinforce' | 'complicate'
  direction: string                       // "camille → npc_gear"
}

interface RelationshipState {
  direction: Record<EntityId, {
    dimensions: Record<string, number | string>  // trust, intimacy, power 等
    perceivedBy: Record<EntityId, number>        // 对方对该关系的认知
  }>
}

interface RelationshipEffect {
  relationshipId: RelationshipId
  dimension: string
  change: 
    | { type: 'numeric'; delta: number }
    | { type: 'qualitative'; trigger: string; from: string; to: string }
    // 示例: { type:'qualitative', trigger:'betrayal', from:'trust', to:'irrevocably_broken' }
}
```

### 7.4.4 Rule 的定性转换语义

```typescript
interface StateTransitionRule {
  id: string
  eventType: EventType
  condition?: (event: NarrativeEvent, state: WorldState) => boolean
  
  effects: TransitionEffect[]
}

interface TransitionEffect {
  target: 'character' | 'relationship' | 'knowledge' | 'world'
  dimension: string                  // 如 'alive', 'trust', 'location', 'suspicion'
  
  // 定量模式（内部追踪用）
  delta?: number
  
  // 定性模式（对外暴露，修正游戏机制倾向）
  qualitative?: {
    semantics: 'irreversible' | 'conditional' | 'gradual' | 'threshold'
    // irreversible: 不可逆（死亡、重大背叛后信任崩塌）
    // conditional:  有条件触发（只有特定前提满足时才激活）
    // gradual:      渐进积累
    // threshold:    累积到阈值后质变
    threshold?: number               // threshold 模式的触发值
    description: string              // 人类可读的状态变化描述
  }
}
```

### 7.4.5 Plugin 运行时冲突解决

```typescript
interface PluginManifest {
  name: string; version: string
  priority: number                   // 全局优先级（冲突时裁决）

  provides: string[]                 // 提供的能力
  requires: string[]                 // 依赖的能力
  conflicts: string[]                // 互斥的能力

  authority: {
    dimensions: string[]             // 本插件负责的维度（如 'clue_progression'）
    exclusive: boolean               // 是否独占该维度
  }

  observes: {
    eventTypes: EventType[]
    stateDomains: string[]           // 'relationship' | 'knowledge' | 'worldrule'
  }
}

// 冲突仲裁策略
type ArbitrationStrategy =
  | 'priority'              // 按优先级，高覆盖低
  | 'human_arbitration'     // 暂停流程，人工裁决
  | 'first_writer_wins'     // 先提交的生效
  | 'merge'                 // 合并非冲突部分
```

### 7.4.6 Context Compiler 相关性算法

```typescript
interface RelevanceScore {
  entity: EntityId
  score: number              // 0-1
  basis: {
    participation: number    // 参与当前 Scene = 0.6
    threadAssociation: number // 共享活跃 Thread 比例
    spatioTemporal: number   // 同场景=0.3, 相邻=0.15
    knowledgeIntersection: number // 角色知识 ∩ Scene 知识需求
    relationshipRelevance: number // 与 Scene 参与者的关系强度
  }
}

// 编译策略：
// 1. 对 State 中所有实体计算 RelevanceScore
// 2. 降序排列，按 token budget 从高到低填充 Context Package
// 3. 必选项（Scene 参与者 + 活跃 Thread 直接关联实体）不受裁剪
// 4. 使用 DOME 式 TKG 四元组索引（SQLite 层）加速查询
// 5. Fallback: 若 Validator 拒绝 → ComoRAG 式迭代重编译，扩大检索范围
```

### 7.4.7 分支叙事模型（Branch Narrative — 一期原生支持）

> 线性叙事是分支叙事退化为每条边只有单一后继的特例。模型向后兼容：所有分支字段的默认值等于 `{ type: "all" }`，线性故事无需任何修改。

```typescript
// ——— 分支标识：从故事根节点到当前节点的选择序列 ———
// 空的 BranchPath（decisions = []） = 线性叙事默认路径

type BranchPath = {
  decisions: Array<{
    atEventId: string         // 在哪个分支节点做的选择
    choiceId: string          // 哪个选择
    narrativeOrder: number
  }>
}

// ——— 分支点定义 ———

interface BranchPoint {
  branchPointId: string
  atEventId: string           // 分支发生的 Event
  description: string         // 用户可见描述："玩家选择救她还是离开她"
  choices: BranchChoice[]
  defaultBranch?: string      // 未显式选择时的默认路径（如"真结局"或作者指定的 canon 路径）
  // 此分支点本身的有效路径条件（父分支的嵌套）
  existenceCondition: BranchSet
}

interface BranchChoice {
  choiceId: string
  label: string
  condition?: Condition       // 什么条件下此选项可用（某些选项在特定路径上被锁）
  narrativeOrder: number      // 选择后的 narrative order
}

// ——— 分支集：事实/事件在哪些路径上成立 ———

type BranchSet =
  | { type: "all" }                                    // 在所有分支路径上成立（默认，线性故事用这个）
  | { type: "paths"; paths: BranchPath[] }             // 仅在明确列出的路径上成立
  | { type: "condition"; condition: Condition }         // 在满足条件的路径上成立（延迟求值）
  | { type: "except"; branches: BranchSet }            // 除某些路径外

// ——— Fact（Event 产生的事実）扩展 ———

interface FactValidity {
  temporal: { start: EventTime; end: EventTime | null }  // 时间维度
  branches: BranchSet                                      // ★ 分支维度
}

interface Fact {
  id: string
  entityId: EntityId
  attribute: string
  value: any
  validity: FactValidity      // 替代原来的 validTime
}

// ——— Replay 算法（分支感知） ———
// 线性：replay(allEvents)              → currentState
// 分支：replay(allEvents, branchPath)   → currentStateOnPath

function replay(
  events: NarrativeEvent[],
  branchPath?: BranchPath
): WorldState {
  const state = new WorldState()

  for (const event of events.sort(byNarrativeOrder)) {
    // ★ 唯一新增的过滤步骤：跳过不在当前路径上的事件
    if (!event.branchExistence.includesPath(branchPath)) continue

    for (const fact of event.postconditions) {
      // ★ 事实本身也有分支约束（双向过滤）
      if (!fact.validity.branches.includesPath(branchPath)) continue

      state.apply(fact)
    }
  }

  return state
}

// BranchSet.includesPath 的核心逻辑：
// - { type: "all" } → 永远 true
// - { type: "paths", paths } → branchPath 是否在 paths 列表中
// - { type: "except", branches } → !branches.includesPath(branchPath)
// - 空 branchPath（线性故事）→ { type: "all" } 和 { type: "except", ... } 都返回 true
//   （空路径不会被任何 except 过滤，因为没有选择 = 无条件接受所有事件）

// ——— Scene 渲染：分支感知的 prose template ———

interface SceneRender {
  sceneId: string
  eventId: string
  // 一个 Scene 可以在不同分支上有不同的 prose 表现
  branchProse: Record<string, string>   // choiceId → prose 模板
  defaultProse: string                  // 无匹配分支时的默认 prose
}

// 举例：
//   branchProse: {
//     "save_alice":     "Alice 的葬礼上，全镇的人都在悼念...",
//     "abandon_alice":  "Alice 站在人群中，望着远方的山..."
//   }
//   defaultProse: "E5 的场景..."
```

**关键设计决策**：

1. **Event Sourcing 本身就是状态机** — 不需要引入独立的状态机框架。replay 加一个 `branchPath` 过滤参数即可从同一事件流中重放出不同分支的状态。

2. **查询复杂度 O(N) 而非 O(2^N)** — 任意时刻查询只走一个 BranchPath。全局分析（"所有路径是否免于死胡同"）才需要遍历，可在构建时做一次。

3. **线性故事零额外成本** — 所有 `BranchSet` 默认为 `{ type: "all" }`，空 BranchPath 不过滤任何事件，行为完全不变。

4. **BranchPoint 与 Event 分离** — BranchPoint 是元数据（"在哪里、有哪些选择"），不直接影响状态。Event 通过 `branchExistence` 声明自己在哪些分支上存在。两者独立演化。

### 7.4.8 分支合并冲突检测 (BranchMergeValidator)

```typescript
// 当两条分支汇合到同一个后续事件时：检测该事件的 precondition 是否在每条输入分支上都满足

interface MergeConflictReport {
  mergeEventId: string
  incomingBranches: BranchPath[]
  violations: Array<{
    branch: BranchPath
    unsatisfiedPrecondition: Fact      // 该分支到达汇合点时此条件不成立
    reason: string
  }>
  severity: 'error' | 'warning'
}

// 算法：
// 1. 对汇合事件 E_merge 的每一条 incoming branch
// 2. replay(events, branch) → 该分支上的 state
// 3. 检查 E_merge.preconditions 是否全部在 state 中成立
// 4. 如果不成立 → 报告冲突

// 注意：这不是说"不能汇合"，而是"汇合点的 precondition 在某条分支上不成立"→
// 系统标记 ERROR → 作者决定：改分支内容、改合并点内容、或接受并覆盖（人工确认）
```

### 7.4.9 非线性叙事的完整支持总结

```typescript
// 三层时间/顺序模型（原 7.4.7 的保留内容）：
// - 因果一致性（按 storyTime）：原因必须在结果之前
// - 知识检查（按 storyTime）：角色在时刻 T 只能知道 ≤T 发生的事
// - Context 编译（按 narrativeOrder）：给 LLM 看叙事顺序
// - 分支过滤（按 branchPath）：当前路径上的事件才纳入上下文

// 现在新增第四层：
// - 倒叙中的 fact 在其 storyTime 处写入 State，不影响"现在"的 State
//   但可以通过 Knowledge 查询"角色在倒叙时刻知道什么"
// - 不同分支上的 fact 在其 BranchSet 内独立生效，不影响其他分支的 State
```

### 7.4.10 不可靠叙述者（Narrator — 二期预留接口）

> 一期所有 prose 默认为 `objective`，Validator 用 `world_truth` 单 reality 检查。
> 二期引入 Narrator 类型后，系统切换到双 reality 模式。

```typescript
// ——— 叙述者（二期）———

interface Narrator {
  id: string
  type: NarratorType
  reliability: NarratorReliability
  // 叙述者自身的 Knowledge 状态（与 Character Knowledge 结构相同）
  knowledge: NarratorKnowledgeState
}

type NarratorType =
  | 'first_person'              // "我"在故事内，知道的和"我"一样多
  | 'third_person_limited'      // 跟随单一角色视角，知道的和该角色一样多
  | 'third_person_omniscient'   // 全知（但可能选择隐藏）
  | 'framed'                    // 故事套故事（外层叙述者讲述内层故事）

interface NarratorReliability {
  status: 'reliable' | 'unreliable' | 'ambiguous'
  unreliableDomains: KnowledgeDomain[]  // 哪些领域不可靠（死亡真相/角色动机/时间线）
  nature: 'deceptive' | 'self_deceived' | 'limited' | 'unstable'
  window: {                          // 不可靠窗口（哪几章）
    unreliableChapters: number[]
    revelationChapter?: number        // 揭露真相的章节
  }
}

// ——— 叙述者的 Knowledge（与 Character Knowledge 平行）———

interface NarratorKnowledgeState {
  presentedAsTrue: FactId[]      // 叙述者向读者声称的"事实"
  actuallyKnown: FactId[]        // 叙述者实际知道的（可能 ≠ 声称的）
  hidden: FactId[]               // 叙述者知道但故意不告诉读者的
  unknownToNarrator: FactId[]    // 叙述者真的不知道的（limited narrator 的限制）
  confidence: number             // 读者当前对叙述者的信任度 0-1
}

// ——— 二期 Validator 扩展 ———

// DanglingDeceptionValidator:
// 不可靠窗口结束时，检查所有被隐藏/歪曲的事实是否已对读者揭示
// （ForeshadowValidator 的"被放弃的伏笔"变体——改目标从 Thread 到 Knowledge）

// NarratorPOVValidator:
// 限制视角叙述者不应在 prose 中表现出超出其 Knowledge 的信息
// （POVValidator 的变体——检查基准从 Character Knowledge 改为 Narrator Knowledge）

// ——— 二期 Context Compiler 扩展 ———

// Scene 渲染时（叙述者不可靠的情况下）：
//   context_package:
//     narrator_reality:   # LLM 写 prose 时应该用的"事实"
//       facts: [...]
//     world_truth:         # LLM 不应该写出来，但应该知道（用于伏笔/铺垫）
//       facts: [...]
//     narrator_bias_notes: # 提示 LLM 当前叙述者的倾向
//       "叙述者在此处声称无辜，但实际不是。保持叙述语气可信但允许微妙的矛盾。"

// ——— 二期 Scene 渲染扩展 ———

// Prose 按来源分段标记，Validator 知道用哪个 reality 检查：
interface SceneProseSegment {
  type: 'objective' | 'narrator_voice' | 'character_dialogue' | 'character_thought'
  text: string
  // objective → 用 world_truth 检查
  // narrator_voice → 用 narrator_reality 检查
  // character_dialogue/thought → 用该角色的 Knowledge 检查
}
```

### 7.4.11 Event File Schema（事件文件 — 一期核心格式）

> 每个文件 = 一个 NarrativeEvent。一章一个文件夹。AI 写 7 个核心字段，线程/伏笔/关系/规则在文件内声明，系统 commit 后自动提取到 `.nova/derived/` 追踪。

```typescript
interface EventFile {
  // ★ 必填核心（7 个字段）
  event: string                    // 全局唯一 ID，如 "E3b"
  narrative_order: number          // ★ 全局唯一叙事顺序号
  title: string                    // 人类标签
  story_time: string               // "arcane_s1_end + 3 weeks"
  scene_type?: 'linear' | 'flashback' | 'flashforward' | 'dream' | 'parallel'

  pov: {
    character: string              // 引用 definitions/characters/<id>.yaml
    type: 'first_person' | 'third_person_limited' | 'omniscient'
  }

  scene_brief: string              // 自由文本，给 LLM 的上下文

  preconditions: Array<{           // 进入场景前 State 中必须为真
    entity: string
    attribute: string
    value: any
    operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'contains'
  }>

  expected_postconditions: Array<{  // 场景结束后期望产生的事实
    entity: string
    attribute: string
    value: any
    confidence?: number             // 0-1，默认 1.0
  }>

  // 选填：风格指导
  style_guidance?: {
    tone?: string
    character_voice?: Record<string, string>
    avoid?: string
    scene_pacing?: string
  }

  // 选填声明（系统自动追踪，AI 不需要管理跨场景文件）
  thread_progress?: Array<{
    thread: string                  // 引用 state_initial.yaml 的 thread id
    advancement: string
    progress_after: number          // 场景后进度（如 2/5 → progress_after=2）
    progress_total: number
  }>

  foreshadowing?: Array<{
    id: string                      // 全局唯一伏笔 ID
    hint: string
    target_reveal_chapter: number
    thread?: string
  }>

  relationship_effects?: Array<{
    participants: [string, string]
    effect: 'establish' | 'change' | 'dissolve' | 'reinforce' | 'complicate'
    direction: string
  }>

  rule_effects?: Array<{
    rule: string                    // 引用 definitions/rules/ 中的 rule id
    effect: 'reinforce' | 'weaken' | 'introduce_exception' | 'nullify'
    evidence: string
  }>

  introduces?: Array<{              // 新引入实体（角色/地点/物品）
    type: 'character' | 'location' | 'item' | 'concept'
    id: string
    initial_state: Record<string, any>
  }>
}
```

**系统 commit 后的自动处理**：

```
chapters/chapter_03/E3b.yaml  commit
        │
        ├── thread_progress → .nova/derived/threads/T1.yaml 追加进度条目
        ├── foreshadowing  → .nova/derived/foreshadows/F1.yaml 创建/更新状态
        ├── relationship_effects → .nova/derived/relationships/camille_gear.yaml 更新
        └── rule_effects → .nova/derived/rules/hextech_evidence.yaml 追加证据
```

AI 只负责在一个文件里声明"这个场景推动了什么"。系统负责跨场景追踪。

### 图的关系（SQLite 索引层）

所有图关系都建在 SQLite 里——不是独立的图数据库，而是通过索引加速的关联查询：

```sql
-- 依赖图：找 E3b 的所有下游依赖
SELECT event, narrative_order FROM events
WHERE preconditions_json LIKE '%"entity":"camille","attribute":"knows","value":"weapons_smuggler_is_piltovan"%'
ORDER BY narrative_order;

-- Thread 图：T1 的完整进展（从 .nova/derived/threads/T1.yaml 解析）
SELECT event, progress_after FROM thread_progress
WHERE thread = 'T1' ORDER BY narrative_order;

-- 规则证据图：某规则的所有叙事证据
SELECT event, evidence FROM rule_effects
WHERE rule = 'hextech.crystal_scarcity' ORDER BY narrative_order;
```

不需要 Neo4j。YAML 文件是真相源，SQLite 是这些关系的索引视图。可以随时从 YAML 重建。

### 7.4.12 从 Novel-OS 吸收的设计元素

> Novel-OS（mrigankad/Novel-OS）是目前最接近我们设计理念的开源实现。以下 5 项吸收进我们的设计，3 项留为实现细节。

#### 吸收进设计的（5 项）

**1. Agent Prompt 模板结构**

Novel-OS 的 5 个 agent prompt 有统一的模板结构：身份声明 → 核心能力 → 操作原则 → 禁止清单 → 输出契约 → 质量检查清单。我们为每个 agent 定义相同结构：

```markdown
# agents/scribe/prompt.md（示例）

## Identity
You are the Scribe — the prose-drafting specialist.

## Core Capabilities
- Write immersive third-person limited prose
- Maintain character voice consistency across chapters
- Execute scene pacing as specified in style_guidance

## Operating Principles
- Deep POV: never describe what the POV character cannot perceive
- Show, don't tell: physical sensation before emotional label
- Respect knowledge boundaries: characters only know what they've learned

## Prohibitions
- DO NOT use filtering language ("she felt that...", "he thought that...")
- DO NOT contradict established world rules
- DO NOT invent new character traits without authorization

## Output Contract
Return a JSON object:
{ "prose": "...", "newFacts": [...], "threadProgress": [...], "foreshadowingPlanted": [...] }

## Quality Checklist
Before returning, verify:
- [ ] All new facts are consistent with preconditions
- [ ] POV character's knowledge boundary is respected
- [ ] Scene pacing matches style_guidance
```

**2. Output Contract（LLM 返回结构化数据）**

吸收 Novel-OS 的 `[TAG]...[/TAG]` 模式，但改为标准 JSON（可 Zod 验证）：

```typescript
// LLM 每次调用必须返回此结构
interface ScribeOutput {
  prose: string                     // Markdown 正文
  newFacts: Array<{
    entity: string
    attribute: string
    value: any
    confidence: number
  }>
  threadProgress?: Array<{
    thread: string
    advancement: string
    progress_after: number
  }>
  foreshadowingPlanted?: Array<{
    id: string
    hint: string
    target_reveal_chapter: number
  }>
}
```

与 Novel-OS 的区别：我们返回 JSON 而非 `[TAG]` 自定义标记块。JSON 可直接用 Zod 验证，解析无歧义。

**3. Style Profile（结构化风格参数）**

Novel-OS 的 StyleProfile 有 quantized 参数（avg_sentence_length, dialogue_ratio, forbidden_words）。吸收并扩展：

```yaml
# 在 _chapter.yaml 或事件文件的 style_guidance 中：
style_guidance:
  tone: noir_restrained
  point_of_view: third_person_limited
  tense: past
  
  # 量化参数（来自 Novel-OS）
  avg_sentence_length: 18
  dialogue_ratio: 0.3
  vocabulary_level: literary
  
  # 禁止清单
  forbidden_words:
    - "felt that"
    - "thought that"
    - "seemed to"
    - "somehow"
  
  # 角色声线（来自 Novel-OS + 扩展）
  character_voice:
    camille: "calculating, minimal, no sentiment"
    seraphine: "empathetic, musical, thoughtful"
  
  scene_pacing: "tense buildup → pressure point → forced revelation"
```

VoiceDriftDetector 对比生成文本与 forbidden_words + character_voice。

**4. Quality Score（质量追踪）**

吸收 Novel-OS 的 quality_score 概念。每个 Scene 渲染后，Editor agent（如存在）或系统输出质量分：

```typescript
// Scene 元数据（scenes/chapter-03/E3b.yaml）新增字段：
interface SceneQuality {
  prose_quality?: number        // 0-1，Editor agent 评分
  voice_adherence?: number      // 角色声线一致性
  pacing_score?: number         // 节奏控制
  continuity_score?: number     // Validator 一次通过率
}
```

累计到 PROJECT_STATUS.md 的章节质量汇总表中，帮助作者发现哪些章需要重写。

**5. Dry-run 模式**

吸收 Novel-OS 的 `--dry-run`：

```
nova render E3b --dry-run
  → Context Compiler 组装 context_package
  → 生成完整的 LLM prompt
  → 保存到 .nova/dry-runs/E3b_prompt.md
  → 不调用 LLM，不产生费用
  → 作者检查 prompt 是否符合预期后再真正执行
```

#### 留为实现的（3 项）

| 项 | Novel-OS 做法 | 我们的处理 |
|----|-------------|-----------|
| **多 Provider 抽象** | 13+ LLM provider + Claude CLI 回退 | 实现细节。MVP 支持 Anthropic/OpenAI SDK 即可 |
| **原子状态写入** | `os.replace()` + `.bak` 防断电 | 实现细节。我们依赖 Git（.nova/ snapshots 可重建，responses/ 被 git 追踪） |
| **Audit trail** | 每次 LLM 调用 prompt+response 保存磁盘 | 已在设计中（`.nova/responses/`），无需额外吸收 |

### 7.4.13 从游戏叙事工具吸收的设计

> 研究 Ink / articy:draft / Yarn Spinner / Ren'Py / Twine 后，吸收 4 项设计。

#### 吸收进设计的（4 项）

**1. ReachabilityValidator — 从 Story Solver 吸收的定理证明概念**

Yarn Spinner 的 Story Solver（2025）用 SAT/SMT solver 验证"从起始节点能否到达结局 C"。吸收为我们的第 11 个 Validator。

```typescript
// 新增 Validator
{ name: 'reachability', category: 'timeline_plot', requiresLLM: false }

// ReachabilityValidator.validate() 检查：
// 1. 分支可达性：每个 BranchPath 是否能通过已定义的 events 到达结局？
//    → 遍历 Event Store 的 DAG + BranchPoint → 未闭合分支 → WARNING
// 2. Thread 完成性：每个 thread 是否有 events 将其推至 progress.total？
//    → thread.progress < thread.total 且当前章 > target_chapter → ERROR
// 3. Foreshadow 回收：每个伏笔是否有对应揭示 event？
//    → 遍历 foreshadowing 表 → 未回收且超期 → ERROR
// 4. 前置条件死锁：是否存在 event 的 precondition 依赖永远不会被满足？
//    → 拓扑排序 Event DAG → 孤立节点 → WARNING

// 与 Story Solver 的差异：
// Story Solver 验证的是玩家路径（每个选择 → 可达性）
// 我们验证的是叙事完整性（每个声明 → 是否被后续 event 满足）
```

**2. Ink List 系统（位域枚举）—— 紧凑的 trait 存储**

Ink 的 `LIST` 类型是一个位域枚举——一个变量可以同时持有多个互斥状态中的多个值。吸收用于优化 trait 存储：

```yaml
# 当前（字符串数组）:
traits:
  - "speaks_in_questions"
  - "flinches_at_loud_noises"
  - "counts_money_before_speaking"

# 吸收后的可选增强（位域枚举）:
traits_flags:
  speaks_in_questions: true
  flinches_at_loud_noises: true
  counts_money_before_speaking: true

# 位域模式下 Validator 查询:
# "所有有 flinches_at_loud_noises 的角色" → 位掩码 &，O(1)
# 当前字符串数组 → Array.includes，O(n)
```

**一期不实现（字符串数组足够 MVP）**；二期作为性能优化。

**3. Saliency 内容选择系统 —— 从 Yarn Spinner 吸收用于 Context Compiler**

Yarn Spinner v3 的 Saliency 系统让多个 storylet 节点竞争出线，基于 4 个维度：满足条件数、不满足条件数、复杂度分数、最近使用惩罚。吸收到 Context Compiler 的 RelevanceEngine：

```diff
 当前 5 维评分: 实体距离 + 时间接近度 + Thread关联 + 规则相关 + 用户固定

+吸收 Saliency 的维度:
+  6. specificity_bonus: precondition 越具体，分数越高
+     (3 个 precondition 的 event > 1 个 precondition 的 event)
+     → 防止 AI 偷懒写空 preconditions
+  7. recency_penalty: 如果同一角色/地点在上一个场景刚出现过，轻微降分
+     → 防止上下文重复堆积同一个角色的信息
+  8. thread_saturation: 如果某 thread 的 context 信息已经足够推进此场景，
+     继续追加该 thread 的信息降分
+     → 防止上下文被一个 thread 独占
```

**一期可实现 6-7 维度**；维度 8 需要更多实验。

**4. 编译时未使用内容检测 —— 从 Ink/Inky 吸收用于 ISS**

Ink 的 Inky editor 在编译时报告未使用的 knots 和变量。吸收到 ISS 的反模式检测：

```yaml
# 新增 ISS 反模式:
unused_entities:         # definitions/ 中定义但未被任何 event 引用的实体
  - entity: npc_gear_henchman
    defined_in: definitions/characters/npcs/npc_gear_henchman.yaml
    warning: "角色已定义但未在任何 event 中出现"

unused_threads:          # state_initial 中定义但未被 event 推进的 thread
  - thread: T4
    warning: "T4 已定义但 progress 仍为 0/5（可能被遗忘）"

orphan_foreshadows:      # 已种植但无对应揭示的伏笔
  - foreshadow: F3
    planted_in: E5
    warning: "伏笔 F3 已种植但无 target_reveal_chapter"
```

**一期实现**，加入 `nova validate --strict` 的输出。

#### 不吸收的

| 特性 | 来源 | 为什么不吸收 |
|------|------|------------|
| **Rollback at every interaction** | Ren'Py | 我们是异步 commit，不是实时交互 |
| **可视化节点编辑器** | articy:draft | 二期 Web UI |
| **Smart Variables（派生值）** | Yarn Spinner | 可通过 rule progression 实现 |
| **Interactive playthrough simulation** | 所有工具 | 我们是 prose 生成，不是游戏运行时 |

### 7.4.14 Entity 基类型与 EntityRegistry

> **(@oracle C1 修复)** 系统各处引用 `EntityId` 但从未定义 Entity 是什么、如何注册与解析。

```typescript
// ——— 实体基类型 ———

type EntityId = string  // 全局唯一 ID，如 "camille", "npc_gear", "zaun_gray_exchange"

type EntityKind = 'character' | 'location' | 'item' | 'concept' | 'faction' | 'rule'

interface Entity {
  id: EntityId
  kind: EntityKind
  name: string
  definitionFile: string             // 定义文件路径，如 "definitions/characters/camille.yaml"
  state: Record<string, any>         // 当前 State 中的属性值
}

// ——— 实体注册表 ———

interface EntityRegistry {
  // 从 definitions/ + state_initial.yaml 加载所有实体
  load(projectPath: string): void

  // 按 ID 解析实体（可能返回 null）
  resolve(id: EntityId): Entity | null

  // 按类型查询
  findByKind(kind: EntityKind): Entity[]

  // 按属性值查询（用于 Validator filter）
  findByAttribute(attribute: string, value: any): Entity[]

  // 批量解析引用（用于 Event 的 preconditions）
  resolveRefs(refs: EntityId[]): Map<EntityId, Entity | null>

  // 注册新实体（runtime，用于 introduces）
  register(entity: Entity): void

  // 更新实体状态（commit 后）
  updateState(id: EntityId, state: Record<string, any>): void
}
```

**解析算法**（`resolve("camille")` 的执行路径）：

```
1. 检查内存缓存 → 命中则返回
2. 扫描 definitions/characters/ 找 id: camille → 加载 YAML → 提取 initial_state
3. 扫描 definitions/locations/、definitions/rules/ 等同理
4. 检查 state_initial.yaml 的 world_facts
5. 检查 Event Store 中最近一次 snapshot 的 State（运行时用）
6. 以上都不存在 → 返回 null → ISS 扣分（实体引用完整性）
```

### 7.4.15 Validator 接口契约

> **(@oracle C3 修复)** 10 个 Validator 按名称列出但输入/输出契约从未定义。

```typescript
interface ValidatorContext {
  // 系统状态只读访问
  worldState: WorldState              // 当前状态快照
  eventStore: EventStore              // 完整事件日志
  entityRegistry: EntityRegistry      // 实体注册表

  // 当前验证上下文
  currentEvent: NarrativeEvent        // 正在验证的事件
  currentChapter: number
  narrativeOrder: number

  // 工具
  queryState(entityId: EntityId, attribute: string): any
  getKnowledge(characterId: EntityId): KnowledgeState
  getThreadProgress(threadId: string): { progress: number, total: number }
  getRuleEvidence(ruleId: string): EvidenceEntry[]
}

interface Validator {
  /** 唯一标识符，如 "timeline", "knowledge", "character_state" */
  name: string

  /** 检查类别（映射到 ConStory-Bench 19 种错误类型） */
  category: 'characterization' | 'factual_detail' | 'timeline_plot' | 'worldbuilding' | 'narrative_style'

  /** 是否依赖 LLM */
  requiresLLM: boolean

  /**
   * 验证一个事件在提交前是否与当前世界状态一致。
   * 返回空数组 = 通过。非空 = 有问题。
   */
  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[]
}

// ——— 所有 11 个 Validator ———

const validators: Validator[] = [
  { name: 'timeline',           category: 'timeline_plot',      requiresLLM: false },
  { name: 'character_state',    category: 'characterization',   requiresLLM: false },
  { name: 'knowledge',          category: 'characterization',   requiresLLM: false },
  { name: 'world_rule',         category: 'worldbuilding',      requiresLLM: false },
  { name: 'causality',          category: 'timeline_plot',      requiresLLM: true  },
  { name: 'foreshadowing',      category: 'factual_detail',     requiresLLM: false },
  { name: 'pov',                category: 'narrative_style',    requiresLLM: false },
  { name: 'factual_detail',     category: 'factual_detail',     requiresLLM: true  },
  { name: 'voice_drift',        category: 'narrative_style',    requiresLLM: true  },
  { name: 'branch_merge',       category: 'timeline_plot',      requiresLLM: false },
  { name: 'reachability',       category: 'timeline_plot',      requiresLLM: false },  // ★ 从 Story Solver 吸收
]
// 8 纯确定性 + 2 LLM 辅助 + 1 必须 LLM = 11 个
```

### 7.4.16 StoryTimestamp 类型

> **(@oracle C6 修复)** 当前用自由字符串 `"arcane_s1_end + 3 weeks"` 无法进行确定性比较。

```typescript
type StoryTimestamp =
  | AbsoluteTimestamp          // 精确时间点
  | RelativeTimestamp           // 相对于锚点
  | ChapterTimestamp            // 章节号

// —— 绝对时间 ——
interface AbsoluteTimestamp {
  type: 'absolute'
  value: string                // ISO 日期 "2026-03-15" 或纪元 "day_42"
}

// —— 相对时间（最常用）——
interface RelativeTimestamp {
  type: 'relative'
  anchor: string               // 锚点 ID：可在 state_initial.yaml 中定义
                               //   如 "arcane_s1_end" = day 0
                               //   如 "war_begins" = day 180
  offset: {
    amount: number
    unit: 'minute' | 'hour' | 'day' | 'week' | 'month'
  }
}

// —— 章节号（纯叙事顺序）——
interface ChapterTimestamp {
  type: 'chapter'
  chapter: number
}

// 解析器：自由字符串 → StoryTimestamp
function parseStoryTimestamp(raw: string, anchors: Map<string, number>): StoryTimestamp {
  // "arcane_s1_end + 3 weeks" → RelativeTimestamp { anchor: "arcane_s1_end", offset: { amount: 3, unit: "week" } }
  // "day_42" → AbsoluteTimestamp { type: "absolute", value: "day_42" }
  // "chapter_5" → ChapterTimestamp { chapter: 5 }
}

// 比较算法
function compareTimestamp(a: StoryTimestamp, b: StoryTimestamp): number {
  // 先归一化为绝对天数 → 数值比较
  const dayA = resolveToDay(a)
  const dayB = resolveToDay(b)
  return dayA - dayB
}
```

**时间锚点定义**（在 `state_initial.yaml` 中）：

```yaml
# definitions/state_initial.yaml
time_anchors:
  arcane_s1_end: 0              # day 0
  shimmer_crisis_begins: 90     # day 90 ≈ 3 months later
```

事件文件中的时间写法不变（仍可写 `"arcane_s1_end + 3 weeks"`），但系统在 parse 时标准化为 `StoryTimestamp`，TimelineValidator 用 `compareTimestamp` 做确定性时序检查。

### 7.4.17 PromptAssembler — 渲染管线的 LLM 提示组装

> **(@oracle C4 修复)** Context Compiler + Agent Prompt + Render Request 如何组合成最终 LLM 调用。

```typescript
interface RenderRequest {
  event: string             // "E3b"
  mode: 'draft' | 'revise' | 'retry'
  revisionNotes?: string
  provider?: string
  model?: string
  temperature?: number
}

interface FinalPrompt {
  systemPrompt: string      // Agent 的系统角色定义
  userPrompt: string        // 此次渲染的完整上下文
}
```

**组装流程**：

```
assemble(E3b):
  1. 加载 Agent Prompt 模板:
     agents/{agentName}/prompt.md → systemPrompt

  2. Context Compiler 组装 Context Package:
     RelevanceEngine.score(E3b) → 5 维评分
     ContextAssembler.fill(E3b, state) → 按 L1-L5 填充，截断到 token budget
     ContextRenderer.toMarkdown(package) → LLM 可读 markdown

  3. 合并 Render Request 特定信息:
     mode === 'revise' → 追加 revisionNotes + 上次生成的 prose

  4. 组装最终 userPrompt:
     ```
     # 渲染: E3b - "灰色市场：谈判"

     ## 场景上下文
     {contextPackage.markdown}

     ## 你的任务
     以 {pov.type} 视角从 {pov.character} 的角度写这个场景。
     字数: 800-1200
     风格指导: {event.styleGuidance}

     ## 输出要求
     返回 JSON: { prose, newFacts, threadProgress, foreshadowingPlanted }
     ```

  5. --dry-run: 保存到 .nova/dry-runs/E3b_prompt.md，不调用 LLM
```

### 7.4.18 Git 集成与叙事分支区分

> **(@oracle C5 修复)** Git 操作触发时机 + 叙事分支 vs Git 分支的明确区分。

```typescript
// 1. Git 操作触发时机:
//    - nova commit 成功 → 自动 git commit (commit message: "E3b: 灰色市场：谈判 [auto]")
//    - nova git commit "手动说明" → 作者显式提交

// 2. Narrative Branch vs Git Branch —— 完全独立:
//
//    Narrative Branch (BranchPath):
//      同一 Git 分支上的多个叙事路径
//      "A: 救 Alice" vs "B: 放弃 Alice"
//      → 共享 Event Store，通过 BranchPath 过滤 replay
//      → 轻量，一步 undo，无需切换分支
//
//    Git Branch:
//      main vs experiment_e7_rewrite
//      → 文件层 fork，适合大规模改写
//      → 合并时可能产生文件冲突
//
//    作者可同时使用:
//      同一 Git 分支上探索叙事分支（日常轻量）
//      大规模改写时创建 Git 分支（安全回退）

// 3. 两种 diff:
//    git diff → YAML 文件变化（技术细节）
//    nova diff E3b → 状态变化（叙事语言）:
//      "camille.location: zaun_gray_exchange_entrance → zaun_gray_exchange_interior"
//      "camille.knows: +weapons_smuggler_is_piltovan"
```

### 7.4.19 Snapshot 格式与恢复

> **(@oracle C8 修复)** Snapshot 内容、格式、replay 交互、失效规则。

```typescript
interface Snapshot {
  narrativeOrder: number
  eventId: string
  timestamp: string          // ISO 创建时间
  state: {
    entities: Record<EntityId, Record<string, any>>
    relationships: Record<string, { direction: Record<string, any> }>
    knowledge: Record<EntityId, { knownFacts: FactId[] }>
    threads: Record<ThreadId, { progress: number, total: number }>
    rules: Record<RuleId, { active_evidence: number }>
  }
}

// 格式: JSON，.nova/snapshots/snapshot_{narrativeOrder}.json
// 每 20 个 event 创建一次（nova.yaml 可配）

// Replay:
//   getStateAt(point):
//     snapshot = findNearest(point)  // ≤ point 的最近快照
//     events = eventStore.getRange(snapshot.narrativeOrder + 1, point)
//     return replay(snapshot.state, events)

// 快照失效: 编辑 ≤ narrativeOrder 的 event → 该序号及后续快照全部失效
//           下次 nova validate 自动重建
```

对话中有大量时间用于探索各种路径并做出取舍。以下记录关键决策及理由。

### 7.A. 不被采用的架构方向

| 方向 | 为什么讨论过 | 为什么不采用 |
|------|------------|------------|
| **PDDL 规划** | There and Back Again (AIIDE 2023) 用 PDDL 做故事规划，最接近 Novel IR 的论文 | PDDL 表达能力太弱。只能建模 Move/Attack 这类离散动作，无法处理情感变化、心理冲突、隐喻等 |
| **纯 Neo4j 做存储** | 图数据库天然适合关系建模（人物关系、事件因果） | 图数据库不适合作唯一真相源。事件溯源需要时序日志，版本控制需要 Git，图查询只是索引层 |
| **LLM 直接管理状态** | 主流做法（Sudowrite, NovelAI 都用 LLM 记忆） | LLM 不可靠。状态必须由确定性系统管理。LLM 只做提案，不做真相 |
| **PDDL + NL2PDDL 生成** | NL2PDDL（ACL 2023）可以从自然语言生成 PDDL domain | PDDL 无法表示"情感变化""伏笔""隐喻"等叙事核心概念。纯规划模型会丢失文学性 |
| **Fog of War Planning** | 2025 年论文提出多角色受限信息规划 | 过于学术，没有工程化实现。但"角色知识边界"概念被吸收进设计 |
| **Belief Planning** | 论文提出角色信念系统规划 | 太形式化。现实小说中角色信念很模糊，过度建模会变成学术玩具 |
| **自训练小模型** | 对话中讨论过自己训练/微调专用小模型做一致性检查 | MVP 阶段没必要。先用确定性规则 + LLM 做两级检查。自训练需要海量标注数据 |
| **完整 Narrative IR 标准** | 类似 LLVM IR 之于编译器，定义一套完整标准 | 过度设计。先做领域模型和 Context Compiler，IR 格式边用边演化 |
| **自动评价文学质量** | 训练模型自动打分 | 文学质量是主观的，自动化评价会压制创新。只做确定性检查（事实、时间、知识边界） |
| **规则版本化（backward compat）** | 随着剧情推进发现更准确的规则，保留旧版本以验证旧 scene | 过度设计。规则是静态文件，作者改了就是改了。`nova validate --full` 用新规则重验证所有 scene。小改在当前项目修，世界观大改开新项目。不存在"v1 的 scene 需要和 v2 的规则共存"的场景 |
| **渐进式世界构建（动态规则）** | 规则参数随剧情演化（如时间参数被新发现改写） | 同样被"静态文件 + 手动重验证"覆盖。规则级改动是作者的设计决策，不是运行时系统推导 |

### 7.B. 九个架构层的责任划分

对话的核心架构决策是将系统按"是否依赖 LLM"分成九层，这是后续所有设计的基础：

| 层 | 内容 | 技术 | 关键判断 |
|---|------|------|---------|
| **1. 传统软件** | 项目结构、版本控制、Entity管理 | SQLite/Git/文件系统 | LLM 根本不碰 |
| **2. 传统 NLP** | 实体抽取、时间抽取、引用消解 | NER、Dependency Parsing | 小模型即可，不需要 LLM |
| **3. 规则引擎** | Continuity Check 80%（年龄、死亡、位置冲突） | 确定性规则 | 不用 AI，纯计算 |
| **4. 图算法** | 依赖图、影响分析、Plot Thread 追踪 | 图遍历、拓扑排序 | 修改第一章后计算影响范围 |
| **5. 编译器** | Context 编译、Snapshot 生成 | 模板引擎 + 状态序列化 | 把 State 编译成 LLM 可读的 Context |
| **6. LLM + Rule Hybrid** | 复杂连续性判断（"角色声音漂移"） | LLM 辅助 + 规则裁决 | LLM 提出警告，规则决定是否接受 |
| **7. 必须 LLM** | 创意、正文生成、语义审稿、文风迁移 | LLM | 不可替代的 30%-40% |
| **8. 绝不能信 LLM** | Canon 决策、状态写入、历史改写 | 人工确认 | LLM 只提案，不决策 |
| **9. 长期成本** | 缓存、增量更新、依赖图复用 | Bazel 式增量构建 | "不要每次 npm run build" |

**核心结论**：真正不可替代的 LLM 部分只有 30%-40%，剩余 60%-70% 可以工程化。

### 7.C. 具体参考项目的取舍

对话中专门研究了 7 个论文/项目，各自有借鉴和弃用的部分：

| 项目 | 借鉴 | 弃用 |
|------|------|------|
| **Fabula（2026）** | 层级化 UI：Idea→Story Plan→Scenes→Beats→Script | Backend 纯 LLM 驱动，无版本控制、无 CI、无 Rule Engine |
| **There and Back Again** | "小说→Planning Domain→Planner→LLM→故事" 的链条思维 | PDDL 表达能力太弱 |
| **Narrative Planning Model Acquisition** | 从故事中自动学习规划模型 | 学术原型，不可工程化 |
| **Belief Planning** | 角色信念系统建模 | 过于形式化 |
| **Fog of War Planning** | 多角色受限信息规划 | 吸收了"角色知识边界"概念，不采用完整框架 |
| **NL2PDDL** | NL→结构化领域模型的思想 | PDDL 本身不适合叙事 |
| **LLM+P** | LLM 辅助经典规划器 | 规划器对小说过度约束 |

### 7.D. 叙事学理论的工程化取舍

对话深入研究了叙事学（Narratology），但做了选择性工程化：

| 叙事学概念 | 是否工程化 | 理由 |
|-----------|----------|------|
| **Story/Discourse 分离** | ✅ 核心架构 | Story=DAG，Discourse=Render，最精确的工程类比 |
| **Event 本体论** | ✅ 核心模型 | 小说=世界状态变迁 |
| **Focalization（聚焦）** | ✅ POV + Knowledge Boundary | 谁看、谁叙述、谁知道 |
| **Propp 功能函数** | ❌ 不做 | 31 个功能函数太死板，只适合民间故事 |
| **Greimas 行动元模型** | ❌ 不做 | 6 种角色类型过于简化 |
| **Genette 叙事话语** | 部分采用 | Order/Duration/Frequency 概念有用，但不做完整框架 |
| **Chatman Story/Discourse** | ✅ 核心 | 故事层 vs 话语层是最清晰的模型 |
| **Bal 叙事学** | 参考 | Focalization 三级模型值得研究 |
| **场景理论** | ✅ 核心 | Beat 用于规划，Scene 用于生成，Chapter 用于审核 |
| **人物弧光理论** | ✅ Plugin | 作为 Character Arc Plugin 而非核心 |

---

### 7.E. Review Layer（审阅反馈层）TypeScript 定义

```typescript
// ReviewComment 是一等对象，进入版本历史
interface ReviewComment {
  id: string
  author: 'human' | 'llm'
  target: {
    type: 'scene' | 'chapter' | 'character' | 'worldrule' | 'line'
    id: string
    lineRange?: [number, number]
  }
  severity: 'nit' | 'suggestion' | 'blocking'
  category: 'style' | 'pacing' | 'character_voice' | 'plot_logic' | 'world_consistency' | 'reader_experience'
  content: string
  status: 'open' | 'addressed' | 'resolved' | 'wontfix'
  resolvedBy?: PatchId
  createdAt: Timestamp
  resolvedAt?: Timestamp
}

// ReviewPatch 从 Review 生成，走 Proposal → Validate → Commit
interface ReviewPatch extends Proposal {
  sourceReviewIds: ReviewCommentId[]
  changes: PatchChange[]
}

interface PatchChange {
  type: 'rewrite' | 'insert' | 'delete' | 'attribute_change'
  target: EntityRef
  oldValue?: any
  newValue: any
  rationale: string
}
```

### 7.F. Discovery Layer（发现层 — 文件格式约定）

Discovery Layer 与 Core 完全解耦。任何能读写文件的 AI 工具（opencode、claude code、cursor、甚至手写）都可以充当发现层。Core 只定义标准文件格式。

```yaml
# Discovery Layer 产出的创作项目结构（详见 §五）：
#
# arcane-aftermath/
#   definitions/
#     characters/       # camille.yaml, orianna.yaml
#     relationships/    # camille_seraphine.yaml
#     rules/            # hextech.yaml, shimmer.yaml
#     state_initial.yaml
#   chapters/
#     chapter_NN/
#       _chapter.yaml
#       E*.yaml
#   scenes/
#   notes/
#   reference/
#   output/
#   reviews/
#   branches/
#   .nova/
```

---

# 输入质量保证与验证体系

> 系统有价值的前提是 AI 生成了可被系统使用的内容。本章定义三层机制：输入评分卡 → 反偷懒执行门槛 → 反向转换验证。

---

## 一、Input Structure Score (ISS) — 输入结构评分卡

类似代码覆盖率——不测"小说好不好"，测"系统用到了没有"。ISS 低 = 系统在空转。

### 六维评分模型

```yaml
# 每次 nova validate --full 后输出 ISS 报告

Input Structure Score: 72%  (目标 ≥ 80%)

维度 1: 实体引用完整性   15/20  (≥ 18)
  在 events 中引用的 18 个 entity，3 个缺少 definitions/ 定义
  缺失: npc_gear (仅在 introduces 中声明，无独立文件)
  缺失: zaun_gray_exchange (无 definitions/locations/ 文件)

维度 2: 规则可执行性      8/15  (≥ 12)
  3 条世界规则，仅 1 条有 logical_consequences.check 条目
  ✅ hextech.crystal_scarcity: 2 个 executable check
  ❌ shimmer.addiction_timeline: 0 个 executable check
  ❌ piltover_class: 0 个 executable check

维度 3: 前置条件深度      12/15  (≥ 12)
  10 个 events，8 个有至少 1 个 precondition
  ❌ E1a: preconditions 为空
  ❌ E1b: preconditions 为空
  ⚠ 检查: E1a 是否有隐含依赖未声明？

维度 4: 后置条件具体性     18/20  (≥ 16)
  25 个 postconditions，22 个引用具体 entity.attribute + value
  ❌ E3a: "camille.status = changed" — 不是具体值
  ❌ E2:  "situation = resolved" — 不是具体值

维度 5: Thread 覆盖率      12/20  (≥ 15)
  定义了 3 个 thread，仅 T1 被 events 引用
  ❌ T2 "Camille 个人困境": 在 events 中无 thread_progress
  ❌ T3 "Seraphine 双重负担": 在 events 中无 thread_progress

维度 6: 伏笔覆盖率          7/10  (≥ 8)
  2 个伏笔声明，均有 target_reveal_chapter ✓
```

### 六维计算规则

| 维度 | 检查什么 | 计分算法 |
|------|---------|---------|
| 实体引用完整性 | events 中每个引用的 entity 在 definitions/ 或 state_initial 中有定义文件 | `已定义引用 / 总引用数 × 20` |
| 规则可执行性 | 每条 defined rule 至少有 1 个 `logical_consequences.check` 条目 | `可执行规则数 / 总规则数 × 15` |
| 前置条件深度 | 每个 event（除第一个）有至少 1 个 precondition | `有 precondition 的 event 数 / 总 event 数 × 15` |
| 后置条件具体性 | postconditions 引用 entity.attribute + 具体值，非占位符 | `具体 postcondition 数 / 总 postcondition 数 × 20` |
| Thread 覆盖率 | 每个 defined thread 至少在 1 个 event 中被 thread_progress 引用 | `被引用的 thread 数 / 总 thread 数 × 20` |
| 伏笔覆盖率 | 每个 foreshadowing 声明的 thread 引用有效，target 在合理范围 | `有效伏笔数 / 总伏笔数 × 10` |

### 反模式检测（额外 WARNING，不计分）

| 反模式 | 检测方法 | 严重度 |
|--------|---------|--------|
| 所有 traits 都是单形容词 | `traits` 数组每项 ≤ 1 个词 → 无法用于 Validator 检查 | WARNING |
| 复制粘贴的 preconditions | 多个 event 的 preconditions 完全相同 → 疑似批量生成未定制 | WARNING |
| 死线程 | thread 定义后 5 章内 progress 仍为 0/total | WARNING |
| 空场景 | event 的 postconditions 中没有新 facts 产生 → 场景未推进剧情 | INFO |

---

## 二、反偷懒 — Agent Prompt 执行门槛

AI agent 生成 YAML 时必须在 system prompt 中嵌入以下硬性要求。由 `nova validate --strict` 强制执行。不满足 → ERROR。

```markdown
## 最低执行门槛

1. 每个 character 必须有至少 3 个可验证的 traits
   ❌ traits: ["brave", "kind"]  ← 单形容词，无法检查
   ✅ traits: ["speaks_in_questions", 
               "flinches_at_loud_noises", 
               "counts_money_before_speaking"]

2. 每个 event（除 E1）必须有至少 1 个具体 precondition
   ❌ preconditions: []
   ✅ preconditions: [{ entity: camille, attribute: location, 
                        value: zaun_gray_exchange_entrance }]

3. 每个世界规则必须有至少 1 个 executable check
   ❌ logical_consequences: ["shimmer 使用者随时间恶化"]
   ✅ logical_consequences: [{ check: { type: state_invariant, 
        filter: "condition contains 'shimmer'", assert: "status != 'healthy'" } }]

4. 每个 thread 必须在前 3 章内被至少 1 个 event 引用
   T1/T2/T3 定义了，但第 3 章仍未推进 → WARNING

5. 禁止占位符后置条件
   ❌ expected_postconditions: [{ entity: camille, attribute: status, value: "changed" }]
   ✅ expected_postconditions: [{ entity: camille, attribute: emotional_state, value: suspicious }]
```

### 验证流程

```
nova validate          # 标准验证 — WARNING 不阻断
nova validate --strict  # 严格验证 — 反偷懒门槛强制执行 → ERROR 阻断 commit
```

`--strict` 模式用于 CI/CD（每次 commit 前），普通模式用于日常写作。

---

## 三、成品小说反向转换验证

验证路径：用 AI agent 把已出版小说转换为我们的 YAML 格式，跑验证器，三层分析。

### 转换流程

```
已出版的成品小说（全文）
        │
        ▼
AI agent（opencode）读取全文 → 转换为 YAML 格式
        │
        ├── definitions/    角色/规则/关系提取
        ├── chapters/       事件拆分（按叙事顺序）
        └── state_initial.yaml  起始世界状态
        │
        ▼
nova validate --full --strict
        │
        ├── ISS 评分：原小说"工程化"后系统覆盖率
        ├── Validator 输出：一致性错误
        │   "E15 中 Alice 知道 Bob 的秘密，但 Alice 的 Knowledge 状态中无此信息"
        │   → 问题分类：原小说的 bug？转换时的 AI 幻觉？格式限制？
        └── 反向验证：将 errors 映射回原文确认
```

### 三层分析

| 层 | 验证什么 | 方法 | 目标 |
|---|---------|------|------|
| **转换保真度** | AI 生成的 YAML 是否忠实于原文 | 按 event 的 scene_brief 回译成自然语言，人工/LLM 判断与原文是否一致。抽样 20% 的 events | 保真度 ≥ 90% |
| **系统有效性** | 对公认逻辑严谨的小说，ISS 应高分 | 选阿加莎·克里斯蒂的推理小说跑转换 → ISS | 期望 ≥ 85% |
| **系统诊断力** | 系统能否发现已知的一致性错误 | 选已知有 bug 的小说（冰火时间线矛盾）、ConStory-Bench 19 种错误样本 | 确定性 Validator 检出率 ≥ 0.678（LLM-as-judge baseline） |

---

## 四、Benchmark 集成计划

| Benchmark | 任务 | 评估指标 | 优先级 |
|-----------|------|---------|--------|
| **ATANT** (250 stories) | 每个故事转 YAML → `nova validate --full` | 7 个连续性属性的通过率。目标：确定性 Validator 达到 Gold 级别（100%） | P0 — LLM-free，唯一纯确定性评测 |
| **ConStory-Bench** (2000 prompts, 19 种错误) | 选代表性 prompt 生成故事 → 跑 10 个 Validator | 错误检出率 vs ConStory-Checker baseline (F1=0.678) | P1 — 验证 Validator 覆盖是否匹配学界标准 |
| **LongStoryEval** (600 books) | 系统产出的长篇小说 vs 已出版书 | NovelCritique 打分 + 趋势对比 | P2 — 最终质量参考，不完全依赖 |

**ATANT 是最关键的**：如果 7 个纯确定性 Validator 达不到 Gold 级别，说明 Validator 设计有根本缺陷。

---

## ISS 的哲学定位

```
ISS 的职责：
  确保输入"能让系统工作"。
  提高门槛 > 拒绝空洞输入 > 减少下游浪费。

ISS 不等于文学质量：
  ISS 高 ≠ 小说好。
  一个事件齐全、规则可执行但故事无聊的输入 → ISS 95%，但产出烂小说。

ISS 低 = 系统在空转：
  preconditions 都是空的 → Validator 没有检查对象 → commit 全部通过，
  但小说仍然矛盾百出。用户以为系统在工作，实际上什么都没做。
```

ISS 在 PROJECT_STATUS.md 中以人类语言展示：

```markdown
## 输入质量

ISS: 72% — 还有改进空间

关键问题:
  • 3 个角色缺少定义文件 → 没有定义的角色无法被系统追踪
  • shimmer 规则缺少可执行约束 → 系统无法自动检查 shimmer 一致性
  • T2 线程未在任何事件中推进 → 这个线程可能被遗忘了

完成以上 3 项后 ISS 将达到 85%
```

---

# MCP 反馈接口 — Core → AI Agent 的结构化通信协议

> Core 不控制 AI agent 的行为。但提供两样东西让 agent 高效决策：机器可读的结构化指标 + 指导话术。

---

## 一、StatusReport — 单次调用的完整反馈

`mcp_nova_status()` 返回此类型。所有字段机器可读、可编程。

```typescript
// ——— MCP tool: mcp_nova_status(project_path: string) → StatusReport ———

interface StatusReport {
  project: string
  timestamp: string

  iss: ISSSnapshot
  validation: ValidationSnapshot
  threads: ThreadSnapshot[]
  render: RenderSnapshot
  blockers: Blocker[]
  next_actions: NextAction[]
}

// ─── ISS ───

interface ISSSnapshot {
  overall: number                          // 72
  target: number                           // 80
  dimensions: ISSDimension[]
}

interface ISSDimension {
  name: string                             // "实体引用完整性"
  score: number                            // 15
  max: number                              // 20
  threshold: number                        // 18
  status: 'green' | 'yellow' | 'red'
  gaps: ISSGap[]
}

interface ISSGap {
  entity?: string                          // 缺失引用的实体名
  id?: string                              // 缺失引用的 id
  file?: string                            // 应该存在的文件路径
  suggestion: string                       // 人类可读
  fix_action: 'create_file' | 'edit_file' | 'add_field' | 'change_value'
  fix_target: string                       // 文件路径或字段名
  template?: string                        // 骨架 YAML 内容（如需要创建新文件）
}

// ─── Validation ───

interface ValidationSnapshot {
  last_run: string
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

interface ValidationIssue {
  validator: string                        // "KnowledgeValidator"
  severity: 'error' | 'warning'
  event: string                            // "E3b"
  entity: string                           // "camille"
  attribute?: string
  message: string                          // 人类可读
  fix_suggestion: string
  fix_action: 'add_knowledge' | 'remove_line' | 'change_value' | 'add_precondition' | 'declare_flashback' | 'manual'
  fix_target: {
    file: string                           // 应编辑的文件
    field?: string                         // 应修改的字段
    value?: any                            // 建议值
  }
}

// ─── Thread ───

interface ThreadSnapshot {
  id: string                               // "T1"
  name: string
  progress: string                         // "2/5"
  last_advanced_in: string                 // "E3b"
  target_chapter: number
  current_chapter: number
  on_track: boolean
  risk: 'on_track' | 'behind' | 'critical' | 'stalled'
}

// ─── Render ───

interface RenderSnapshot {
  ready: string[]                          // ["E3a"] — preconditions 满足，可渲染
  blocked: string[]                        // ["E3b"] — 被 validation error 阻断
  waiting: string[]                        // ["E3c", "E4"] — 等待依赖
  completed: string[]                      // ["E1a", "E1b", "E2"]
}

// ─── Blockers ───

interface Blocker {
  event: string                            // "E4"
  reason: string
  missing_preconditions: Array<{
    entity: string
    attribute: string
    expected_value: any
    current_value: any | null              // null = 完全不存在
    provided_by?: string                   // 应该由哪个 event 提供
  }>
}

// ─── Next Actions ───

interface NextAction {
  priority: 'critical' | 'high' | 'medium' | 'low'
  category: 'iss' | 'validation' | 'thread' | 'rendering'
  action: string                           // 人类可读
  target_file?: string
  template?: string
  fix_action?: string
}
```

---

## 二、next_actions 生成逻辑

Core 内部优先级排序算法：

```
1. 遍历 iss.dimensions:
   → 每个 gap 生成一个 NextAction
   → status='red' → priority='critical'
   → status='yellow' → priority='high'
   → 有 template → 填入 template 字段

2. 遍历 validation.errors:
   → 每个 error 生成一个 NextAction
   → severity='error' → priority='critical'
   → fix_action != 'manual' → 填入 fix_target + fix_action

3. 遍历 threads:
   → risk='critical' → priority='high', category='thread'
   → risk='behind' → priority='medium'

4. 遍历 render.blocked:
   → 不是 validation error 导致的 → "E3c blocked: 等待 E3b 的 postcondition"

5. 排序:
   critical → high → medium → low
   同类内: ISS gaps 先于 validation errors 先于 thread warnings
```

---

## 三、指导话术（AI agent system prompt 注入）

`mcp_nova_status()` 返回附加字段 `guidance`：一段给 AI agent 的自然语言指导，由 core 自动生成。

```typescript
interface StatusReport {
  // ... 以上字段
  guidance: string     // ★ 注入到 AI agent 的 system prompt
}

// 生成逻辑：
function generateGuidance(report: StatusReport): string {
  let guidance = "## 当前项目状态指导\n\n"

  // 1. ISS 优先
  if (report.iss.overall < report.iss.target) {
    guidance += `ISS: ${report.iss.overall}% (目标 ${report.iss.target}%)\n\n`
    guidance += "### 你应该优先修复 ISS\n\n"

    for (const action of report.next_actions.filter(a => a.category === 'iss')) {
      guidance += `${action.priority === 'critical' ? '🔴' : '🟡'} ${action.action}\n`
      if (action.target_file) guidance += `   → 编辑 ${action.target_file}\n`
      if (action.template) guidance += "   → 模板已附在 StatusReport.next_actions[].template 中\n"
      guidance += "\n"
    }
  }

  // 2. 渲染
  if (report.render.ready.length > 0) {
    guidance += "### 当前可渲染的场景\n"
    for (const e of report.render.ready) {
      guidance += `- ${e} — ✅ preconditions 满足\n`
    }
    guidance += "\n"
  }

  // 3. 阻断
  if (report.blockers.length > 0) {
    guidance += "### 被阻断的场景\n"
    for (const b of report.blockers) {
      guidance += `- ${b.event}: ${b.reason}\n`
    }
    guidance += "\n"
  }

  // 4. 线程
  for (const t of report.threads.filter(t => t.risk !== 'on_track')) {
    guidance += `- ⚠ ${t.name} (${t.id}): ${t.progress}，${t.risk}\n`
  }

  // 5. 不要做的事
  guidance += "\n### 不要做的事\n"
  if (report.iss.overall < report.iss.target) {
    guidance += "- 不要创建新的 chapters/ 文件（ISS 未达标）\n"
  }
  if (report.validation.errors.length > 0) {
    guidance += "- 不要渲染被 ERROR 阻断的场景\n"
  }
  if (report.render.ready.length === 0 && report.validation.errors.length > 0) {
    guidance += "- 不要创建新的 events（先修复现有 ERROR）\n"
  }

  return guidance
}
```

生成的 `guidance` 示例：

```markdown
## 当前项目状态指导

ISS: 72% (目标 80%)

### 你应该优先修复 ISS

🔴 补 shimmer 规则的 executable check (definitions/rules/shimmer.yaml)
   → 模板已附在 StatusReport.next_actions[].template 中
   完成后 ISS +7

🟡 创建 npc_gear 角色定义文件 (definitions/characters/npcs/npc_gear.yaml)
   → 模板已附在 StatusReport.next_actions[].template 中
   完成后 ISS +5

### 当前可渲染的场景

- E3a — ✅ preconditions 满足

### 被阻断的场景

- E3b: KnowledgeValidator ERROR — camille 知道不该知道的信息

### 不要做的事

- 不要创建新的 chapters/ 文件（ISS 未达标）
- 不要渲染被 ERROR 阻断的场景
```

---

## 四、opencode 使用此接口的典型循环

```
1. mcp_nova_status() → StatusReport
2. 读 guidance → 注入 system prompt
3. 读 iss.overall < 80:
   → 遍历 next_actions.filter(p => p.category === 'iss')
   → 按 priority 顺序执行 fix_action
   → 每个修复后: mcp_nova_validate()
4. ISS ≥ 80:
   → 遍历 next_actions.filter(p => p.category === 'validation')
   → 执行 fix_action
5. 无 ERROR:
   → render.ready 中选下一个 → mcp_nova_render(event)
   → 生成的 prose 验证 → commit → 循环
```

---



> 系统读取的所有结构化文件格式。按内容类型分组。

---

## A. 静态定义（`definitions/`）

### A1. 角色 — `definitions/characters/<id>.yaml`

```yaml
# definitions/characters/camille.yaml
id: camille
name: "Camille"
type: character
archetype: investigator
faction: piltover_enforcers

description: |
  Piltover 的首席情报官。全身 hextech 增强，右腿是刀刃假肢。
  理性至上，效率优先，不容忍腐败。外表冰冷但有隐藏的正义感。

initial_state:
  location: piltover_enforcer_headquarters
  status: alive
  condition: healthy
  emotional_state: determined

traits:
  - calculating
  - ruthless_when_necessary
  - hidden_moral_code
  - physically_intimidating

voice_notes: |
  Calculating, minimal, no sentiment. Speaks in statements, not questions.
  When she asks a question it's a demand, not curiosity.

# 可选
backstory: |
  Born into a Piltover noble house. Chose enforcer life over privilege.
  Received hextech augmentations after a near-fatal incident in Zaun.

known_secrets:  # 角色已知的秘密（初始 Knowledge 状态）
  - "Piltover 旧议会中存在未被清查的腐败势力"
```

```yaml
# definitions/characters/npcs/npc_gear.yaml
id: npc_gear
name: "Gear"
type: character
archetype: informant
faction: zaun_underground
role: minor  # minor | supporting | antagonist | background

description: |
  一个被 shimmer 损坏身体的中年 Zaun 居民。
  在灰色市场做中间人，靠情报交易维持生计。
  害怕 Piltover 的上层势力，但更害怕没钱。

initial_state:
  location: zaun_gray_exchange
  status: alive
  condition: shimmer_damaged
  emotional_state: desperate

traits:
  - greedy
  - cowardly
  - survival_instinct
  - knows_more_than_he_says

voice_notes: |
  Nervous, speaks too fast when scared. Uses Zaun street dialect.
  Deflects with complaints about money and shimmer prices.
```

### A2. 关系 — `definitions/relationships/<id>.yaml`

```yaml
# definitions/relationships/camille_seraphine.yaml
participants: [camille, seraphine]
type: professional

description: |
  Camille recruited Seraphine for her hextech-enhanced empathy — a capability
  no other agent can provide. The relationship is utilitarian on Camille's side,
  and cautiously hopeful on Seraphine's.

initial_state:
  camille_to_seraphine:
    trust: 0.5
    attitude: utilitarian
  seraphine_to_camille:
    trust: 0.4
    attitude: cautious_respect

established_event: "system:genesis"  # 初始关系在创世时建立
```

### A3. 世界规则 — `definitions/rules/<id>.yaml`

```yaml
# definitions/rules/hextech.yaml
rule_id: hextech.crystal_scarcity
name: "Hextech 晶体稀缺"
category: world_rule
type: conditional

statement: |
  Hextech 晶体来源有限，开采危险。供应渠道由 Piltover 议会严格控制。
  非官方渠道获取的晶体量极少且不稳定。

logical_consequences:
  - description: "大型 hextech 装置需要定期维护——不能无限使用"
    check:
      type: state_invariant
      filter: "entity_kind == 'character' AND traits contains 'hextech_augmented'"
      assert: "physical_state.operational == true"
      severity: warning

  - description: "私人渠道持有的晶体数量超过阈值时，意味着高层腐败"
    check:
      type: state_invariant
      filter: "entity_kind == 'character' AND hextech_crystal_count > 10"
      assert: "NOT faction IN ['piltover_enforcers', 'piltover_council']"
      severity: error

exceptions:
  - condition: "议会授权特批"
    note: "Arcane S1 后议会改革，审批更严格"

evidence_chain: []  # 系统从 chapters/ 中的 rule_effects 自动填充
```

```yaml
# definitions/rules/shimmer.yaml
rule_id: shimmer.addiction_timeline
name: "Shimmer 成瘾时间线"
category: world_rule
type: gradual

statement: |
  Shimmer 使用者的身体和精神状态随时间恶化。
  阶段：initial_use → dependency → physical_decay → mental_break → death。
  每个阶段 2-6 周（因人而异），不可逆。

logical_consequences:
  - description: "有 shimmer 标记的角色不能处于 healthy 状态"
    check:
      type: state_invariant
      filter: "condition contains 'shimmer'"
      assert: "status != 'healthy'"
      severity: error

  - description: "无医疗干预时 shimmer 成瘾者不能自行康复"
    check:
      type: transition_constraint
      filter: "condition contains 'shimmer'"
      assert: "condition NOT IN ['healthy', 'recovered']"
      unless_event: "medical_intervention"
      severity: error

  - description: "shimmer 成瘾者情绪状态应持续恶化"
    check:
      type: progression
      filter: "condition contains 'shimmer'"
      attribute: emotional_state
      direction: downward
      tolerance: 3       # 允许 3 章的波动窗口
      severity: warning

exceptions: []
evidence_chain: []
```

**三种 check 类型**：

| 类型 | 检查什么 | Validator | 触发时机 |
|------|---------|-----------|---------|
| `state_invariant` | 某事实在任何时间点都必须为真 | WorldRuleValidator | 每次 `nova validate`，检查当前 State |
| `transition_constraint` | 两个状态之间不能直接跳转 | CharacterStateValidator | Scene commit 时，检查 pre→post 状态变化 |
| `progression` | 某属性应朝特定方向变化（软约束） | ProgressionValidator | 每 N 章定期检查，允许 tolerance 波动窗口 |

系统读取 `logical_consequences` 中的 `check` 声明后，自动生成 SQL/内存查询，在每次 commit 时验证。**规则从自然语言变成了可执行约束**——这是我们的系统区别于 Novel-OS 6 个硬编码检查函数的根本差异。

### A3b. 地点 — `definitions/locations/<id>.yaml`

> **(@oracle C7 修复)** 地点在 event preconditions 中被引用但无定义 schema。

```yaml
# definitions/locations/zaun_gray_exchange.yaml
id: zaun_gray_exchange
name: "灰色市场"
kind: location
parent: zaun_undercity                 # 父地点（用于层级导航）

description: |
  Zaun 底层的一个半合法交易点。隐藏在旧工厂区的地下室网络中。
  买卖情报、黑市货物、shimmer。由当地帮派松散管理。

initial_state:
  status: operational
  controlled_by: zaun_underground      # 引用 faction/entity id
  security_level: medium               # low | medium | high
  atmosphere: oppressive_humidity      # 自由描述，供 Context Compiler 使用

notable_features:
  - "shimmer 残留气味弥漫"
  - "入口由两个带病守卫看守"
  - "谈判在后面的暗室进行"
```

### A3c. 物品 — `definitions/items/<id>.yaml`

```yaml
# definitions/items/hextech_crystal_sample.yaml
id: hextech_crystal_sample
name: "Hextech 晶体样本"
kind: item

description: |
  从爆炸现场回收的 hextech 晶体碎片。能量读数异常。
  Camille 随身携带作为证据。

initial_state:
  location: camille_possession         # 物品当前所在地点或持有者
  status: intact
  significance: key_evidence           # key_evidence | plot_critical | background | mcguffin
```

### A3d. 势力 — `definitions/factions/<id>.yaml`

```yaml
# definitions/factions/zaun_underground.yaml
id: zaun_underground
name: "Zaun 地下势力"
kind: faction

description: |
  Piltover 阴影下的松散联盟。没有统一领导，由各区域帮派分别控制。

initial_state:
  status: fragmented                  # unified | fragmented | suppressed | rising
  influence: moderate
  territory: [zaun_lower_levels, zaun_gray_markets]
```

### A4. 世界初始状态 — `definitions/state_initial.yaml`

```yaml
# definitions/state_initial.yaml —— ★ 所有动态状态的起点
# 系统读取 → 包装为 type: system:genesis 的 NarrativeEvent → Event Store.commit()

info:
  current_era: "arcane_s1_end"
  political_situation: |
    议会改革后 Piltover 与 Zaun 进入脆弱和平期。
    但 Zaun 地下势力在权力真空中重组。
    Piltover 内部存在未被清查的旧利益集团。

# ★ Plot Threads（贯穿全文的主线/支线）
threads:
  - id: T1
    name: "Hextech 武器走私"
    description: "有组织地向 Zaun 地下市场供应 hextech 晶体，用于制造非法武器"
    type: main
    target_reveal_chapter: 7
    initial_progress: 0/5

  - id: T2
    name: "Camille 的个人困境"
    description: "全身 hextech 增强的她在 Zaun 环境中越来越格格不入，面临身份危机"
    type: character_arc
    target_reveal_chapter: 8
    initial_progress: 0/4

  - id: T3
    name: "Seraphine 的双重负担"
    description: "她的魔力同理心既是追踪工具也是心理负担，听到的痛苦声音越来越难以承受"
    type: character_arc
    target_reveal_chapter: 6
    initial_progress: 0/3

# ★ World Facts（全局事实，不归属任何实体）
world_facts:
  - id: piltover_zaun_peace
    value: fragile
    description: "Piltover 与 Zaun 的和平状态"

  - id: hextech_public_moratorium
    value: active
    description: "议会暂停公开 hextech 研究，但私人/地下研究仍在继续"

  - id: shimmer_trade_underground
    value: active
    description: "Shimmer 交易转入地下，由新崛起的帮派控制"
```

---

## B. 章节与事件（`chapters/`）

### B1. 章节元数据 — `chapters/chapter_NN/_chapter.yaml`

```yaml
# chapters/chapter_03/_chapter.yaml
chapter: 3
title: "灰色市场"
summary: |
  Camille 潜入 Zaun 黑市追查 hextech 走私线索。
  与地下中间人 Gear 的谈判揭示了 Piltover 内部
  存在未被清查的腐败势力。

# 章节意图（给 AI agent 的创作上下文）
intent: |
  建立 Camille 作为"有效率的调查者"的形象。
  引出 Piltover 上层腐败的第一条硬线索。
  同时展示 Zaun 的底层生态——灰色市场、shimmer 受害者、
  在 Piltover 阴影下生存的人。

# 规划的场景数
planned_scenes: 3  # E3a, E3b, E3c

# 章节级风格指导（默认所有 scene 继承）
style_guidance:
  tone: noir
  atmosphere: "oppressive humidity, shimmer smell, coughing in the background"
```

### B2. 事件文件 — `chapters/chapter_NN/E*.yaml`

```yaml
# chapters/chapter_03/E3b.yaml

# ★ 必填核心（7 字段）
event: E3b
narrative_order: 9
title: "灰色市场：谈判"
story_time: "arcane_s1_end + 3 weeks"
scene_type: linear

pov:
  character: camille
  type: third_person_limited

scene_brief: |
  Camille 与 Gear 在暗室谈判。Gear 开始闪烁其词，
  Camille 通过精确的心理施压逼他透露供货人的信息。

preconditions:
  - entity: camille
    attribute: location
    value: zaun_gray_exchange_entrance
  - entity: hextech_crystals
    attribute: status
    value: scattered

expected_postconditions:
  - entity: camille
    attribute: knows
    value: weapons_smuggler_is_piltovan
    confidence: 0.6
  - entity: npc_gear
    attribute: status
    value: intimidated
  - entity: camille
    attribute: location
    value: zaun_gray_exchange_interior

style_guidance:
  tone: noir_restrained
  camille_voice: "calculating, minimal, no sentiment"
  avoid: "excessive interiority, emotional adjectives"
  scene_pacing: "tense buildup → pressure point → forced revelation"

# ─ 系统自动追踪的声明（AI 在一个文件里声明，系统 commit 后提取到 .nova/derived/）───

thread_progress:
  - thread: T1
    advancement: "获得第一条明确线索——供货人是 Piltover 上层"
    progress_after: 2
    progress_total: 5

foreshadowing:
  - id: F1
    hint: "Gear 提到'他们给的晶体比议会库存还多'——暗示 Piltover 内部有私藏晶体"
    target_reveal_chapter: 7
    thread: T1

relationship_effects:
  - participants: [camille, npc_gear]
    effect: establish
    direction: camille → npc_gear
    new_state:
      type: hostility
      intensity: 0.7

rule_effects:
  - rule: hextech.crystal_scarcity
    effect: reinforce
    evidence: "Gear 提到黑市上有比议会库存更多的晶体在流通"

introduces:
  - type: character
    id: npc_gear
    initial_state:
      location: zaun_gray_exchange_interior
      status: alive
      condition: shimmer_damaged
  - type: location
    id: zaun_gray_exchange_interior
    parent: zaun_gray_exchange
```

**验证规则**：

```
Zod schema 层面:
  1. narrative_order 全局唯一
  2. preconditions 中 entity 引用必须在以下位置存在:
     - definitions/characters/<id>.yaml
     - definitions/state_initial.yaml 的 world_facts
  3. rule_effects.rule 必须在 definitions/rules/ 中存在
  4. thread_progress.thread 必须在 state_initial.yaml 中定义
  5. expected_postconditions 中新 entity 必须在 introduces 中声明

State Manager 层面:
  6. precondition 的值在 State 中必须为真（运行时检查，非 Zod）
  7. narrative_order 严格递减 = ERROR
```

**系统 commit 后自动执行**：

```
chapters/chapter_03/E3b.yaml commit
  ├── thread_progress   → .nova/derived/threads/T1.yaml 追加
  ├── foreshadowing     → .nova/derived/foreshadows/F1.yaml 创建
  ├── relationship_effects → .nova/derived/relationships/camille_gear.yaml 更新
  ├── rule_effects      → definitions/rules/hextech.yaml evidence_chain 追加
  └── expected_postconditions → Event Store 写入 + State 更新
```

---

## C. 渲染请求与产物（`scenes/`）

### C1. 渲染请求 — `scenes/chapter-NN/E*_render_request.yaml`

```yaml
# scenes/chapter-03/E3b_render_request.yaml
event: E3b
model: claude-sonnet-4-20250514  # 或 "default" 使用项目默认
temperature: 0.7

instructions: |
  Write this scene in third person limited, POV Camille.
  Focus on the psychological pressure Camille applies — she doesn't threaten,
  she uses precision. Gear's fear should be palpable but not overplayed.
  
  Setting: dim room, smells of shimmer residue. Gear at a makeshift desk.
  Camille stands — her blade leg visible but not deployed.

output_format:
  prose: markdown
  facts: structured  # LLM 除 prose 外还返回 newFacts JSON
```

### C2. 场景元数据 — `scenes/chapter-NN/E*.yaml`

```yaml
# scenes/chapter-03/E3b.yaml
event: E3b
prose_source: llm  # llm | human_edited | human_locked
model_used: claude-sonnet-4-20250514
rendered_at: "2026-07-16T15:30:00Z"
word_count: 847

edit_history: []
# 当人为编辑时追加:
# - timestamp: "2026-07-16T16:00:00Z"
#   notes: "Tightened dialogue in negotiation scene"
```

---

## D. 分支（可选 — `branches/`）

```yaml
# branches/branch_points.yaml
branch_points:
  - id: BP1
    at_event: E5
    description: "Camille 决定是否信任 Seraphine 的直觉"
    choices:
      - path: trust_seraphine
        label: "相信 Seraphine 的直觉，直接突袭仓库"
        branch_id: branch_a
        description: "突袭成功但惊动了背后势力"
      - path: investigate_first
        label: "先自己调查，延迟行动"
        branch_id: branch_b
        description: "获得更多证据但失去了时机"
```

---

## E. 项目配置（`nova.yaml`）

```yaml
# nova.yaml
project: arcane_aftermath
title: "Arcane 后传：灰色市场"
author: "作者名"

default_model: claude-sonnet-4-20250514
default_language: zh

# Validator 级别覆盖
validator_overrides:
  voice_drift: warning    # off | warning | error
  world_rule: error       # 升级为 ERROR（严格要求世界规则）

# Circuit Breaker
circuit_breaker:
  max_retries: 3

# Review 时效
review_expiry:
  blocking_chapters_before_downgrade: 3

# 快照间隔
snapshot_interval: 20
```

---

## F. 人类语言状态（`PROJECT_STATUS.md`）

> 系统自动维护。不是 YAML——是 markdown。

```markdown
# Arcane 后传：灰色市场 — 项目状态

_最后更新: 2026-07-16 15:31_

## 进度

| 章 | 场景数 | 已渲染 | 状态 |
|---|--------|--------|------|
| 第 1 章: 信号 | 2 (E1a, E1b) | 2/2 | ✅ 完成 |
| 第 2 章: 委托 | 1 (E2) | 1/1 | ✅ 完成 |
| 第 3 章: 灰色市场 | 3 (E3a, E3b, E3c) | 1/3 | 🔄 进行中 |

## 最近验证结果

### ✅ E3a "入口" — 通过
Camille 到达 Zaun 黑市入口。地点状态已更新。无警告。

### 🚫 E3b "谈判" — 被拒绝
**原因**: Camille 在场景中说出 "Piltover 内部有叛徒"，但她此时尚未获得此信息。
**建议**: 删除该台词，或在前置场景中补一个 Camille 获得此情报的事件。

## ⚠️ 待处理警告

| 场景 | 警告 |
|------|------|
| E2 "委托" | WorldRule: hextech.crystal_scarcity — Camille 在黑市使用 hextech 扫描器（Academy 禁区规则）。如是有意违反，标记 `wontfix` |

## Thread 状态

| Thread | 进度 | 最近推进 |
|--------|------|---------|
| T1 Hextech 武器走私 | 1/5 | E1a "Seraphine 感知到异常信号" |
| T3 Seraphine 双重负担 | 1/3 | E1b "Seraphine 独白" |

## 下一步

1. 修复 E3b 被拒绝的原因：删除 Camille 的过早信息，或在前置场景中补充情报获取事件
2. 继续渲染 E3c "复盘"
3. 检查 T2 在第 1-2-3 章是否有推进（已完成 3 章，T2 仍为 0/4）
```

---

## 八、参考资源清单

### 必读论文
1. DOME — 时间KG + 增量提纲
2. FactTrack — 带有效期的事实追踪
3. CreAgentive — 双重KG + 角色受限认知
4. Amory — 叙事层级记忆组织

### 必读代码库
1. [Novel OS](https://github.com/andrewbiro/novelos) — agent pipeline 参考
2. [write_ai_agent](https://github.com/rareloto/write_ai_agent) — KG 反馈循环
3. [mcp-writing](https://github.com/hannasdev/mcp-writing) — MCP + 元数据优先
4. [SillyTavern](https://github.com/SillyTavern/SillyTavern) — 提示词工程基础设施

### 社区关注
- r/WritingWithAI — 用户痛点一手来源
- r/NovelAi — NovelAI 用户讨论
- r/SillyTavernAI — 酒馆生态
- Hacker News — 行业讨论
