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
import { generateText, type LanguageModel, Output } from 'ai';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../types.ts';
import { LLMError } from '../types.ts';

export interface AiSdkProviderOptions {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** Optional multi-model routing config.
   *  When set, `complete()` selects the model based on `request.taskType`:
   *  `pass1` → `routing.pass1 ?? routing.default`,
   *  `pass2` → `routing.pass2 ?? routing.default`,
   *  `summary` → `routing.summary ?? routing.default`.
   *  Falls back to the base `model` if routing is absent for a task type. */
  routing?: {
    default: string;
    pass1?: string;
    pass2?: string;
    summary?: string;
  };
}

export class AiSdkProvider implements LLMProvider {
  readonly name = 'ai-sdk';
  private readonly options: AiSdkProviderOptions;
  private readonly client: (modelId: string) => LanguageModel;
  private readonly models: Map<string, LanguageModel>;
  private model: LanguageModel;
  private modelId: string;

  constructor(options: AiSdkProviderOptions = {}) {
    this.options = options;
    const baseURL =
      options.baseURL ?? process.env.NOVALISTICALLY_AI_BASE_URL ?? 'https://opencode.ai/zen/v1';

    const apiKey = options.apiKey ?? process.env.NOVALISTICALLY_AI_API_KEY ?? '';
    if (!apiKey) {
      throw new Error(
        'API key not provided. Set NOVALISTICALLY_AI_API_KEY environment variable or pass apiKey option.',
      );
    }

    this.modelId = options.model ?? process.env.NOVALISTICALLY_AI_MODEL ?? 'deepseek-v4-flash-free';

    // ── Create client ───────────────────────────────────────────────────
    this.client = createOpenAICompatible({
      name: 'ai-sdk',
      baseURL,
      apiKey,
    });
    this.models = new Map();
    this.model = this.getOrCreateModel(this.modelId);
  }

  /**
   * Get or create a LanguageModel for the given modelId.
   * Caches instances so repeated calls reuse the same object.
   */
  private getOrCreateModel(modelId: string): LanguageModel {
    let m = this.models.get(modelId);
    if (!m) {
      m = this.client(modelId);
      this.models.set(modelId, m);
    }
    return m;
  }

  /**
   * Resolve the model ID to use for a given task type based on routing config.
   * Falls back to the base modelId when no routing is configured or no override exists.
   */
  private resolveModelId(taskType?: string): string {
    const routing = this.options.routing;
    if (!routing || !taskType) {
      return this.modelId;
    }
    if (taskType === 'pass1' && routing.pass1) return routing.pass1;
    if (taskType === 'pass2' && routing.pass2) return routing.pass2;
    if (taskType === 'summary' && routing.summary) return routing.summary;
    return routing.default ?? this.modelId;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const isPass2 = request.seed !== undefined || request.responseFormat?.type === 'json_object';

    // Resolve model via routing (if configured and taskType is present)
    const usedModelId = this.resolveModelId(request.taskType);
    const usedModel =
      usedModelId === this.modelId ? this.model : this.getOrCreateModel(usedModelId);

    // Warn when routing changes the model from the base
    if (this.options.routing && usedModelId !== this.modelId) {
      console.warn(
        `[AiSdkProvider] Routing override: taskType="${request.taskType ?? '<none>'}" using "${usedModelId}" instead of default "${this.modelId}"`,
      );
    }

    // Split system message — ai SDK requires system as separate param
    const systemMsg = request.messages.find((m) => m.role === 'system');
    const nonSystem = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    try {
      const outputSpec = isPass2 ? Output.json() : undefined;

      const result = await generateText({
        model: usedModel,
        system: systemMsg?.content,
        messages: nonSystem,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
        seed: request.seed,
        ...(outputSpec ? { output: outputSpec } : {}),
      });

      const content = result.text; // raw text — pipeline owns Pass 2 parsing/validation

      return {
        id: result.response?.id ?? 'ai-sdk',
        model: usedModelId,
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
