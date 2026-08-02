# Pass 2 分析

**源类型：** `packages/core/src/types/analysis.ts` (AnalysisResult)、`packages/core/src/validator/index.ts` (AnalysisContent — 唯一声明处，为 `z.infer<typeof analysisContentSchema>`)
**Schema：** `packages/core/src/schemas/analysis.ts` (buildAnalysisResultSchema、analysisResultSchema、parseAnalysisJSON、parseAnalysisJSONWithErrors)、`packages/core/src/validator/index.ts` (analysisContentSchema、AnalysisContent)
**提示：** `packages/core/src/ai/prompts/render-analysis.ts` (buildAnalysisPrompt)

> 本页为 current reference，与 [`docs/current-state.md`](../current-state.md)（2026-08-02 源码核验基线）同步。

Pass 2 是两趟渲染管线中的结构化自我分析阶段。在 LLM 生成散文（Pass 1，温度 0.8）后，同一篇散文加上完整上下文以温度 0.3 和种子 42 被反馈给 LLM，生成一个机器可解析的 JSON 分析结果。这是一个**硬性要求**——Pass 2 不可用（缺失 analysis）会让该场景在 release 决策中 `blocked`（`missing analysis output`，没有 waiver 路径），且没有正则表达式回退。

## Pass 2 是什么

Pass 2 要求 LLM 扮演文学编辑和质量保证代理的角色：给定场景规范和渲染出的散文，生成一个结构化分析，评估散文与规范的匹配程度。它**不是**一个独立的验证步骤——验证器在其 `validatePost()` 方法中消费此分析，用于正则表达式无法执行的语义检查。

## 20 个 schema 字段（14 必需 + 6 可选）

定义在 `AnalysisContent`（`validator/index.ts` 中由 `analysisContentSchema` 推断；`types/analysis.ts` 只声明外层 `AnalysisResult`）中，共 20 个字段——14 个必需块 + 6 个可选块：

| 块 | 状态 | 类型 | 描述 |
|---|---|---|---|
| `postconditions` | 必需 | `{ covered, dropped }` | 散文中覆盖了哪些后置条件 |
| `preconditions` | 必需 | `{ violated }` | 任何被违反的前提条件 |
| `pov` | 必需 | `{ consistent, leaks }` | 视角一致性和视角泄露 |
| `inventedDetails` | 必需 | `InventedDetail[]` | 散文中不属于规范的细节 |
| `quality` | 必需 | `{ proseScore, maxScore, strengths, weaknesses, estimatedWordCount }` | 自我评估的散文质量（分数/满分、优点、缺点、估算字数） |
| `threadProgressAchieved` | 必需 | `string[]` | 已推进的线程 ID |
| `foreshadowingDeployed` | 必需 | `string[]` | 在散文中部署的伏笔 ID |
| `narrativeChecks` | 必需 | `NarrativeCheck[]` | 实体级叙事属性检查（entityId、attribute、hint、evidence、matchLevel） |
| `appearanceChecks` | 必需 | `AppearanceCheck[]` | 角色外貌一致性检查（entityId、feature、declared、evidence、matchLevel） |
| `characterReferences` | 必需 | `CharacterReference[]` | 每个角色使用的名称（entityId、namesUsed） |
| `tenseDetected` | 必需 | `TenseDetected` | `"past"` \| `"present"` \| `"mixed"` |
| `conflictAnalysis` | 必需 | `{ primaryType, resolutionAchieved }` | 冲突类型和解决状态 |
| `ruleChecks` | 必需 | `RuleCheck[]` | 世界规则合规性检查 |
| `knowledgeChecks` | 必需 | `KnowledgeCheck[]` | 知识边界违规检测 |
| `checklistResults` | 可选 | `ChecklistResult[]` | 叙事清单维度覆盖结果（由 ChecklistValidator 驱动） |
| `durationDetected` | 可选 (S6a) | `DurationDetected` | Genette 时长检测：`scene` \| `summary` \| `ellipsis` \| `pause` \| `stretch` |
| `frequencyDetected` | 可选 (S6b) | `FrequencyDetected` | Genette 频率检测：`singulative` \| `repeating` \| `iterative` |
| `focalizationDetected` | 可选 (S6c) | `FocalizationDetected` | Genette 聚焦检测：`zero` \| `internal` \| `external` |
| `voiceDetected` | 可选 (S6d) | `{ level, relation }` | Genette 叙事声音检测（叙事层级 + 同/异故事） |
| `anachronyDetected` | 可选 (S6e) | `AnachronyDetected` | Genette 时序倒错检测：`analepsis` \| `prolepsis` \| `none` |

## Envelope：eventId / protocol / observations / analysis

`AnalysisResult`（`types/analysis.ts`）是 Pass 2 的外层测量记录，含四个字段：

- **`eventId`** — 被测场景的事件 ID。
- **`protocol`** — `ValidationKey`，精确测量协议：散文（proseHash）、激活 schema、模型、提示、采样、validator/reference 策略。解析器把解析出的协议与 `buildAnalysisPrompt()` 嵌入提示的真实期望协议逐字段比较——任何缺失、多余或不同的字段都 fail closed（`protocolMatches()`）。
- **`observations`** — 按激活的顶层分析字段键控的测量记录（`AnalysisObservation`），每个字段恰好一条 disposition：
  - `produced`：字段测量完成，规范 payload 存在于 `analysis[field]` 且通过块 schema；`evidence` 是散文的逐字引用
  - `abstained`：无法测量，无规范 payload，附 `reason`
  - `ambiguous`：单次评估发现至少两个文本支持的合理解读，无规范 payload（不是多评估者共识，绝不叫 `contested`）
