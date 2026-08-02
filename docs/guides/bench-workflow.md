# 基准测试工作流

> ~500 字 — 基准测试系统的工作方式：live-smoke 候选集与已批准参考数据。

基准测试套件（`packages/bench/`）分两条路径：**live smoke**（真实 LLM 运行，产出候选集）与**确定性基准**（无 LLM，针对已批准参考数据运行）。

## 路径一：Live Smoke — 生成候选集（需要凭据）

```
NOVALISTICALLY_AI_API_KEY=... NOVALISTICALLY_AI_MODEL=... npm run smoke:stage1:live
# 或直接：node packages/bench/scripts/generate-reference.mjs [project-name]
```

默认项目为 `zhu-fu`。该脚本会：

1. 把夹具复制到临时目录（排除 `.nova`/`scenes`/`output`，确保任何开发者缓存都无法命中）
2. 通过公共 API `renderNovel()` + `AiSdkProvider` 渲染全部事件（Pass 1 散文 + Pass 2 分析 JSON；Pass 1 seed 为 null，Pass 2 seed 固定 42）

> ⚠️ **该命令当前不可运行**（2026-08-02 现状）：`generate-reference.mjs` 调用了 `buildLiveSmokeRecord()`（`packages/bench/src/live-smoke.ts`）与 `collectReferenceIssueIdentities()`（`packages/bench/src/reference.ts`），但从未导入这两个 helper——任何非空渲染都会在 LLM 调用之后抛 `ReferenceError`。该错误发生在账本构建步骤（此时尚未写任何候选文件），以 “Smoke record build failed: buildLiveSmokeRecord is not defined” 形式非零退出，也不会写 `fatal-error.json`。在补上导入之前，`npm run smoke:stage1:live` 无法产出候选集。

修复后脚本的预期产物（写到 `fixtures/{project}/.nova/smoke-candidates/{timestamp}/`）：
- `smoke-record.json` — 账本记录（`reviewStatus: candidate`；成功要求 E0–E6 全部存在、已释放、无错误）
- `{eventId}.json` — 每个事件的候选响应（`reviewStatus: candidate`）
- `observed-outcomes.json`、`candidate-provenance.json`

**失败语义（按当前实现）**：`fatal-error.json` 在三条路径写入——`renderNovel` 抛出、返回零结果、候选 schema 校验失败（`responseReferenceSchema`）。其中候选校验失败路径**先全量校验、后写文件**：任何候选无效时写 `fatalType: 'candidate_validation_failure'` 的 `fatal-error.json` 并退出，候选事件 JSON 尚未落盘，不会留下部分候选集。**不写** `fatal-error.json` 的失败路径：账本构建失败（`buildLiveSmokeRecord` 抛出——包括未导入 helper 的 `ReferenceError`）时尚未写任何候选文件；provenance manifest 校验失败时事件 JSON 与 `observed-outcomes.json` 已落盘；`smokeOutput.success === false` 时全部文件（含 `reviewStatus: 'failed'` 的 `smoke-record.json`，脚本自称为 failure record）已写入。临时目录在所有退出路径都被清理，但 `fixtures/{project}/.nova/smoke-candidates/{timestamp}/` 下已写出的产物会保留。因此“失败必写 fatal-error.json、绝不留下残缺候选集”是目标语义，当前实现并不保证。

**Live smoke 产出的是候选集（candidates），不是已批准参考。** 脚本绝不写入 `reference/data/` 目录。候选集经人工审核（`reference/review.json` 中 `decision: approved`）后才成为参考；`verify-stage1-acceptance.mjs` 负责校验 review 记录与 `live-smoke-record.json`（要求 cache.hits=0、事件恰好为 E0–E6、pass2 seed=42 等）。**证据资格**：在未导入 helper 的缺陷修复前，本脚本无法产出候选集；`reference/` 下已有的 mock/参考 fixture 数据及其确定性重放结果**不是**人工或 live-LLM 证据。候选集只有在 helper 修复后由真实 LLM 运行产出、并经人工审核批准后，才能作为 live-LLM 证据引用。

