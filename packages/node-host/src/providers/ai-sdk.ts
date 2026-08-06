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

/** Shared env-backed OpenAI-compatible client construction for Host adapters. */
export interface AiSdkClientOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly model?: string;
}

/** Resolved client + per-model factory; one client per adapter, models cached. */
export interface AiSdkModelClient {
  readonly modelId: string;
  modelFor(modelId: string): LanguageModel;
}

/**
 * Build the OpenAI-compatible client and model factory every Host AI adapter
 * shares (AiSdkProvider, the WorkbenchAgentModel). Env defaults and the
 * missing-key failure live in exactly one place.
 */
export function createAiSdkModelClient(options: AiSdkClientOptions = {}): AiSdkModelClient {
  const baseURL =
    options.baseURL ?? process.env.NOVALISTICALLY_AI_BASE_URL ?? 'https://opencode.ai/zen/v1';
  const apiKey = options.apiKey ?? process.env.NOVALISTICALLY_AI_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('API key not provided. Set NOVALISTICALLY_AI_API_KEY or provide apiKey.');
  }
  const modelId = options.model ?? process.env.NOVALISTICALLY_AI_MODEL ?? 'deepseek-v4-flash-free';
  const client = createOpenAICompatible({ name: 'ai-sdk', baseURL, apiKey });
  const models = new Map<string, LanguageModel>();
  return {
    modelId,
    modelFor(id) {
      const cached = models.get(id);
      if (cached) return cached;
      const model = client(id);
      models.set(id, model);
      return model;
    },
  };
}

/** Node-owned provider adapter. Core receives only the LLMProvider port. */
export class AiSdkProvider implements LLMProvider {
  readonly name = 'ai-sdk';
  readonly #modelId: string;
  readonly #model: LanguageModel;
  readonly #modelFor: (modelId: string) => LanguageModel;

  constructor(private readonly options: AiSdkProviderOptions = {}) {
    const client = createAiSdkModelClient(options);
    this.#modelId = client.modelId;
    this.#modelFor = client.modelFor;
    this.#model = client.modelFor(this.#modelId);
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

  #modelIdFor(taskType?: string): string {
    const routing = this.options.routing;
    if (!routing || !taskType) return this.#modelId;
    if (taskType === 'pass1' && routing.pass1) return routing.pass1;
    if (taskType === 'pass2' && routing.pass2) return routing.pass2;
    if (taskType === 'summary' && routing.summary) return routing.summary;
    return routing.default;
  }
}
