# 基准测试

**包：** `@novalistically/bench`，位于 `packages/bench/`
**入口：** `packages/bench/src/index.ts`
**测试框架：** `packages/bench/tests/bench.test.ts`
**运行：** `npx vitest run packages/bench/tests/bench.test.ts`

基准测试包衡量 Novalistically 的功能正确性、性能、一致性以及外部数据集兼容性。`runAll(fixturePath?)` 编排器依次运行 **回归 + 变体 + 外部数据集 + 性能** 四个基准并写盘；各基准也可单独运行（`runRegressionBench`、`runVariantBench`、`runExternalBench`、`runPerformanceBench`）。

## 1. 回归测试 — `packages/bench/src/regression.ts`

在 `fixtures/zhu-fu/` 下的 祝福（zhu-fu）测试夹具上运行 8 个阶段：

| 阶段 | 功能说明 |
|-------|-------------|
| Load entities | EntityMapper + InMemoryEntityRegistry |
| Load events | `mapper.loadAllEvents()`，包含 system:genesis |
| Build DAG | `compileStoryRuntimeGraph()` + `compileStoryBoundaries()`（取代旧的 `buildCausalEdges()` + `topologicalSort()`） |
| Replay state | 使用编译出的边界状态（`stateBeforeByEventId` / `finalState`） |
| Run validators | `ResultAggregator.validateAll()`（28 个内置验证器）— 结构/定义级别检查（L1） |
| Run post-render validators (L2) | 从 `fixtures/zhu-fu/reference/` 闭集加载参考数据（`loadApprovedReferences()`：校验 data set、provenance manifest、expected outcomes、review.json、generation-record 哈希），对每个事件运行 `aggregator.validateRender()`，并把实际 issue identity 与 approved manifest 比对（missing/unexpected 检查）。参考目录不存在时该阶段仍记为 PASS（`mark()` 正常返回，`passed: true`），仅在 detail 字符串中注明 “No reference directory found — skipping L2 validation” |
| Write validation report | `writeValidationReport(storage, projectDir, report)` 写入 `{projectDir}/output/validation.md` |
| Compile context | 对最后一个叙事事件执行 `ContextCompiler.compile()`，并断言包完整性 |

**L1 与 L2 的区别：** L1 在渲染前验证事件定义和世界状态。L2 在渲染后，对照闭集参考数据（含 Pass 2 `AnalysisResult`）验证生成的散文；参考数据缺失时 L2 阶段以 PASS 状态通过（带 skip 说明），而非标记为跳过。

## 2. 变体测试 — `packages/bench/src/variants.ts`

测试验证器管道检测注入错误的能力。操作对象为 `fixtures/zhu-fu-variants/`：

- **分支变体**（branch-A、branch-B）：加载变体夹具目录并运行 `ResultAggregator.validateAll()`
- **错误注入变体**（`error-injection/` 下 28 个 YAML 文件）：深度克隆基础事件，通过 `applyInjections()` 应用定向修改，从修改后的事件回放状态，运行验证器，检查预期的验证器是否触发
- **极端损坏变体**（`extreme-damage/` 下 5 个 YAML 文件）：与错误注入相同的管道，但采用更激进的修改

注入引擎（`applyInjections()`）支持 20 多种注入类型：storyTime 损坏、无法满足的前提条件、后置条件交换、POV 指向不存在的角色、发明细节、知识泄露、指向不存在的章节的伏笔、占位符值、时态不匹配等。

**管道 F1 值：** 根据注入结果计算（`variants.ts` 中的 `computeF1()`，覆盖 error-injection + extreme-damage 全部结果）。匹配（TP）= 预期的验证器触发了预期严重级别的 issue，未匹配（FN）= 未触发。`computeF1()` 按文件扫描 `actualIssues`（其中只含来自预期验证器的 issue）统计意外验证器——但由于 `actualIssues` 已被过滤到预期验证器，`falsePositiveCount` 实际恒为 0；`unexpectedIssues` 字段会被收集但不参与 F1 计算，不存在基线运行/扣除语义。

## 3. 性能测试 — `packages/bench/src/performance.ts`

在 N=10、N=100、N=1000 事件规模下的合成计时基准测试。使用 `makeSyntheticEvent()` 生成包含 10 个角色、10 个地点和 4 条线索的事件数组（含 `system:genesis`）。在每个规模下测量 5 个阶段：

- Run all validators（每个事件直接调用 11 个内置验证器的 `validatePre`）
- ResultAggregator（`validateAll()`）
- Calculate ISS
- Replay state（`ReplayEngine.replay()`）
- Compile context（`ContextCompiler.compile()`）

