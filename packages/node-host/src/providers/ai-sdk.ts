import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type CompletionRequest,
  type CompletionResponse,
  LLMError,
  type LLMProvider,
} from '@novalistically/core';
import { generateText, type LanguageModel, Output } from 'ai';

/** Explicit Node-host configuration for an OpenAI-compatible provider. */
export interface AiSdkProviderOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly routing?: {
    readonly default: string;
    readonly pass1?: string;
    readonly pass2?: string;
    readonly summary?: string;
  };
}

/** Node-owned provider adapter. Core receives only the LLMProvider port. */
export class AiSdkProvider implements LLMProvider {
  readonly name = 'ai-sdk';
  readonly #client: (modelId: string) => LanguageModel;
  readonly #models = new Map<string, LanguageModel>();
  readonly #modelId: string;
  readonly #model: LanguageModel;

  constructor(private readonly options: AiSdkProviderOptions = {}) {
    const baseURL =
      options.baseURL ?? process.env.NOVALISTICALLY_AI_BASE_URL ?? 'https://opencode.ai/zen/v1';
    const apiKey = options.apiKey ?? process.env.NOVALISTICALLY_AI_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('API key not provided. Set NOVALISTICALLY_AI_API_KEY or provide apiKey.');
    }
    this.#modelId =
      options.model ?? process.env.NOVALISTICALLY_AI_MODEL ?? 'deepseek-v4-flash-free';
    this.#client = createOpenAICompatible({ name: this.name, baseURL, apiKey });
    this.#model = this.#modelFor(this.#modelId);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const modelId = this.#modelIdFor(request.taskType);
    const model = modelId === this.#modelId ? this.#model : this.#modelFor(modelId);
    const system = request.messages.find((message) => message.role === 'system')?.content;
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
    try {
      const result = await generateText({
        model,
        system,
        messages,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
        seed: request.seed,
        ...(request.seed !== undefined || request.responseFormat?.type === 'json_object'
          ? { output: Output.json() }
          : {}),
      });
      return {
        id: result.response?.id ?? this.name,
        model: modelId,
        content: result.text,
        usage: {
          promptTokens: result.usage?.inputTokens ?? 0,
          completionTokens: result.usage?.outputTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
        },
        finishReason: result.finishReason ?? 'stop',
      };
    } catch (error) {
      throw new LLMError(`ai-sdk error: ${(error as Error).message}`, {
        provider: this.name,
        cause: error,
      });
    }
  }

  #modelFor(modelId: string): LanguageModel {
    const cached = this.#models.get(modelId);
    if (cached) return cached;
    const model = this.#client(modelId);
    this.#models.set(modelId, model);
    return model;
  }

  #modelIdFor(taskType?: string): string {
    const routing = this.options.routing;
    if (!routing || !taskType) return this.#modelId;
    if (taskType === 'pass1' && routing.pass1) return routing.pass1;
    if (taskType === 'pass2' && routing.pass2) return routing.pass2;
    if (taskType === 'summary' && routing.summary) return routing.summary;
    return routing.default;
  }
}
