// ============================================================================
// Pi OpenAI-Compatible Provider — LLMProvider contract implementation
// ============================================================================
// Implements the core `LLMProvider` contract (the role formerly played by
// `AiSdkProvider`) on top of the pi-ai stack. Resolves a model id from the
// request task type via the routing table, requires an explicit apiKey, and
// maps pi-ai's `completeSimple` result onto `CompletionResponse`.
// Never reads process.env.
// ============================================================================

import {
  LLMError,
  type CompletionRequest,
  type CompletionResponse,
  type LLMProvider,
  type TaskType,
} from '@novalistically/core';
import type { Message } from '@earendil-works/pi-ai';
import {
  createPiProviderStack,
  PI_DEFAULT_BASE_URL,
  PI_DEFAULT_MODEL,
  type PiProviderStack,
} from './pi-provider.js';

export interface PiOpenAICompatibleProviderOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly model?: string;
  /** Task-type routing. Unconfigured task types fall back to `routing.default`, then `model`. */
  readonly routing?: {
    readonly default?: string;
    readonly pass1?: string;
    readonly pass2?: string;
    readonly summary?: string;
  };
}

export class PiOpenAICompatibleProvider implements LLMProvider {
  readonly name = 'pi-openai-compatible';
  readonly #stack: PiProviderStack;
  readonly #options: PiOpenAICompatibleProviderOptions;

  constructor(options: PiOpenAICompatibleProviderOptions = {}) {
    this.#options = options;
    this.#stack = createPiProviderStack({
      baseURL: options.baseURL ?? PI_DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      modelId: options.model ?? options.routing?.default ?? PI_DEFAULT_MODEL,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const modelId = this.#modelIdFor(request.taskType);
    const apiKey = this.#options.apiKey ?? '';
    if (!apiKey) throw new LLMError('apiKey is required', { provider: this.name });
    const model = this.#stack.models.getModel('pi-provider', modelId);
    if (model === undefined) throw new LLMError(`Model ${modelId} not found`, { provider: this.name });
    try {
      const result = await this.#stack.models.completeSimple(
        model,
        {
          systemPrompt: undefined,
          // pi-ai's `Message` union types assistant turns as the full
          // `AssistantMessage` (api/provider/model/usage/stopReason required),
          // but its runtime accepts minimal hand-built turns; cast to the
          // context input type with the same runtime shape.
          messages: request.messages.map((m) => ({
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: [{ type: 'text', text: m.content }],
            timestamp: Date.now(),
          })) as Message[],
        },
        {
          apiKey,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          signal: request.signal,
        },
      );
      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        id: result.responseId ?? this.name,
        model: modelId,
        content: text,
        usage: {
          promptTokens: result.usage.input,
          completionTokens: result.usage.output,
          totalTokens: result.usage.input + result.usage.output,
        },
        finishReason:
          result.stopReason === 'error' ? 'error' : result.stopReason === 'length' ? 'length' : 'stop',
      };
    } catch (error) {
      throw new LLMError(`pi-ai error: ${(error as Error).message}`, { provider: this.name, cause: error });
    }
  }

  #modelIdFor(taskType?: TaskType): string {
    const routing = this.#options.routing;
    if (!routing || !taskType) return this.#options.model ?? PI_DEFAULT_MODEL;
    if (taskType === 'pass1' && routing.pass1) return routing.pass1;
    if (taskType === 'pass2' && routing.pass2) return routing.pass2;
    if (taskType === 'summary' && routing.summary) return routing.summary;
    return routing.default ?? this.#options.model ?? PI_DEFAULT_MODEL;
  }
}
