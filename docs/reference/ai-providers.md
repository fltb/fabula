# AI 提供商

> **时间**: 2026-08-02 19:17 CST
>
> **当前基线**: 以 [当前系统状态](../current-state.md) 为准（源码核验）；本页描述当前源码中的 provider 边界。

**端口（Core）：** `packages/core/src/ai/types.ts`（LLMProvider 接口、CompletionRequest/Response）
**测试替身（Core）：** `packages/core/src/ai/providers/mock.ts`（MockProvider）、`packages/core/src/ai/providers/mock-pass2.ts`（MockPass2Provider，经 `@novalistically/core/testing` 导出）
**生产 provider（Node Host）：** `packages/node-host/src/providers/ai-sdk.ts`（AiSdkProvider）、`packages/node-host/src/providers/file-mock-pass2.ts`（FileMockPass2Provider）
**提示词模板：** `packages/core/src/ai/prompts/`（scene-render、render-analysis、prose-only、thread-status）

Core 只定义 `LLMProvider` 端口与纯内存测试替身，不实现生产 provider；Node Host 通过该端口注入 `AiSdkProvider` / `FileMockPass2Provider`，Core 永远看不到 base URL、API key 或 reference 目录。

## LLMProvider 接口

所有 LLM 提供者都实现 `LLMProvider` 接口（`packages/core/src/ai/types.ts`）：

```typescript
interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
```

`CompletionRequest` 包含 `messages`、`model?`、`temperature?`、`maxTokens?`、`stop?`、`signal?`、`seed?`、`responseFormat?` 和 `taskType`（`'pass1' | 'pass2' | 'summary'`——`AiSdkProvider` 的 routing 依靠它选择模型）。`CompletionResponse` 返回 `id`、`model`、`content`、`usage`（token 计数）和 `finishReason`。没有 `completeStream`。

## AiSdkProvider（生产环境，Node Host）

`AiSdkProvider`（`packages/node-host/src/providers/ai-sdk.ts`）是生产 provider，利用 Vercel AI SDK 的 `createOpenAICompatible()` 支持任何兼容 OpenAI 的端点，Pass 1（散文生成）与 Pass 2（JSON 分析）都经 `generateText()`。由于 `structuredOutputs` 并非普遍支持，Pass 2 不依赖服务端 schema 强制——`complete()` 返回原始文本，markdown 围栏去除、`JSON.parse` 与 Zod 验证统一由渲染管线（`parseAnalysisJSONWithErrors()`）完成。

**环境变量：**

| 变量 | 默认值 | 必填 |
|----------|---------|----------|
| `NOVALISTICALLY_AI_API_KEY` | — | 是（未设置且未传 `apiKey` 时构造抛错） |
| `NOVALISTICALLY_AI_BASE_URL` | `https://opencode.ai/zen/v1` | 否 |
| `NOVALISTICALLY_AI_MODEL` | `deepseek-v4-flash-free` | 否 |

`baseURL`/`apiKey`/`model` 均可通过构造选项覆盖（优先于环境变量）。不做 API 密钥前缀检测。此外支持可选的 `routing` 配置按任务类型选择模型：`pass1` → `routing.pass1`，`pass2` → `routing.pass2`，`summary` → `routing.summary`，未配置对应项时回退 `routing.default`；未配置 routing 时始终用基础 `model`。

Pass 2 的检测条件为 `request.seed !== undefined` 或 `request.responseFormat?.type === 'json_object'`。检测到 Pass 2 时使用 AI SDK 的 `Output.json()` 请求 JSON 输出，但 `complete()` 返回的是 `result.text`（原始文本）——**解析与验证不在 provider 内进行**；底层 SDK 异常统一包装为 `LLMError`。

CLI 不自动读取 `.env`；凭据与模型选择由 Host 边界（环境或构造选项）显式提供。

## MockPass2Provider（Core 测试替身，纯内存）

`MockPass2Provider`（`packages/core/src/ai/providers/mock-pass2.ts`，经 `@novalistically/core/testing` 导出）支持在不实际调用 LLM 的情况下进行渲染后验证器的集成测试。它返回预先编写的散文（Pass 1）和预先编写的 `AnalysisResult` JSON（Pass 2）。条目以 `eventId` 为键，由 `entries` 内联提供；`latencyMs` 模拟延迟。Core 的替身不接收任何文件路径。

