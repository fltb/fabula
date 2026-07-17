# BatchRenderPipeline — 异步分批滑动窗口渲染系统

**状态：设计锁定。** 创建日期：2026-07-17。

> 本文档是 Novalistically 分批渲染系统的权威设计来源。涵盖架构定位、API 设计、内部机制、配置参数、错误处理、与 bench-rewrite 计划的集成。

---

## 第一部分：问题陈述

### 1.1 当前状态

`RenderPipeline.renderAll()` 一次性提交所有事件到 `ConcurrencyPool`，全量并行渲染。这在事件数较少时（6-20 个）工作良好，但在 bench 场景下有问题：

| 问题 | 影响 |
|---|---|
| **内存膨胀** | ChiNovelKE 150 角色 + 互动小说 100K 章节，全部结果 hold 在内存直到 `renderAll` 完成 |
| **无进度可见性** | 用户看不到中间进度，必须等全部完成 |
| **无流式输出** | 输出文件只在全部渲染完成后一次性写入 |
| **无批次间状态优化** | 没有机会在批次边界执行上下文预热、缓存更新 |

### 1.2 目标

1. **内存控制** — 每批完成即写盘，不累积原始 LLM 响应在内存（结果对象本身仍需收集用于返回，但体积远小于原始响应）
2. **流式输出** — 每批完成立即写盘
3. **进度可见性** — 实时进度回调
4. **批次间状态优化** — 钩子系统支持批次边界的自定义逻辑
5. **提前终止** — 支持 bench 场景的提前终止（如错误率过高）

---

## 第二部分：架构定位

### 2.1 层次模型

```
packages/core/src/
├── api.ts                     ← renderNovel() 编排入口
├── batch-renderer.ts          ← ★ BatchRenderPipeline（编排层，新增）
│   pipeline/
│   ├── render.ts              ← RenderPipeline（不变）
│   │   renderScene() — 纯渲染
│   │   renderAll()   — 全量并行（保留）
│   └── ...
│   util/
│   └── pool.ts                ← ConcurrencyPool（不变）
```

### 2.2 设计原则

- **BatchRenderPipeline 是编排层，不是渲染机制。** 它组合 `RenderPipeline`，不继承。
- **RenderPipeline 不变。** `renderScene()` 和 `renderAll()` 保持纯渲染语义。
- **ConcurrencyPool 不变。** 批次内部仍用它做有界并行。
- **api.ts 新增可选参数。** `renderNovel()` 接受 `batch?: BatchConfig`，传了就分批，不传走原路。

### 2.3 数据流

```
renderNovel(jobs, { batch: { size: 10, window: 2 } })
  │
  ├─ 构建 jobs[]（不变）
  ├─ 创建 RenderPipeline（不变）
  ├─ new BatchRenderPipeline(pipeline)
  └─ batchRenderer.renderBatched(jobs, config)
       │
       ├─ 拆批: batch_0[0..9], batch_1[10..19], batch_2[20..29], ...
       │
       ├─ 滑动窗口循环:
       │    ├ 提交 batch_0 → renderAll() → renderScene() × 10
       │    ├ 提交 batch_1 → renderAll() → renderScene() × 10
       │    │   (窗口已满，暂停提交)
       │    ├ Promise.race: batch_0 完成 →
       │    │   ├ onAfterBatch(results, 0)  ← 钩子（可选，由调用方实现写盘）
       │    │   ├ onProgress({ batchIndex: 0, completed: 10, total: N })
       │    │   └ 提交 batch_2 → renderAll() → ...
       │    ├ batch_1 完成 → ...
       │    └ ...
       │
       └─ 返回全部 Result[]（或部分，如果提前终止）
```

---

## 第三部分：API 设计

### 3.1 核心类

