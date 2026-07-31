# AI 提供商

**源文件：** `packages/core/src/ai/types.ts`（LLMProvider 接口、类型）、`packages/core/src/ai/providers/ai-sdk.ts`（AiSdkProvider）、`packages/core/src/ai/providers/mock-pass2.ts`（MockPass2Provider）、`packages/core/src/ai/providers/mock.ts`（MockProvider）
**提示词模板：** `packages/core/src/ai/prompts/`（buildSceneRenderPrompt、buildAnalysisPrompt、buildProsePrompt、buildThreadStatusPrompt）

## LLMProvider 接口

所有 LLM 提供者都实现 `LLMProvider` 接口（`packages/core/src/ai/types.ts`）：

```typescript
interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  completeStream?(request, onChunk): Promise<CompletionResponse>;
}
```

`CompletionRequest` 包含 `messages`、`model`、`temperature`、`maxTokens`、`stop`、`signal`、`seed`、`responseFormat` 和 `taskType`（`'pass1' | 'pass2' | 'summary'`——`AiSdkProvider.resolveModelId()` 依靠它激活下文描述的 pass1/pass2/summary 路由）。`CompletionResponse` 返回 `id`、`model`、`content`、`usage`（token 计数）和 `finishReason`。

## AiSdkProvider（生产环境）

`AiSdkProvider`（`packages/core/src/ai/providers/ai-sdk.ts`）是生产环境使用的提供者，它利用 Vercel AI SDK 的 `createOpenAICompatible()` 来支持任何兼容 OpenAI 的端点。Pass 1（散文生成）和 Pass 2（JSON 分析）均使用 `generateText()`。由于 `structuredOutputs` 并非普遍支持，Pass 2 不依赖服务端 schema 强制——`complete()` 返回原始文本，markdown 围栏去除、`JSON.parse` 与 Zod 验证统一由渲染管线（`parseAnalysisJSONWithErrors()`）完成。

**环境变量：**

| 变量 | 默认值 | 必填 |
|----------|---------|----------|
| `NOVALISTICALLY_AI_API_KEY` | — | 是（未设置且未传 `apiKey` 时构造抛错） |
| `NOVALISTICALLY_AI_BASE_URL` | `https://opencode.ai/zen/v1` | 否 |
| `NOVALISTICALLY_AI_MODEL` | `deepseek-v4-flash-free` | 否 |

`baseURL`/`apiKey`/`model` 均可通过构造选项覆盖（优先于环境变量）。此外支持可选的 `routing` 配置按任务类型选择模型：`pass1` → `routing.pass1 ?? routing.default`，`pass2` → `routing.pass2 ?? routing.default`，`summary` → `routing.summary ?? routing.default`，未配置时回退到基础 `model`。

Pass 2 的检测条件为 `request.seed !== undefined` 或 `request.responseFormat?.type === 'json_object'`。检测到 Pass 2 时使用 AI SDK 的 `Output.json()` 请求 JSON 输出，但 `complete()` 返回的是 `result.text`（原始文本）——**解析与验证不在提供者内进行**；底层 SDK 异常统一包装为 `LLMError`。

## MockPass2Provider（测试用）

`MockPass2Provider`（`packages/core/src/ai/providers/mock-pass2.ts`）支持在不实际调用 LLM 的情况下进行渲染后验证器的集成测试。它返回预先编写的散文（Pass 1）和预先编写的 `AnalysisResult` JSON（Pass 2）。条目以 `eventId` 为键，可以通过内联方式加载，也可以从包含 `<eventId>.json` 文件（结构为 `{ prose, analysis }`）的 `referenceDir` 中加载。

`MockPass2Provider.isPass2Request()` 通过检查 `seed` 和 `responseFormat` 来静态区分 Pass 1 和 Pass 2。从消息中提取 Event ID 时，会先搜索任意位置的 `"eventId"` JSON 字段，然后搜索任意位置的 `"id"` 字段，最后回退到最后一条用户消息的内容哈希（`msg-<hash>`）。

## MockProvider（简单测试用）

`MockProvider`（`packages/core/src/ai/providers/mock.ts`）是一个更简单的测试替身，支持三种响应模式：固定的 `responses[]` 数组（轮询）、`generator` 函数（动态生成），或者默认回显最后一条用户消息。支持可配置的延迟以及在第 N 次调用时可选地注入失败。

## Pass 2 JSON 处理

生产与测试提供者都只负责返回原始内容字符串；**解析与验证统一发生在管线层**（`pipeline/render.ts` 的 Pass 2 重试循环与 `evaluateProseCandidate()`）：

1. `parseAnalysisJSONWithErrors()` 去除 Markdown 代码围栏（```json ... ```）。
2. `JSON.parse()` 生成对象；失败记录 `parse` 拒绝类别。
3. 对照组合 Zod schema（`analysisResultSchema`，即 `{ eventId, analysis }` 包装的 `analysisContentSchema`；有插件/分析契约时使用 `getCombinedValidationSchema()`）验证。静态回退 `analysisContentSchema` 覆盖 20 个字段（14 个必需：postconditions、preconditions、pov、inventedDetails、quality、threadProgressAchieved、foreshadowingDeployed、narrativeChecks、appearanceChecks、characterReferences、tenseDetected、conflictAnalysis、ruleChecks、knowledgeChecks；6 个可选：checklistResults、durationDetected、frequencyDetected、voiceDetected、anachronyDetected、focalizationDetected）；而默认 `ResultAggregator` 下 `ChecklistValidator.getAnalysisRequirements()` 贡献非可选的 `checklistResults`，组合生产 schema 因此有 **15 个必需字段**，仅 5 个 Genette 块（duration/frequency/voice/anachrony/focalization）可选。

验证失败返回字段级 Zod issue，作为反馈注入下一次 Pass 2 提示（带反馈的重试，最多 4 次子尝试：初始 + 最多 3 次重试）。没有正则表达式回退方案；全部子尝试耗尽后 Pass 2 失败，场景被标记为 `needsReview`。

## 配置示例

```typescript
// 环境变量
process.env['NOVALISTICALLY_AI_API_KEY'] = 'ocg-...';
process.env['NOVALISTICALLY_AI_MODEL'] = 'deepseek-v4-flash-free';

// 代码
import { AiSdkProvider } from '@novalistically/core';
const provider = new AiSdkProvider({
  baseURL: 'https://opencode.ai/zen/v1',
});
const response = await provider.complete({
  messages: [{ role: 'user', content: 'Write prose...' }],
  temperature: 0.8,
});
```
