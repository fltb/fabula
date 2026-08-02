# Public API TSDoc Audit

**Last updated:** 2026-08-02（与 `docs/current-state.md` 源码核验基线同步）
**Scope:** `packages/core` 全部七个发布入口（根 `.` 与 `source`/`schema`/`extensions`/`editorial`/`tooling`/`testing` 六个 subpath）
**Authority:** `public-api.manifest.json` + `scripts/check-public-api.mjs`

> **关于数字的说明：** 早期版本把导出数与 TSDoc 覆盖率钉死为固定百分比表格，这些数字随代码演进持续漂移、无法保持可信。本文档改为给出**从当前源码可直接复现**的导出清单与按源码分节的分组描述；精确的 TSDoc 覆盖率百分比应在需要时通过运行 `npx typedoc --json … packages/core/src/index.ts` 生成，而不是固化在文档中。

## 当前导出表面（七个发布入口）

`@novalistically/core` 不再从根入口聚合导出全部类与类型。根入口 `@novalistically/core` 是**通用叙事引擎语义合同**，恰好 **10 个值导出** 与 **121 个声明类型**：

- **值导出（10）：** `compileProject`、`resolveTemporalContext`、`validateNovel`、`getProjectStatus`、`listEntities`、`showEntity`、`compareFact`、`NovalisticallyError`、`LLMError`、`sanitizeError`
- **类型导出（121）：** 源/领域类型（`ProjectConfig`、`EventFile`、`NarrativeEvent`、`Fact`、`Entity`、`BranchPath`、`TimeAnchor`、`ProjectSourceSnapshotV1`、`SourceDocumentV1` 等）、规范化编译状态（`ProjectData`、`ProjectCompilation`、`CompileProjectOptions`、`EntityLookup`、`WorldState`、`StoryBoundaries`、`EntityTypeCatalog`、`EntityDeclarationCatalog`、`EpistemicLedger`、`ThreadRuntimeState`、`ISSSnapshot`、`ContextPackage`、`TemporalContext` 等）、provider 端口（`Message`、`CompletionRequest`、`CompletionResponse`、`TaskType`、`LLMProvider`）、分析/验证端口（`AnalysisResult`、`Validator`、`PreRenderInput`、`PostRenderInput`、`ValidationIssue`、`ValidationResult`、`NovelValidationResult` 等）、语义运行时端口（`CoreRuntimeServices`、`CoreExecutionRepository`、`RenderCacheRepository`、`StateLogRepository`、`StateSnapshotRepository`、`LayeredCacheKey`、`OperationRecord` 等）、错误/查询结果（`ErrorContext`、`ProjectStatusResult`、`EntitySummary`、`EntityDetail` 等）

其余六个 scoped 入口：`@novalistically/core/source`（不可变 source identity 工具：`buildSourceSnapshot`、`compareLogicalPaths`、`computeSourceDocumentHash`、`computeSourceHash`）、`/schema`（Zod schema）、`/extensions`（插件扩展类型，仅类型）、`/editorial`（渲染/源码/审阅/修订工作流）、`/tooling`（验证聚合、上下文编译、图/ISS/缓存工具）、`/testing`（mock provider、内存仓库、`InMemoryEntityRegistry`）。`/adapters` 入口已删除——provider 与文件 adapter 归 `@novalistically/node-host`。

`scripts/check-public-api.mjs` 基于 TypeScript Compiler API 解析全部七个入口的完整导出表面（递归遍历具名导出、`export *` 与 `export type *`，并区分值导出与仅类型导出），要求每个 manifest 条目的源码导出集合与其 allowlist **精确相等**；未声明的具名导出、漏掉的通配符派生类型都会使检查失败。manifest 是**完整当前导出表面**，而不是"仅稳定子集"的声明。

### 根入口的 `compileProject` 投影

`compileProject(snapshot: ProjectSourceSnapshotV1, options?: CompileProjectOptions)` 取代已删除的 `initializeProject` 与旧 `(projectDir, storage)` 签名：输入是不可变 source snapshot（内容哈希标识，非 Git 历史），在 API 边界对返回的 `data`、事件/事实数组、catalog 与 `boundaries` 做 `structuredClone` 分离；`entities` 是只含 `resolve`/`findByKind`/`getAll` 三个方法的冻结普通对象（每次查询返回新鲜克隆），不暴露 `load`/`register`/`updateState`，也不返回 mapper、registry、stateManager 或 state。

### 适配器与扩展协议

Core 不再提供存储实现：旧的 `FsStorage`/`MemoryStorage` 与 `/adapters` 入口已删除。provider 与持久化 adapter 归 `@novalistically/node-host`（`AiSdkProvider`、`FileProjectSourceLoader`/`Writer`、`FileExecutionRepository`、`FileRenderCacheRepository`、`FileStateLogRepository`、`FileStateSnapshotRepository`、`FileMockPass2Provider`、`createFileCoreRuntimeServices`）；`@novalistically/core/testing` 只提供内存替身（`MockProvider`、`MockPass2Provider`、`InMemoryEntityRegistry`、四个 `Memory*Repository`）。验证器扩展收敛为单一协议：`Validator`（`validatePre?`/`validatePost?`/`getAnalysisRequirements?`），插件经 `ValidatorRegistrar` 注册，`ResultAggregator(validators?, entityTypeCatalog?)` 把 `createBuiltInValidators()` 与已注册验证器合并为一条调度路径；旧的 `validate`/`validateRender`/`requiresLLM` 生命周期已删除。

