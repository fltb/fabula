# API 参考 — `@novalistically/core`

**入口：** `packages/core` 的七个发布入口：根 `.`（通用叙事引擎语义合同）+ `source`/`schema`/`extensions`/`editorial`/`tooling`/`testing` 六个 subpath
**类型定义：** `packages/core/src/types/`（39 个文件，通过 `types/index.ts` 桶文件重新导出）
**权威清单：** 根目录 `public-api.manifest.json`（由 `npm run check:public-api` 校验，2026-08-06 全绿）。六个工作区包全部登记（含 `@novalistically/workbench-protocol`），manifest 即当前已验证的导出权威。

## 包导出

`@novalistically/core` 有 **7 个发布入口**：根入口是通用叙事引擎语义合同，另有六个 scoped subpath（`/source`、`/schema`、`/extensions`、`/editorial`、`/tooling`、`/testing`）。以下表格是主要公共 API 的摘要；**精确导出数量以 `public-api.manifest.json` 为准**（2026-08-06 `check:public-api` 全绿，manifest 与源码导出表面逐符号一致）。

### 入口一览

| 入口 | stability | 内容 |
|------|-----------|------|
| `@novalistically/core` | `core` | 通用叙事引擎语义合同：根入口值/类型计数见 manifest（2026-08-06 `check:public-api` 全绿，manifest 即权威） |
| `@novalistically/core/source` | `scoped` | 不可变 source identity 工具：`buildSourceSnapshot`、`compareLogicalPaths`、`computeSourceDocumentHash`、`computeSourceHash` |
| `@novalistically/core/schema` | `scoped` | Zod schema 33 个：`projectConfigSchema`、`eventFileSchema`、`entityTypeCatalogSourceSchema`、`analysisResultSchema`、`buildAnalysisResultSchema`、`projectSourceSnapshotV1Schema` 与 state/record schema |
| `@novalistically/core/extensions` | `scoped` | 插件扩展类型（仅类型，无运行时值）：`PluginHooks`、`PluginContext`、`PluginLogger`、`PromptDecoration`、`BuildPromptInput`、`ProviderRegistry`、`ValidatorRegistrar`、`PluginManifest` |
| `@novalistically/core/editorial` | `scoped` | 渲染/源码/审阅/修订 facade、版本化 DTO 与 Zod schema、`TypedEventBus`：34 个值 + 35 个类型 |
| `@novalistically/core/tooling` | `non-contract` | `ResultAggregator`、`createBuiltInValidators`、`ContextCompiler`、`ReplayEngine`、`compileStoryRuntimeGraph`、`inspectProjectGraph`、`calculateISS`、缓存/图导出、`diffEvent`、`analyzeProjectImpact`、`formatValidationReport`、`ReportWriter`、记录 schema 与错误：34 个值 + 20 个类型 |
| `@novalistically/core/testing` | `non-contract` | `MockProvider`、`MockPass2Provider`、`InMemoryEntityRegistry`、四个 `Memory*Repository` + options 类型：7 个值 + 3 个类型 |

`stability` 是语义元数据而非版本策略：`core` 标识通用叙事引擎语义合同；`scoped` 与 `non-contract` 是可导入的当前表面，**不提供兼容性保证**。Core 不再提供存储实现；provider 与持久化 adapter 归 `@novalistically/node-host`（生产）与 `@novalistically/core/testing`（内存替身）所有。

### 核心类

