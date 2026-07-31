# 架构

## 高层数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        NOVALISTICALLY PIPELINE                          │
└─────────────────────────────────────────────────────────────────────────┘

YAML files (.yaml)
     │
     ▼
┌────────────────┐
│  EntityMapper  │  读取 YAML 定义，映射到内部类型
│  (entity/)     │  通过 Zod 验证 schema，设置文件路径
└───────┬────────┘
        │
        ▼
┌────────────────────┐
│   Event Sourcing   │  StateManager commit() → EventStore，可选 Snapshot
│  StateManager      │  ReplayEngine.replay() 按编译图顺序重放
│  (state/)          │  （compileStoryRuntimeGraph → compileGraph → buildStoryOrderIndex）
│                    │  循环是硬错误，绝不回退 narrativeOrder
└───────┬────────────┘
        │
        ▼
┌────────────────────┐
│  ContextCompiler   │  ContextAssembler 填充 5 层优先级
│  (context/)        │  RelevanceEngine 8 维评分（含 role→importance）
│                    │  无固定 token 截断
└───────┬────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│             RenderPipeline                   │
│  (pipeline/render.ts)                        │
│                                              │
│  ┌──────────┐   ┌──────────┐                │
│  │  Pass 1  │ → │  Pass 2  │                │
│  │ temp 0.8 │   │ temp 0.3 │                │
│  │  prose   │   │ seed 42  │                │
│  └──────────┘   │ analysis │                │
│                 │   JSON   │                │
│                 └──────────┘                │
│                                              │
│  缓存：v2 双层查找键（logical + surface）      │
│  命中后重 parse + 重校验                       │
│  并行：ConcurrencyPool（默认 5）              │
│  熔断器：错误阈值                             │
│  仅开发模式：双重运行验证                     │
└───────┬──────────────────────────────────────┘
        │
        ▼
┌────────────────────┐
│  ResultAggregator  │  运行全部 28 个内置验证器
│  (validator/)      │  渲染前（L1）：validatePre() → 事件定义
│                    │  渲染后（L2）：validatePost() → 散文 + 分析
│                    │  按严重程度分组：error | warning | info
└───────┬────────────┘
        │
        ▼
