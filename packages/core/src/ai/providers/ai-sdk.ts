// ============================================================================
// AI Provider — Vercel AI SDK Provider
// ============================================================================
//
// Uses createOpenAICompatible() for any OpenAI-compatible endpoint and
// generateText() for both Pass 1 (prose) and Pass 2 (JSON analysis).
// Manual JSON parse + Zod validation for Pass 2 since structuredOutputs
// is not universally supported by all providers.
//
// Environment Variables:
//   NOVALISTICALLY_AI_API_KEY    Required — the API key
//   NOVALISTICALLY_AI_BASE_URL   Optional — override auto-detected endpoint
//   NOVALISTICALLY_AI_MODEL      Optional — override model (default: deepseek-v4-flash)
//
// When NOVALISTICALLY_AI_BASE_URL is not set, auto-detection from key prefix:
//   ocg-  → https://opencode.ai/zen/go/v1
//   sk-   → https://api.deepseek.com/v1
//   else  → throws (must set NOVALISTICALLY_AI_BASE_URL)
// ============================================================================

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import type { LLMProvider, CompletionRequest, CompletionResponse } from '../types.ts';
import { LLMError } from '../types.ts';
import { analysisResultSchema } from '../../schemas/analysis.js';

export interface AiSdkProviderOptions {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export class AiSdkProvider implements LLMProvider {
  readonly name = 'ai-sdk';
  private model: any;
  private modelId: string;

  constructor(options: AiSdkProviderOptions = {}) {
    const baseURL =
      options.baseURL ??
      process.env['NOVALISTICALLY_AI_BASE_URL'] ??
      'https://opencode.ai/zen/v1';

    const apiKey = options.apiKey ?? process.env['NOVALISTICALLY_AI_API_KEY'] ?? '';
    if (!apiKey) {
      throw new Error(
        'API key not provided. Set NOVALISTICALLY_AI_API_KEY environment variable or pass apiKey option.',
      );
    }

    this.modelId =
      options.model ??
      process.env['NOVALISTICALLY_AI_MODEL'] ??
      'deepseek-v4-flash-free';

    // ── Create client ───────────────────────────────────────────────────
    const client = createOpenAICompatible({
      name: 'ai-sdk',
      baseURL,
      apiKey,
    });
    this.model = client(this.modelId);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const isPass2 =
      request.seed !== undefined ||
      request.responseFormat?.type === 'json_object';

    // Split system message — ai SDK requires system as separate param
    const systemMsg = request.messages.find((m) => m.role === 'system');
    const nonSystem = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    try {
      const result = await generateText({
        model: this.model,
        system: systemMsg?.content,
        messages: nonSystem,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
        seed: request.seed,
      });

      let content = result.text;

      if (isPass2) {
        // Validate JSON output for Pass 2
        const cleaned = stripMarkdownFences(result.text);
        try {
          const parsed = JSON.parse(cleaned);
          const validated = analysisResultSchema.safeParse(parsed);
          if (!validated.success) {
            throw new Error(
              `Schema validation failed: ${validated.error.message}`,
            );
          }
          content = JSON.stringify(validated.data);
        } catch (e) {
          throw new Error(
            `Pass 2 JSON parse/validation failed: ${(e as Error).message}`,
          );
        }
      }

      return {
        id: result.response?.id ?? 'ai-sdk',
        model: this.modelId,
        content,
        usage: {
          promptTokens: result.usage?.inputTokens ?? 0,
          completionTokens: result.usage?.outputTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
        },
        finishReason: result.finishReason ?? 'stop',
      };
    } catch (err) {
      throw new LLMError(`ai-sdk error: ${(err as Error).message}`, {
        provider: this.name,
        cause: err,
      });
    }
  }
}

function stripMarkdownFences(text: string): string {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  return match ? match[1].trim() : text.trim();
}
