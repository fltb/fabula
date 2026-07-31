# 渲染管线

**源文件：** `packages/core/src/pipeline/render.ts` (RenderPipeline)，`packages/core/src/pipeline/output.ts` (OutputWriter)
**缓存：** `packages/core/src/cache/render-cache.ts`
**类型：** `packages/core/src/types/event.ts`、`packages/core/src/types/analysis.ts`

渲染管线是 Novalistically 的核心渲染引擎——从结构化叙事规范到 LLM 生成的散文以及机器可解析的自我分析之间的桥梁。它运行两趟 LLM 调用，以 v2 分层规范键缓存结果，通过错误反馈进行重试，并可选择在开发模式下运行双重运行验证。

## RenderPipelineOptions

在构造时配置：

| 选项 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `provider` | `LLMProvider` | 可选 | LLM 提供者抽象；与 `providerFactory` 互斥（同时提供会抛 `PROVIDER_REQUIRED` 错误）。二者都未提供时构造不报错——纯缓存渲染无需提供者，首次真正需要 LLM 调用时才在 `resolveProvider()` 中抛出 `PROVIDER_REQUIRED`（延迟失败） |
| `providerFactory` | `ProviderFactory` | 可选 | 惰性创建提供者的工厂；`resolveProvider()` 在 `await create()` 成功后才把结果记忆化到 `_resolvedProvider`，因此 `create()` 被拒绝或并发缓存未命中时可能被多次调用，不存在恰好一次保证；与 `provider` 互斥 |
| `model` | `string` | 必填 | 模型标识符（例如 `gpt-4o`、`claude-opus-4`） |
| `cacheDir` | `string` | 必填 | v2 分层缓存键渲染缓存的目录 |
| `storage` | `Storage` | 必填 | 文件系统抽象（FsStorage、MemoryStorage） |
| `concurrency` | `number` | `5` | 并行渲染池大小 |
| `maxTokens` | `number` | `10000` | Pass 1 响应的最大令牌数（Pass 2 固定为 12000） |
| `skipCache` | `boolean` | `false` | 强制重新渲染所有场景 |
| `referenceExample` | `string` | 可选 | Pass 1 的"优秀"散文示例 |
| `aggregator` | `ResultAggregator` | 可选 | 渲染后验证聚合器 |
| `maxRetries` | `number` | `3` | 传给 `decideRepairStrategy()` 的修复轮次预算（`maxRepairRounds`）；实际尝试上限由断路器的 `maxRounds * 2` 决定 |
| `doubleRunVerification` | `boolean` | `false` | 仅开发模式：Pass 2 运行两次，比较分析块 |

## 管线流程

### 1. 缓存初始化（v2 分层缓存）

缓存采用 v2 格式（`cache/render-cache.ts`，`CACHE_FORMAT_VERSION = 2`），基于规范化 JSON（`canonicalJson()`：对象键按字典序排序、数组保序、省略 `undefined` 成员）的 SHA-256 哈希构建四层独立的缓存键：

- **LogicalRenderKey**（定义/状态/逻辑变更）：根是 `computeSourceContentHash()`——只对调用方传入的事件文件（按项目相对路径排序的实际字节）与 `definitions/` 目录做递归哈希，并叠加分支/话语作用域哈希（`branchDiscourseScopeHash`）。编辑服务把事件文件数组过滤为 `plan.selectedEventIds`，树渲染路径过滤为当前路由事件——失效范围限于所选/当前事件文件加定义目录，并非全源失效。再与场景契约哈希、世界状态哈希、计划话语哈希、披露摘要哈希、目录版本、图谱哈希、风格档案、模型/路由、语言/目标长度、分析契约/验证器覆盖、插件身份等输入一起规范化后取 SHA-256。
- **SurfaceRenderKey**（组/策略/散文变更）：规范化序列化 LogicalRenderKey 材料 + 组清单哈希 + surface 策略 + 有序的前驱散文哈希 + 提取器/预算/锚点版本。
- **SurfaceValidationKey**（散文/schema/策略变更）：规范化序列化 SurfaceRenderKey 材料 + 散文哈希 + Pass 2 模型/schema + 验证器策略版本。
- **AttemptKey**（每次重试的可变请求身份）：规范化序列化 SurfaceValidationKey 材料 + 尝试编号 + 先前散文/反馈哈希 + 任何实质性变更指纹。每次重试必须变更至少一个材料字段（尝试编号、反馈、模型/路由变更等），否则键不会变化。