### 何时重新生成 live smoke

- 在修改任何 Pass 2 提示模板（`render-analysis.ts`）之后
- 在修改验证器的 `getAnalysisRequirements()` 之后
- 在添加新的 AnalysisResult 块之后
- 在修改 `EntityMapper`、`compileStoryBoundaries()` 或 `compileStoryRuntimeGraph()` 之后

## 已批准参考集

`fixtures/{project}/reference/` 存放已批准参考数据：

- `data/E0.json … E6.json` — 每个事件 `{ prose, analysis, metadata }`（`reviewStatus: approved`）
- `provenance.json` — 来源记录（generated / source_quotation）
- `expected-outcomes.json` — 期望验证 issue 身份清单（版本化 allowlist）
- `review.json` — 人工审核记录（decision: approved）

`loadApprovedReferences()`（`packages/bench/src/reference.ts`）做封闭加载：校验文件集、schema、metadata 完整性、provenance、outcome manifest、review 决策与哈希。

## 路径二：确定性基准（无 LLM）

```
npx vitest run packages/bench/tests/bench.test.ts
```

`runRegressionBench()`（`packages/bench/src/regression.ts`）按八个阶段运行：

### L1 — 预渲染验证（无需 LLM）

- 通过 `FileProjectSourceLoader` 加载测试夹具，`compileProject()`（canonical kernel load）在 “Load entities” 阶段一次性编译实体、事件与 story boundaries（`stateBeforeByEventId` / `finalState` / `orderedEventIds`）——**规范重放/边界编译发生在这里**，`runRegressionBench()` 并不构造 `ReplayEngine`
- 后续 “Load events” / “Build DAG” / “Replay state” 阶段只是消费 kernel load 产物的占位阶段，不执行新的重放
- 通过 `ResultAggregator.validateAll()` 运行全部 28 个内建验证器（仅结构性检查）

### L2 — 后渲染验证（基于已批准参考）

- 用 `loadApprovedReferences()` 加载 `fixtures/{project}/reference/` 参考数据
- 使用存储的分析按事件运行 `ResultAggregator.validatePost()`（不存在 `validateRender()` 方法）
- 将实际验证 issue 身份与 `expected-outcomes.json` 清单逐项比较（缺失或意外即失败）
- 计算 N-CED / S-CED 等一致性指标（`packages/bench/src/consistency.ts`）

### 其他测试与基准

- `reference.test.ts` — 参考集封闭加载 + live-smoke-record schema 校验
- `consistency.test.ts` — N-CED/S-CED/Spearman ρ 等指标
- `live-smoke-record.test.ts` — `buildLiveSmokeRecord()` 单元测试
- `runVariantBench()` — 分支变体、错误注入、极端破坏场景（含 pipeline F1）
- `runPerformanceBench()` — N=10/100/1000 事件下的加载/验证吞吐量

## 输出

| 内容 | 位置 |
|------|------|
| 基准测试报告（JSON + MD） | `output/bench/{timestamp}.json` + `.md` |
| 验证报告 | `fixtures/{project}/output/validation.md` |

## 为什么分两条路径？

- **速度**：确定性基准无 LLM 调用（秒级），live smoke 需要 30-60 秒
- **确定性**：已批准参考数据固定 → 结果可复现；live smoke 候选集只为人工审核提供真实 LLM 证据
- **CI 兼容性**：确定性基准可以在 CI 中运行，无需 API 密钥
- **证据资格**：确定性基准与参考 fixture 的重放结果不是人工或 live-LLM 证据；只有 live smoke（helper 修复后）的真实 LLM 运行并经理人工审核批准，才能作为 live-LLM 证据引用
- **迭代开发**：开发过程中反复运行确定性基准，仅在提示模板/分析需求变更时重新生成 live smoke 候选集
