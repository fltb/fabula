# API 参考 — `@novalistically/core`

**入口：** `packages/core/src/index.ts`
**类型定义：** `packages/core/src/types/`（39 个文件，通过 `types/index.ts` 桶文件重新导出）
**权威清单：** 根目录 `public-api.manifest.json`（由 `scripts/check-public-api.mjs` 校验，见下文）

## 包导出

`packages/core/src/index.ts` 导出 **178 个值导出** 与 **129 个具名类型导出**，并通过 `export type * from './types/index.js'` 重新导出类型桶中的 393 个类型导出。以下表格是主要公共 API 的摘要；完整清单以 `public-api.manifest.json` 为准。

### 核心类

| 类 | 源文件 | 用途 |
|-------|--------|---------|
| `EntityMapper` | `packages/core/src/entity/mapper.ts` | 将项目 YAML 文件加载为类型化的 `NarrativeEvent[]`、`ProjectData` |
| `InMemoryEntityRegistry` | `packages/core/src/entity/registry.ts` | 所有实体（角色、地点、物品、概念、派系、规则）的内存注册表 |
| `ReplayEngine` | `packages/core/src/state/replay.ts` | 从创世事件开始回放 `NarrativeEvent[]`，使用 DAG 拓扑排序生成 `WorldState` |
| `StateManager` | `packages/core/src/state/manager.ts` | 协调 EventStore + SnapshotEngine，负责事件提交、快照和状态查询（`getCurrentState()` / `getStateAt(position)`） |
| `ContextCompiler` | `packages/core/src/context/compiler.ts` | 编译 `ContextPackage`（场景规格、角色快照、关系、世界事实、知识边界、活跃线索、卷摘要、markdown、叙事技巧契约等） |
| `ContextAssembler` | `packages/core/src/context/assembler.ts` | 组装 `ContextPackage` 的各层内容 |
| `RelevanceEngine` | `packages/core/src/context/index.ts` | 相关性评分（`RelevanceScore`） |
| `ResultAggregator` | `packages/core/src/validator/aggregator.ts` | 运行全部 28 个内置验证器（渲染前 + 渲染后）并收集 `ValidationIssue[]` |
| `AiSdkProvider` | `packages/core/src/ai/providers/ai-sdk.ts` | 使用 Vercel AI SDK 的生产环境 LLM 提供者 |
| `MockPass2Provider` | `packages/core/src/ai/providers/mock-pass2.ts` | 测试用提供者，支持预先编写的散文 + AnalysisResult |
| `MockProvider` | `packages/core/src/ai/providers/mock.ts` | 简单测试提供者，支持固定响应 |
| `ReviewManager` | `packages/core/src/review/index.ts` | 管理已渲染场景的审阅评论 |
| `ReportWriter` | `packages/core/src/report/writer.ts` | 统一报告输出格式：Markdown（validation.md）、机器可读 JSON、MCP `StatusReport` |
| `FsStorage` | `packages/core/src/storage/fs-storage.ts` | 基于 Node.js 文件系统的 `Storage` 实现 |
| `MemoryStorage` | `packages/core/src/storage/memory-storage.ts` | 测试用的内存 `Storage` |
| `InteractionManager` | `packages/core/src/pipeline/interaction-gate.ts` | 渲染交互门控（interaction gate） |
| `TypedEventBus` | `packages/core/src/event-bus.ts` | 类型化事件总线（如 `pipeline:render:after`） |
| `AgentRegistry` | `packages/core/src/agent/index.ts` | Agent 系统注册表 |
| `PluginHooksManager` | `packages/core/src/plugin/index.ts` | 插件钩子管理（外部验证器插件） |

**内部实现（未从 `index.ts` 导出，外部不应 import）：** `RenderPipeline`（`pipeline/render.ts`）、`SceneCollector`（`assembler/collector.ts`）、`PluginLoader`（`plugin/loader.ts`）、`buildAndWriteOutputs`（`pipeline/output.ts`）、`buildAnalysisPrompt`（`ai/prompts/render-analysis.ts`）、`parseAnalysisJSONWithErrors`（`schemas/analysis.ts`）、`AnalysisContent` 类型（`validator/index.ts`，内置 Pass 2 分析块 schema 的 `z.infer`）。渲染入口请使用 `renderNovel()` / `renderGameDialogueTree()` 等 api.ts facade 函数。

### 核心类型

