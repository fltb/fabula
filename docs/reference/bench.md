# 基准测试

**包：** `@novalistically/bench`，位于 `packages/bench/`
**入口：** `packages/bench/src/index.ts`
**测试框架：** `packages/bench/tests/bench.test.ts`
**运行：** `npm run bench`（root，经 `@novalistically/bench` 的 vitest 脚本跑 `packages/bench/tests`）或 `npx vitest run packages/bench/tests/bench.test.ts`

基准测试包衡量 Novalistically 的功能正确性、性能、一致性以及外部数据集兼容性。`runAll(fixturePath?)` 编排器依次运行 **回归 + 变体 + 外部数据集 + 性能** 四个基准并写盘；各基准也可单独运行（`runRegressionBench`、`runVariantBench`、`runExternalBench`、`runPerformanceBench`）。

## 1. 回归测试 — `packages/bench/src/regression.ts`

在 `fixtures/zhu-fu/` 下的 祝福（zhu-fu）测试夹具上运行 8 个阶段：

| 阶段 | 功能说明 |
|-------|-------------|
| Load entities | `compileProject(new FileProjectSourceLoader().load(p))`（canonical kernel：entity registry + 边界 + 事件） |
| Load events | 作者事件随 kernel load 到达（`project.events`，全部为 `E*.yaml` 事件，不含 `system:genesis`） |
| Build DAG | 排序与边界随 kernel load 到达（`boundaries.orderedEventIds` / `stateBeforeByEventId` / `finalState`），不再单独调用 `compileStoryRuntimeGraph()` / `compileStoryBoundaries()` |
| Replay state | 使用编译出的边界状态（`stateBeforeByEventId` / `finalState`），detail 报告实体/事实/线程计数 |
| Run validators | `ResultAggregator.validateAll()`（默认 28 个内置验证器）— 结构/定义级别检查（L1） |
| Run post-render validators (L2) | 从 `fixtures/zhu-fu/reference/` 闭集加载参考数据（`loadApprovedReferences()`：数据集合必须恰好为 E0–E6、校验 provenance manifest、expected outcomes、review.json、generation-record 哈希与审批状态），对每个参考事件运行 `aggregator.validatePost(prose, event, stateBefore, analysis)`，并把实际 issue identity 与 approved manifest 比对（missing/unexpected 检查）。参考目录不存在时该阶段仍记为 PASS（`mark()` 正常返回，`passed: true`），仅在 detail 字符串中注明 “No reference directory found — skipping L2 validation” |
| Write validation report | 用 `new ReportWriter(runResult).toMarkdown()` 生成 Markdown 并直接写入 `{projectDir}/output/validation.md`（bench 自己负责落盘，不再调用 Core 的写入函数） |
| Compile context | 对最后一个叙事事件执行 `ContextCompiler.compile()`，并断言包完整性 |

**L1 与 L2 的区别：** L1 在渲染前验证事件定义和世界状态。L2 在渲染后，对照闭集参考数据（含 Pass 2 `AnalysisResult`）验证生成的散文（`aggregator.validatePost()`）；参考数据缺失时 L2 阶段以 PASS 状态通过（带 skip 说明），而非标记为跳过。

## 2. 变体测试 — `packages/bench/src/variants.ts`

测试验证器管道检测注入错误的能力。操作对象为 `fixtures/zhu-fu-variants/`：

- **分支变体**（branch-A、branch-B）：加载变体夹具目录并运行 `ResultAggregator.validateAll()`
- **错误注入变体**（`error-injection/` 下 28 个 YAML 文件）：深度克隆基础事件，通过 `applyInjections()` 应用定向修改，然后沿用基础编译的 canonical 边界运行验证器（`buildSyntheticStateBoundaries()` 仅对注入 dead-state 前提的事件做合成修正，不再对修改后的事件重新回放），检查预期的验证器是否触发
- **极端损坏变体**（`extreme-damage/` 下 5 个 YAML 文件）：与错误注入相同的管道，但采用更激进的修改

注入引擎（`applyInjections()`）支持 20 多种注入类型：storyTime 损坏、无法满足的前提条件、后置条件交换、POV 指向不存在的角色、发明细节、知识泄露、指向不存在的章节的伏笔、占位符值、时态不匹配等。

**管道 F1 值：** 根据注入结果计算（`variants.ts` 中的 `computeF1()`，覆盖 error-injection + extreme-damage 全部结果）。匹配（TP）= 预期的验证器触发了预期严重级别的 issue，未匹配（FN）= 未触发。`computeF1()` 按文件扫描 `actualIssues`（其中只含来自预期验证器的 issue）统计意外验证器——但由于 `actualIssues` 已被过滤到预期验证器，`falsePositiveCount` 实际恒为 0；`unexpectedIssues` 字段会被收集但不参与 F1 计算，不存在基线运行/扣除语义。

## 3. 性能测试 — `packages/bench/src/performance.ts`

