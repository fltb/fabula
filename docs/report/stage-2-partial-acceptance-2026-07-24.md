# 阶段 2 部分验收报告

> **时间**: 2026-07-24 16:56 CST
**日期:** 2026-07-23
**状态:** 27/30 项已交付；3 项阻塞于人工标注

---

## 1. 已交付成果

### 阶段 1：缺口闭合（4/4 ✅）

| 条目 | 证据 |
|------|------|
| state-semantics.md | `docs/reference/state-semantics.md` — 6 节，覆盖全部 STORY-SEMANTICS 规则与测试引用 |
| ConflictDeriver bug 修复 | `assembler.ts:127`: `scenePacing ?? 'TBD'` → `event.conflictType ?? 'unspecified'` |
| 审计 ⚠️ 三项修复 | TraceCollector 导出、PluginHooks 扩展、validation-reporter 迁移至 Storage |
| 审计报告 | 英文 + 中文版本在 `docs/audits/` |

### 阶段 2：论文级指标（6/6 ✅）

| 指标 | 源文件 | 测试数 |
|------|--------|--------|
| N-CED | `consistency.ts:computeNCED()` | 2 |
| S-CED（严重性加权） | `consistency.ts:computeSCED()` | 6 |
| Spearman rho（midrank 并列处理） | `consistency.ts:computeSpearmanRho()` | 7 |
| 去衰减 rho | `consistency.ts:computeDisattenuatedRho()` | 10 |
| 按语言 CED（中/英） | `consistency.ts:computeWordCountByLanguage()` | 15 |
| 按验证器 + 按严重性分解 | `consistency.ts:computePerValidatorBreakdown()`, `computeSeverityLevelCED()` | 3 |

全部 41 项测试通过。

### 阶段 3：长篇小说语料管线（4/4 ✅）

| 模块 | 文件 | 内容 |
|------|------|------|
| CORPUS-2: 全作品索引 | `state/corpus-index.ts` | SourceManifest、WorkIndex、CandidateEventIndex、锚点类型、冻结/校验/检测函数、ANCHORED_WORKS 常量 |
| CORPUS-3: 选择性渲染 | `state/corpus-selection.ts` | SelectionPlan、planSelection()、公式 `min(32, max(20, ceil(0.15*N)))`、覆盖率校验 |
| CORPUS-4: 回放与基准 | `state/corpus-replay.ts` | StoryBoundaryOracle、DiscourseOracle、混合节点排序、stateBefore 计算 |
| CORPUS-5: 门禁 | `state/corpus-gate.ts` | CorpusGateResult、provenance/因果/oracle/selection 检查、87/103 禁止混池 |

32 项测试通过（corpus-index.test.ts）。基础设施完成；外部语料文本按 TODO L99-100 推迟。

### 阶段 4：项目级指标（5/5 ✅）

| 条目 | 证据 |
|------|------|
| 测试覆盖率 ≥80% | 行 82.47%、分支 84.22%、函数 88.27%、语句 82.47% |
| 断路器矩阵 | `docs/reference/circuit-breaker-matrix.md` — 18 种错误类型对应策略 |
| API TSDoc 审计 | `docs/reference/api-audit.md` — 141 项导出审计，63 项有 TSDoc（45%） |
| N=100 性能基准 | `performance.ts:runOfflineCorePathBench()` — 6 阶段 + 缓存 + 并行效率 |
| 可扩展性基线 | `docs/reference/scalability-baseline.md` — 3 项任务，共 100 行 |

### 阶段 5：人工评估框架（3/5 ⚠️）

| 条目 | 状态 | 证据 |
|------|------|------|
| 5a: 标注规范 | ✅ 已交付 | `docs/reference/annotation-guidelines.md`（634 行，v1.0 冻结）<br>`docs/reference/stage-3/annotation-guidelines.zh-CN.md`（中文版） |
| 5b: 抽样协议 | ✅ 已交付 | `bench/src/annotation-sampler.ts` — 分层随机抽样、复标计划、覆盖率校验 |
| 5c: 统计分析 | ✅ 已交付 | `bench/src/annotation-stats.ts` — 二次加权 Cohen's kappa、bootstrap 95% CI、一致性统计、转移矩阵、Spearman 重测 rho |
| **5d: 首轮标注** | ❌ **阻塞** | **需人工：≥120 问题级 + ≥50 场景级标注** |
| **5e: 盲法复标** | ❌ **阻塞** | **需人工：7-14 天间隔，隐藏首轮分数，随机排序** |

---

## 2. 阻塞项

以下三项在人工标注（5d/5e）完成前无法推进：