| 类型 | 源文件 | 描述 |
|------|--------|-------------|
| `NarrativeEvent` | `types/event.ts` | 完整的事件规格，包含前提条件、后置条件、POV、线索进展、伏笔、关系/规则效果、话语元数据 |
| `CharacterDefinition` | `types/character.ts` | 角色 YAML 定义，包含角色类型、特质、语气、背景故事、别名 |
| `RuleDefinition` | `types/rule.ts` | 世界规则（YAML，向后兼容），包含可选的 `ruleClass?`、必填的 `logicalConsequences` / `evidenceChain`、可选的 `exceptions?`。静态规则模式见 `RuleTypeDefinition`（含 `defaultConstraints`），已实施的正式语义见 `RuleSpecification`（含 `constraints`） |
| `AnalysisResult` | `types/analysis.ts` | `{ eventId, analysis: Record<string, unknown>, checklistResults?: ChecklistResult[] }` — Pass 2 输出。`analysis` 是开放 Record：内置分析块（postconditions、preconditions、pov、inventedDetails、quality、threadProgressAchieved、foreshadowingDeployed、narrativeChecks、appearanceChecks、characterReferences、tenseDetected、conflictAnalysis、ruleChecks、knowledgeChecks，以及可选的 checklistResults / durationDetected / frequencyDetected / voiceDetected / anachronyDetected / focalizationDetected）由内部 `analysisContentSchema` 校验，插件验证器可在运行时扩展字段 |
| `ValidationIssue` | `types/validator.ts` | `{ validator, severity: 'error'\|'warning'\|'info', event, entity, attribute?, message, fixSuggestion, fixAction, fixTarget }`。`fixAction` 为 9 值联合：`add_knowledge` \| `remove_line` \| `change_value` \| `add_precondition` \| `declare_flashback` \| `manual` \| `add_field` \| `create_file` \| `edit_file`；`fixTarget` 为 `{ file, field?, value? }` |
| `PostRenderInput` | `types/validator.ts` | 渲染后验证器的输入：`{ event, worldState, prose, analysis, chapter, entityRegistry?, context? }` |
| `PreRenderInput` | `types/validator.ts` | 渲染前验证器的输入：`{ event, worldState, events, entityRegistry, chapter, eventStore?, queryState, getKnowledge, getThreadProgress, story? }` |
| `WorldState` | `types/world.ts` | 当前状态：实体、关系、知识、线索、规则、事实 |
| `ContextPackage` | `types/context.ts` | 为 LLM 渲染编译的上下文包：`eventId`、`systemContext`、`sceneSpec`、`characterSnapshots`、`relationshipContext`、`worldFacts`、`knowledgeBoundary`、`activeThreads`、`volumeSummary`、`markdown`，以及可选的 `activeRules?`、`narratorProfile?`、`discourseProjection?` 和必填的 `narrativeTechniques` |
| `GameDialogueChoice` | `types/game-dialogue.ts` | EventFile-local 玩家选择：`id`、`label`、`description`、`targetEvent`、`effects` |
| `CompiledGameDialogueTree` | `branch/game-dialogue-tree.ts` | leaf paths、event scopes、representative paths、synthetic choice transitions 与 source choices |
| `Storage` / `DirEntry` / `StorageWrite` | `storage/types.ts` | 存储抽象层（见下文） |

### 核心函数