```typescript
// packages/core/src/batch-renderer.ts

import type { RenderPipeline, RenderJob, RenderSceneResult } from './pipeline/render.ts';

// ── 配置 ──

export interface BatchConfig {
  /** 每批事件数。默认 10。 */
  batchSize?: number;

  /** 滑动窗口大小（同时在飞的批次数）。默认 2。 */
  windowSize?: number;

  /** 一批失败是否终止全部。默认 true（fail-fast）。 */
  failFast?: boolean;

  /** 进度回调 — 每批完成时调用 */
  onProgress?: (event: BatchProgressEvent) => void;

  /** 批次开始前钩子 — 可用于 context 预热、状态更新等 */
  onBeforeBatch?: (batch: RenderJob[], batchIndex: number) => Promise<void>;

  /** 批次完成后钩子 — 可用于写盘、统计收集、下游通知 */
  onAfterBatch?: (results: RenderSceneResult[], batchIndex: number) => Promise<void>;

  /** AbortSignal — 外部取消信号 */
  signal?: AbortSignal;
}

export interface BatchProgressEvent {
  batchIndex: number;
  totalBatches: number;
  completedInBatch: number;
  totalCompleted: number;
  totalJobs: number;
  elapsedMs: number;
  batchResults: RenderSceneResult[];
}

export interface BatchResult {
  results: RenderSceneResult[];
  /** 是否全部批次完成（false 表示提前终止） */
  completed: boolean;
  /** 批次级别的统计 */
  stats: BatchStats;
}

export interface BatchStats {
  totalJobs: number;
  totalBatches: number;
  completedBatches: number;
  cacheHits: number;
  cacheMisses: number;
  totalErrors: number;
  totalAttempts: number;
  elapsedMs: number;
  aborted: boolean;
}

// ── 主类 ──

export class BatchRenderPipeline {
  private pipeline: RenderPipeline;
  private controller: AbortController;

  constructor(pipeline: RenderPipeline) {
    this.pipeline = pipeline;
    this.controller = new AbortController();
  }

  /**
   * 分批渲染。内部使用滑动窗口调度。
   *
   * @param jobs - 所有渲染任务
   * @param config - 分批配置（batchSize 默认 10，windowSize 默认 2）
   * @returns 全部渲染结果 + 统计
   */
  async renderBatched(jobs: RenderJob[], config: BatchConfig): Promise<BatchResult>;

  /** 提前终止。正在飞行的批次会完成当前场景后停止。 */
  abort(): void;
}
```

### 3.2 在 api.ts 中的集成

```typescript
// api.ts — renderNovel 签名变更

export async function renderNovel(
  projectDir: string,
  options?: {
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    concurrency?: number;
    maxRetries?: number;
    skipCache?: boolean;
    /** ★ 新增：分批配置。不传则全量并行（原行为） */
    batch?: BatchConfig;
  },
): Promise<{ results: MappedResult[]; errors: string[] }> {
  // ...
  const pipeline = new RenderPipeline({ provider, model, cacheDir, storage, concurrency, maxRetries, skipCache });

  if (options?.batch) {
    // 分批模式
    const batchRenderer = new BatchRenderPipeline(pipeline);
    const batchResult = await batchRenderer.renderBatched(jobs, options.batch);
    // 每批的 onAfterBatch 里已流式写盘
    return mapResults(batchResult.results);
  } else {
    // 原模式：全量并行
    const results = await pipeline.renderAll(jobs);
    buildAndWriteOutputs(storage, projectDir, jobs, results);
    return mapResults(results);
  }
}
```

---

## 第四部分：内部机制

### 4.1 滑动窗口算法

```
输入: jobs[], batchSize, windowSize
输出: BatchResult

算法:
  batches = chunk(jobs, batchSize)          // 拆批
  inFlightPromises = new Set()              // 飞行中的 Promise 集合
  nextToSubmit = 0                          // 下一个待提交的批次索引
  allResults = []                           // 收集全部结果
  completedBatches = 0

  for (let i = 0; i < Math.min(windowSize, batches.length); i++) {
    inFlightPromises.add(submitBatch(batches[nextToSubmit++]))
  }

  while (completedBatches < batches.length) {
    result = await Promise.race(inFlightPromises)  // 等任意一批完成
    inFlightPromises.delete(result.promise)

    onAfterBatch(result.results, result.batchIndex)
    onProgress(...)

    if (signal.aborted) break               // 提前终止检查

    allResults.push(...result.results)
    completedBatches++

    if (nextToSubmit < batches.length) {
      inFlightPromises.add(submitBatch(batches[nextToSubmit++]))
    }
  }
```

### 4.2 批次提交

```typescript
function submitBatch(batch: RenderJob[], batchIndex: number): Promise<BatchFlight> {
  inFlight++;
  return this.pipeline.renderAll(batch)    // renderAll 内部使用 ConcurrencyPool
    .then(results => ({ results, batchIndex }));
}
```

每个批次内部调用 `RenderPipeline.renderAll()`，享受现有的有界并行（默认 5）。

### 4.3 提前终止

```typescript
abort(): void {
  this.controller.abort();
}
```

- 调用 `abort()` 后，`signal.aborted` 变为 true
- 滑动窗口循环在下一批完成时检测到 `aborted` 并退出
- 已在飞的批次会跑完当前场景（不中断 LLM 调用，避免浪费 token）
- 返回 `BatchResult.completed = false`，`stats.aborted = true`

### 4.4 失败隔离（failFast: false）

当 `failFast: false` 时：

