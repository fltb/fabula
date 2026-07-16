// ============================================================================
// AI Provider — Opencode-Go (low-cost subscription via opencode.ai/zen/go)
// ============================================================================
//
// Format: OpenAI-compatible chat completions.
// Default endpoint: https://opencode.ai/zen/go/v1
// Default model:    deepseek-v4-flash (paid; go subscription)
//
// Environment overrides:
//   OPENCODE_GO_API_KEY   — required
//   OPENCODE_GO_BASE_URL  — default https://opencode.ai/zen/go/v1
//   OPENCODE_GO_MODEL     — default deepseek-v4-flash
//
// See: https://opencode.ai/docs/go
// ============================================================================

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
} from '../types.ts';
import { LLMError } from '../types.ts';

export interface OpencodeGoOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in ms (default 60_000) */
  timeoutMs?: number;
}

const DEFAULTS = {
  baseUrl: 'https://opencode.ai/zen/go/v1',
  model: 'deepseek-v4-flash',
} as const;

/** All available models on opencode-go (from https://opencode.ai/docs/go) */
export const OPENCODE_GO_MODELS = [
  'glm-5.2',
  'glm-5.1',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
] as const;

export type OpencodeGoModel = (typeof OPENCODE_GO_MODELS)[number];

interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Provider for opencode-go — the low-cost subscription service.
 *
 * Uses OpenAI-compatible chat completions at ${baseUrl}/chat/completions.
 * Same response shape as OpencodeZenProvider (so tests can share fixtures).
 */
export class OpencodeGoProvider implements LLMProvider {
  public readonly name = 'opencode-go';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: OpencodeGoOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENCODE_GO_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error(
        '[opencode-go] API key not provided. Set OPENCODE_GO_API_KEY in your environment or pass apiKey in options.',
      );
    }
    this.baseUrl = (options.baseUrl
      ?? process.env.OPENCODE_GO_BASE_URL
      ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.defaultModel = options.model
      ?? process.env.OPENCODE_GO_MODEL
      ?? DEFAULTS.model;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: request.model ?? this.defaultModel,
      messages: request.messages.map((m: Message) => ({ role: m.role, content: m.content })),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.stop ? { stop: request.stop } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new LLMError(
        `Network error calling ${url}: ${(err as Error).message}`,
        { provider: this.name, cause: err },
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LLMError(
        `opencode-go returned ${response.status}: ${text || response.statusText}`,
        { statusCode: response.status, provider: this.name },
      );
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new LLMError(
        `opencode-go returned no choices`,
        { statusCode: response.status, provider: this.name, requestId: data.id },
      );
    }

    return {
      id: data.id,
      model: data.model,
      content: choice.message.content,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: choice.finish_reason as CompletionResponse['finishReason'],
    };
  }

  /**
   * Streaming is not natively supported by this provider; fall back to
   * single-shot complete() and emit the whole content as one chunk.
   */
  async completeStream(
    request: CompletionRequest,
    onChunk: (chunk: string) => void,
  ): Promise<CompletionResponse> {
    const result = await this.complete(request);
    onChunk(result.content);
    return result;
  }
}
