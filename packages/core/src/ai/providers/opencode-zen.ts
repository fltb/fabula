// ============================================================================
// AI Provider — Opencode-Zen (deepseek-v4-flash via local proxy)
// ============================================================================

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
} from '../types.ts';
import { LLMError } from '../types.ts';

export interface OpencodeZenOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in ms (default 60_000) */
  timeoutMs?: number;
}

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:25793/v1',
  model: 'deepseek-v4-flash',
} as const;

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
 * Provider for the opencode-zen local proxy (OpenAI-compatible).
 *
 * Configured for deepseek-v4-flash by default. Override via constructor
 * options or environment variables:
 *   - `OPENCODE_ZEN_API_KEY`
 *   - `OPENCODE_ZEN_BASE_URL`
 *   - `OPENCODE_ZEN_MODEL`
 */
export class OpencodeZenProvider implements LLMProvider {
  public readonly name = 'opencode-zen';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: OpencodeZenOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENCODE_ZEN_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error(
        '[opencode-zen] API key not provided. Set OPENCODE_ZEN_API_KEY in your environment or pass apiKey in options.',
      );
    }
    this.baseUrl = (options.baseUrl
      ?? process.env.OPENCODE_ZEN_BASE_URL
      ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.defaultModel = options.model
      ?? process.env.OPENCODE_ZEN_MODEL
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
        `opencode-zen returned ${response.status}: ${text || response.statusText}`,
        { statusCode: response.status, provider: this.name },
      );
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new LLMError(
        `opencode-zen returned no choices`,
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
      finishReason: choice.finish_reason ?? 'stop',
    };
  }

  async completeStream(
    request: CompletionRequest,
    onChunk: (chunk: string) => void,
  ): Promise<CompletionResponse> {
    // The deepseek-v4-flash endpoint may not support streaming; fall back to
    // a single complete() call and emit the whole content as one chunk.
    const result = await this.complete(request);
    onChunk(result.content);
    return result;
  }
}