| 函数 | 源文件 | 用途 |
|----------|--------|---------|
| `compareFact(fact, stateValue)` | `entity/compare.ts` | 单一统一的事实比较函数 → `'match' \| 'mismatch' \| 'deferred'` |
| `calculateISS(options)` | `iss/score.ts` | 计算各维度的实现状态评分（Implementation Status Score），返回 `ISSSnapshot` |
| `compileGameDialogueTree(events, temporalContext)` | `branch/game-dialogue-tree.ts` | 验证 EventFile-local choices tree 并生成 `CompiledGameDialogueTree`（leaf paths / branch sets / transition events）；无 choices 返回 `null` |
| `renderGameDialogueTree(request, runtime?)` | `api.ts` | 通过编辑化渲染服务（`RenderGameDialogueTreeRequestV1`）渲染每个 event-local game-tree node 一次；所有节点 accepted 后写 `output/dialogue-tree.md`，返回 `RenderGameDialogueTreeResult` |
| `assembleGameDialogueTree(options)` | `assembler/game-dialogue-tree.ts` | 只从 fully released scene documents 组装带 choice target anchors 的 dialogue tree |
| `renderNovel(request, runtime?)` | `api.ts` | 完整 LLM 渲染管道（`EditorialRenderRequestV1` → `RenderNovelResult`）；`runtime` 可注入 `storage`、`provider`、`eventBus`、`trace`、`concurrency` |
| `previewEditorialRun(request, runtime?)` | `api.ts` | 渲染 dry-run：编译计划与提示词而不调用 LLM，返回 `PreviewResult` |
| `validateNovel(projectDir, overrides?, storage?)` | `api.ts` | 运行全部 28 个内置验证器 + ISS 计算，返回 `{ passed, results: Map<string, ValidationResult>, iss }`；`overrides` 可按验证器覆盖为 `'off' \| 'warning' \| 'error'` |
| `initializeProject(projectDir, storage)` | `api.ts` | 加载 `{ mapper, data, events, registry, stateManager, state }` —— CLI/MCP 共用的初始化序列 |
| `getProjectStatus(projectDir, validationResults?, storage?)` | `api.ts` | 项目状态汇总（事件、线程、渲染队列、阻碍因素） |
| `diffEvent(projectDir, eventId, storage?)` | `api.ts` | 显示某事件的世界状态变化（前后对比） |
| `listEntities(projectDir, kind?, storage?)` | `api.ts` | 列出实体，可按 kind 筛选 |
| `showEntity(projectDir, entityId, storage?)` | `api.ts` | 显示实体详情 |
| `analyzeProjectImpact(oldPath, newPath)` | `api.ts` | 比较两个项目目录的 YAML 事件定义，按影响等级（Red/Yellow/Green）分类变更，检测下游事件，返回 `ImpactAnalysisResult` |
| `writeValidationReport(storage, projectDir, report)` | `reporter/validation-reporter.ts` | 写入 `{projectDir}/output/validation.md`，返回输出路径（签名详见 `reporter.md`） |
| `migrateProjectFile(yamlPath, storage)` / `loadProjectConfig(yamlPath, storage)` / `readYamlFile(...)` | `entity/index.ts` | 项目配置迁移 / 加载、类型化 YAML 读取 |
| `resolveTemporalContext(events, timeAnchors)` | `entity/index.ts` | 解析时间锚点与事件时间戳，构造 `TemporalContext` |
| `exportDAGtoDOT(...)` / `exportDAGtoMermaid(...)` | `state/dag-export.ts` | 因果边 DAG 可视化导出（dot / mermaid） |

另有 `buildStoryOrderIndex`、`compileNarrativeRuntime`、`compileStoryBoundaries`、`compileStoryRuntimeGraph`、`resolveDiscourseBranch`、`isProvenBefore` 等图/话语运行时函数，以及 `TypedEventBus`、`migrateToLatest`/`CURRENT_SCHEMA_VERSION`、编辑化 facade（`adoptSceneProse`、`applySourceChange`、`assembleCanonicalNovel`、`assembleCustomNovel`、`inspectScenes`、`setSceneLock`、`rollbackSceneRevision` 等）和缓存函数（`canonicalJson`、`verifyEvidenceChain`、`computeEvidenceHash` 等），详见 `index.ts` 与 `public-api.manifest.json`。

### 存储抽象层

作为项目持久化/报告约定，常规文件系统 I/O 都通过 `Storage` 接口（`packages/core/src/storage/types.ts`）进行：`exists`、`read`、`readOptional`、`write`、`commitBatch(transaction)`、`mkdirp`、`list`、`listFiles`、`remove`、`removeAll`、`resolvePath`。`commitBatch()` 在事务锁与日志（journal）下原子校验读期望（`StorageTransaction` / `StorageWrite` / `TransactionReadExpectation`）并应用写入，崩溃可在下次调用时恢复。有两种实现：`FsStorage`（Node.js 文件系统）和 `MemoryStorage`（测试用内存存储）。

**直接 I/O 例外（不走 `Storage`）：** `MockPass2Provider.loadReferenceDir()`（`ai/providers/mock-pass2.ts`）直接用 `node:fs` 的 `existsSync` / `readdirSync` / `readFileSync` 读取参考目录中的 `<eventId>.json`；`PromptAssembler(templatePath)`（`context/prompt-assembler.ts`）在传入模板路径时直接用 `readFileSync` 读取模板。

## 推荐用法示例（公共 facade API）