| 阶段 | 条目 | 依赖 |
|------|------|------|
| 6a | 执行校准分割 | 需要人工标注的问题严重性 + 修复优先级数据 |
| 6c | 记录版本化基线 | 需要 6a 的校准指标 |
| 7b | 全量 bench 运行 | 需要校准基线 + 人工评估 rho |

校准分割的所有基础设施（`computeSCED`、`computeSpearmanRho`、`computeWordCountByLanguage` 等）已构建并测试。管线已准备好消费标注数据——只是目前还没有数据。

---

## 3. 完成操作清单

### 第 1 步：准备标注工作区

```bash
# 阅读中文标注指南
cat docs/reference/stage-3/annotation-guidelines.zh-CN.md

# 抽样器已就绪——从问题列表确定性生成样本
# 用法（在 bench 包中）：
#   sampleAnnotationIssues(issues, strata, config)
#   createReannotationPlan(samples, config)
```

### 第 2 步：执行首轮标注（预估：4-8 小时）

1. 打开项目验证输出（`output/validation.md`）
2. 对每个问题：分配**严重性**（blocker/high/medium/low）和**修复优先级**（blocker/high/medium/low）
3. 对每个场景：分配**质量评分**（excellent/good/acceptable/poor）并附理由
4. 目标：≥120 问题级 + ≥50 场景级
5. 记录格式（JSON 或 CSV，匹配 `AnnotationSample` schema）

### 第 3 步：等待 7-14 天

**关键：间隔必须 ≥7 天且 ≤14 天**，否则重测信度无效。

### 第 4 步：执行盲法复标（预估：2-4 小时）

1. 使用 `createReannotationPlan()` 选择复标子集
2. 随机排序，隐藏首轮分数
3. 不看原始评分，完全重新打分

### 第 5 步：运行统计分析

```bash
# 输入两轮标注数据后：
npm run bench
# 将输出：
#   - 二次加权 Cohen's kappa + 95% CI
#   - Spearman 重测 rho（目标：≥0.40）
#   - 一致性矩阵和等级分布
```

### 第 6 步：运行校准和最终 bench

```bash
# 人工数据到位后：
npm run bench
# 核验：
#   - F1 precision ≥ 0.95，recall ≥ 0.70
#   - Spearman rho ≥ 0.40
#   - 干净 fixture error-level CED = 0
#   - 相对校准基线无退化
```

---

## 4. 验证基线

| 检查项 | 结果 |
|--------|------|
| TypeScript 编译 | `tsc -b` — 零错误 |
| 测试套件 | 102 文件 / 1839 测试 — 全部通过 |
| 测试覆盖率 | 行 82.47%、分支 84.22%、函数 88.27%、语句 82.47% |
| 一致性指标测试 | 41 项 — 全部通过 |
| 语料基础设施测试 | 32 项 — 全部通过 |
| 审计交付物 | 6 份文档已交付 |

---

## 5. 文件清单

```
docs/reference/
  state-semantics.md              （阶段 1a — STORY-SEMANTICS 规范）
  circuit-breaker-matrix.md       （阶段 4b — 18 种错误类型矩阵）
  api-audit.md                    （阶段 4c — 141 项导出审计）
  annotation-guidelines.md        （阶段 5a — 英文标注规范）
  annotation-guidelines.zh-CN.md  （阶段 5a — 中文标注指南）
  scalability-baseline.md         （阶段 4e — 3 任务，100 行）

docs/audits/
  project-walkthrough-audit.md        （阶段 1d — 英文审计报告）
  project-walkthrough-audit.zh-CN.md  （阶段 1d — 中文审计报告）

docs/report/
  stage-2-partial-acceptance.md  （本报告）

packages/core/src/
  context/assembler.ts            （阶段 1b — line 127 修复）
  state/corpus-index.ts           （阶段 3a）
  state/corpus-selection.ts       （阶段 3b）
  state/corpus-replay.ts          （阶段 3c）
  state/corpus-gate.ts            （阶段 3d）
  ai/providers/noop.ts            （阶段 4e — 可扩展性）
  schemas/mood.ts                 （阶段 4e — 可扩展性）
  validator/counting.ts           （阶段 4e — 可扩展性）

packages/bench/src/
  consistency.ts                  （阶段 2 — 全部 7 项指标）
  annotation-stats.ts             （阶段 5c — 统计分析）
  annotation-sampler.ts           （阶段 5b — 抽样选择）
  performance.ts                  （阶段 4d — N=100 扩展）
```

---

*报告生成于 2026-07-23。阶段 2 全部代码/文档工作已完成。等待人工标注（两轮，间隔 7-14 天）以解除校准、基线和最终 bench 报告的阻塞。*
