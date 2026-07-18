# 基准测试工作流

> ~400 字 — 基准测试系统的工作方式：参考数据生成和验证运行。

基准测试套件（`packages/bench/`）分两个阶段运行，以将依赖于 LLM 的生成与确定性验证分离开来。

## 第一阶段：生成参考数据

```
node packages/bench/scripts/generate-reference.mjs [project-name]
```

默认项目为 `zhu-fu`。该脚本会：

1. 从 `fixtures/{project}/` 加载 YAML 测试夹具
2. 通过增量 `ReplayEngine` 重放构建每个事件的世界状态
3. 使用 `AiSdkProvider` 运行完整 `RenderPipeline`（Pass 1 散文 + Pass 2 分析 JSON）
4. 将结果保存到 `fixtures/{project}/reference/data/{eventId}.json` — 每个文件包含 `{ prose, analysis, _metadata }`
5. 将验证报告写入 `fixtures/{project}/output/validation.md`

参考数据作为第二阶段的确定性输入。**每个项目在影响分析输出的代码更改后生成一次。**

### 何时重新生成

- 在修改任何 Pass 2 提示模板（`render-analysis.ts`）之后
- 在修改验证器的 `getAnalysisRequirements()` 之后
- 在添加新的 AnalysisResult 块之后
- 在修改 `EntityMapper`、`ReplayEngine` 或 `ContextCompiler` 之后

## 第二阶段：运行基准测试

```
npx vitest run packages/bench/tests/bench.test.ts
```

基准测试套件（`packages/bench/tests/bench.test.ts`）运行时不进行 LLM 调用：

### L1 — 预渲染验证（无需 LLM）

- 从测试夹具加载 YAML 定义和事件
- 通过 `buildCausalEdges()` + `topologicalSort()` 构建 DAG 因果边
- 通过 `ReplayEngine` 重放世界状态
- 通过 `ResultAggregator.validateAll()` 运行全部 18 个验证器（仅结构性检查）
- 检查：实体加载、事件加载、DAG 构建、状态重放、上下文编译

### L2 — 后渲染验证（基于参考数据）

- 从 `fixtures/{project}/reference/data/` 加载参考数据 `{prose, analysis}`
- 使用存储的分析运行 `ResultAggregator.validateRender()`
- 检查语义正确性：节奏、时态一致性、外貌匹配、规则合规等

### 性能和变体测试

- `runPerformanceBench()` 测量 N=10、100、1000 事件下的加载/验证吞吐量
- `runVariantBench()` 测试分支变体、错误注入和极端破坏场景

## 输出

| 内容 | 位置 |
|------|------|
| 基准测试报告（JSON + MD） | `output/bench/{timestamp}.json` + `.md` |
| 核心验证报告 | `fixtures/{project}/output/validation.md` |

## 为什么分两个阶段？

- **速度**：第二阶段运行时间 <1 秒，而第一阶段需要 30-60 秒（LLM 调用）
- **确定性**：相同的参考数据 = 相同的结果，不受 LLM 随机性影响
- **CI 兼容性**：第二阶段可以在 CI 中运行，无需 API 密钥
- **迭代开发**：开发过程中，在编辑验证器逻辑时反复运行第二阶段，仅在提示模板变更时重新生成参考数据
