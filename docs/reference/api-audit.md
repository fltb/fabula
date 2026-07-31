# Public API TSDoc Audit

**Last updated:** 2026-07-31
**Scope:** `packages/core/src/index.ts` — all named exports
**Authority:** `public-api.manifest.json` + `scripts/check-public-api.mjs`

> **关于数字的说明：** 早期版本把导出数与 TSDoc 覆盖率钉死为固定百分比表格，这些数字随代码演进持续漂移、无法保持可信。本文档改为给出**从当前源码可直接复现**的导出清单与按源码分节的分组描述；精确的 TSDoc 覆盖率百分比应在需要时通过运行 `npx typedoc --json … packages/core/src/index.ts` 生成，而不是固化在文档中。

## 当前导出表面（从 `packages/core/src/index.ts` 解析）

- **值导出：178 个**（类、函数、常量、Zod schema）
- **具名类型导出：129 个**
- **`export type * from './types/index.js'`：** 重新导出 `packages/core/src/types/` 下的 393 个类型导出（角色、事件、世界状态、知识、关系、话语、图、编辑化 DTO 等），这些类型由类型桶自身负责，不在本文档逐一列举

`scripts/check-public-api.mjs` 保证清单中显式列出的导出与实际源导出零漂移；任何未声明的具名导出都会使该检查失败。该保证不覆盖 `export type *` 通配符桶的成员：脚本跳过通配符重导出，只把声明的类型桶文件作为回退解析（manifest 未列出的桶成员如 `AuthoredLocatableStoryTime`、`AuthoredStoryTime` 仍会通过），且只校验桶文件存在且首个非空、非注释行以 `export type` 开头。

## 按源码分节的导出分组

分组跟随 `packages/core/src/index.ts` 中的分节注释（顺序即源码顺序）：

| 分节 | 代表性导出 |
|---------|-----------|
| Agent System | `AgentRegistry` + `Agent` / `AgentConfig` / `AgentPacket` / `AgentRole` |
| AI | `AiSdkProvider`、`LLMError`、`MockPass2Provider`、`MockProvider` + provider/input 类型（`LLMProvider`、`CompletionRequest`、`RenderAnalysisInput` 等） |
| Assembler | `assembleGameDialogueTree`、`countNarrativeText`、`countWords` + `AssembleOptions` / `AssembleResult` / `AssembleGameDialogueTreeOptions` 等 |
| Batch | `BatchConfig` / `BatchProgressEvent` / `BatchResult` / `BatchStats`（纯类型） |
| Branch | `compileGameDialogueTree`、`branchPathsEqual` + `CompiledGameDialogueTree` |
| Cache | `canonicalJson`、`computeEvidenceHash`、`verifyEvidenceChain`、`buildAttemptKeyMaterial` 等 13 个函数 + `CacheDiagnostics` / `VerifyChainResult` |
| Context | `ContextAssembler`、`ContextCompiler`、`RelevanceEngine` + `RelevanceContext` |
| Editorial | 编辑化 facade/存储/发布：`adoptSceneProse`、`applySourceChange`、`assembleCanonicalNovel`、`assembleCustomNovel`、`inspectScenes`、`setSceneLock`、`rollbackSceneRevision`、`SourceWorkspace`、`OperationStore`、`EditorialPublisher`、`preflightSelector` 等 + 编译/校验输入类型 |
| Editorial Review | `addReviewComment` / `listReviewComments` / `replaceReviewComment` / `updateReviewComment` |
| Entity | `EntityMapper`、`InMemoryEntityRegistry`、`compareFact`、`resolveTemporalContext`、`migrateProjectFile`、`loadProjectConfig`、`readYamlFile` + `CompareOutcome` / `ProjectData` / `TemporalContext` |
| Errors | `NovalisticallyError`、`ConfigError`、`StorageError`、`DagCycleError`、`PipelineError`、`ValidationError` 等 18 个错误类 + `sanitizeError` + `ErrorContext` |
| Event bus | `TypedEventBus` + `EventMap` |
| ISS | `calculateISS` |
| Migration | `migrateToLatest`、`CURRENT_SCHEMA_VERSION` + `MigrationFn` |
| Observability | `LogContext` / `LogEntry` / `LogLevel` / `LogTransport`（纯类型） |
| Pipeline | `InteractionManager` + `RenderJob` / `RenderSceneResult` / `RenderPipelineOptions` / `InteractionGate` 等 |
| Plugin | `PluginHooksManager` + `PluginValidator` / `PluginHooks` / `ConflictReport` 等 |
| Report | `ReportWriter` + `BenchReport` / `PipelineRunResult` |
| Reporter | `writeValidationReport` + `ValidationReport` |
| Review | `ReviewManager` + `CommentFilter` / `StatusSummary` |
| Schemas | `analysisResultSchema`、`expectedOutcomeManifestSchema`、`provenanceManifestSchema`、`responseReferenceSchema`、`liveSmokeRecordSchema` |
| Editorial schemas | `branchPathV1Schema`、`sceneSelectorSchema`、`editorialRenderRequestV1Schema`、`sourceChangePreviewV1Schema` 等 19 个 Zod schema（另 4 个 review schemas 在下一行单独列出，合计 23 个） |
| Review schemas | `reviewCommentSchema`、`reviewLedgerV1Schema` 等 |
| State | `ReplayEngine`、`StateManager`、`compileNarrativeRuntime`、`compileStoryRuntimeGraph`、`buildStoryOrderIndex`、`exportDAGtoDOT`/`exportDAGtoMermaid`、`resolveDiscourseBranch` 等 13 个函数/类 + 图/话语类型 |
| Storage | `FsStorage`、`MemoryStorage` + `Storage` / `DirEntry` / `StorageWrite` |
| Summary | `LogicalDisclosureSummaryCompiler`、`SurfaceReferenceExtractor`、`VolumeSummaryCompiler` + `VolumeSummaryOptions` |
| Editorial types | `types/editorial.ts` 的 DTO 类型（`EditorialRenderRequestV1`、`RenderNovelResult`、`SceneSelector`、`PublicationResult` 等） |
| Types barrel | `export type * from './types/index.js'`（全部领域类型） |
| Validator | 25 个验证器类 + `ResultAggregator`（共 26 个值导出）。`ResultAggregator` 默认注册 **28 个内置验证器**（含 `QualityValidator`、`ThreadProgressValidator`、`ChecklistValidator`、`NarrativeTechniqueValidator` 等） |
| API | `renderNovel`、`renderGameDialogueTree`、`previewEditorialRun`、`validateNovel`、`initializeProject`、`getProjectStatus`、`diffEvent`、`listEntities`、`showEntity`、`analyzeProjectImpact` + `DiffResult` / `ImpactAnalysisResult` / `ImpactLevel` / `ProjectStatusResult` |