| 类 | 源文件 | 用途 | 当前入口 |
|-------|--------|---------|-----------|
| `EntityMapper` | `packages/core/src/entity/mapper.ts` | 将 source snapshot 文档加载为类型化的 `NarrativeEvent[]`、`ProjectData` | 不公开（`compileProject` 内部使用） |
| `InMemoryEntityRegistry` | `packages/core/src/entity/registry.ts` | 所有实体（角色、地点、物品、概念、派系、规则）的内存注册表 | `testing` |
| `ReplayEngine` | `packages/core/src/state/replay.ts` | 从创世事件开始回放 `NarrativeEvent[]`，使用 DAG 拓扑排序生成 `WorldState` | `tooling` |
| `StateManager` | `packages/core/src/state/manager.ts` | 协调 EventStore + SnapshotEngine，负责事件提交、快照和状态查询（`getCurrentState()` / `getStateAt(position)`）。当前这两个查询仍经 `ReplayEngine` 重放，不能宣传为已接入的快照恢复加速 | 不公开 |
| `ContextCompiler` | `packages/core/src/context/compiler.ts` | 编译 `ContextPackage`（场景规格、角色快照、关系、世界事实、知识边界、活跃线索、卷摘要、markdown、叙事技巧契约等） | `tooling` |
| `ContextAssembler` | `packages/core/src/context/assembler.ts` | 组装 `ContextPackage` 的各层内容 | 不公开 |
| `RelevanceEngine` | `packages/core/src/context/relevance.ts` | 相关性评分（`RelevanceScore`） | 不公开 |
| `ResultAggregator` | `packages/core/src/validator/aggregator.ts` | 运行验证器集合：未提供自定义数组时用 `createBuiltInValidators()`，提供时该数组**替换**默认集（不自动合并）；需要内置 + 插件的调用方必须显式组合 `[...createBuiltInValidators(), ...plugins]`，收集 `ValidationIssue[]` | `tooling` |
| `ReportWriter` | `packages/core/src/report/writer.ts` | 统一报告输出格式：Markdown（`toMarkdown()`）、机器可读 JSON（`toJSON()`）、`StatusReport`（`toStatusReport()`，含面向 LLM 代理的 `guidance`）、bench 报告。**接线现状（2026-08-06）**：MCP `nova_status` 经 `buildWorkflowStatus()` 返回完整 `WorkflowStatusV1`（guidance/nextActions/ISS 在内），Node Host `FileProjectStatusReporter` 派生 `PROJECT_STATUS.md`；report writer 的 `toStatusReport()` 仍属 tooling，不被 nova_status 调用 | `tooling` |
| `InteractionManager` | `packages/core/src/pipeline/interaction-gate.ts` | 交互门控管理器：`needsApproval()` / `recordWaiver()` / `getPendingGates()`；**release 策略路径已接线**：`executeEditorialRender` 把预授 waivers 种入 `waiverManager` 并作为第四参传入 `evaluateReleaseDecision`（`require-waiver` 策略下 warning 候选保持 `pending_waiver` 直到 gate 决议），`resolveReleaseGate` 同样用它记录豁免 | 不公开 |
| `TypedEventBus` | `packages/core/src/event-bus.ts` | 类型化事件总线（如 `pipeline:render:after`） | `editorial` |
| `AgentRegistry` | `packages/core/src/agent/registry.ts` | Agent 系统注册表 | 不公开 |
| `PluginHooksManager` | `packages/core/src/plugin/hooks-manager.ts` | 插件钩子管理（外部验证器插件）；production 由 Node Host `activateNodePlugins` 构造（受信任本机插件，manifest/index.js hash 身份）并注入渲染管线与验证路径，插件身份（manifest/module hash）进入 validationIdentity 与 cache key | 不公开（`@novalistically/node-host` 的 `activateNodePlugins` 是其唯一 production 构造方） |
| `MockProvider` | `packages/core/src/ai/providers/mock.ts` | 简单测试提供者，支持固定响应 | `testing` |
| `MockPass2Provider` | `packages/core/src/ai/providers/mock-pass2.ts` | 测试用提供者，按 `entries`（eventId → 散文 + AnalysisResult）返回预写响应 | `testing` |
| `MemoryExecutionRepository` / `MemoryRenderCacheRepository` / `MemoryStateLogRepository` / `MemoryStateSnapshotRepository` | `packages/core/src/testing/memory-repositories.ts` | `CoreRuntimeServices` 四个持久化端口的内存实现 | `testing` |
| `AiSdkProvider` | `packages/node-host/src/providers/ai-sdk.ts` | 使用 Vercel AI SDK 的生产环境 LLM 提供者（默认 OpenAI-compatible base URL，可由运行时配置或环境覆盖） | `@novalistically/node-host` |
| `FileProjectSourceLoader` / `FileProjectSourceWriter` | `packages/node-host/src/source/` | 从项目目录加载不可变 `ProjectSourceSnapshotV1`；以 source-hash CAS 写入 `SourceChangeV1` | `@novalistically/node-host` |
| `FileExecutionRepository` / `FileRenderCacheRepository` / `FileStateLogRepository` / `FileStateSnapshotRepository` | `packages/node-host/src/` | Core 语义端口在项目目录上的文件实现 | `@novalistically/node-host` |
| `FileMockPass2Provider` | `packages/node-host/src/providers/file-mock-pass2.ts` | 磁盘版 mock provider：`loadReferenceEntries(referenceDir)` 读 `<eventId>.json` 构造 `MockPass2Entry` | `@novalistically/node-host` |
| `createFileCoreRuntimeServices` | `packages/node-host/src/runtime.ts` | 组装项目私有 `CoreRuntimeServices`（文件仓库 + provider + clock/ids）；不读凭据或环境变量 | `@novalistically/node-host` |
| `buildWorkflowStatus` | `packages/core/src/status/workflow-status.ts` | 从 accepted 层派生单一 `WorkflowStatusV1` 合同（`nova_status` 与 `PROJECT_STATUS.md` 共用），含 guidance/nextActions/ISS | `.`（根） |
| `FileProjectStatusReporter` / `writeFileProjectStatus` / `formatProjectStatus` | `packages/node-host/src/reports/` | 项目根写派生 `PROJECT_STATUS.md`（`WorkflowStatusV1` 的降级容错物化）；`degradedFlag` 保证不因 reporter 故障阻塞 status | `@novalistically/node-host` |
| `FilePublicationWriter` | `packages/node-host/src/publication/` | 写 `output/novel.md`（`PUBLICATION_OUTPUT_DIRECTORY`）与 `hashPublicationMarkdown`；publication 字节的单一物化方 | `@novalistically/node-host` |
| `activateNodePlugins` / `shutdownNodePlugins` | `packages/node-host/src/plugins/activate.ts` | 受信任本机插件激活：manifest + index.js 的 SHA-256 身份校验（不匹配即 `PluginIdentityMismatchError`），构造 hooks manager 并注入 Core runtime | `@novalistically/node-host` |
| `createDeterministicMockProvider` | `packages/node-host/src/providers/deterministic-mock.ts` | Pass-2-aware 确定性 mock provider（无网络、可复现）；launch 与 parity/e2e 证据均用它 | `@novalistically/node-host` |
| `createWorkbenchAgentModelAdapter` | `packages/node-host/src/agent/workbench-agent-model.ts` | 内置 Agent 的 AI SDK tool-calling 模型缝（`WorkbenchAgentModelPort`，含 `supportsToolCalls` 能力门字段） | `@novalistically/node-host` |
| `PluginExtensionSchemaRegistrar` | `packages/core/src/plugin/extension-registrar.ts` | EventFile `extensions` 命名空间的启用门：未知/禁用插件 namespace = source error，声明 schema 时校验 payload | `.`（根） |
| `assembleRelease` / `resolveReleaseGate` | `packages/core/src/assembler/release-assembly.ts` / `editorial/release-gate.ts` | `assembleRelease` 是唯一 production assembly caller（Workbench `ProjectPublicationService`）；`resolveReleaseGate` 重跑唯一 release evaluator 决议 gate（零 provider 调用）；`computeReleaseGateId` 是 gate 身份的 sha256 | `@novalistically/core/editorial` |

