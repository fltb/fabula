# 快速开始

> ~300 字 — 几分钟内上手 Novalistically。

> 本文为当前参考文档，与 [当前系统状态](../current-state.md) 保持同步。

## 前置条件

- Node.js 26.5+（`package.json` 的 `engines` 限定 `>=26.5.0 <27`）
- npm 11.17+（`engines` 限定 `>=11.17.0 <12`）

## 安装

```bash
cd fabula
npm install
npm run build
```

`npm install` 安装所有工作空间包（`core`、`node-host`、`bench`、`cli` 与私有 `workbench`）；`npm run build` 编译 TypeScript 并打包各包产物（CLI 依赖 `packages/core` 与 `packages/node-host` 的 `dist`）。

## 配置

复制示例环境文件并设置你的 API 密钥：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
NOVALISTICALLY_AI_API_KEY=your_api_key_here
```

默认情况下，系统使用：
- **Base URL：** `https://opencode.ai/zen/v1`（opencode zen 免费套餐）
- **模型：** `deepseek-v4-flash-free`

如果使用其他提供商，可以通过 `NOVALISTICALLY_AI_BASE_URL` 和 `NOVALISTICALLY_AI_MODEL` 覆盖。

这些变量由 `@novalistically/node-host` 的 `AiSdkProvider`（`packages/node-host/src/providers/ai-sdk.ts`）读取；CLI **不会**自动加载 `.env` 文件——运行前需要把变量导出到 shell 环境。

## 运行现有测试夹具

`zhu-fu`（祝福 — "New Year's Sacrifice"）测试夹具是主要的回归测试夹具。运行基准测试套件：

```bash
npx vitest run packages/bench/tests/bench.test.ts
```

**预期输出（无需 LLM；以下为格式示意，具体数字随机器与夹具状态而异）：**

```
[Regression] N/N passed, 0 failed, NNNms total
[L2] Passed: true, Detail: L2 issues — errors: 0, warnings: N, infos: 0
[L1 Issues] Total: N
[Perf] Total measurements: N
```

这个测试文件会运行（`packages/bench/src/`）：
- **回归基准测试**（`runRegressionBench`）：加载 YAML 定义（实体 + 事件）、构建 DAG、重放状态、通过 `ResultAggregator` 运行全部 28 个内置验证器、为最后一个叙事事件编译上下文，并把验证报告写入 `fixtures/zhu-fu/output/validation.md`
- **L2 验证**（回归基准中的 “Run post-render validators (L2)” 阶段）：当 `fixtures/zhu-fu/reference/` 目录存在时，针对其中已审核（哈希校验）的参考数据运行后渲染验证，无 API 调用。参考目录**缺失**时该阶段直接跳过、以 “No reference directory found — skipping L2 validation” 通过——只有参考数据**存在但损坏或未审核**时该阶段才失败
- **性能基准测试**（`runPerformanceBench`）：在 N=10、100、1000 个合成事件下测量各阶段吞吐（Run all validators、ResultAggregator、Calculate ISS、Replay state、Compile context），输出表格与缩放摘要
- **报告写入测试**：把回归结果写为 `output/bench/{timestamp}.{json,md}`
- **`runAll` 集成用例**：调用 `runAll()`，在回归与性能基准之外**还会**运行变体基准测试（`runVariantBench`：branch A/B、错误注入、极端损坏、pipeline F1）与外部基准测试（`runExternalBench`），并再次写入完整结果——因此运行整个文件会比“三个阶段”做更多工作

## 查看结果

| 内容 | 位置 |
|------|------|
| 基准测试报告 | `output/bench/{timestamp}.md` |
| 核心验证报告 | `fixtures/zhu-fu/output/validation.md` |

## 生成候选输出（可选，需要 API 密钥）

```bash
node packages/bench/scripts/generate-reference.mjs zhu-fu
```

这是实时冒烟脚本（`npm run smoke:stage1:live` 的底层命令）：通过 `renderNovel` 跑完整流水线（Pass 1 散文 + Pass 2 分析）。注意只有 **Pass 2 的 seed 固定为 42**（`SEED = 42`）；Pass 1 明确不设种子（`null`），因此散文生成本身不可复现。脚本把每个事件的候选输出 `{prose, analysis}` 写入 `fixtures/zhu-fu/.nova/smoke-candidates/{timestamp}/`（含 `smoke-record.json`、`candidate-provenance.json`、`observed-outcomes.json`）。

- 需要 `NOVALISTICALLY_AI_API_KEY`；未设置时脚本直接退出（不写入任何记录）
- 默认模型为 `deepseek-v4-flash`（可用 `NOVALISTICALLY_AI_MODEL` 覆盖）
- 成功时输出：`✓ Live smoke passed for zhu-fu E0–E6`，并打印候选目录与 provenance 哈希
- 注意：它不会写入 `fixtures/zhu-fu/reference/`（L2 使用的已审核参考数据是独立的审核流程）

## 后续步骤

- [配置](./configuration.md) — 所有可用设置
- [第一个项目](./first-project.md) — 创建你自己的叙事项目
- [添加验证器](../guides/adding-a-validator.md) — 扩展验证逻辑
- [基准测试工作流](../guides/bench-workflow.md) — 理解两阶段测试系统