┌──────────────────────────────┐
│   Novel assembly             │  EditorialPublisher.publish()：isCurrent 时
│  (editorial/publisher.ts +   │  buildNovelDocument 按 ledger scene sequence
│   assembler/release-assembly)│  写 output/novel.md，否则保留既有 novel 并标 stale。
│                              │  CLI assemble → assembleCanonicalNovel /
│                              │  assembleCustomNovel；legacy assembleNovel 无生产调用方
└──────────────┬───────────────┘
```

## 包结构

Monorepo 包含三个包，按依赖顺序构建：`core → bench → cli`（bench 与 cli 都依赖 core，cli 额外依赖 bench；`npm run build` = `tsc -b` 三个包 + 各自的 esbuild 构建脚本）。

### `@novalistically/core`（`packages/core/`）

引擎。包含所有类型、状态管理、渲染和验证逻辑。入口：`src/index.ts` → `dist/`。通过 `tsc -b`（类型）+ esbuild（JS）构建。

### `@novalistically/bench`（`packages/bench/`）

基准测试和回归套件。调用核心 API 用于：

- **回归测试** — 在 祝福（`zhu-fu`）夹具上执行 L1 + L2 验证。报告每个验证器阶段的通过/失败。
- **变体测试** — 错误注入（故意制造 YAML 错误以测试验证器检测能力）+ 极端破坏（严重损坏的文件以测试错误韧性）+ 分支 A/B 对比 + Pipeline F1 评分。
- **性能测试** — N=10、N=100、N=1000 事件的合成工作负载。测量每个流水线阶段的吞吐量（Hz）和平均延迟。
- **一致性测试** — N-CED（叙事级一致性错误密度）、S-CED（场景级 CED）和 Pipeline F1（检测准确率）。
- **外部数据集** — 适配 ChiNovelKE、AgentSFT 和 IN3KNovel 格式以通过 Novalistically 流水线运行。
- **报告器** — 输出 JSON 和 Markdown 报告至 `output/bench/`。

### `@novalistically/cli`（`packages/cli/`）

使用 `commander` 的 CLI 应用程序，在包含 `nova.yaml` 的项目目录内运行（`ensureProjectDir()` 检查 cwd）。命令：

- `nova project init <name>` — 初始化新项目
- `nova render [event]` — 渲染一个/多个场景、章节或整个 branch（`--dry-run` 走 `previewEditorialRun`，`--scene` / `--all` / `--chapter` 选择，`--branch-path` / `--discourse-branch` 路由，`--model` / `--provider` / `--reference-dir` 提供者选项，`--trace` / `--concurrency` / `--actor` / `--json`）
- `nova revise [event]` — 用 open review 反馈修订 accepted prose
- `nova render-tree` — 渲染每个 game-dialogue node 恰好一次
- `nova validate` — 不渲染仅验证（`--strict`、`--event <id>`）
- `nova status` — 项目状态摘要；`nova diff [event]` — 事件 state before/after 或 `--project` 版本对比
- `nova assemble` — 组装 `output/novel.md`（`--output` / `--branch-path` / `--discourse-branch` / `--actor`）
- `nova scene list|show|history|adopt|lock|unlock|rollback` — scene revision 管理
- `nova review <action> [target] [message]` — 评论管理（list/add/replace/resolve/wontfix/reopen/escalate）
- `nova entity list [kind]` / `nova entity show <id>` — 实体查看（无独立的 `inspect` 命令）
- `nova graph` — 导出因果边可视化（`--format dot|mermaid`）
- `nova source list|show|preview|apply|reconcile` — 源文档工作区
- `nova operation list|show`、`nova trace event|stats`、`nova verify`、`nova commit`、`nova migrate`
- `nova bench` — 运行回归/性能基准（`--regression` / `--performance`）

MCP 服务器不是子命令：`packages/cli/src/mcp-server.ts` 是独立构建入口（`dist/mcp-server.js`），提供 IDE 集成用的 MCP 工具函数，全部薄包装 core root facade 调用。

## 核心模块映射

### `entity/` — YAML 加载与映射

- **`EntityMapper`** — 从项目目录读取 YAML 文件，通过 Zod 验证 schema，映射到内部 `NarrativeEvent`、`Entity`、`Fact`、`RuleDefinition` 类型。
- **`InMemoryEntityRegistry`** — 从 `EntityMapper` 填充的内存注册表。提供 `getAll()`、`findByKind()`、`resolve()`。
- **`compareFact()`** — 严格 `===` 相等比较函数，返回 `'match' | 'mismatch' | 'deferred'`（仅 hint 时）。实际调用方是 causality / branch-merge 验证器与 deferred resolver；重放前置条件校验不走它，`validatePreconditions()` 通过私有 `preconditionMatches()` 按全部 10 个 operator 分派。

### `state/` — 图编译、事件溯源与状态管理

- **`compileStoryRuntimeGraph()`**（`graph-adapter.ts`）— 解析全部事件时间（`resolveTemporalContext()`）、按 `branchPath` 过滤事件、把 genesis postconditions 与 initial facts 归并到 `system:initial` root，产出 `CompileNode[]`。
- **`compileGraph()`**（`graph-compiler.ts`）— 固定 12 阶段的图编译器，产出 `StoryGraph` / `DiscourseGraph`（四类边：`author_origin`、`provider`、`same_coordinate_order`、`internal`）与 typed 错误。
- **`buildStoryOrderIndex()`**（`dag.ts`）— Kahn 拓扑排序的确定性线性扩展与可达性索引（事件 ID 决胜）；`exportDAGtoDOT()` / `exportDAGtoMermaid()` 导出 DOT / Mermaid。
- **`EventStore`** — 仅追加的事件日志。`commit()` 添加事件，`getAll()` 返回所有事件，`load()` 用于初始化。
- **`ReplayEngine`** — 先 `compileStoryRuntimeGraph()` 得到 `topologicalOrder`，再依序重放以重建 `WorldState`。可按 `BranchPath` 过滤 branch-scoped event；线性项目里 mapper 只产生 `{ type: 'all' }` scope，带 `choices` 的项目按 `compileGameDialogueTree()` 派生的 descendant-leaf `BranchSet` 写入。
- **`SnapshotEngine`** — 在 `snapshot_interval`（默认 20）处创建快照。`findNearest(n)` 已实现并有单测，但**尚无生产调用方**：`StateManager.getCurrentState()` / `getStateAt()` 总是经 `ReplayEngine` 从 event store 重放，快照恢复尚未接入（当前只是 recovery primitive，见 `reference/state-management.md` 的边界警告）。
- **`StateManager`** — 协调 EventStore + SnapshotEngine + ReplayEngine。

### `context/` — 上下文组装与编译

- **`ContextCompiler`** — 主入口。委托给 ContextAssembler。
- **`ContextAssembler`** — 填充 5 层优先级上下文包（L1-L5）：系统上下文、场景说明、角色快照、关系上下文、世界事实；另有 knowledge boundary、active threads 与 active rules。**无固定 token 截断**（没有 8000-token 预算）。
- **`RelevanceEngine`** — 使用 8 个维度对实体进行相关性评分：participation（在场）、threadAssociation（线程关联）、spatioTemporal（空间/时间邻近）、knowledgeIntersection（知识重叠）、relationshipRelevance（关系相关）、specificityBonus（前置条件特异性）、recencyPenalty（近因惩罚）、importanceBonus（role→importance）。

### `pipeline/` — 渲染流水线

- **`RenderPipeline`** — 带 v2 双层规范缓存键（logical + surface 扁平）的两阶段并行渲染。Pass 1：散文（温度 0.8）。Pass 2：分析 JSON（温度 0.3，种子 42）。Zod 错误时带结构化反馈重试（每次重试变更 AttemptKey 元数据）。开发模式下可选的重复运行验证。错误阈值触发熔断。
- **`BatchRenderPipeline`** — 滑动窗口批处理渲染编排器。组合 RenderPipeline。将大型任务集分割为可配置的窗口。专为基准重写而构建。
- **`ConcurrencyPool`** — 有界并发 LLM 调用池（默认 5）。

### `validator/` — 验证系统

28 个内置验证器，每个实现 `Validator` 接口（外加 plugin 验证器）：

| 类别 | 验证器 |
|---|---|
| 角色刻画 | CharacterState、Alias、Pronoun、Appearance、VoiceConsistency、FocalizationConsistency |
| 事实细节 | FactualDetail、Knowledge、Checklist |
| 时间线/情节 | Timeline、Causality、Foreshadowing、ThreadProgress、Reachability、BranchMerge、DurationConsistency、FrequencyConsistency、AnachronyConsistency |
| 世界观 | WorldRule |
| 叙事风格 | POV、VoiceDrift、Pacing、TenseConsistency、DiscourseBalance、Conflict、Discourse |
| 散文质量 | Quality |
| 叙事技巧 | NarrativeTechnique |

关键类型：

- **`PreRenderInput`** — 渲染前验证上下文（事件、世界状态、实体注册表、事件存储）。
- **`PostRenderInput`** — 渲染后验证上下文（事件、世界状态、散文、分析 JSON）。
- **`AnalysisBlockRequirement`** — 声明验证器需要从 Pass 2 分析中获取的内容。
- **`ValidationIssue`** — 单个问题，包含严重级别、消息、修复建议、修复操作和修复目标。

**`ResultAggregator`** 运行所有验证器并收集结果：`validate()` 走 L1（各验证器的 `validatePre()`），`validateRender()` 走 L2（各验证器的 `validatePost()`）；`getAnalysisContract()` 从启用的内置 + plugin 验证器派生确定性的 Pass 2 分析契约（含 hash，进入 cache identity）。

### `ai/` — AI 提供商抽象

- **`AiSdkProvider`** — 使用 `createOpenAICompatible()` 的 Vercel AI SDK 提供商。baseURL 解析顺序：`options.baseURL` → `NOVALISTICALLY_AI_BASE_URL` → 默认 `https://opencode.ai/zen/v1`；**不做 API 密钥前缀检测**。API key 来自 `options.apiKey` 或 `NOVALISTICALLY_AI_API_KEY`（缺失抛错）；model 默认 `deepseek-v4-flash-free`（`options.model` / `NOVALISTICALLY_AI_MODEL` 可覆盖），支持按 taskType（pass1/pass2/summary）的 routing 选模型。Pass 2 使用手动 JSON 解析 + Zod 验证（结构化输出未获得普遍支持）。
- **`MockProvider`** — 用于测试的模拟 LLM。返回预写的散文。
- **`MockPass2Provider`** — 返回预写 Pass 1 散文 + Pass 2 分析 JSON 的模拟提供商。支持在无需真实 LLM 调用的情况下对渲染后验证器进行完整集成测试。
- **提示词构建器** — `prose-only.ts`、`render-analysis.ts` 分别用于 Pass 1 和 Pass 2 提示词。