**内部实现（未从任何发布入口导出，外部不应 import）：** `RenderPipeline`（`pipeline/render.ts`）、`PluginLoader`（`plugin/loader.ts`）、`buildAndWriteOutputs`（`pipeline/output.ts`）、`buildAnalysisPrompt`（`ai/prompts/render-analysis.ts`）、`parseAnalysisJSONWithErrors`（`schemas/analysis.ts`）、`AnalysisContent` 类型（`validator/index.ts`，内置 Pass 2 分析块 schema 的 `z.infer`）、`CompiledGameDialogueTree` 类型（`branch/game-dialogue-tree.ts`，`compileGameDialogueTree` 的返回类型，未从发布入口重新导出）。渲染入口请使用 `renderNovel()` / `renderGameDialogueTree()` 等 editorial facade 函数。

### 核心类型

| 类型 | 源文件 | 描述 |
|------|--------|-------------|
| `NarrativeEvent` | `types/event.ts` | 完整的事件规格，包含前提条件、后置条件、POV、线索进展、伏笔、关系/规则效果、话语元数据 |
| `CharacterDefinition` | `types/character.ts` | 角色 YAML 定义，包含角色类型、特质、语气、背景故事、别名 |
| `RuleTypeDefinition` / `RuleDeclaration` / `RuleRuntimeState` | `types/rule.ts` | 规则类型目录、作者声明与已 materialize 的运行时规则状态；声明以 `typeId`、初始 epoch/specification、activation/effectiveness、scope bindings、exceptions 和 specifications 表达，事件使用 canonical `RuleTransaction`。 |
| `AnalysisResult` | `types/analysis.ts` | `{ eventId, protocol, observations, analysis }` — Pass 2 输出。`protocol` 是 `ValidationKey`（精确测量协议：prose、schema、model、prompts、sampling、validator/reference 策略）；`observations` 为每个活跃顶层分析字段记录一个 disposition（`produced` / `abstained` / `ambiguous`），`produced` 要求 `analysis[field]` 有规范 payload，`abstained`/`ambiguous` 要求缺席；`analysis` 是开放 Record，内置分析块由 `analysisContentSchema` 校验，插件验证器可在运行时扩展字段。Pass 2 无 regex fallback；反馈尝试耗尽时场景记录错误并进入 review/release 决策路径 |
| `ValidationIssue` | `types/validator.ts` | `{ validator, severity: 'error'\|'warning'\|'info', kind, event, entity, attribute?, message, fixSuggestion, fixAction, fixTarget, observationRef? }`。`kind` 为 4 值联合 `ValidationIssueKind`：`compiler_invariant` \| `evidence_mismatch` \| `interpretive_assessment` \| `analysis_uncertainty`；`fixAction` 为 9 值联合：`add_knowledge` \| `remove_line` \| `change_value` \| `add_precondition` \| `declare_flashback` \| `manual` \| `add_field` \| `create_file` \| `edit_file`；`fixTarget` 为 `{ file, field?, value? }`；`observationRef?` 引用其消费的 Pass 2 observation（`{ field, analysisPointer? }`，RFC 6901 指针），`compiler_invariant` 永不携带 |
| `PostRenderInput` | `types/validator.ts` | 渲染后验证器的输入：`{ event, worldState, prose, analysis, chapter, entities?, entityTypeCatalog?, context? }` |
| `PreRenderInput` | `types/validator.ts` | 渲染前验证器的输入：`{ event, worldState, events, entities: EntityLookup, chapter, queryState, getKnowledge, getThreadProgress, story?, entityTypeCatalog? }` |
| `WorldState` | `types/world.ts` | 当前状态：实体、关系、知识、线索、规则、事实 |
| `ContextPackage` | `types/context.ts` | 为 LLM 渲染编译的上下文包：`eventId`、`systemContext`、`sceneSpec`、`characterSnapshots`、`relationshipContext`、`worldFacts`、`knowledgeBoundary`、`activeThreads`、`volumeSummary`、`markdown`，以及可选的 `activeRules?`、`narratorProfile?`、`discourseProjection?` 和必填的 `narrativeTechniques` |
| `GameDialogueChoice` | `types/game-dialogue.ts` | EventFile-local 玩家选择：`id`、`label`、`description`、`targetEvent`、`effects` |
| `ProjectSourceSnapshotV1` | `contracts/source.ts` | 不可变 source snapshot：按 `logicalPath` 排序的 `documents`（`SourceDocumentV1`：content + `contentHash` + parse result + diagnostics）+ 内容哈希 `sourceHash`。source hash 表示内容身份，不是 Git 历史；Core 的所有项目入口都以它为输入 |
| `CoreRuntimeServices` | `ports/runtime-services.ts` | 注入的语义运行时端口：`execution`、`renderCache`、`stateLog`、`stateSnapshots`、`promptTemplates`、`clock`、`ids`、`llm`（见「持久化与运行时服务边界」） |