`MockPass2Provider.isPass2Request()` 通过检查 `seed` 和 `responseFormat` 静态区分 Pass 1 和 Pass 2。从消息中提取 Event ID 时，会先搜索任意位置的 `"eventId"` JSON 字段，然后搜索任意位置的 `"id"` 字段，最后回退到最后一条用户消息的内容哈希（`msg-<hash>`）。

## FileMockPass2Provider（Node Host fixture 适配器）

`FileMockPass2Provider`（`packages/node-host/src/providers/file-mock-pass2.ts`）在创建 Core 的纯内存 `MockPass2Provider` 之前把 reference 文件物化为条目；Core 本身不接收路径。`referenceDir` 中的 `<eventId>.json` 文件结构为 `{ prose, analysis }`（形状非法即抛错），目录按文件名排序读取；`loadReferenceEntries()` 可单独使用。内联 `entries` 与文件条目合并（内联优先）。CLI `nova render` / `revise` / `render-tree` 的 `--provider mock-pass2 --reference-dir <dir>` 使用它。

## MockProvider（Core 简单测试替身）

`MockProvider`（`packages/core/src/ai/providers/mock.ts`，经 `@novalistically/core/testing` 导出）是更简单的测试替身，支持三种响应模式：固定的 `responses[]` 数组（按调用顺序依次消耗，耗尽后回退）、`generator` 函数（按请求动态生成），或者默认回显最后一条用户消息。支持可配置的 `latencyMs`、在第 N 次调用时可选注入失败（`failOnCall` / `failMessage`），并记录 `calls[]` / `callCount` / `lastRequest`。

## Pass 2 JSON 处理

生产与测试 provider 都只负责返回原始内容字符串；**解析与验证统一发生在管线层**（`pipeline/render.ts` 的 Pass 2 重试循环与 `evaluateProseCandidate()`）：

1. `parseAnalysisJSONWithErrors()` 去除 Markdown 代码围栏（```json ... ```）。
2. `JSON.parse()` 生成对象；失败记录 `parse` 拒绝类别。
3. 对照组合 Zod schema 验证。`AnalysisResult` 信封是 `{ eventId, protocol, observations, analysis }`（`analysisResultSchema`，strict）：`protocol` 固定精确测量配置（prose hash、schema、model、provider、sampling、validator/reference policy 等），`observations` 为每个激活的顶层分析字段记录 `produced` / `abstained` / `ambiguous` 处置并校验与 payload 的配对，`analysis` 是动态领域 payload。静态回退 `analysisContentSchema` 覆盖 20 个字段（14 个必需：postconditions、preconditions、pov、inventedDetails、quality、threadProgressAchieved、foreshadowingDeployed、narrativeChecks、appearanceChecks、characterReferences、tenseDetected、conflictAnalysis、ruleChecks、knowledgeChecks；6 个可选：checklistResults、durationDetected、frequencyDetected、voiceDetected、anachronyDetected、focalizationDetected）；有插件/分析契约时使用 `getCombinedValidationSchema()`——默认 `ResultAggregator` 下 `ChecklistValidator.getAnalysisRequirements()` 贡献非可选的 `checklistResults`，组合生产 schema 因此有 **15 个必需字段**，仅 5 个 Genette 块（duration/frequency/voice/anachrony/focalization）可选。

验证失败返回字段级 Zod issue，作为反馈注入下一次 Pass 2 提示（带反馈的重试，最多 4 次子尝试：初始 + 最多 3 次重试），拒绝类别（`empty` / `parse` / `validation`）被记录用于确定性诊断。没有正则表达式回退方案；全部子尝试耗尽后 Pass 2 失败，场景被标记为 `needsReview`。

## 配置示例

```typescript
// 环境变量（由 Host 边界提供；CLI 不自动读取 .env）
process.env['NOVALISTICALLY_AI_API_KEY'] = 'ocg-...';
process.env['NOVALISTICALLY_AI_MODEL'] = 'deepseek-v4-flash-free';

// 代码（Node Host 导出）
import { AiSdkProvider } from '@novalistically/node-host';
const provider = new AiSdkProvider({
  baseURL: 'https://opencode.ai/zen/v1',
});
const response = await provider.complete({
  messages: [{ role: 'user', content: 'Write prose...' }],
  temperature: 0.8,
  taskType: 'pass1',
});
```
