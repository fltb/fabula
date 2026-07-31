# 报告器

**源文件：** `packages/core/src/reporter/validation-reporter.ts`（验证报告写入）、`packages/core/src/reporter/index.ts`（桶文件）、`packages/core/src/report/writer.ts`（`ReportWriter` 统一格式生成）
**基准测试报告器：** `packages/bench/src/reporters.ts`（基准测试 JSON + Markdown 输出）
**一致性指标：** `packages/bench/src/consistency.ts`（N-CED、S-CED、Spearman rho、去衰减系数等）＋ `packages/bench/src/variants.ts`（管道 F1，私有 `computeF1()`）

## 验证报告格式

`packages/core/src/reporter/validation-reporter.ts` 中的 `writeValidationReport(storage, projectDir, report): string` 在 `{projectDir}/output/validation.md` 写入报告并返回输出路径。签名：第一个参数是 `Storage` 实例（如 `new FsStorage()`），第二个是项目目录，第三个是 `ValidationReport`：

```typescript
interface ValidationReport {
  projectName: string;
  generatedAt: string;
  l1Issues: ValidationIssue[]; // pre-render issues
  l2Issues: ValidationIssue[]; // post-render issues
}
```

实现将 `ValidationReport` 包装为 `PipelineRunResult` 并委托给 `packages/core/src/report/writer.ts` 中的 `ReportWriter`。Markdown 结构：

### 1. 标题与摘要

```
# Validation Report — {projectName}
**Generated:** {generatedAt}
✅ **All validations passed.**  /  ❌ **Validation failed — issues found.**

## Summary
| Layer | Errors | Warnings | Infos | Total |
|-------|--------|----------|-------|-------|
| L1 (Pre-render) | N | N | N | N |
| L2 (Post-render) | N | N | N | N |
```

L1 问题来自 `ResultAggregator.validateAll()` 对事件定义和世界状态运行的结构性/定义性检查。L2 问题来自渲染后验证器对已渲染散文和 Pass 2 `AnalysisResult` 的运行结果，通过 `aggregator.validateRender()` 执行。

### 2. L1 问题表格

```
## L1 Issues (Pre-Render Validation)
| # | Validator | Severity | Event | Entity | Attribute | Message |
```

每一行对应一个 `ValidationIssue`，包含字段：`validator`（例如 `timeline`、`causality`、`character_state`）、`severity`（`🔴 error` / `🟡 warning` / `🔵 info`）、`event`（事件 ID）、`entity`（实体 ID）、`attribute`（截断至 40 字符）和 `message`（截断至 120 字符）。问题按严重性（error → warning → info）再按验证器名排序。

### 3. L2 问题表格

```
## L2 Issues (Post-Render Validation with Pass 2)
```

格式与 L1 相同，行号从 `l1Issues.length + 1` 继续，涵盖通过 Pass 2 分析检测到的渲染后问题。

当有渲染结果、next actions 或管道错误时，报告还会追加 `## Render Summary`（事件数、已渲染、缓存命中、渲染错误、总耗时）、`## Next Steps`（优先级/类别/行动/目标文件）与 `## Pipeline Errors` 小节。`ReportWriter` 同时提供 `toJSON()`（机器可读结构，含 validation/iss/render/threads/blockers/nextActions/guidance）和 `toStatusReport()`（MCP `StatusReport`）。

**输出路径：** `{projectDir}/output/validation.md`

## 基准测试报告格式

`packages/bench/src/reporters.ts` 中的 `writeResults(results: BenchResults, storage?: Storage): string` 使用 `FsStorage`（或传入的 `Storage`）将 JSON 和 Markdown 分别写入工作区根目录 `output/bench/{ts}.json` 和 `output/bench/{ts}.md`，返回 `{ts}` 基础路径。`{ts}` 由 `results.timestamp` 规范化而来（冒号/点替换为 `-`、`T` 替换为 `_`、去掉 `Z`），形如 `2026-07-31_12-34-56`。

### Markdown 报告章节

- **`## Regression Benchmarks (祝福)`：** 8 个阶段的表格，包含 PASS/FAIL 状态、耗时（ms）和详情
- **`### L2 Post-Render Validation`：** 状态、耗时和详情
- **`## Variant Benchmarks`：** 分支变体表格、每个文件的错误注入结果（匹配/未匹配预期的验证器）、极端损坏结果、管道 F1 分数（精确率、召回率、F1、匹配/遗漏/误报计数）
- **`### L1 Issues (Pre-Render Validation)` / `### L2 Issues (Post-Render Validation with Pass 2)`：** 问题表格
- **`### Per-Validator Error Density (L1/L2)`：** 每个验证器的完整分解，包含每万字的 N-CED
- **`### Severity-Level CED`：** 按严重性（error、warning、info）划分的 L1 和 L2 CED
- **`## Performance Benchmarks`：** 每个阶段的 Hz、平均值（ms）、样本数和规模
- **`### Scaling Summary`：** N=10、N=100、N=1000 时平均耗时并排对比

### JSON 报告结构（`BenchResults`）

```typescript
interface BenchResults {
  timestamp: string;
  regression: Array<{ stage: string; passed: boolean; ms: number; detail: string }>;
  performance: BenchMeasurement[]; // { name, hz, meanMs, samples, scale }
  l2Stats?: { passed: boolean; ms: number; detail: string };
  l1Issues: ValidationIssue[];
  l2Issues: ValidationIssue[];
  variants?: {
    branchA: { eventsLoaded: number; issues: ValidationIssue[] };
    branchB: { eventsLoaded: number; issues: ValidationIssue[] };
    errorInjection: Array<{
      file: string; description: string; expectedValidator: string;
      expectedSeverity: string; matched: boolean; actualIssueCount: number;
    }>;
    extremeDamage: /* 同 errorInjection */ [];
  };
  pipelineF1?: {
    precision: number; recall: number; f1: number;
    matchedCount: number; missedCount: number; falsePositiveCount: number;
  };
  l1PerValidator: PerValidatorBreakdown[];
  l2PerValidator: PerValidatorBreakdown[];
  severityCED: SeverityLevelCED[];
}
```

### 输出位置

| 报告 | 路径 |
|--------|------|
| 核心验证报告 | `{projectDir}/output/validation.md` |
| 基准测试 JSON | `output/bench/{ts}.json` |
| 基准测试 Markdown | `output/bench/{ts}.md` |

根据仓库约定，所有输出产物都写入项目根目录（验证报告）或工作区根目录（基准测试）下的 `output/` 目录。