**验证器扩展协议（单一协议）：** 扩展通过 `Validator` 接口（`validatePre?` / `validatePost?` / `getAnalysisRequirements?`）实现；插件经 `ValidatorRegistrar.register()` 注册为扩展，但注册本身不会进入 `ResultAggregator` —— `ResultAggregator(validators?, entityTypeCatalog?)` 在提供自定义数组时把它作为唯一验证器集（替换 `createBuiltInValidators()` 默认），需要内置 + 插件的调用方必须显式传入 `[...createBuiltInValidators(), ...plugins]`。旧的 `validate` / `validateRender` / `requiresLLM` 生命周期已删除，不存在第二套验证器协议。

### 核心函数

| 函数 | 源文件 | 用途 | 当前入口 |
|----------|--------|---------|-----------|
| `compareFact(fact, stateValue)` | `entity/compare.ts` | 单一统一的事实比较函数 → `'match' \| 'mismatch' \| 'deferred'` | `.`（根） |
| `calculateISS(options)` | `iss/score.ts` | 计算各维度的实现状态评分（Implementation Status Score），返回 `ISSSnapshot` | `tooling` |
| `compileGameDialogueTree(events, temporalContext)` | `branch/game-dialogue-tree.ts` | 验证 EventFile-local choices tree 并生成 `CompiledGameDialogueTree`（leaf paths / event scopes / representative paths / transition events）；无 choices 返回 `null` | `editorial` |
| `renderGameDialogueTree(request, runtime?)` | `api.ts` | 通过编辑化渲染服务（`RenderGameDialogueTreeRequestV1`）渲染每个 event-local game-tree node 一次；返回 `RenderGameDialogueTreeResult`（compiled tree、逐 scene 结果与 publication） | `editorial` |
| `renderNovel(request, runtime?)` | `api.ts` | 完整 LLM 渲染管道（`EditorialRenderRequestV1` → `RenderNovelResult`）；`runtime` 是 `EditorialRuntime`，可注入 `services`、`provider`、`providerFactory`、`signal`、`eventBus`、`trace`、`concurrency` | `editorial` |
| `previewEditorialRun(request, runtime?)` | `api.ts` | 渲染 dry-run：编译计划与提示词而不调用 LLM（request 为去掉 `mutation` 的 `EditorialRenderRequestV1`），返回 `PreviewResult` | `editorial` |
| `validateNovel(snapshot, overrides?)` | `api.ts` | 对 `ProjectSourceSnapshotV1` 运行根验证管道（`ResultAggregator` 显式传入 `createBuiltInValidators()`；插件验证器不自动包含，需调用方自行组合）+ ISS 计算，返回 `NovelValidationResult`（`{ passed, results: ReadonlyMap<string, ValidationResult>, iss }`）；`overrides` 可按验证器覆盖为 `'off' \| 'warning' \| 'error'` | `.`（根） |
| `compileProject(snapshot, options?)` | `api.ts` | 编译 source snapshot 并返回**分离快照** `ProjectCompilation`（`data`、`events`/`runtimeEvents`、`initialFacts`、`entityTypes`、`entityDeclarations`、`entities`、`boundaries`）。API 边界 `structuredClone` 分离；`entities` 是只含 `resolve`/`findByKind`/`getAll` 的冻结 `EntityLookup`，不暴露 `load`/`register`/`updateState`。取代已删除的 `initializeProject` 与旧 `(projectDir, storage)` 签名，不再返回 mapper/registry/stateManager/state | `.`（根） |
| `getProjectStatus(snapshot, validationResults?)` | `api.ts` | 项目状态汇总（事件、线程、渲染队列、阻碍因素） | `.`（根） |
| `diffEvent(snapshot, eventId)` | `api.ts` | 显示某事件的世界状态变化（前后对比），返回 `DiffResult \| null` | `tooling` |
| `listEntities(snapshot, kind?)` | `api.ts` | 列出实体，可按 kind 筛选，返回 `EntitySummary[]` | `.`（根） |
| `showEntity(snapshot, entityId)` | `api.ts` | 显示实体详情，返回 `EntityDetail \| null` | `.`（根） |
| `analyzeProjectImpact(oldSnapshot, newSnapshot)` | `api.ts` | 比较两个 source snapshot 的事件定义，按影响等级（Red/Yellow/Green）分类变更，检测下游事件，返回 `ImpactAnalysisResult` | `tooling` |
| `formatValidationReport(report)` | `reporter/validation-reporter.ts` | 将 `ValidationReport` 格式化为统一 Markdown 报告字符串（`ReportWriter.toMarkdown()` 的薄封装）；文件写入由 Node Host 的 `writeFileValidationReport` 负责 | `tooling` |
| `loadProjectConfig(snapshot)` / `readYamlFile({ logicalPath, schema, snapshot, … })` | `entity/yaml-loader.ts` | 从 source snapshot 读取并校验一个 YAML 文档 / 加载 `nova.yaml`。旧的 `migrateProjectFile` 与路径式签名已删除 | 不公开（`compileProject` 内部使用） |
| `resolveTemporalContext(events, timeAnchors)` | `entity/timestamp.ts` | 解析时间锚点与事件时间戳，构造 `TemporalContext` | `.`（根） |
| `exportDAGtoDOT(...)` / `exportDAGtoMermaid(...)` | `state/dag-export.ts` | 因果边 DAG 可视化导出（dot / mermaid） | `tooling` |
| `getCachedRender` / `setCachedRender` / `clearRenderCache` / `clearEventCache` / `computeEvidenceHash` / `verifyEvidenceChain` / `computeFlatCacheKey` / `buildLogicalKeyMaterial` 等 | `cache/render-cache.ts` | 分层缓存键、证据链校验与缓存读写 | `tooling` |
图/话语运行时函数（`compileStoryRuntimeGraph`、`inspectProjectGraph`、`inspectCanonicalGraphRuntime`）属 `tooling`；编辑化 facade（`getSourceDocument`、`listSourceDocuments`、`previewSourceChange`、`getEditorialOperation`、`getSceneRevision`、`addReviewComment`、`listReviewComments`、`replaceReviewComment`、`updateReviewComment`、`assembleRelease`、`resolveReleaseGate`）属 `editorial`。`assembleRelease` 的生产 caller 是 Workbench `ProjectPublicationService`（输出经 Node Host `FilePublicationWriter` 物化为 `output/novel.md`）；`resolveReleaseGate` 由 Workbench review service 在 `nova_release_gate_decide` 时调用。以下符号已从当前实现移除，不得出现在任何使用指南中：`assembleGameDialogueTree`、`adoptSceneProse`、`applySourceChange`、`assembleCanonicalNovel`、`inspectScenes`、`setSceneLock`、`rollbackSceneRevision`、`migrateProjectFile`、core 侧 `writeValidationReport`。完整清单见 `public-api.manifest.json`。