`renderScene()` 直接以 `sha256Canonical({ logical, surface })` 计算两层扁平查找键；`computeFlatCacheKey()` 是要求 logical/surface/validation/attempt 全部四层的独立导出工具，管线并不调用它。validation 与 attempt 键只是随 `cache.meta.json` 写入的元数据，`getCachedRender()` 仅检查它们是否为字符串，并不参与查找身份比较。损坏/过期总是表现为一次带诊断（`CacheDiagnostics`）的干净 miss，绝不会出现 `{ cacheHit: true, analysis: null }` 的部分命中。缓存存储在 `cacheDir` 中，渲染前经 `getCachedRender()` 检查（命中时会按当前契约重新解析并重新验证缓存的分析）。不存在“无实质性变更就不重试”的保证：Pass 1 超时只记录一次失败并 `continue` 断路器循环，不修改请求消息、模型、路由或期限，下一次提供者请求可能具有相同的请求哈希。

### 2. Pass 1：散文生成（温度 0.8）

`PromptAssembler` 从 `NarrativeEvent` + `ContextPackage`（角色快照、世界事实、激活规则、线程状态）构建上下文包。LLM 接收到：

- 场景规范（id、title、sceneType、storyTime、pov、sceneBrief、tense 等）
- 带有相关性加权优先级的角色快照
- 世界事实和激活规则
- 风格指导（语调、氛围、角色声音）
- 之前的验证错误（重试时）

温度 0.8 允许创造性的散文变化。默认目标长度约 400 词（`targetLengthWords`，经 `getBuiltInInstructions()` 输出为 `Target length: ~400`）——这只是提示中的近似目标，没有截断或最大长度校验；真正的提供者输出上限是 `maxTokens`（默认 10000）。

### 3. Pass 2：结构化分析（温度 0.3，种子 42）

散文和上下文被反馈给 LLM，使用来自 `buildAnalysisPrompt()`（`packages/core/src/ai/prompts/render-analysis.ts`）的提示。Pass 2 请求设置 `temperature: 0.3`、`seed: 42`、`maxTokens: 12000`，并通过 `responseFormat: { type: 'json_object' }` 要求 JSON 输出。LLM 生成结构化的 `AnalysisResult` JSON：`analysisContentSchema`（`validator/index.ts`）共 20 个字段——14 个必需块（postconditions、preconditions、pov、inventedDetails、quality、threadProgressAchieved、foreshadowingDeployed、narrativeChecks、appearanceChecks、characterReferences、tenseDetected、conflictAnalysis、ruleChecks、knowledgeChecks）+ 6 个可选块（checklistResults、durationDetected、frequencyDetected、voiceDetected、anachronyDetected、focalizationDetected）。提示中的 JSON 模板由激活的分析需求动态构建（`buildDynamicJsonTemplate()`），因此单次请求实际出现的字段可能少于 schema 全集。温度 0.3 + 种子 42 仅被转发给提供者，可复现性是尽力而为且依赖提供者——可选的 `doubleRunVerification` 路径正是用于检测发散结果，且只记录 `Pass 2 unstable` 错误而非强制输出一致。

**带反馈的重试：** `parseAnalysisJSONWithErrors()` 去除 Markdown 代码围栏、解析 JSON，并对照组合 Zod schema（`analysisResultSchema` / `getCombinedValidationSchema()`）验证。解析或验证失败时，具体错误（parse 错误或字段级 Zod issue）被反馈到 Pass 2 提示中修正——最多 4 次子尝试（初始 + 最多 3 次反馈重试），拒绝类别（`empty` / `parse` / `validation`）被记录用于确定性诊断。这不是盲目重试：LLM 会收到具体的字段级别错误，每次重试都携带新的反馈消息以变更请求身份。

