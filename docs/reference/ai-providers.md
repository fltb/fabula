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

`CompletionRequest` 包含 `messages`、`model`、`temperature`、`maxTokens`、`stop`、`signal`、`seed` 和 `responseFormat`。`CompletionResponse` 返回 `id`、`model`、`content`、`usage`（token 计数）和 `finishReason`。

## AiSdkProvider（生产环境）

`AiSdkProvider`（`packages/core/src/ai/providers/ai-sdk.ts`）是生产环境使用的提供者，它利用 Vercel AI SDK 的 `createOpenAICompatible()` 来支持任何兼容 OpenAI 的端点。Pass 1（散文生成）和 Pass 2（JSON 分析）均使用 `generateText()`。由于 `structuredOutputs` 并非普遍支持，Pass 2 采用手动 `JSON.parse` 加 Zod 验证（`analysisResultSchema.safeParse()`）的方式。

**环境变量：**

| 变量 | 默认值 | 必填 |
|----------|---------|----------|
| `NOVALISTICALLY_AI_API_KEY` | — | 是 |
| `NOVALISTICALLY_AI_BASE_URL` | `https://opencode.ai/zen/v1` | 否 |
| `NOVALISTICALLY_AI_MODEL` | `deepseek-v4-flash-free` | 否 |

当 `NOVALISTICALLY_AI_BASE_URL` 未设置时，会根据 API 密钥前缀自动检测：`ocg-` → `https://opencode.ai/zen/go/v1`，`sk-` → `https://api.deepseek.com/v1`，否则抛出异常。

Pass 2 的检测条件为 `request.seed !== undefined` 或 `request.responseFormat?.type === 'json_object'`。返回结果会去除 markdown 代码块标记，进行解析，并对照 `analysisResultSchema` 进行验证。JSON 格式错误或 schema 违反将抛出 `LLMError`。

## MockPass2Provider（测试用）

`MockPass2Provider`（`packages/core/src/ai/providers/mock-pass2.ts`）支持在不实际调用 LLM 的情况下进行渲染后验证器的集成测试。它返回预先编写的散文（Pass 1）和预先编写的 `AnalysisResult` JSON（Pass 2）。条目以 `eventId` 为键，可以通过内联方式加载，也可以从包含 `<eventId>.json` 文件（结构为 `{ prose, analysis }`）的 `referenceDir` 中加载。

`MockPass2Provider.isPass2Request()` 通过检查 `seed` 和 `responseFormat` 来静态区分 Pass 1 和 Pass 2。从消息中提取 Event ID 时，会先搜索 `"eventId"` JSON 字段，然后搜索场景字段附近的 `"id"`，最后回退到内容哈希。

## MockProvider（简单测试用）

`MockProvider`（`packages/core/src/ai/providers/mock.ts`）是一个更简单的测试替身，支持三种响应模式：固定的 `responses[]` 数组（轮询）、`generator` 函数（动态生成），或者默认回显最后一条用户消息。支持可配置的延迟以及在第 N 次调用时可选地注入失败。

## Pass 2 JSON 处理

两个提供者处理 Pass 2 的方式相同：`generateText()` 生成字符串，`stripMarkdownFences()` 移除代码块包裹，`JSON.parse()` 生成对象，`analysisResultSchema.safeParse()` 验证 12 个分析块（现有：postconditions、preconditions、pov、inventedDetails、quality、threadProgressAchieved、foreshadowingDeployed；新增：narrativeChecks、appearanceChecks、characterReferences、tenseDetected、conflictAnalysis）。验证失败会抛出硬错误——没有正则表达式回退方案。

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
