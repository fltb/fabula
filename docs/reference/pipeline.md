# 渲染管线

**源文件：** `packages/core/src/pipeline/render.ts` (RenderPipeline)，`packages/core/src/pipeline/output.ts` (OutputWriter)  
**缓存：** `packages/core/src/cache/render-cache.ts`  
**类型：** `packages/core/src/types/event.ts`、`packages/core/src/types/analysis.ts`

渲染管线是 Novalistically 的核心渲染引擎——从结构化叙事规范到 LLM 生成的散文以及机器可解析的自我分析之间的桥梁。它运行两趟 LLM 调用，以哈希链方式缓存结果，通过错误反馈进行重试，并可选择在开发模式下运行双重运行验证。

## RenderPipelineOptions

在构造时配置：

| 选项 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `provider` | `LLMProvider` | 必填 | LLM 提供者抽象 |
| `model` | `string` | 必填 | 模型标识符（例如 `gpt-4o`、`claude-opus-4`） |
| `cacheDir` | `string` | 必填 | 哈希链渲染缓存的目录 |
| `storage` | `Storage` | 必填 | 文件系统抽象（FsStorage、MemoryStorage） |
| `concurrency` | `number` | `5` | 并行渲染池大小 |
| `maxTokens` | `number` | `10000` | LLM 响应的最大令牌数 |
| `skipCache` | `boolean` | `false` | 强制重新渲染所有场景 |
| `referenceExample` | `string` | 可选 | Pass 1 的"优秀"散文示例 |
| `aggregator` | `ResultAggregator` | 可选 | 渲染后验证聚合器 |
| `maxRetries` | `number` | `3` | 最大渲染+验证尝试次数 |
| `doubleRunVerification` | `boolean` | `false` | 仅开发模式：Pass 2 运行两次，比较分析块 |

## 管线流程

### 1. 缓存初始化（`initCache()`）

`computeCacheKeys()` 在所有事件文件和定义文件上构建一个 SHA-256 哈希链。事件 N 的缓存键为：

```
eventHashN = sha256(eventHash{N-1} + "|event:" + fileContent + "|defs:" + defsHash)
```

这意味着对先前事件或任何定义文件的更改都会级联失效到所有下游场景。缓存存储在 `cacheDir` 中，并在渲染前进行检查。

### 2. Pass 1：散文生成（温度 0.8）

`PromptAssembler` 从 `NarrativeEvent` + `ContextPackage`（角色快照、世界事实、激活规则、线程状态）构建上下文包。LLM 接收到：

- 场景规范（id、title、sceneType、storyTime、pov、sceneBrief、tense 等）
- 带有相关性加权优先级的角色快照
- 世界事实和激活规则
- 风格指导（语调、氛围、角色声音）
- 之前的验证错误（重试时）

温度 0.8 允许创造性的散文变化。默认场景长度最多 400 词，`maxTokens` 上限为 10000。

### 3. Pass 2：结构化分析（温度 0.3，种子 42）

散文和上下文被反馈给 LLM，使用来自 `buildAnalysisPrompt()`（`packages/core/src/ai/prompts/render-analysis.ts`）的提示。LLM 生成一个包含最多 14 个分析块的结构化 JSON `AnalysisResult`。温度 0.3 + 种子 42 确保可复现性。

**带反馈的重试：** `parseAnalysisJSONWithErrors()` 解析 JSON 响应。在 Zod 验证失败时，错误详情被反馈到 Pass 2 提示中进行修正（Instructor 模式——最多 2 次尝试）。这不是盲目重试：LLM 会收到具体的字段级别错误。

### 4. 渲染后验证

如果配置了 `aggregator`（ResultAggregator），`validateRender()` 会在渲染的散文上运行全部 20 个验证器，可选地消费 Pass 2 `AnalysisResult`。验证失败会触发断路器：

- **第 1 轮：** 提示修复——错误信息注入到重试指导中
- **第 2 轮：** 上下文丰富——向提示添加更多上下文
- **第 3 轮：** 降级策略——接受较低的质量

最多 3 轮，每轮 2 次尝试。如果所有重试均失败，场景被标记为 `needsReview: true`。

### 5. 双重运行验证（仅开发模式）

当 `doubleRunVerification: true` 时，Pass 2 在相同的温度 0.3 和种子 42 下运行两次。`compareAnalysisBlocks()` 工具使用 `JSON.stringify` 逐字段比较全部 14 个分析块。任何差异都会被记录为错误，标记非确定性的分析输出。

### 6. 缓存写入

如果验证通过，结果会被缓存：散文 + 分析原始 JSON + LLM 使用元数据 + 时间戳。糟糕的渲染结果永远不会被缓存。

### 7. 发布门控与交互式审批

发布门控在 `renderNovel()` 中运行。渲染完成后，检查每个 `RenderSceneResult`：

- **S/X 级别错误（`severity: 'error'`）**：必须修复，不可豁免。门控阻塞，输出错误诊断。
- **C 级别警告（`severity: 'warning'`）**：可通过 `InteractionManager.recordWaiver()` 记录签名豁免后放行。豁免记录包含：门 ID、签署人、时间戳、原因。

如果没有提供 `InteractionManager`，所有 `needsReview === true` 的结果都会阻塞发布。

相关类型和类：

| 符号 | 文件 | 说明 |
|------|------|------|
| `InteractionGate` | `pipeline/interaction-gate.ts` | 门控描述（条件、期望输入、超时） |
| `WaiverRecord` | `pipeline/interaction-gate.ts` | 豁免记录（签署人、时间、原因） |
| `InteractionManager` | `pipeline/interaction-gate.ts` | 门控管理器：`needsApproval()`/`recordWaiver()`/`getPendingGates()` |

`InteractionManager` 的生命周期由调用方管理（典型为 CLI 层）。每个 `renderNovel()` 调用可以传入同一个 `InteractionManager` 实例，以便跨调用累积豁免记录。

## 输出文件

由 `output.ts` 通过 `Storage` 抽象写入：

| 文件 | 内容 |
|---|---|
| `scenes/chapter-NN/{eventId}.md` | 纯散文输出 |
| `scenes/chapter-NN/{eventId}.yaml` | 场景元数据（散文来源、字数、编辑历史） |
| `scenes/chapter-NN/{eventId}_render_request.yaml` | 发送给 LLM 的上下文包 |
| `.nova/responses/{eventId}.json` | 完整原始 LLM 响应 |
| `.nova/derived/threads.yaml` | 线程进度追踪 |
| `.nova/derived/foreshadowing.yaml` | 伏笔状态 |
| `.nova/derived/relationships.yaml` | 关系演变 |
| `.nova/derived/rules.yaml` | 规则证据链 |

所有文件 I/O 都通过 `Storage` 抽象（从不直接使用 `fs`），支持 `FsStorage` 和 `MemoryStorage` 用于测试。