```typescript
import {
  initializeProject,
  renderNovel,
  validateNovel,
  FsStorage,
} from '@novalistically/core';

const projectDir = 'my-novel';
const storage = new FsStorage();

// 1. 加载（mapper、data、events、registry、stateManager、state）
//    注意：`state` 是初始空 WorldState 占位，不是任何事件的边界状态；
//    每个事件的因果前置状态由 `compileNarrativeRuntime(...).boundaries.stateBeforeByEventId`
//    提供（`renderNovel()` / `validateNovel()` 内部已使用该边界状态，
//    facade 层无需手动逐事件编译上下文）。
const { data, events, registry } = initializeProject(projectDir, storage);

// 2. 渲染（编辑化渲染服务；LLM provider 默认按项目配置解析）
//    如需 dry-run（只编译不调用 LLM），改用 previewEditorialRun(request, runtime)
const result = await renderNovel(
  {
    version: 1,
    projectDir,
    selector: { type: 'all' }, // 或 { type: 'events', eventIds: [...] } / { type: 'chapter', chapter: 1 }
    mutation: { operationId: 'op-1', actorId: 'local-cli' },
    model: 'claude-sonnet-4-20250514',
  },
  { storage }, // 可选：{ provider, eventBus, trace, concurrency }
);

// 3. 验证 + ISS
const { passed, results: validationResults, iss } = await validateNovel(projectDir);
```

## 公开 API 清单与死代码检测

Monorepo 使用两层防御来防止意外公开内部代码和检测死代码：

### `public-api.manifest.json`

根目录下的 `public-api.manifest.json` 是每个工作区包的权威公开 API 表面。
它枚举了每个包入口的显式值导出和类型导出，以及类型桶（type barrel）文件。
任何未在此清单中声明的导出都被视为内部实现细节，不应被外部依赖。

```jsonc
// 结构示例
{
  "version": 1,
  "packages": {
    "@novalistically/core": {
      "entry": "packages/core/src/index.ts",
      "typeBarrels": ["packages/core/src/types/index.ts"],
      "values": ["EntityMapper", "ReplayEngine", "StateManager", …],
      "types": ["ErrorContext", "Storage", …]
    }
  }
}
```

### `scripts/check-public-api.mjs`

该脚本是一个离线确定性检查器，用于验证清单与实际源导出之间没有漂移。
针对每个包：

1. 验证清单中声明的每个值导出是否存在于入口源中
2. 验证清单中声明的每个类型导出是否存在于入口源中（带类型桶回退解析）
3. 标记入口源中任何未声明的具名值导出（需要添加到清单或设为内部）
4. 标记入口源中任何未声明的具名类型导出（需要添加到清单或设为内部）
5. 验证声明的类型桶文件存在且首个非空、非注释行以 `export type` 开头
6. 验证 `bin` 条目指向真实文件

**通配符桶的局限：** 第 3/4 项只覆盖入口源中显式列名的导出。`parseNamedExports()` 刻意跳过 `export type * from '...'`（仅记录类型桶存在，不收集成员名），因此类型桶中未被清单逐一声明的成员（例如 `AuthoredLocatableStoryTime`、`AuthoredStoryTime`）不会触发“未声明导出”错误。第 5 项也只检查类型桶的首个有意义行以 `export type` 开头，并不比对桶内全部成员，也不会拒绝桶中后置的值导出——`packages/core/src/types/index.ts` 中位于类型块之后的 `NARRATIVE_TECHNIQUE_KINDS` 值导出能通过检查。

此外还执行跨包检查：验证所有工作区包在清单中有条目，且清单 `version` 为受支持的版本。
任何漂移都会导致非零退出码。

### `knip.json`

根目录下的 `knip.json` 配置了 [`knip`](https://github.com/webpro/knip) 死代码检测工具。
配置为每个工作区声明 `entry` / `project` glob（core 覆盖 `src/**/*.ts`，bench/cli 以各自 `scripts`/`src` 为入口），
并保留少量针对性豁免（`ignoreIssues`：`packages/bench/src/consistency.ts` 的类型导出；`ignoreDependencies`：`tinybench`）。
对生产代码没有广泛排除。

### `dead-code:knip` 脚本

```bash
npm run dead-code:knip
```

该脚本运行 `node scripts/check-public-api.mjs`（如果清单与导出不符则失败）。
knip 本身通过 `npx knip` 按 `knip.json` 配置运行（如检测到死代码则失败），但不再串联进该 npm 脚本。
