# Pass 2 分析

**源类型：** `packages/core/src/types/analysis.ts` (AnalysisResult, AnalysisContent)  
**Schema：** `packages/core/src/schemas/analysis.ts` (analysisResultSchema、parseAnalysisJSON、parseAnalysisJSONWithErrors)  
**提示：** `packages/core/src/ai/prompts/render-analysis.ts` (buildAnalysisPrompt)

Pass 2 是两趟渲染管线中的结构化自我分析阶段。在 LLM 生成散文（Pass 1，温度 0.8）后，同一篇散文加上完整上下文以温度 0.3 和种子 42 被反馈给 LLM，生成一个机器可解析的 JSON 分析结果。这是一个**硬性要求**——Pass 2 不可用将被视为硬错误，且没有正则表达式回退。

## Pass 2 是什么

Pass 2 要求 LLM 扮演文学编辑和质量保证代理的角色：给定场景规范和渲染出的散文，生成一个结构化分析，评估散文与规范的匹配程度。它**不是**一个独立的验证步骤——验证器在其 `validatePost()` 方法中消费此分析，用于正则表达式无法执行的语义检查。

## 14 个分析块

定义在 `AnalysisContent`（`types/analysis.ts`）中：

| 块 | 状态 | 类型 | 描述 |
|---|---|---|---|
| `postconditions` | 已有 | `{ covered, dropped }` | 散文中覆盖了哪些后置条件 |
| `preconditions` | 已有 | `{ violated }` | 任何被违反的前提条件 |
| `pov` | 已有 | `{ consistent, leaks }` | 视角一致性和视角泄露 |
| `inventedDetails` | 已有 | `InventedDetail[]` | 散文中不属于规范的细节 |
| `quality` | 已有 | `{ proseScore, strengths, weaknesses }` | 自我评估的散文质量 |
| `threadProgressAchieved` | 已有 | `string[]` | 已推进的线程 ID |
| `foreshadowingDeployed` | 已有 | `string[]` | 在散文中部署的伏笔 ID |
| `narrativeChecks` | 新增 (P0g) | `NarrativeCheck[]`（可选） | 实体级叙事属性检查（entityId、attribute、hint、evidence、matchLevel） |
| `appearanceChecks` | 新增 (P0g) | `AppearanceCheck[]`（可选） | 角色外貌一致性检查（entityId、feature、declared、evidence、matchLevel） |
| `characterReferences` | 新增 (P0g) | `CharacterReference[]`（可选） | 每个角色使用的名称（entityId、namesUsed） |
| `tenseDetected` | 新增 (P0g) | `TenseDetected`（可选） | `"past"` \| `"present"` \| `"mixed"` |
| `conflictAnalysis` | 新增 (P0g) | `{ primaryType, resolutionAchieved }`（可选） | 冲突类型和解决状态 |
| `ruleChecks` | 新增 (P0h) | `RuleCheck[]`（可选） | 世界规则合规性检查 |
| `knowledgeChecks` | 新增 (P0h) | `KnowledgeCheck[]`（可选） | 知识边界违规检测 |

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
   - `schemaExample`：显示预期 JSON 结构的模板
   - `instruction`：以字段名称为前缀的 LLM 指令文本

2. `ResultAggregator.getAnalysisRequirements()` 从所有验证器收集需求，**检测属性冲突**——如果两个验证器在同一字段上声明相同的属性，则抛出硬错误。

3. `buildDynamicJsonTemplate()`（在提示模块中）仅根据激活的需求构建 JSON Schema 模板。对于 `narrativeChecks`，多个验证器的属性会被合并（例如 `pacing | time_period | pronoun_consistency`）。

这意味着：如果没有验证器需要 `appearanceChecks`，则该字段会完全从 Pass 2 提示中省略，从而减少令牌使用。

## 三层输出模式

| 层级 | 提供者 | 行为 |
|---|---|---|
| L1 `json_schema` | OpenAI、Anthropic | 带严格 JSON Schema 强制约束的结构化输出 |
| L2 `json_object` | DeepSeek | 无 Schema 强制约束的 JSON 模式（之后由 Zod 验证） |
| L3 仅提示 | 其他 | 提示中的自由文本 JSON，之后由 Zod 验证 |

对于所有层级，`parseAnalysisJSONWithErrors()` 处理响应：去除 Markdown 代码围栏、解析 JSON、根据 `analysisResultSchema`（Zod）进行验证。若失败，错误详情会被反馈给 LLM 进行修正（带反馈的重试，最多 2 次尝试）。
