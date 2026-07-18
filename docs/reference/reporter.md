# 报告器

**源文件：** `packages/core/src/reporter/validation-reporter.ts`（验证报告写入）、`packages/core/src/reporter/index.ts`（桶文件）  
**基准测试报告器：** `packages/bench/src/reporters.ts`（基准测试 JSON + Markdown 输出）  
**一致性指标：** `packages/bench/src/consistency.ts`（N-CED、S-CED、管道 F1、Spearman rho）

## 验证报告格式

`packages/core/src/reporter/validation-reporter.ts` 中的 `writeValidationReport(projectDir, report)` 在项目根目录写入 `output/validation.md`。报告包含三个部分：

### 1. 摘要表格

```
| 层级 | 错误 | 警告 | 信息 | 总计 |
|-------|--------|----------|-------|-------|
| L1（渲染前） | N | N | N | N |
| L2（渲染后） | N | N | N | N |
```

L1 问题来自 `ResultAggregator.validateAll()` 对事件定义和世界状态运行的结构性/定义性检查。L2 问题来自渲染后验证器对已渲染散文和 Pass 2 `AnalysisResult` 的运行结果，通过 `aggregator.validateRender()` 执行。

### 2. L1 问题表格

```
| # | 验证器 | 严重性 | 事件 | 实体 | 属性 | 消息 |
```

每一行对应一个 `ValidationIssue`，包含字段：`validator`（例如 `timeline`、`causality`、`character_state`）、`severity`（`🔴 error` / `🟡 warning` / `🔵 info`）、`event`（事件 ID）、`entity`（实体 ID）、`attribute`（截断至 40 字符）和 `message`（截断至 120 字符）。

### 3. L2 问题表格

格式与 L1 相同，涵盖通过 Pass 2 分析检测到的渲染后问题。

**输出路径：** `{projectDir}/output/validation.md`

## 基准测试报告格式

`packages/bench/src/reporters.ts` 中的 `writeResults(results, storage?)` 将 JSON 和 Markdown 分别写入 `output/bench/{timestamp}.json` 和 `output/bench/{timestamp}.md`。

### Markdown 报告章节

- **回归基准测试（祝福）：** 8 个阶段的表格，包含 PASS/FAIL 状态、耗时（ms）和详情
- **L2 渲染后验证：** 状态、耗时和详情，包括错误/警告/信息计数
- **变体基准测试：** 分支变体表格、每个文件的错误注入结果（匹配/未匹配预期的验证器）、极端损坏结果、管道 F1 分数（精确率、召回率、F1、匹配/遗漏/误报计数）
- **L1 问题表格：** 每个验证器的完整分解，包含每万字的 N-CED
- **L2 问题表格：** 渲染后问题的相同格式
- **严重性级别 CED：** 按严重性（error、warning、info）划分的 L1 和 L2 CED
- **性能基准测试：** 每个阶段的 Hz、平均值（ms）、样本数和规模
- **规模扩展摘要：** N=10、N=100、N=1000 时平均耗时并排对比

### JSON 报告结构（`BenchResults`）

```typescript
interface BenchResults {
  timestamp: string;
  regression: Array<{ stage, passed, ms, detail }>;
  performance: BenchMeasurement[];
  l2Stats?: { passed, ms, detail };
  l1Issues: ValidationIssue[];
  l2Issues: ValidationIssue[];
  variants?: { branchA, branchB, errorInjection, extremeDamage };
  pipelineF1?: { precision, recall, f1, matchedCount, missedCount, falsePositiveCount };
  l1PerValidator: PerValidatorBreakdown[];
  l2PerValidator: PerValidatorBreakdown[];
  severityCED: SeverityLevelCED[];
}
```

### 输出位置

| 报告 | 路径 |
|--------|------|
| 核心验证报告 | `{projectDir}/output/validation.md` |
| 基准测试 JSON | `output/bench/{timestamp}.json` |
| 基准测试 Markdown | `output/bench/{timestamp}.md` |

根据 PROJECT.md 的约定，所有输出产物都写入项目根目录（验证报告）或工作区根目录（基准测试）下的 `output/` 目录。