- **`analysis`** — 原有动态 domain payload（`Record<string, unknown>`，块形状不变；插件可在运行时贡献字段）。

顶层 schema 由 `buildAnalysisResultSchema()` 动态构建：每个激活字段在顶层都是可选的（`produced` 才要求存在、`abstained`/`ambiguous` 可省略 payload），配对 refinement（`pairObservationsWithPayload()`）再强制：`produced` ⇒ payload 存在且 schema 有效；`abstained`/`ambiguous` ⇒ payload 缺失；每个存在的 payload 与每个必需激活字段恰好对应一条 observation。解析器拿到散文时，每条 evidence 引用还会被校验为渲染散文的非空精确子串（基于 `protocol.proseHash`）。

observation 记录的是“测量是否产生”，不是“测量结论为真”；observations 从不进入 WorldState、DiscourseState、epistemic ledger/catalog 或 reference index。

### MatchLevel 枚举

由 `NarrativeCheck`、`AppearanceCheck` 和 `KnowledgeCheck` 使用：

| 值 | 含义 |
|---|---|
| `exact` | 散文与声明规范精确匹配 |
| `similar` | 散文一致但并非精确匹配 |
| `absent` | 期望的细节在散文中缺失 |
| `contradicted` | 散文直接与规范相矛盾 |

## 动态生成（AnalysisBlockRequirement）

并非所有块在每次 Pass 2 提示中都会被请求。`AnalysisBlockRequirement` 系统驱动动态提示构建：

1. 每个验证器实现 `getAnalysisRequirements()`，返回一个或多个 `AnalysisBlockRequirement` 对象，每个对象包含：
   - `field`：JSON 字段路径（例如 `narrativeChecks`、`ruleChecks`、`pov.leaks`）
   - `attributes?`：对于键控块（如 `narrativeChecks`），为 LLM 应检查的属性值
   - `schema`：该分析块的 Zod schema——提示中自动生成 JSON 示例（`zodExample`）
   - `instruction`：以字段名称为前缀的 LLM 指令文本

2. `ResultAggregator.getAnalysisRequirements()` 从所有验证器收集需求，**检测属性冲突**——如果两个验证器在同一字段上声明相同的属性，则抛出硬错误。

3. `buildDynamicJsonTemplate()`（在提示模块中）仅根据激活的需求构建 JSON Schema 模板。对于 `narrativeChecks`，多个验证器的属性会被合并（例如 `pacing | time_period | pronoun_consistency`）。

这意味着：如果没有验证器需要 `appearanceChecks`，则该字段会完全从 Pass 2 提示中省略，从而减少令牌使用。

## 输出格式与解析（json_object）

Pass 2 请求在管线层（`pipeline/render.ts`）统一设置 `responseFormat: { type: 'json_object' }`，并携带 `temperature: 0.3`、`seed: 42`、`maxTokens: 12000`。生产提供者 `AiSdkProvider` 检测到 Pass 2（`seed !== undefined` 或 `responseFormat?.type === 'json_object'`）时，额外通过 AI SDK 的 `Output.json()` 请求 JSON 输出，但 `complete()` 返回的是原始文本——**解析与验证统一发生在管线层**，而不是提供者内部：

1. `parseAnalysisJSONWithErrors()` 去除 Markdown 代码围栏（```json ... ```）。
2. `JSON.parse()` 解析为对象；失败记录 `parse` 拒绝类别。
3. 对照动态构建的顶层 schema（`buildAnalysisResultSchema()`：envelope `{ eventId, protocol, observations, analysis }`，payload 字段按激活分析契约可选；有插件时以 `getCombinedValidationSchema()` 扩展）验证；失败返回字段级 Zod issue（`validation` 拒绝类别）。
4. `protocolMatches()` 把解析出的 `protocol` 与期望协议（`buildAnalysisPrompt` 返回的真实协议）逐字段比较——任何缺失、多余或不同的字段都 fail closed。
5. 配对 refinement（`pairObservationsWithPayload()`）强制 observations↔payload 对应关系（见 Envelope 一节）。
6. 提供散文时，每条 evidence 引用必须是渲染散文的非空精确子串。

验证失败时，具体错误详情会被反馈给 LLM 进行修正（带反馈的重试）——最多 4 次子尝试（初始 + 最多 3 次反馈重试），拒绝类别（`empty` / `parse` / `validation`）被记录。没有正则表达式回退方案；全部子尝试耗尽后 Pass 2 视为失败：`analysis` 置 null，`RenderSceneResult.errors` 记录对应拒绝类别的错误（`Pass 2 exhausted: ...`），`needsReview` 置 true。随后 release 决策路径（`evaluateReleaseDecision()`）对缺失 analysis 或耗尽重试一律返回 `blocked`（reason：`missing analysis output` / `exhausted retries — needs review`），场景进入 review 路径——这是**逐场景**的 release/review 判定，不会让所有外层处理立即终止，其他场景照常渲染。

同一套解析/验证逻辑也暴露为 `evaluateProseCandidate()`（`pipeline/render.ts`，Pass 2 解析 + Zod + aggregator + release 判定），供编辑服务等外部消费者复用。
