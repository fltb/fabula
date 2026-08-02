# 架构

## 高层数据流

Core 只消费不可变的 `ProjectSourceSnapshotV1` 与注入的语义端口；它不读取项目目录、不写
`.nova`，也不知道 Git、SQLite、凭据或浏览器传输。Node Host 和 Workbench Host 分别在
边界外实现这些能力。

```
作者 YAML / 已授权场景采纳
        │
        ▼
Node Host: FileProjectSourceLoader ───────► ProjectSourceSnapshotV1
        │                                           │
        │                                    Core: 映射、图编译、
        │                                    回放、上下文、渲染、
        │                                    验证、组装计算
        │                                           │
        ▼                                           ▼
CLI / Bench                              注入的 execution/cache/report 端口

Workbench Host
  ├─ Local Auth + ProjectSession + browser read surface
  ├─ Yjs：在线工作层；不是已接受 source
  ├─ SQLite worker：会话、能力、工作层与提交 journal
  └─ Host-only Git：受控 AuthoringManifest、固定 ref CAS、恢复 journal
        │
        ▼
Workbench Browser：仅消费版本化、无秘密的 contracts DTO；
不推断项目、图、路由或 authoring source。
```

Git authoring 是 Workbench Host 的可注入边界，而非 Core 版本历史。Git bootstrap/submit
测试直接构造 Host Git 服务；Host 启动时是否暴露某个 surface 取决于显式注入的配置，未配置
时保持 fail-closed。Yjs 更新只有在 Host 验证并提交后才会产生新的已接受 source。

Core 的渲染路径仍为：snapshot → `EntityMapper` → 因果图与事件重放 →
`ContextCompiler` → Pass 1 prose → Pass 2 analysis → validators → assembly 计算。Pass 2
不可用是硬错误；确定性事实由 `compareFact()` 比较，语义提示由 Pass 2 analysis 消费。

## 包结构

Monorepo 有五个包，依赖方向是单向的：
`core → node-host → {bench, cli, workbench}`。`core` 不依赖任何 workspace 包；
`bench`、`cli` 和 Workbench Host 可使用 Node Host 适配器。Workbench 浏览器客户端只依赖
自身的 browser-safe contracts 类型，不导入 Core/Node/Host 实现。

### `@novalistically/core`（`packages/core/`）

纯叙事引擎：source snapshot 分析、实体映射、图编译、状态重放、上下文、渲染编排、验证和
组装计算。入口包含 root、`/source`、`/schema`、`/editorial`、`/tooling`、`/testing`；
没有 `/adapters` 或文件系统持久化入口。

### `@novalistically/node-host`（`packages/node-host/`）

Node 运行时适配器：文件 source loader/writer、execution/state/cache repositories、报告、
插件与 AI provider。它是 CLI 和 Bench 的文件系统边界；其独立测试套件禁止网络访问。

### `@novalistically/bench`（`packages/bench/`）

基准、回归、变体与性能套件。它通过 Core 与 Node Host 运行版本化 fixture；Bench 不能成为
Core 的依赖。

### `@novalistically/cli`（`packages/cli/`）

`commander` CLI 与 MCP 入口。CLI 在 Host 边界加载项目 source 并向 Core 注入运行时服务；
它不把文件路径或 Git 行为带回 Core。

### `@novalistically/workbench`（`packages/workbench/`）

浏览器优先的本机 Host 与 Solid client。Host 持有本地认证、Yjs gateway、SQLite worker、
provider credential boundary、ProjectSession，以及受控 Git authoring 服务。客户端拥有本地
布局偏好，只读取认证后的 Host projection；Yjs working layer 和已接受 source 必须明确区分。
Host 与 client 分别类型检查、构建和测试；浏览器 E2E 单独运行。

## 核心模块映射

### `entity/` — snapshot 映射

- **`EntityMapper`** — 消费 `ProjectSourceSnapshotV1` 中的逻辑文档与解析结果，通过 Zod 验证并映射为 `NarrativeEvent`、`Entity`、`Fact`、`RuleDefinition`。读取目录和生成 snapshot 是 Host adapter 的职责。
- **`InMemoryEntityRegistry`** — 从 mapper 的项目数据填充的内存注册表。提供 `getAll()`、`findByKind()`、`resolve()`。
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
- **`buildNovelDocument()`**（`assembler/publication-model.ts`）— 将 verified scene heads 与 discourse scene sequence 组织成可验证的小说文档数据；Core 不直接写 `output/novel.md`。
- **`assembleCanonicalNovel()` / `assembleCustomNovel()`**（`editorial/facade.ts` → `assembler/release-assembly.ts`）— canonical / custom 组装计算通过 semantic execution port 读取已接受的 scene revision；产物持久化由 Host adapter 决定。
- **`assembleNovel()`** — legacy 组装流水线（SceneCollector → compileDiscourseSceneSequence → ProseConcatenator）；**无生产调用方**，仅测试使用。
- **`countNarrativeText()`** — 版本化文本计数器；`countWords()` 别名已移除。

### `reporter/` — 报告写入

- **`writeValidationReport()`** — 将 L1 和 L2 问题表格及摘要写入 `output/validation.md`。

### `source/` 与持久化边界

- **Core source** — `ProjectSourceSnapshotV1`、source analysis 与变更预览都是值对象/纯计算；Core 不含 `FsStorage`、`MemoryStorage`、项目路径或 Git history。
- **Node Host** — 文件 source、execution/state/cache/report adapters 都在 `@novalistically/node-host`，通过 Core ports 注入。
- **Workbench Host** — SQLite、认证、Yjs working documents 与 Host-only Git authoring 也通过边界服务持有。`AuthoringManifest` 只允许显式 authoring entries；`.nova/**`、cache、response、journal、output 和 derived 内容不能进入作者提交。

## 关键技术决策

1. **TS 优先，esbuild 打包。** 类型使用 `tsc -b` 编译，JS 使用 esbuild 打包。所有源码使用 `.ts` 扩展名并启用 `allowImportingTsExtensions`。

2. **v2 双层规范缓存键。** 查找 identity 是 `sha256Canonical({ logical, surface })`（LogicalRenderKey → SurfaceRenderKey）；ValidationKey / AttemptKey 只在 fresh render 后计算并作为元数据存储，`computeFlatCacheKey()` 无生产调用方。任何 logical/surface material（source 字节、scope、contract、model、analysis contract、plugin identity、前驱 prose 等）变更都会产生新键 → miss；命中后重 parse + 重校验，损坏/过期一律 fresh miss。

3. **Pass 2 是硬性要求。** 没有正则表达式兜底。Zod 验证错误经 `analyzeValidationErrors()` / `decideRepairStrategy()` 转成结构化反馈喂回 LLM 重试（`prompt_fix` / `regenerate` 等策略，每次重试都会变更 AttemptKey）。

4. **并发池。** LLM 调用的有界并行度（默认 5）。可配置。

5. **图循环为硬错误。** `compileGraph()` 的 DFS 检测与 `buildStoryOrderIndex()` 的 Kahn 检测都会抛出环错误（`EdgeOriginCycleError` / `DagCycleError`），经 `compileStoryRuntimeGraph()` 汇总为 phase `narrative-graphs` 的 `ConfigError`；绝不按 `narrativeOrder` 降级重放。