### `schemas/` — Zod 模式

- 所有类型都有对应的 Zod schema 用于运行时验证。
- `analysis.ts` — 解析和验证 Pass 2 分析 JSON。同时支持错误收集模式和抛出模式。

### `cache/` — v2 规范渲染缓存

- **双层查找键** — 实际缓存 identity 是 `sha256Canonical({ logical: logicalKeyStr, surface: surfaceKeyStr })`：`LogicalRenderKey`（source 内容 hash + scene contract + world/knowledge state hash + discourse hash + branch/discourse scope + graph hash + style profile + model（同时充当 provider ID 与版本，无独立 routing/prompt-version 字段）+ language + analysis contract/overrides + plugin identity）→ `SurfaceRenderKey`（+ group manifest + surface policy + accepted 前驱 prose 哈希 + extractor 版本）。`getCachedRender()` 只比较这个 logical+surface 扁平键。
- **validation / attempt 键是元数据** — `SurfaceValidationKey`（+ prose 哈希 + Pass 2 model/schema + validator policy）与 `AttemptKey`（+ attempt 号 + 反馈/变更指纹）只在 fresh render 之后计算，作为 metadata 存入 `cache.meta.json`，不参与查找；`computeFlatCacheKey()`（四层汇总）没有生产调用方。任何 logical/surface material 变更都产生新键 → miss。
- **命中行为** — 命中后缓存 analysis 会重新 parse（当前 combined schema）并重新 `validateRender()`，随后仍走 release gate；损坏/过期一律作为 fresh miss（带 diagnostics），绝不返回部分命中。
- **`computeSourceContentHash()`** — project-relative YAML 字节 + scope 的严格源内容哈希；`computeEvidenceHash()` — 事件关键语义字段（eventId + 排序后的 pre/postcondition fact IDs）防篡改哈希。

