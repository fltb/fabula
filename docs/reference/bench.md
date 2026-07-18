# 基准测试

**包：** `@novalistically/bench`，位于 `packages/bench/`  
**入口：** `packages/bench/src/index.ts`  
**测试框架：** `packages/bench/tests/bench.test.ts`  
**运行：** `npx vitest run packages/bench/tests/bench.test.ts`

基准测试包衡量 Novalistically 的功能正确性、性能、一致性以及外部数据集兼容性。它包含 **5 个子系统**，可通过 `runAll()` 编排器统一访问，也可单独运行。

## 1. 回归测试 — `packages/bench/src/regression.ts`

在 `fixtures/zhu-fu/` 下的 祝福（zhu-fu）测试夹具上运行 8 个阶段：

| 阶段 | 功能说明 |
|-------|-------------|
| 加载实体 | EntityMapper + InMemoryEntityRegistry |
| 加载事件 | `mapper.loadAllEvents()`，包含 system:genesis |
| 构建 DAG | `buildCausalEdges()` + `topologicalSort()` |
| 回放状态 | `ReplayEngine.replay()` |
| 运行验证器 (L1) | `ResultAggregator.validateAll()` — 结构/定义级别检查 |
| 运行渲染后验证器 (L2) | 从 `fixtures/zhu-fu/reference/data/` 加载参考数据，使用预先生成的散文和 AnalysisResult 运行 `aggregator.validateRender()` |
| 写入验证报告 | 将 `writeValidationReport()` 写入 `fixtures/zhu-fu/output/validation.md` |
| 编译上下文 | 对最后一个叙事事件执行 `ContextCompiler.compile()` |

**L1 与 L2 的区别：** L1 在渲染前验证事件定义和世界状态。L2 在渲染后，对照参考数据中的 Pass 2 `AnalysisResult` 验证生成的散文。当参考数据目录不存在时，L2 会被标记为跳过。

## 2. 变体测试 — `packages/bench/src/variants.ts`

测试验证器管道检测注入错误的能力。操作对象为 `fixtures/zhu-fu-variants/`：

- **分支变体**（branch-A、branch-B）：加载变体夹具目录并运行 `ResultAggregator.validateAll()`
- **错误注入变体**（28 个 YAML 文件）：深度克隆基础事件，通过 `applyInjections()` 应用定向修改，从修改后的事件回放状态，运行验证器，检查预期的验证器是否触发
- **极端损坏变体**（5 个 YAML 文件）：与错误注入相同的管道，但采用更激进的修改

修改引擎（`applyInjections()`）支持 20 多种注入类型：storyTime 损坏、无法满足的前提条件、后置条件交换、POV 指向不存在的角色、发明细节、知识泄露、指向不存在的章节的伏笔、占位符值、时态不匹配等。

**管道 F1 值：** 根据注入结果计算。TP = 预期的验证器已触发，FN = 预期的验证器未触发，FP = 意外的验证器在基线之外产生了问题。使用 `consistency.ts` 中的 `computeF1()` 计算。

## 3. 性能测试 — `packages/bench/src/performance.ts`

在 N=10、N=100、N=1000 事件规模下的合成计时基准测试。使用 `makeSyntheticEvent()` 生成包含 10 个角色、10 个地点和 4 条线索的事件数组。在每个规模下测量 5 个阶段：

- 运行所有验证器（每个事件 11 个验证器）
- ResultAggregator
- 计算 ISS
- 回放状态
- 编译上下文

迭代次数随规模调整：N=10 时迭代 10 次，N=100 时迭代 5 次，N=1000 时迭代 3 次。结果包括 Hz、平均毫秒数和样本数量。

## 4. 一致性测试 — `packages/bench/src/consistency.ts`

定义了 4 种指标类型：

- **N-CED**（Novalistically 一致性错误密度）：每万字的总问题数
- **S-CED**（严重性加权 CED）：按严重性（error=1.0、warning=0.3、info=0.1）和类别系数加权
- **管道 F1**：包含 baselineFP、injectionTP、injectionFN 的 `computeF1()`
- **Spearman 秩相关系数**：用于兼容 HANNA 的系统与人工评估的 `computeSpearmanRho()`
- **去衰减系数**：`disattenuateRho()` 对观察到的相关性进行测量不可靠性校正

同时还支持每个验证器的 N-CED 分解（`PerValidatorBreakdown`）和严重性级别 CED（`SeverityLevelCED`，包含 L1 和 L2 两列）。

## 5. 外部数据集 — `packages/bench/src/external.ts`

位于 `packages/bench/src/adapters/` 的三个外部数据集适配器：

- **ChiNovelKE**：角色/地点/关系转换，含字段来源追踪
- **Novel Agent SFT**：章节/事件转换，含覆盖率报告
- **InteractiveNovels3K**：小说到事件的转换，含字数处理统计

结果报告状态（`ran | skipped | failed`）及各基准测试的指标。

## 参考数据

预生成的散文和分析存放于 `fixtures/zhu-fu/reference/data/` — 每个事件对应一个 `<eventId>.json` 文件，包含 `{ prose: string, analysis: AnalysisResult }`。L2 验证加载这些文件并对其运行渲染后验证器。

## 输出与报告

基准测试结果以 JSON 和 Markdown 两种格式写入 `output/bench/`。`packages/bench/src/reporters.ts` 中的 `writeResults()` 函数使用 `FsStorage`。Markdown 报告包括：回归阶段表格、L2 验证摘要、变体基准测试（分支、错误注入（每个文件的匹配/未匹配情况）、极端损坏）、管道 F1 分数、每个验证器的 N-CED 表格（L1 和 L2），以及严重性级别 CED。

## 核心验证报告

`packages/core/src/reporter/validation-reporter.ts` 中的 `writeValidationReport()` 写入 `output/validation.md`，包含摘要表格和 L1/L2 问题表格。

## 运行方式

```bash
# 所有基准测试
npx vitest run packages/bench/tests/bench.test.ts

# 通过 CLI
nova bench
nova bench --regression
nova bench --performance
```