### 4. 渲染后验证

如果配置了 `aggregator`（ResultAggregator），`validateRender()` 会在渲染的散文上运行全部 28 个默认验证器（外加插件验证器），可选地消费 Pass 2 `AnalysisResult`。验证失败会驱动断路器（`pipeline/circuit-breaker.ts`）的三轮升级：

- **第 1 轮：** `retry`（策略标签；验证重试会把先前错误消息追加进重试提示，并非完全相同的提示）
- **第 2 轮：** `prompt_fix`——注入修复指导后重试
- **第 3 轮：** `abort`（只是策略标签——`escalate()` 不打开断路器，剩余的第 3 轮尝试仍会执行；真正的停止来自总尝试上限或断路器打开）

每轮最多 2 次尝试（`maxAttemptsPerRound: 2`），总计最多 6 次尝试（`maxRounds: 3`，可由 `RenderPipelineOptions.maxRounds` 覆盖）。此外 `decideRepairStrategy()`（`pipeline/reverse-validate.ts`）按错误数量选择修复策略：1–2 个错误 → `retry`；3–5 个 → `prompt_fix`（`[Revision n/max]` 结构化修复指导）；6–10 个 → `context_enrich`；11 个以上或超过 `maxRetries` 轮 → `abort`。但 `renderScene()` 只把返回的 `guidance` 字符串追加进重试消息（`context_enrich` 也只是追加指导文本，并不补充额外上下文素材），返回的 `shouldRetry`/`abort` 决策不参与控制流——真正的尝试上限由断路器 `maxRounds * 2` 决定。连续 2 次失败触发断路器升级到下一轮。当分析缺失（`analysis === null`）、断路器打开或验证结果仍失败时，场景被标记为 `needsReview: true`。

### 5. 双重运行验证（仅开发模式）

当 `doubleRunVerification: true` 时，Pass 2 在相同的温度 0.3 和种子 42 下再运行一次（`pass2_verify`）。`compareAnalysisBlocks()`（`util/compare-analysis.ts`）使用 `JSON.stringify` 逐字段比较两次运行的分析内容（覆盖全部 20 个 schema 字段中任一存在的键，跳过 `eventId`）。任何差异都会被记录为错误（`Pass 2 unstable: ...`），标记非确定性的分析输出；验证运行本身的失败是非致命的。

### 6. 缓存写入

只有当分析非空且验证结果不含错误级问题（仅警告允许）时，结果才会被缓存——糟糕的渲染永远不会写入缓存。缓存记录包含：散文、分析原始 JSON、Pass 1/Pass 2 的 token 使用量、`promptHash`、时间戳与章节号；四层缓存键（logical/surface/validation/attempt）作为元数据随记录写入。来自 `proseCandidate` 路径的候选不写缓存。

### 7. 发布门控与豁免

发布决策由 `evaluateReleaseDecision()`（`pipeline/release-decision.ts`）统一评估，任何渲染候选都必须满足全部条件才能释放：

- **空散文、缺失分析、重试耗尽（`needsReview: true`）、缺失验证**：一律 `blocked`，输出错误诊断。
- **错误级问题（`severity: 'error'`）**：必须修复，不可豁免。门控阻塞。
- **仅警告问题（`severity: 'warning'`）**：需要豁免。`evaluateReleaseDecision()` 的第四个参数 `interactionManager` 是可选的（`InteractionManager` 本身提供 `needsApproval()`/`recordWaiver()`/`getPendingGates()`，生命周期由调用方管理），但当前生产 API 无法消费它——`EditorialRuntime` 没有 interaction-manager 字段，`renderNovel()` 也接不到该参数，`executeEditorialRender()`/`executeEditorialTreeRender()` 的两处调用都不传第四参。`EditorialRenderRequestV1.waivers`（`WaiverRecordV1[]`）只作为 waiver hashes 参与编译/计划身份（planHash）计算，不参与发布评估。因此当前编辑管线中：警告候选一律 → `pending_waiver`（候选以 pending_waiver 信封存档并更新 latest），即使请求携带匹配豁免也不会放行；请求级豁免的消费需要另行布线。
- **仅信息级问题（`severity: 'info'`）**：无需审批，直接 `accepted`。