在 N=10、N=100、N=1000 事件规模下的合成计时基准测试。使用 `makeSyntheticEvent()` 生成事件数组：10 个角色（CHARACTERS）、10 个地点（LOCATIONS）和 4 条线索（THREADS），事件 id 为 `E1..E1000`；**不生成 `system:genesis` 事件**（源码注释明确 “no genesis event”）。在每个规模下测量 5 个阶段：

- Run all validators（每个事件直接调用 11 个内置验证器的 `validatePre`：timeline、character_state、knowledge、world_rule、causality、foreshadowing、pov、factual_detail、voice_drift、branch_merge、reachability）
- ResultAggregator（`validateAll()`）
- Calculate ISS
- Replay state（`ReplayEngine.replay()`）
- Compile context（`ContextCompiler.compile()`）

迭代次数在所有规模下统一为 10 次（`const iters = 10`），每次计时前另有 3 次 warmup。结果包括 Hz、平均毫秒数和样本数量。

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

结果报告状态（`pending | ran | skipped | failed`）及各基准测试的指标（`ExternalBenchResult`）。

此外，`reference.ts` 提供闭集参考数据加载（`loadApprovedReferences`、`collectReferenceIssueIdentities`），`live-smoke.ts` 提供 `buildLiveSmokeRecord()`（现场冒烟记录，供 `liveSmokeRecordSchema` 校验），`annotation-stats.ts` 提供人工评估一致性指标（`agreementStats`、`quadraticWeightedKappa`、`spearmanTestRetestRho` 等）。

## 参考数据

预生成的散文与分析存放于 `fixtures/zhu-fu/reference/`：`data/`（恰好 E0–E6 七个 `<eventId>.json`，含 `{ prose, analysis, metadata }`）、`expected-outcomes.json`、`provenance.json`、`generation-record.json`、`review.json`。L2 阶段通过 `loadApprovedReferences()` 闭集加载这些文件——校验数据集合恰好为 E0–E6、responsesSha256、provenance/expected-outcomes/generation-record 哈希与 review 审批状态——并对其运行渲染后验证器（`aggregator.validatePost()`）。

### Reference evidence boundary

`reference/data` is a deterministic mock/generated regression input, not a human annotation set or live-provider claim. `npm run smoke:stage1:live` is credential-gated, cold-copies the fixture, and writes only a timestamped `.nova/smoke-candidates/` candidate. It never overwrites approved reference data. A candidate becomes live evidence only after the record/provenance gates pass and a human records approval; absent such a record, benchmark results must be described as mock-reference regression evidence.

## 输出与报告

基准测试结果以 JSON 和 Markdown 两种格式写入工作区根目录 `output/bench/`。`packages/bench/src/reporters.ts` 中的 `writeResults(results: BenchResults): string` 不接受 storage 参数，`RESULTS_DIR` 硬编码为工作区根目录下的 `output/bench/`；文件名由 `results.timestamp` 规范化而来（`2026-07-31_12-34-56` 形式），返回 `{ts}` 基础路径；`toJson()` / `toMarkdown()` 分别生成 JSON 与 Markdown。Markdown 报告包括：回归阶段表格（`## Regression Benchmarks (祝福)`）、L2 验证摘要（`### L2 Post-Render Validation`）、变体基准测试（`### Branch Variants`、`### Error Injection Validation`、`### Extreme Damage Validation`、`### Pipeline F1 Score`——每个文件的匹配/未匹配情况与精确率/召回率/F1/匹配/遗漏/误报计数）、问题表格（仅非空时输出：`### L1 Issues (Pre-Render Validation) — N issues` 与 `### L2 Issues (Post-Render Validation with Pass 2) — N issues`，列为 `# | Validator | Severity | Event | Entity | Attribute | Message`）、两个独立的按验证器 N-CED 小节（`### Per-Validator Error Density (L1)` 与 `### Per-Validator Error Density (L2)`）、严重性级别 CED（`### Severity-Level CED`）、性能基准测试（`## Performance Benchmarks`）与规模扩展摘要（`### Scaling Summary`，N=10/100/1000 平均耗时并排）。

## 核心验证报告

`packages/core/src/reporter/validation-reporter.ts` 中的 `formatValidationReport(report)` 是纯格式化函数（返回 Markdown 字符串），落盘由调用方决定：本基准用 `new ReportWriter(...).toMarkdown()` + fs 写入 `{projectDir}/output/validation.md`，node-host 另有 `writeFileValidationReport(projectRoot, report, relativeOutputDirectory?)`（详见 `reporter.md`）。

## 运行方式

```bash
# 全部基准测试（回归 + 变体 + 外部数据集 + 性能）
npm run bench

# 或直接跑 vitest 测试文件
npx vitest run packages/bench/tests/bench.test.ts
```

> 注意：CLI 目前没有 `nova bench` 命令（`nova` 仅提供 validate/status/entity/graph/source/render/revise/render-tree/project-init）。基准测试通过 vitest 测试文件（`packages/bench/tests/`）驱动，单独运行某个基准可调用 `runRegressionBench()` / `runVariantBench()` / `runExternalBench()` / `runPerformanceBench()`。
