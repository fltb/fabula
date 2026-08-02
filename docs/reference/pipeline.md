# 渲染管线

> **时间**: 2026-08-02 19:17 CST
>
> **当前基线**: 以 [当前系统状态](../current-state.md) 为准（源码核验）；本页描述当前源码中的渲染管线。

**源文件：** `packages/core/src/pipeline/render.ts`（RenderPipeline）、`packages/core/src/pipeline/output.ts`（纯 output intents）、`packages/core/src/pipeline/circuit-breaker.ts`、`packages/core/src/pipeline/release-decision.ts`、`packages/core/src/pipeline/reverse-validate.ts`
**缓存：** `packages/core/src/cache/render-cache.ts`（纯键材料）、`packages/core/src/ports/render-cache-repository.ts`（仓库端口）、`packages/node-host/src/cache/file-render-cache-repository.ts`（文件仓库）
**类型：** `packages/core/src/types/event.ts`、`packages/core/src/types/analysis.ts`

渲染管线是 Novalistically 的核心渲染引擎——从不可变 source snapshot + 注入的语义端口到 LLM 生成的散文以及机器可解析的自我分析之间的桥梁。它运行两趟 LLM 调用，以分层规范缓存键缓存结果，通过错误反馈进行重试，并可选择在开发模式下运行双重运行验证。Core 本身不持有 Storage、不写任何文件：文件物化是 Host（Node Host repository）的职责。

## RenderPipelineOptions

在构造时配置：

| 选项 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `provider` | `LLMProvider` | 可选 | LLM 提供者抽象；与 `providerFactory` 互斥（同时提供在构造时抛 `PROVIDER_REQUIRED` 错误） |
| `providerFactory` | `ProviderFactory` | 可选 | 惰性创建提供者的工厂；`resolveProvider()` 把成功结果记忆化到 `_resolvedProvider`（成功后恰好调用一次 `create()`）；`create()` 被拒绝时不会记忆化，下一次解析会再次调用，失败路径不保证恰好一次 |
| `model` | `string` | 必填 | 模型标识符（例如 `gpt-4o`、`claude-opus-4`） |
| `runtimeServices` | `Pick<CoreRuntimeServices, 'renderCache' \| 'promptTemplates'> & Partial<Pick<CoreRuntimeServices, 'clock' \| 'ids'>>` | 必填 | 注入的语义端口：`renderCache`（`RenderCacheRepository`）与 `promptTemplates`（`PromptTemplateCatalog`）必填，`clock` / `ids` 可选；没有 `cacheDir` / `storage` 选项 |
| `validatorPolicyId` | `string` | 必填 | validator 策略身份（editorial 路径传 `plan.planSummary.validationIdentity`）；空值在构造时抛 `VALIDATOR_POLICY_REQUIRED` |
| `concurrency` | `number` | `5` | 并行渲染池大小 |
| `maxTokens` | `number` | `10000` | Pass 1 响应的最大令牌数（Pass 2 固定为 12000） |
| `maxRetries` | `number` | `3` | 传给 `decideRepairStrategy()` 的修复轮次预算（`maxRepairRounds`）；实际尝试上限由断路器的 `maxRounds * 2` 决定 |
| `maxRounds` | `number` | `3` | 断路器升级轮数上限（每轮最多 2 次尝试，总计最多 6 次） |
| `skipCache` | `boolean` | `false` | 强制重新渲染所有场景 |
| `referenceExample` | `string` | 可选 | Pass 1 的"优秀"散文示例 |
| `aggregator` | `ResultAggregator` | 可选 | 渲染后验证聚合器；提供时还会启用缓存命中后的重新校验 |
| `doubleRunVerification` | `boolean` | `false` | 仅开发模式：Pass 2 运行两次，比较分析块 |
| 其它 | — | — | `signal`、`entities`、`validatorOverrides`、`analysisContract`、`logger`、`traceCollector`、`eventBus`、`targetLengthWords`（默认 400）、`language`（默认 `'en'`）、`pluginHooksManager`、`styleProfile`、`retryJitter`（默认确定性 `DEFAULT_RETRY_JITTER`）、`providerProfile` |