`InteractionManager`（`pipeline/interaction-gate.ts`）的生命周期由调用方管理：`needsApproval()`/`recordWaiver()`/`getPendingGates()`。目前 `renderNovel()` 无法传入该实例（`EditorialRuntime` 无此字段），`evaluateReleaseDecision()` 的第四参数只对直接调用该函数的外部调用方可用。

相关类型和类：

| 符号 | 文件 | 说明 |
|------|------|------|
| `InteractionGate` | `pipeline/interaction-gate.ts` | 门控描述（条件、期望输入、超时） |
| `WaiverRecord` | `pipeline/interaction-gate.ts` | 豁免记录（签署人、时间、原因） |
| `InteractionManager` | `pipeline/interaction-gate.ts` | 门控管理器：`needsApproval()`/`recordWaiver()`/`getPendingGates()` |

`InteractionManager` 的生命周期由调用方管理；当前 `renderNovel()` 无法传入该实例（见上文第 7 节）。

## 输出文件

场景、元数据、请求记录与派生文件由编辑管线经 `editorial/publisher.ts` 的 `EditorialPublisher.publish()` 在一个原子工作区事务（`ProjectTransactionCoordinator`）中写入；`pipeline/output.ts::buildAndWriteOutputs()` 只是无生产调用方的独立导出辅助函数（同样通过 `Storage` 抽象）。响应文件也在存档/发布时由同一发布器提升。`workDir` 默认是项目下的 `.nova`（可用 `nova.yaml` 的 `outputDir` 配置）：

| 文件 | 内容 |
|---|---|
| `scenes/chapter-NN/{eventId}.md` | 散文输出（发布时由 publisher 写入）；游戏对话（game-dialogue）场景在写入前会经 `appendPlayerChoicesBlock()` 追加 `<!-- FABULA:PLAYER_CHOICES:v1 -->` 标记与围栏 YAML `playerChoices` 块，不再是纯散文 |
| `scenes/chapter-NN/{eventId}.yaml` | 场景元数据（scene_metadata v1：prose_source、word_count、edit_history 等） |
| `scenes/chapter-NN/{eventId}_render_request.yaml` | 提供者请求/响应审计记录：`RenderPipeline.requestRecords` 捕获每个 Pass 1/Pass 2 的消息数组与 `responseContent`，发布器连同披露摘要（`logicalDisclosureSummary`）与 surface 数据包（`surfaceReferencePacket`）一起写入（有请求记录时） |
| `{workDir}/responses/{eventId}.json` | 该事件最新的 `SceneRevisionEnvelopeV1` 制品——包含散文、Pass 2 分析、验证结果、`releaseDecision`、`providerCalls`、`requestRecords`、错误与重试信息（**不是原始 LLM 响应**；由编辑代码在存档/发布时提升） |
| `{workDir}/revisions/scenes/{eventId}/{revisionId}.json` | 每次场景修订的存档信封（`SceneRevisionStore`） |
| `{workDir}/derived/threads.yaml` | 线程进度追踪 |
| `{workDir}/derived/foreshadowing.yaml` | 伏笔状态 |
| `{workDir}/derived/relationships.yaml` | 关系演变 |
| `{workDir}/derived/rules.yaml` | 规则证据链 |
| `{workDir}/publication.json`、`{workDir}/source-head.json` | 发布清单与源文件头 |

所有文件 I/O 都通过 `Storage` 抽象（从不直接使用 `fs`），支持 `FsStorage` 和 `MemoryStorage` 用于测试。