### 持久化与运行时服务边界

Core 的持久化语义通过注入端口表达，不直接触碰文件系统。`EditorialRuntime.services` 是 `CoreRuntimeServices`（`packages/core/src/ports/runtime-services.ts`）：`execution`（`CoreExecutionRepository`）、`renderCache`（`RenderCacheRepository`）、`stateLog` / `stateSnapshots`（`StateLogRepository` / `StateSnapshotRepository`）、`promptTemplates`（`PromptTemplateCatalog`）、`clock`、`ids`、`llm`。这些端口属于根合同，但实现全部归 Host：`@novalistically/node-host` 提供项目目录上的文件实现（`FileExecutionRepository`、`FileRenderCacheRepository`、`FileStateLogRepository`、`FileStateSnapshotRepository`、`createFileCoreRuntimeServices`、`FileProjectSourceLoader` / `FileProjectSourceWriter`、`FileMockPass2Provider`），`@novalistically/core/testing` 提供内存实现（`MemoryExecutionRepository`、`MemoryRenderCacheRepository`、`MemoryStateLogRepository`、`MemoryStateSnapshotRepository`）。旧的 `Storage` 抽象（`FsStorage` / `MemoryStorage`）与 `@novalistically/core/adapters` 入口已删除，不再出现在任何发布表面。