## 管线流程

### 1. 缓存初始化（分层规范缓存）

缓存身份是纯 Core 计算（`cache/render-cache.ts`），持久化经 `RenderCacheRepository` 端口由 Host 提供（Node Host 默认 `.nova/render-cache`，键被视为不透明值仅用于派生文件名）。键材料用规范化 JSON（`canonicalJson()`：对象键按字典序排序、数组保序、省略 `undefined` 成员）的 SHA-256 哈希：

- **LogicalRenderKey**（定义/状态/逻辑变更）：根是 `computeSourceContentHash(snapshot)` —— 直接返回 Host 物化的 `ProjectSourceSnapshotV1.sourceHash`（内容身份，不是 Git 历史）。再与场景契约哈希（`promptContractHash`）、世界状态哈希、planned discourse 哈希（同时充当 branch/discourse scope 哈希）、披露摘要哈希、目录版本哈希、图谱哈希、风格档案哈希、模型（同时充当 provider ID 与版本）、language、target length、分析契约哈希、validator override 哈希、插件身份哈希等材料一起规范化后取 SHA-256。
- **SurfaceRenderKey**（组/策略/散文变更）：规范化序列化 LogicalRenderKey 材料 + 组清单哈希 + surface 策略哈希 + 有序的前驱散文哈希 + 提取器版本（`'1'`）。
- 另有独立的 **SurfaceValidationKey** / **AttemptKey** 材料构建器与 `computeFlatCacheKey()`（四层汇总）作为 tooling 导出（`@novalistically/core/tooling`，测试使用）；渲染管线本身**不调用**它们，也不把它们写入元数据文件。

`renderScene()` 用 `buildLogicalKeyMaterial` / `buildSurfaceKeyMaterial` 计算两层材料，再以 `sha256Canonical({ logical, surface })` 得到扁平键；实际查找经 `LayeredCacheKey`（`version: 1`，`{ sourceHash, layers: { eventId, logical, surface } }`）走 `getCachedRender()`。**没有 `CACHE_FORMAT_VERSION = 2`，也没有 `cache.meta.json`**：记录是 `RenderCacheRecord`（`version: 1`，`{ key, recordHash, output }`），仓库失败与损坏记录一律表现为带诊断（`CacheDiagnostics`）的干净 miss，绝不会出现 `{ cacheHit: true, analysis: null }` 的部分命中。

缓存命中后 cached analysis 会按**当前**协议重新 parse（协议从 cached prose + 当前配置 + prompt 材料确定性重建，任何 prompt/schema/sampling/policy 变更都 fail closed 并视为 miss），随后经 `aggregator.validatePost()` 重新校验，再走 release gate。`computeSourceContentHash` 只对 Host 物化的 snapshot 生效——编辑服务把事件文件过滤为 `plan.selectedEventIds`、树渲染过滤为当前路由事件属于 job 构造阶段的选择，失效范围限于所选事件 + 全源 hash。

### 2. Pass 1：散文生成（温度 0.8）

`PromptAssembler` 从 `NarrativeEvent` + `ContextPackage`（角色快照、世界事实、激活规则、线程状态、logical disclosure summary、surface packet、revision 基础散文等）构建上下文包。LLM 接收到：

- 场景规范（id、title、sceneType、storyTime、pov、sceneBrief、tense 等）
- 带有相关性加权优先级的角色快照
- 世界事实和激活规则
- 风格指导（语调、氛围、角色声音、style profile）
- 之前的验证错误（重试时）

温度 0.8 允许创造性的散文变化。默认目标长度约 400 词（`targetLengthWords`，经 `getBuiltInInstructions()` 输出为 `Target length: ~400`）——这只是提示中的近似目标，没有截断或最大长度校验；真正的提供者输出上限是 `maxTokens`（默认 10000）。Pass 1 提示模板可经注入的 `PromptTemplateCatalog`（名称 `pass1`）覆盖；目录缺失或查询失败时回退内置模板。

### 3. Pass 2：结构化分析（温度 0.3，种子 42）

