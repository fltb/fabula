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
│   Event Sourcing   │  commit() → EventStore，可选 Snapshot
│  StateManager      │  ReplayEngine.replay() 通过 DAG 拓扑排序
│  (state/)          │  遇到循环时回退到 narrativeOrder
└───────┬────────────┘
        │
        ▼
┌────────────────────┐
│  ContextCompiler   │  ContextAssembler 填充 5 层优先级
│  (context/)        │  RelevanceEngine 对实体评分（role→importance）
│                    │  截断至 token 预算（默认 8000）
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
│  缓存：哈希链（所有上游的 SHA256）            │
│  并行：ConcurrencyPool（默认 5）              │
│  熔断器：错误阈值                             │
│  仅开发模式：双重运行验证                     │
└───────┬──────────────────────────────────────┘
        │
        ▼
┌────────────────────┐
│  ResultAggregator  │  运行全部 20 个验证器
│  (validator/)      │  渲染前（L1）：validatePre() → 事件定义
│                    │  渲染后（L2）：validatePost() → 散文 + 分析
│                    │  按严重程度分组：error | warning | info
└───────┬────────────┘
        │
        ▼
┌────────────────────┐
│    Assembler       │  SceneCollector → NarrativeSorter → ProseConcatenator
│  (assembler/)      │  → assembleNovel() → output/novel.md
│                    │  支持章节感知；branch filtering 仅为 runtime/API 层，当前 YAML 输入仍线性
└────────────────────┘
```

## 包结构

Monorepo 包含三个包，按以下顺序构建：`core → cli`（bench 独立但依赖 core）。

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

使用 `commander` 的 CLI 应用程序。命令：

- `nova render [projectDir]` — 运行完整渲染流水线
- `nova validate [projectDir]` — 不渲染仅验证
- `nova status [projectDir]` — 显示项目渲染状态
- `nova diff <eventId> [projectDir]` — 显示事件的状体差异
- `nova inspect <entityId> [projectDir]` — 检查实体的状态
- `nova bench [projectDir]` — 运行基准测试
- `nova mcp` — 启动 MCP 服务器用于 IDE 集成

## 核心模块映射

### `entity/` — YAML 加载与映射

- **`EntityMapper`** — 从项目目录读取 YAML 文件，通过 Zod 验证 schema，映射到内部 `NarrativeEvent`、`Entity`、`Fact`、`RuleDefinition` 类型。
- **`InMemoryEntityRegistry`** — 从 `EntityMapper` 填充的内存注册表。提供 `getAll()`、`findByKind()`、`resolve()`。
- **`compareFact()`** — 单一统一比较函数。返回 `'match' | 'mismatch' | 'deferred'`。所有验证器都使用它。

### `state/` — 事件溯源与状态管理

- **`EventStore`** — 仅追加的事件日志。`commit()` 添加事件，`getAll()` 返回所有事件，`load()` 用于初始化。
- **`ReplayEngine`** — 按 DAG 拓扑顺序重放事件以重建 `WorldState`。可按 `BranchPath` 过滤程序构造的 branch-scoped event；当前 YAML mapper 只产生 `{ type: 'all' }` scope。
- **`SnapshotEngine`** — 在 `snapshot_interval`（默认 20）处创建快照。`findNearest(n)` 用于从快照优化的重放。
- **`StateManager`** — 协调 EventStore + SnapshotEngine + ReplayEngine。
- **`buildCausalEdges()` / `topologicalSort()`** — 通过后置条件→前置条件匹配构建 DAG。导出为 DOT 和 Mermaid 格式。

### `context/` — 上下文组装与编译

- **`ContextCompiler`** — 主入口。委托给 ContextAssembler。
- **`ContextAssembler`** — 填充 5 层优先级上下文包（L1-L5），截断至 token 预算。各层：当前场景、活跃实体、近期事件、规则、世界事实。
- **`RelevanceEngine`** — 使用 8 个维度对实体进行相关性评分：在场状态、role→importance、近因性、关系、线索参与度、POV、知识重叠、规则参与度。

### `pipeline/` — 渲染流水线

- **`RenderPipeline`** — 带哈希链缓存的两阶段并行渲染。Pass 1：散文（温度 0.8）。Pass 2：分析 JSON（温度 0.3，种子 42）。Zod 错误时带反馈重试（Instructor 模式）。开发模式下可选的重复运行验证。错误阈值触发熔断。
- **`BatchRenderPipeline`** — 滑动窗口批处理渲染编排器。组合 RenderPipeline。将大型任务集分割为可配置的窗口。专为基准重写而构建。
- **`ConcurrencyPool`** — 有界并发 LLM 调用池（默认 5）。

### `validator/` — 验证系统

20 个验证器，每个实现 `Validator` 接口：

| 类别 | 验证器 |
|---|---|
| 角色刻画 | CharacterState、Alias、Pronoun、Appearance |
| 事实细节 | FactualDetail、Knowledge |
| 时间线/情节 | Timeline、Causality、Foreshadowing、ThreadProgress、Reachability、BranchMerge |
| 世界观 | WorldRule |
| 叙事风格 | POV、VoiceDrift、Pacing、TenseConsistency、DiscourseBalance、Conflict |
| 散文质量 | Quality |

关键类型：

- **`PreRenderInput`** — 渲染前验证上下文（事件、世界状态、实体注册表、事件存储）。
- **`PostRenderInput`** — 渲染后验证上下文（事件、世界状态、散文、分析 JSON）。
- **`AnalysisBlockRequirement`** — 声明验证器需要从 Pass 2 分析中获取的内容。
- **`ValidationIssue`** — 单个问题，包含严重级别、消息、修复建议、修复操作和修复目标。

**`ResultAggregator`** 运行所有验证器并收集结果。同时支持旧版（已弃用）的 `validate()` / `validateRender()` 和新版 `validatePre()` / `validatePost()` 方法。

### `ai/` — AI 提供商抽象

- **`AiSdkProvider`** — 使用 `createOpenAICompatible()` 的 Vercel AI SDK 提供商。根据 API 密钥前缀自动检测基础 URL（`ocg-` → OpenCode，`sk-` → DeepSeek）。Pass 2 使用手动 JSON 解析 + Zod 验证（结构化输出未获得普遍支持）。
- **`MockProvider`** — 用于测试的模拟 LLM。返回预写的散文。
- **`MockPass2Provider`** — 返回预写 Pass 1 散文 + Pass 2 分析 JSON 的模拟提供商。支持在无需真实 LLM 调用的情况下对渲染后验证器进行完整集成测试。
- **提示词构建器** — `prose-only.ts`、`render-analysis.ts` 分别用于 Pass 1 和 Pass 2 提示词。

### `schemas/` — Zod 模式

- 所有类型都有对应的 Zod schema 用于运行时验证。
- `analysis.ts` — 解析和验证 Pass 2 分析 JSON。同时支持错误收集模式和抛出模式。

### `cache/` — 哈希链缓存

- **`computeCacheKeys()`** — SHA256 哈希（definitions 哈希 + event_1 哈希 + ... + event_N 哈希）。任何上游变更都会使下游缓存失效。
- **`getCachedRender()` / `setCachedRender()`** — 缓存查找和存储。

### `assembler/` — 最终组装

- **`SceneCollector`** — 收集已提交的场景散文。
- **`NarrativeSorter`** — 按 `narrativeOrder` 排序。
- **`ProseConcatenator`** — 将场景拼接成一部完整小说。
- **`assembleNovel()`** — 完整组装流水线。支持章节感知，并可按已写 scene metadata 的 runtime/API branch scope 过滤；当前 authoring YAML 不产生该 scope。
- **`countWords()`** — 字数统计工具。

### `reporter/` — 报告写入

- **`writeValidationReport()`** — 将 L1 和 L2 问题表格及摘要写入 `output/validation.md`。

### `storage/` — 存储抽象

- **`FsStorage`** — 供 storage-aware core 模块使用的文件系统实现。
- **`MemoryStorage`** — 测试用的内存实现。
- 渲染缓存通过注入的 `Storage` 读写；不得在缓存模块直接导入或调用 Node `fs`。

## 关键技术决策

1. **TS 优先，esbuild 打包。** 类型使用 `tsc -b` 编译，JS 使用 esbuild 打包。所有源码使用 `.ts` 扩展名并启用 `allowImportingTsExtensions`。

2. **哈希链缓存。** 事件 N 的缓存键 = SHA256(defs 哈希 + event_1 哈希 + ... + event_N 哈希)。任何前置事件或定义的变更都会使所有下游缓存失效。

3. **Pass 2 是硬性要求。** 没有正则表达式兜底。Zod 验证错误被反馈给 LLM 进行纠正（Instructor 模式，而非盲目重试）。

4. **并发池。** LLM 调用的有界并行度（默认 5）。可配置。

5. **DAG cycle 为硬错误。** 拓扑排序检测到循环即抛出 `DagCycleError`；不会按 `narrativeOrder` 降级重放。