**直接 I/O 例外：** Core 本身不读文件。参考目录的磁盘读取发生在 Node Host 的 `loadReferenceEntries()`（`packages/node-host/src/providers/file-mock-pass2.ts`，用 `node:fs` 读 `<eventId>.json` 构造 `MockPass2Entry`）；`PromptAssembler(templateText?)`（`context/prompt-assembler.ts`）接收模板**文本**而非路径，模板的解析与读取由调用方经 `PromptTemplateCatalog` 完成。

## 推荐用法示例（公共 facade API）

```typescript
import {
  compileProject,
  validateNovel,
  getProjectStatus,
} from '@novalistically/core';
import { renderNovel } from '@novalistically/core/editorial';
import {
  createFileCoreRuntimeServices,
  FileProjectSourceLoader,
} from '@novalistically/node-host';

const projectDir = 'my-novel';
// 不可变 source snapshot：documents 按 logicalPath 排序 + 内容哈希 sourceHash。
// 目录加载在 Node Host（FileProjectSourceLoader.load）；
// 测试可用 @novalistically/core/source 的 buildSourceSnapshot(documents) 构造。
const snapshot = new FileProjectSourceLoader().load(projectDir);

// 1. 编译（分离快照：data、events、entities、boundaries …）
//    compileProject 在 API 边界对返回数据做 structuredClone 分离；
//    entities 是只含 resolve/findByKind/getAll 的冻结 EntityLookup，
//    不返回 mapper/registry/stateManager/state。
const compilation = compileProject(snapshot, { branchPath: { decisions: [] } });
const { data, events, entities, boundaries } = compilation;
const first = entities.getAll()[0];       // 每次返回新鲜克隆
const byKind = entities.findByKind('character');

// 2. 渲染（编辑化渲染服务；LLM provider 经 EditorialRuntime 注入）
//    如需 dry-run（只编译不调用 LLM），改用 previewEditorialRun(request, runtime)
const runtime = {
  services: createFileCoreRuntimeServices(projectDir, { provider }),
};
const result = await renderNovel(
  {
    version: 1,
    source: snapshot,
    selector: { type: 'all' }, // 或 { type: 'events', eventIds: [...] } / { type: 'chapter', chapter: 1 }
    mutation: { operationId: 'op-1', actorId: 'local-cli' },
    model: 'claude-sonnet-4-20250514',
  },
  runtime, // EditorialRuntime：可选 { services, provider, providerFactory, signal, eventBus, trace, concurrency }
);

// 3. 验证 + ISS（对同一 snapshot）
const { passed, results: validationResults, iss } = await validateNovel(snapshot);
const status = getProjectStatus(snapshot, validationResults);
```