## 按入口分组的导出

| 入口 | stability | 内容 |
|---------|-----------|-----------|
| `.`（根） | `core` | 通用叙事引擎语义合同：10 个值 + 121 个类型（见上） |
| `./source` | `scoped` | `buildSourceSnapshot`、`compareLogicalPaths`、`computeSourceDocumentHash`、`computeSourceHash`（4 个值，无类型） |
| `./schema` | `scoped` | 33 个 Zod schema：`projectConfigSchema`、`eventFileSchema`、`entityTypeCatalogSourceSchema`、`analysisResultSchema`、`buildAnalysisResultSchema`、`projectSourceSnapshotV1Schema` 与 state/record schema |
| `./extensions` | `scoped` | 插件扩展类型（仅类型，无运行时值）：`PluginHooks`、`PluginContext`、`PluginLogger`、`PromptDecoration`、`BuildPromptInput`、`ProviderRegistry`、`ValidatorRegistrar`、`PluginManifest` |
| `./editorial` | `scoped` | 34 个值 + 35 个类型：`renderNovel`、`previewEditorialRun`、`renderGameDialogueTree`、`compileGameDialogueTree`、源码/审阅/修订 facade、版本化 DTO 与 Zod schema、`TypedEventBus`、`EditorialRuntime` |
| `./tooling` | `non-contract` | 34 个值 + 20 个类型：`ResultAggregator`、`createBuiltInValidators`、`ContextCompiler`、`ReplayEngine`、`compileStoryRuntimeGraph`、`inspectProjectGraph`/`inspectCanonicalGraphRuntime`、`calculateISS`、缓存证据（`computeEvidenceHash`/`verifyEvidenceChain`/`getCachedRender`/`setCachedRender`/`clearRenderCache` 等）、`exportDAGtoDOT`/`exportDAGtoMermaid`、`diffEvent`、`analyzeProjectImpact`、`formatValidationReport`、`ReportWriter`、记录 schema 与错误 |
| `./testing` | `non-contract` | 7 个值 + 3 个类型：`MockProvider`、`MockPass2Provider`、`InMemoryEntityRegistry`、`MemoryExecutionRepository`、`MemoryRenderCacheRepository`、`MemoryStateLogRepository`、`MemoryStateSnapshotRepository` + options 类型 |

`stability` 是语义元数据而非版本策略：`core` 标识通用叙事引擎语义合同；`scoped` 与 `non-contract` 是可导入的当前表面，但在正式版本策略建立前全部允许直接破坏更新；`non-contract` 尤其不把工具/测试符号描述为 Core 语义合同的一部分。

## TSDoc 覆盖（定性评估，非固定百分比）

精确百分比随代码演进变化，需要用 typedoc 按需生成；以下是对当前源码的定性观察：

- **根入口 API（10 值合同）：** `compileProject`、`validateNovel`、`getProjectStatus`、`listEntities`、`showEntity`、`compareFact`、`resolveTemporalContext` 均有 JSDoc 描述，是文档最完整的部分；`renderNovel`、`renderGameDialogueTree`、`previewEditorialRun` 等编辑化/工具函数已移入 `editorial`/`tooling` 入口
- **错误类（`errors.ts`）：** 文件以 `ErrorContext` 接口开头，没有文件头注释；多数错误类缺少逐类 TSDoc —— 用户最先看到的就是这些异常
- **验证器：** 各验证器文件有文件头注释；`base.ts` / `aggregator.ts` 有较多文档注释，但不少具体验证器类（如 `TimelineValidator`）缺少类级 TSDoc
- **Runtime 端口（`ports/runtime-services.ts`）：** `CoreRuntimeServices` 及其四个持久化端口（`CoreExecutionRepository` / `RenderCacheRepository` / `StateLogRepository` / `StateSnapshotRepository`）有接口级 TSDoc；实现文档密度最高的是 `node-host` 的文件仓库
- **Cache / Pipeline / Editorial：** `render-cache.ts`、`interaction-gate.ts`、`report/writer.ts` 文档注释密度较高
- **`@example` 标签：** 目前没有任何可从根入口到达的导出带 `@example` 标签；仓库中唯一的 `@example` 匹配位于非公共的 `ai/generators/schema-aware-gen.ts`

## 建议

1. **错误类优先**：为根入口的 `NovalisticallyError`/`LLMError` 与 `tooling` 入口的错误类补一行"何时抛出"的 TSDoc
2. **API 函数补 `@example`**：`compileProject`、`validateNovel` 等根入口函数是 CLI/MCP/外部消费者的主入口，应带用法示例
3. **验证器模式**：文件头注释模式已统一，可推广为每个验证器类的类级 TSDoc
4. **精确覆盖率按需生成**：不要固化百分比；需要时运行 typedoc 并作为审查制品记录

## 验证方式

```bash
# 检查清单与全部七个入口的导出表面零漂移（仓库门禁的一部分；编译器解析覆盖 `export *` 与 `export type *` 通配符）
npm run dead-code:knip

# 按需生成精确 TSDoc 覆盖率
npx typedoc --json docs/reference/typedoc.json packages/core/src/index.ts packages/core/src/source.ts packages/core/src/schema.ts packages/core/src/extensions.ts packages/core/src/editorial.ts packages/core/src/tooling.ts packages/core/src/testing.ts
```

---

*本审计覆盖 `packages/core` 全部七个发布入口的导出；根入口的 121 个类型为声明合同，各 subpath 的逐项 TSDoc 随对应入口维护。*
