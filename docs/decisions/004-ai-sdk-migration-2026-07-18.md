# ADR-004: 从手写提供者迁移到 AI SDK

> **时间**: 2026-07-18 21:27 CST
**Date:** 2026-07  
**Status:** Accepted  
**Designer:** Novalistically Core Team  
**File:** `packages/core/src/ai/providers/ai-sdk.ts`

## Context

原始系统有两个手写的 LLM 提供者（`OpencodeZenProvider` 和 `OpencodeGoProvider`），使用原始的 `fetch()` 调用。它们存在若干限制：

- 不支持标准的 `response_format` — Pass 2 JSON 解析依赖于脆弱的正则表达式提取
- 不支持流式传输或结构化输出
- 认证、重试和错误处理的逻辑重复
- 特定于提供者的代码路径随时间推移产生了分化

## Decision

将两个提供者替换为单一的 `AiSdkProvider` 类，使用 Vercel AI SDK 的 `createOpenAICompatible()` 和 `generateText()`：

```typescript
const client = createOpenAICompatible({ name: 'ai-sdk', baseURL, apiKey });
this.model = client(this.modelId);
```

关键设计选择：
- **使用 `generateText()` 而非 `streamText()`**：对于批量散文生成和结构化分析更简单
- **手动 JSON 解析 + Zod 验证**用于 Pass 2：`structuredOutputs` 并非所有提供者都普遍支持（兼容 OpenAI 的端点不等于完全支持结构化输出）
- **统一的环境变量命名约定**：`NOVALISTICALLY_AI_*` 命名空间 — `API_KEY`、`BASE_URL`、`MODEL`

自动检测（ai-sdk.ts:15-18）：
- 未设置 base URL → 默认为 `https://opencode.ai/zen/v1`
- 密钥前缀 `ocg-` → opencode zen go 层级
- 密钥前缀 `sk-` → DeepSeek API

## Consequences

- **删除了 2 个提供者文件**：`opencode-zen.ts` 和 `opencode-go.ts` 已被删除
- **统一配置**：同一个 `AiSdkProvider` 可与 OpenAI、Anthropic、DeepSeek 或任何兼容 OpenAI 的端点配合使用
- **Pass 2 可靠性提升**：AI SDK 一致地处理请求格式化、错误码和响应解析
- **保留的提供者**：`MockProvider`（`mock.ts`）用于单元测试，`MockPass2Provider`（`mock-pass2.ts`）用于集成测试（使用预先编写的分析数据）
- **非结构化输出提供者的回退方案**：手动 `JSON.parse` + `analysisResultSchema.safeParse()`，带有用于带反馈重试的详细错误报告