## 公开 API 清单与死代码检测

Monorepo 使用两层防御来防止意外公开内部代码和检测死代码。2026-08-06 门禁实测：`npm test`（根 3,197 / Host 716 / Client 156）、`typecheck`、`typecheck:dead-code`、`typecheck:e2e`、`build`、`bundle-check`、`lint`、`check:public-api` 全绿；`npm run test:e2e` 23/23（workbench Playwright：harness self-test 1、host-http 5、mcp-chain 3、browser 3、concurrency-recovery 5、plugin-snapshot 6）。

### `public-api.manifest.json`

根目录下的 `public-api.manifest.json` 声明每个工作区包的公开 API 表面——这是**规范意图**（每个包应公开的导出集合），不是当前已验证的导出清单。它按入口枚举：每个包有 `entries` 对象，键为入口路径（`.` 根入口与各 subpath），每个条目声明源路径、dist 路径、`stability`（`core`/`scoped`/`non-contract`）、值导出与类型导出。manifest 声明完整表面（不是"仅稳定子集"）；任何未在此清单中声明的导出都被视为内部实现细节，不应被外部依赖。`stability` 是语义元数据而非版本策略：`core` 标识通用叙事引擎语义合同，`scoped`/`non-contract` 是可导入的当前表面但不提供兼容性保证。

**2026-08-06 起校验器全绿（已验证）**：六个工作区包全部登记（`.packages` 含 bench/cli/core/node-host/workbench/workbench-protocol），manifest 与源码导出表面逐符号一致，是当前权威清单。漂移会在 `check:public-api` 以非零退出码暴露。

```jsonc
// 结构示例
{
  "version": 1,
  "packages": {
    "@novalistically/core": {
      "entries": {
        ".": {
          "source": "packages/core/src/index.ts",
          "dist": "packages/core/dist/index.js",
          "stability": "core",
          "values": ["compileProject", "validateNovel", "resolveTemporalContext", …],
          "types": ["ProjectConfig", "EntityLookup", "Validator", …]
        },
        "./schema": {
          "source": "packages/core/src/schema.ts",
          "dist": "packages/core/dist/schema.js",
          "stability": "scoped",
          "values": ["projectConfigSchema", "analysisResultSchema", …],
          "types": []
        }
      }
    }
  }
}
```

### `scripts/check-public-api.mjs`

该脚本是一个离线确定性检查器，用于验证清单与实际源导出之间没有漂移。
它使用 TypeScript Compiler API 按仓库 `tsconfig` 的模块解析设置解析每个入口源，递归遍历具名导出、`export *` 与 `export type *`，并保留每个重导出是值导出还是仅类型导出。针对每个 manifest 条目：