- 单批失败 → 记录错误到 stats，继续下一批
- 失败的批次结果中的 `errors` 字段保留
- 不会因为一个场景的 Pass 2 解析失败而终止整个 bench run

---

## 第五部分：配置默认值与依据

| 参数 | 默认值 | 依据 |
|---|---|---|
| `batchSize` | 10 | 2× pool concurrency (5)，保证池子满但不堆积。与 LangChain batch() 的 maxConcurrency=5~10 范围一致 |
| `windowSize` | 2 | 业界标准：p-queue 滑动窗口默认 2 窗口。保持 2 批在飞 = 20 个事件在飞，避免 API rate limit 同时提供足够的工作量 |
| `failFast` | true | 开发/调试阶段快速失败。bench 批量跑外部数据集时可设为 false |
| `concurrency`（pool） | 5 | 不变，与 Anthropic Build tier 的安全上限一致 |

---

## 第六部分：错误处理矩阵

| 场景 | failFast=true | failFast=false |
|---|---|---|
| 单场景 Pass 1 失败 | retry 最多 3 次 → 仍失败则该场景 error，该批标记为失败 → 终止全部 | retry → 仍失败 → 场景 error，该批标记为失败 → 继续下一批 |
| 单场景 Pass 2 parse 失败 | retry 1 次 → 仍失败 → analysis=null，不影响该批 | 同左 |
| 单批全部场景失败 | 终止全部，返回已完成的结果 | 跳过该批，继续 |
| API rate limit (429) | 不重试（应由 provider 层处理），终止 | 跳过该批，继续 |
| AbortSignal 触发 | 当前飞行批次完成后停止，返回 `completed=false` | 同左 |

---

## 第七部分：在 bench-rewrite 计划中的位置

### 7.1 所属阶段

`BatchRenderPipeline` 属于 **P2（Bench 重构）** 的前置基础设施。它不是 bench 专用代码，而是 bench 调用的 core 能力。

依赖链：

```
P0-tier3 (RenderPipeline 稳定)
  └── BatchRenderPipeline (新增，无上游依赖变更)
        └── P2 Bench 重构 (调用 BatchRenderPipeline)
```

### 7.2 工作量估算

| 文件 | 内容 | 行数 |
|---|---|---|
| `packages/core/src/batch-renderer.ts` | BatchRenderPipeline 类 + 类型 | ~250 行 |
| `packages/core/src/api.ts` | renderNovel 新增 batch 参数 | ~30 行 |
| `packages/core/src/index.ts` | 导出 BatchRenderPipeline + 类型 | ~5 行 |
| `packages/core/tests/batch-renderer.test.ts` | 单元测试（mock provider） | ~200 行 |
| **合计** | | **~485 行** |

### 7.3 与现有代码的关系

- **不修改** `RenderPipeline`、`ConcurrencyPool`、`render-analysis.ts`、`cache/`
- **不修改** bench 包（P2 阶段才接线）
- **新增导出**：`BatchRenderPipeline`、`BatchConfig`、`BatchProgressEvent`、`BatchResult`、`BatchStats`

---

## 第八部分：测试策略

### 8.1 单元测试（mock provider，不需要 LLM）

| 测试 | 验证 |
|---|---|
| 基本分批 | jobs=25, batchSize=10 → 检查正好 3 批，结果数=25 |
| 滑动窗口 | windowSize=2，验证最多 2 批同时在飞 |
| 进度回调 | 验证 onProgress 调用次数 = 批次数，参数正确 |
| 钩子调用 | onBeforeBatch/onAfterBatch 调用次数、参数 |
| 提前终止 | abort() → completed=false, 结果数 < jobs.length |
| failFast=false | 单批失败后继续下一批 |
| 空 jobs | 返回空结果，不报错 |
| 单批 < batchSize | 最后一批不足 batchSize 也能正常处理 |

### 8.2 集成测试（需要 live LLM，标记 `e2e`）

| 测试 | 验证 |
|---|---|
| 真实渲染 + 分批 | most-dangerous-game 6 场景, batchSize=2 → 3 批，prose 正确 |
| 流式输出 | onAfterBatch 中写盘，验证文件存在 |
| 缓存交叉 | 第一遍渲染 → 第二遍全缓存命中 |

---

## 第九部分：未来扩展（本轮不做）

- **token-budget-based 批次大小** — 按预计 token 消耗分批次，而非固定事件数
- **批次并行写盘** — 当前每批顺序写盘，可改为并发写盘
- **批次间 DAG 级预热** — 利用 DAG 拓扑信息，批次 N+1 的 context 编译器可提前计算
- **WebSocket 进度推送** — 通过 MCP server 推送实时进度给 IDE