散文和上下文被反馈给 LLM，使用来自 `buildAnalysisPrompt()`（`packages/core/src/ai/prompts/render-analysis.ts`）的提示。Pass 2 请求由 `PASS2_SAMPLING_CONFIG` 统一定义：`temperature: 0.3`、`seed: 42`、`maxTokens: 12000`、`responseFormat: { type: 'json_object' }`（该常量同时是 `samplingConfigHash` 的唯一来源）。提示采用两阶段构造：先由规范 prompt 材料派生 `analysisPromptHash`，再把**真实** protocol 嵌入最终消息。LLM 生成结构化的 `AnalysisResult` JSON，信封为 `{ eventId, protocol, observations, analysis }`（见 `reference/ai-providers.md`）。`analysisContentSchema`（`validator/index.ts`）共 20 个字段——14 个必需块 + 6 个可选块（checklistResults 与 5 个 Genette 维度）。提示中的 JSON 模板由激活的分析需求动态构建（`buildDynamicJsonTemplate()`），因此单次请求实际出现的字段可能少于 schema 全集。温度 0.3 + 种子 42 仅被转发给提供者，可复现性是尽力而为且依赖提供者。

**带反馈的重试：** `parseAnalysisJSONWithErrors()` 去除 Markdown 代码围栏、解析 JSON，并对照组合 Zod schema（`analysisResultSchema` / `getCombinedValidationSchema()`）验证，同时校验 protocol、observations 与 payload 的配对和证据。解析或验证失败时，具体错误（parse 错误或字段级 Zod issue）被反馈到 Pass 2 提示中修正——最多 4 次子尝试（初始 + 最多 3 次反馈重试），拒绝类别（`empty` / `parse` / `validation`）被记录用于确定性诊断。这不是盲目重试：每次重试都携带新的反馈消息以变更请求身份（空内容也会注入结构化反馈，绝不盲试）。

### 4. 渲染后验证

如果配置了 `aggregator`（ResultAggregator），`validatePost()` 会在渲染的散文上运行全部 28 个默认验证器（外加插件验证器），可选地消费 Pass 2 `AnalysisResult`（含 uncertainty preflight：`abstained`/`ambiguous` 字段不会交给验证器，而是产生 `analysis_uncertainty` warning；observationRef/pointer 非法以 `compiler_invariant` 错误 fail closed）。验证失败驱动断路器（`pipeline/circuit-breaker.ts`）的三轮升级：

- **第 1 轮：** `retry`（验证重试会把先前错误消息追加进重试提示，并非完全相同的提示）
- **第 2 轮：** `prompt_fix`——注入修复指导后重试
- **第 3 轮：** `abort`（断路器打开，剩余尝试不再执行；真正的停止来自总尝试上限或断路器打开）

每轮最多 2 次尝试（`maxAttemptsPerRound: 2`），总计最多 `maxRounds * 2` = 6 次尝试（`maxRounds` 可由 `RenderPipelineOptions.maxRounds` 覆盖）。连续 2 次失败触发 `escalate()` 升级到下一轮；`recordFailure()` 的 `failureThreshold: 3` 也会直接打开断路器。`decideRepairStrategy()`（`pipeline/reverse-validate.ts`）按错误数量选择修复策略：1–2 个错误 → `retry`；3–5 个 → `prompt_fix`（`[Revision n/max]` 结构化修复指导）；6–10 个 → `context_enrich`；11 个以上或轮次超过 `maxRetries` → `abort`。`renderScene()` 把返回的 `guidance` 追加进重试消息（`context_enrich` 也只是追加指导文本），真正的尝试上限由断路器决定。**Pass 1 超时只在携带实质性变更（不同模型/routing/期限）时可重试**：没有材料变更的超时只记录失败并让断路器处理，绝不盲试。当分析缺失（`analysis === null`）、断路器打开或验证结果仍失败时，场景被标记为 `needsReview: true`。

### 5. 双重运行验证（仅开发模式）

当 `doubleRunVerification: true` 时，Pass 2 在相同采样配置下再运行一次（`pass2_verify`）。`compareAnalysisBlocks()`（`util/compare-analysis.ts`）使用 `JSON.stringify` 逐字段比较两次运行的分析内容（覆盖任一存在的键，跳过 `eventId`）。任何差异都会被记录为错误（`Pass 2 unstable: ...`），标记非确定性的分析输出；验证运行本身的失败是非致命的。双重运行响应按与主运行**相同**的 protocol 与 prose 验证，mismatch fail closed。