迭代次数随规模调整：N=10 时迭代 10 次，N=100 时迭代 5 次，N=1000 时迭代 3 次。结果包括 Hz、平均毫秒数和样本数量。

`performance.ts` 还提供附加基准：`runOfflineCorePathBench()`（N=100 离线核心路径，6 阶段 + 中位数/均值/p95）、`runCacheBench()`（冷/热缓存）、`runPoolEfficiencyBench()`（池大小 1/2/5/10）、`runFullOfflineBench()`（组合离线基准）。

## 4. 一致性指标 — `packages/bench/src/consistency.ts`

定义的指标函数：

- **N-CED**（`computeNCED`）：每万字的总问题数（Novalistically 一致性错误密度）
- **S-CED**（`computeSCED`）：按严重性权重（`DEFAULT_SEVERITY_WEIGHTS`：error=1.0、warning=0.3、info=0.1）加权的 CED
- **管道 F1**：`computeF1()` 位于 `variants.ts`（覆盖 error-injection + extreme-damage；匹配/遗漏计数，`falsePositiveCount` 恒为 0——见上），不在 `consistency.ts` 中
- **Spearman 秩相关系数**：`computeSpearmanRho()`，用于兼容 HANNA 的系统与人工评估
- **去衰减系数**：`computeDisattenuatedRho()` 对观察到的相关性进行测量不可靠性校正
- **按语言字数**：`computeWordCountByLanguage(prose, 'zh' | 'en')`
- **按验证器分解**：`computePerValidatorBreakdown()`（`PerValidatorBreakdown`）
- **严重性级别 CED**：`computeSeverityLevelCED()`（`SeverityLevelCED`，含 L1 和 L2 两列）

## 5. 外部数据集 — `packages/bench/src/external.ts`

位于 `packages/bench/src/adapters/` 的三个外部数据集适配器：

- **ChiNovelKE**：角色/地点/关系转换，含字段来源追踪（`convertChiNovelKE*`）
- **Novel Agent SFT**：章节/事件转换，含覆盖率报告（`convertAgentSFT*`）
- **InteractiveNovels3K**：小说到事件的转换，含字数处理统计（`convertIN3K*`）

结果报告状态（`ran | skipped | failed`）及各基准测试的指标（`ExternalBenchResult`）。

此外，`reference.ts` 提供闭集参考数据加载（`loadApprovedReferences`、`collectReferenceIssueIdentities`），`live-smoke.ts` 提供 `buildLiveSmokeRecord()`（现场冒烟记录，供 `liveSmokeRecordSchema` 校验），`annotation-stats.ts` 提供人工评估一致性指标（`agreementStats`、`quadraticWeightedKappa`、`spearmanTestRetestRho` 等）。

## 参考数据

预生成的散文与分析存放于 `fixtures/zhu-fu/reference/`：`data/`（每个事件一个 `<eventId>.json`，含 `{ prose, analysis }`）、`expected-outcomes.json`、`provenance.json`、`generation-record.json`、`review.json`。L2 阶段通过 `loadApprovedReferences()` 闭集加载这些文件（校验哈希与审批状态）并对其运行渲染后验证器。

## 输出与报告

基准测试结果以 JSON 和 Markdown 两种格式写入工作区根目录 `output/bench/`。`packages/bench/src/reporters.ts` 中的 `writeResults(results, storage?)` 使用 `FsStorage`（或传入的 `Storage`），文件名由 `results.timestamp` 规范化而来（`2026-07-31_12-34-56` 形式），返回 `{ts}` 基础路径；`toJson()` / `toMarkdown()` 分别生成 JSON 与 Markdown。Markdown 报告包括：回归阶段表格（`## Regression Benchmarks (祝福)`）、L2 验证摘要（`### L2 Post-Render Validation`）、变体基准测试（分支、错误注入（每个文件的匹配/未匹配情况）、极端损坏）、管道 F1 分数、L1/L2 问题表格、按验证器的 N-CED 表格（`### Per-Validator Error Density (L1/L2)`）、严重性级别 CED、性能基准测试与规模扩展摘要（N=10/100/1000）。

## 核心验证报告

`packages/core/src/reporter/validation-reporter.ts` 中的 `writeValidationReport(storage, projectDir, report)` 写入 `{projectDir}/output/validation.md`（详见 `reporter.md`）。

## 运行方式

```bash
# 所有基准测试
npx vitest run packages/bench/tests/bench.test.ts

# 通过 CLI
nova bench
nova bench --regression
nova bench --performance
```