1. 要求条目的源码值集合与源码类型集合**精确等于**其 allowlist（`values`/`types`）
2. 拒绝未声明的具名符号、漏掉的通配符派生类型、缺失的声明、不存在的源码入口，以及没有 `stability` 的条目
3. 不再存在 `typeBarrels` 或桶回退解析——类型桶不是列出桶成员的替代品，每个被导出的名称必须逐一列入清单
4. 验证 `bin` 条目指向真实文件（包级字段）

**通配符已纳入检查：** `export *` / `export type *` 的所有成员都会被编译器解析收集并与清单逐项比对，未列出的成员（例如 `AuthoredLocatableStoryTime`，曾漏网后已从清单移除）会使检查失败。
此外还执行跨包检查：验证所有工作区包在清单中有条目，且清单 `version` 为受支持的版本。
任何漂移都会导致非零退出码。

### `knip.json`

根目录下的 `knip.json` 配置了 [`knip`](https://github.com/webpro/knip) 死代码检测工具。
配置为每个工作区声明 `entry` / `project` glob（core 覆盖 `src/**/*.ts`，bench/cli 以各自 `scripts`/`src` 为入口），
并保留少量针对性豁免（`ignoreIssues`：`packages/bench/src/consistency.ts` 的类型导出；`ignoreDependencies`：`tinybench`）。
对生产代码没有广泛排除。

### `check:public-api` 脚本

```bash
npm run check:public-api
```

该脚本**只**运行 public API checker：`node scripts/check-public-api.mjs`（清单与导出不符则非零退出）。
它**不运行 knip CLI**——`knip.json` 只是死代码检测的配置，当前仓库没有任何 npm script 执行 knip（`npx knip` 只能手动运行）。2026-08-06 实测该脚本为绿：六个包全部登记，manifest 与导出表面一致。

## MCP 工具目录与 CLI 命令（Workbench / CLI 表面）

MCP 工具目录的权威是 `@novalistically/workbench-protocol` 的 `MCP_TOOL_CATALOG_V1`（`packages/workbench-protocol/src/mcp.ts`），当前 **72 个工具**；Workbench Host 的 `createProjectSessionMcpRegistry` / `createAdminMcpRegistry` 与目录双向一致（`mcp-catalog-parity.test.ts`，`KNOWN_ORPHAN_TOOLS = []`）。本交付补齐/新增的工具（名 + scope）：

| 工具 | scope | 说明 |
|---|---|---|
| `nova_graph` / `nova_event_state_diff` | `mcp:read` | 严格路由 selector 的图投影 / 事件前后状态 diff（`nova_event_state_diff` 经 `CanonicalStateProjectionService` 派生流读取，含全量重放 fallback） |
| `nova_revise` / `nova_render_tree` | `mcp:render` | 与 `nova_render` 共享 render 输入解析，走两阶段 detached lane（queued → operationHandle） |
| `nova_authoring_validate` | `mcp:author` | working-layer 验证（与 accepted 层的 `nova_validate` 语义分离） |
| `nova_operation_get` / `nova_operation_cancel` | `mcp:submit` | 持久 operation 队列的查询/取消 |
| `nova_review_list` / `nova_review_get` | `mcp:read` | append-only review stream 投影 |
| `nova_review_add` / `nova_review_update` | `mcp:author` | review 写入 |
| `nova_release_gate_list` | `mcp:read` | gate 列表 |
| `nova_release_gate_decide` | `mcp:submit` | 决议 gate（Core `resolveReleaseGate`，零 provider 调用） |
| `nova_publish` | `mcp:submit` | 入队 publish operation（kind `publish`） |
| `nova_publication_get` / `nova_publication_read` | `mcp:read` | 按 id 读 publication 记录 / 有界完整性校验的 markdown 分片读取 |

CLI（`@novalistically/cli`，typed Workbench MCP client）命令组：`source validate --working` / `source submit`、`operation get|wait|cancel`、`authoring conflict|resolve`、`event-diff`、`review list|add|update|history|revise`、`gate list|decide`、`publish`、`publication status|read`。via-workbench 操作只走项目 scoped 的 authenticated Host route；standalone 写入受 Host authority lease 保护。

相关文档：详细命令与 MCP server 见 [`reference/cli.md`](./cli.md)。