### 6. 缓存写入

只有当分析非空、结果可解析为 JSON 且验证结果不含错误级问题（仅警告允许）时，结果才会被缓存——糟糕的渲染永远不会写入缓存；`proseCandidate`（外部提供散文/采纳/回滚）路径不写缓存。缓存记录（`RenderCacheRecord` v1）包含：散文、analysis 原始 JSON、evidenceHash、Pass 1/Pass 2 的 token 使用量、`promptHash`、`renderedAt` 与章节号；`key` 携带 `LayeredCacheKey`（version 1，layers = eventId + logical + surface）。

### 7. 发布门控与豁免

发布决策由 `evaluateReleaseDecision(candidate, scopeHash, validationIdentity, interactionManager?)`（`pipeline/release-decision.ts`）统一评估，任何渲染候选都必须满足全部条件才能释放：

- **空散文、缺失分析、重试耗尽（`needsReview: true`）、缺失验证**：一律 `blocked`，输出错误诊断。
- **错误级问题（`severity: 'error'`）**：必须修复，不可豁免。门控阻塞。
- **仅警告问题（`severity: 'warning'`）**：需要豁免。`evaluateReleaseDecision()` 的第四个参数 `interactionManager` 是可选的（`InteractionManager` 本身提供 `needsApproval()` / `recordWaiver()` / `getPendingGates()` / `hasWaiver()` / `getWaiver()`，生命周期由调用方管理），但当前编辑管线无法消费它——`executeEditorialRender()` 的两处调用（render / tree render）都不传第四参，`EditorialRuntime` 也没有 interaction-manager 字段。`EditorialRenderRequestV1.waivers`（`WaiverRecordV1[]`）只作为 waiver hashes 参与 planHash 计算，不参与发布评估。因此当前编辑管线中：警告候选一律 → `pending_waiver`（候选以 blocked 信封经 execution repository 存档），即使请求携带匹配豁免也不会放行；请求级豁免的消费需要另行布线。
- **仅信息级问题（`severity: 'info'`）**：无需审批，直接 `accepted`。

相关类型和类：

| 符号 | 文件 | 说明 |
|------|------|------|
| `InteractionGate` | `pipeline/interaction-gate.ts` | 门控描述（条件、期望输入、超时） |
| `WaiverRecord` | `pipeline/interaction-gate.ts` | 豁免记录（签署人、时间、原因） |
| `InteractionManager` | `pipeline/interaction-gate.ts` | 门控管理器：`needsApproval()`/`recordWaiver()`/`getPendingGates()`/`hasWaiver()`/`getWaiver()`；默认使用确定性 epoch clock |

## 输出

Core 的渲染输出是**语义 intents/records**，不是文件写入：

- `RenderSceneResult`（pipeline/render.ts）携带 prose、analysis、usage、`cacheHit`、`errors`、`validation`、`providerCalls`、`requestRecords`（实际请求消息与响应内容；cache 命中时为空数组——刻意不伪造旧请求）、`attempts`、`needsReview`、`pass2Rejection?`。
- `pipeline/output.ts` 的 `buildAndWriteOutputs()` 现在构建**纯 JSON-safe output intents**（`RenderOutputs`：`OutputEntry` + `DerivedData`，threads / foreshadowing / relationships / rules），文件写入由 Host 负责；`appendPlayerChoicesBlock()` 给游戏对话场景追加 `<!-- FABULA:PLAYER_CHOICES:v1 -->` 标记与围栏 YAML `playerChoices` 块。
- 已接受场景、场景修订信封、operation、publication、review、trace 记录经 `CoreExecutionRepository`（注入端口）以 CAS 语义持久化；Node Host 的 `FileExecutionRepository` 默认落在 `.nova/execution/` 下，键只用于派生文件名，从不解释为路径。渲染结果排序仍是 chapter + `narrativeOrder`（catalog/selector 排序），但不进入因果 replay 顺序。