### `assembler/` — 最终组装

- **`SceneCollector`** — 收集已提交的场景散文（legacy 路径）。
- **`compileDiscourseSceneSequence()`**（`state/discourse-sequence.ts`）— 场景顺序的唯一来源：由 discourse-ledger 的 `chapters[].sceneIds` 编译出 reader-order 场景序列（`NarrativeSorter` 已移除）。
- **`ProseConcatenator`** — 将场景拼接成一部完整小说（legacy 路径）。
- **`buildNovelDocument()`**（`editorial/publisher.ts`）— 生产 novel 文档构建：按 ledger scene sequence 拼接 verified heads；`EditorialPublisher.publish()` 仅在 `isCurrent`（scope 完整且零 reasons）时写 `output/novel.md`，否则保留既有 novel 字节 / `novel_hash` / `last_assembled_at` 并把 manifest 标 `stale`。
- **`assembleCanonicalNovel()` / `assembleCustomNovel()`**（`editorial/facade.ts` → `assembler/release-assembly.ts`）— CLI `nova assemble` 的 canonical / custom 组装路径（`canonicalAssemble()` / `customAssemble()`）。
- **`assembleNovel()`** — legacy 组装流水线（SceneCollector → compileDiscourseSceneSequence → ProseConcatenator）；**无生产调用方**，仅测试使用。
- **`countWords()` / `countNarrativeText()`** — 字数统计工具（`countNarrativeText` 是版本化文本计数器；`canonicalAssemble()` 报告的是剥离标题后的 `countNovelWords()` 空白计数）。

### `reporter/` — 报告写入

- **`writeValidationReport()`** — 将 L1 和 L2 问题表格及摘要写入 `output/validation.md`。

### `storage/` — 存储抽象

- **`FsStorage`** — 供 storage-aware core 模块使用的文件系统实现。
- **`MemoryStorage`** — 测试用的内存实现。
- 渲染缓存通过注入的 `Storage` 读写；不得在缓存模块直接导入或调用 Node `fs`。

## 关键技术决策

1. **TS 优先，esbuild 打包。** 类型使用 `tsc -b` 编译，JS 使用 esbuild 打包。所有源码使用 `.ts` 扩展名并启用 `allowImportingTsExtensions`。

2. **v2 双层规范缓存键。** 查找 identity 是 `sha256Canonical({ logical, surface })`（LogicalRenderKey → SurfaceRenderKey）；ValidationKey / AttemptKey 只在 fresh render 后计算并作为元数据存储，`computeFlatCacheKey()` 无生产调用方。任何 logical/surface material（source 字节、scope、contract、model、analysis contract、plugin identity、前驱 prose 等）变更都会产生新键 → miss；命中后重 parse + 重校验，损坏/过期一律 fresh miss。

3. **Pass 2 是硬性要求。** 没有正则表达式兜底。Zod 验证错误经 `analyzeValidationErrors()` / `decideRepairStrategy()` 转成结构化反馈喂回 LLM 重试（`prompt_fix` / `regenerate` 等策略，每次重试都会变更 AttemptKey）。

4. **并发池。** LLM 调用的有界并行度（默认 5）。可配置。

5. **图循环为硬错误。** `compileGraph()` 的 DFS 检测与 `buildStoryOrderIndex()` 的 Kahn 检测都会抛出环错误（`EdgeOriginCycleError` / `DagCycleError`），经 `compileStoryRuntimeGraph()` 汇总为 phase `narrative-graphs` 的 `ConfigError`；绝不按 `narrativeOrder` 降级重放。