## TSDoc 覆盖（定性评估，非固定百分比）

精确百分比随代码演进变化，需要用 typedoc 按需生成；以下是对当前源码的定性观察：

- **API facade（`api.ts`）：** `renderNovel`、`renderGameDialogueTree`、`previewEditorialRun`、`validateNovel`、`getProjectStatus`、`diffEvent`、`listEntities`、`showEntity`、`analyzeProjectImpact`、`initializeProject` 均有 JSDoc 描述，是文档最完整的部分
- **错误类（`errors.ts`）：** 文件以 `ErrorContext` 接口开头，没有文件头注释；多数错误类缺少逐类 TSDoc —— 用户最先看到的就是这些异常
- **验证器：** 各验证器文件有文件头注释；`base.ts` / `aggregator.ts` 有较多文档注释，但不少具体验证器类（如 `TimelineValidator`）缺少类级 TSDoc
- **Storage（`storage/types.ts`）：** `Storage` 接口每个方法都有 TSDoc（含事务 `commitBatch`、`resolvePath` 语义）
- **Cache / Pipeline / Editorial：** `render-cache.ts`、`interaction-gate.ts`、`report/writer.ts` 文档注释密度较高
- **`@example` 标签：** 目前没有任何可从 `packages/core/src/index.ts` 到达的导出带 `@example` 标签；`InteractionManager` 只有一段未加标签的“Typical usage”段落。仓库中唯一的 `@example` 匹配位于非公共的 `ai/generators/schema-aware-gen.ts`

## 建议

1. **错误类优先**：为全部 18 个错误类补一行"何时抛出"的 TSDoc
2. **API 函数补 `@example`**：`renderNovel`、`validateNovel`、`initializeProject` 等是 CLI/MCP/外部消费者的主入口，应带用法示例
3. **验证器模式**：文件头注释模式已统一，可推广为每个验证器类的类级 TSDoc
4. **精确覆盖率按需生成**：不要固化百分比；需要时运行 typedoc 并作为审查制品记录

## 验证方式

```bash
# 检查清单与具名导出零漂移（仓库门禁的一部分；`export type *` 桶成员不在其列）
npm run dead-code:knip

# 按需生成精确 TSDoc 覆盖率
npx typedoc --json docs/reference/typedoc.json packages/core/src/index.ts
```

---

*本审计覆盖 `packages/core/src/index.ts` 的全部具名导出；`export type *` 类型桶的逐类型 TSDoc 由类型桶自身的文档覆盖。*
