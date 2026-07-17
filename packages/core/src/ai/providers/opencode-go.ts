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
    message: {
      role: 'assistant';
      content: string;
      reasoning_content?: string;  // deepseek models may emit chain-of-thought here
    };
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
  private static warned = false;

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

    // Combine timeout with any external abort signal from the request
    const signals: AbortSignal[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    signals.push(controller.signal);

    if (request.signal) {
      signals.push(request.signal);
    }

    const combinedSignal = signals.length > 1
      ? AbortSignal.any(signals)
      : controller.signal;

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
        signal: combinedSignal,
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

    // Some deepseek models use chain-of-thought reasoning that goes into
    // reasoning_content. The reasoning often contains the actual prose
    // interleaved with planning and self-correction. We try multiple
    // extraction strategies to find the actual narrative prose.
    let content = choice.message.content;
    const reasoning = choice.message.reasoning_content;
    if ((!content || content.trim() === '') && reasoning) {
      content = extractProseFromReasoning(reasoning) ?? reasoning;
    }

    return {
      id: data.id,
      model: data.model,
      content,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: choice.finish_reason as CompletionResponse['finishReason'],
    };
  }

  /**
   * Synchronous-style streaming wrapper.
   *
   * The underlying opencode-go API does not support true server-sent event
   * streaming.  This method calls the single-shot `complete()` and emits
   * the entire response via `onChunk()` in one invocation.
   *
   * If `request.signal` is provided, it is forwarded to `complete()` which
   * combines it with the internal timeout signal via `AbortSignal.any()`.
   */
  async completeStream(
    request: CompletionRequest,
    onChunk: (chunk: string) => void,
  ): Promise<CompletionResponse> {
    if (!OpencodeGoProvider.warned) {
      OpencodeGoProvider.warned = true;
      console.warn(
        '[opencode-go] completeStream() is a synchronous wrapper — ' +
        'the underlying API does not support true streaming. ' +
        'The full response is buffered and emitted as a single chunk.',
      );
    }
    const result = await this.complete(request);
    onChunk(result.content);
    return result;
  }
}

/**
 * Extract actual narrative prose from a deepseek chain-of-thought response.
 *
 * Deepseek's reasoning_content often contains the prose interleaved with
 * planning bullets, self-correction comments, and section headers. This
 * function tries several strategies to isolate the actual narrative.
 */
function extractProseFromReasoning(reasoning: string): string | null {
  // Strategy 1: explicit "**Drafting the Scene:**" / "**Final Scene:**" section
  const headerPatterns = [
    /\*\*Drafting the Scene:\*\*\s*\n([\s\S]*?)(?=\n\s*\d+\.\s*\*\*|\n\s*\*\*[^*]+:\*\*\s*\n[^*]|$)/,
    /\*\*Final Scene:\*\*\s*\n([\s\S]*?)(?=\n\s*\d+\.\s*\*\*|\n\s*\*\*[^*]+:\*\*\s*\n[^*]|$)/,
    /\*\*Draft:\*\*\s*\n([\s\S]*?)(?=\n\s*\d+\.\s*\*\*|\n\s*\*\*[^*]+:\*\*\s*\n[^*]|$)/,
  ];
  for (const pattern of headerPatterns) {
    const match = reasoning.match(pattern);
    if (match && match[1].trim().length > 200) {
      return match[1].trim();
    }
  }

  // Strategy 2: longest block of text that isn't bullets or headers
  // Split on lines, group by "non-bullet" / "non-header" runs
  const lines = reasoning.split('\n');
  let bestBlock = '';
  let currentBlock = '';
  for (const line of lines) {
    const trimmed = line.trim();
    const isBullet = /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line);
    const isHeader = /^\*\*[^*]+\*\*\s*:?\s*$/.test(trimmed);
    const isBlank = trimmed === '';

    if (isBullet || isHeader || isBlank) {
      if (currentBlock.length > bestBlock.length) {
        bestBlock = currentBlock;
      }
      currentBlock = '';
    } else {
      currentBlock += (currentBlock ? '\n' : '') + line;
    }
  }
  if (currentBlock.length > bestBlock.length) {
    bestBlock = currentBlock;
  }

  // Validate: the block should have multiple sentences and paragraphs
  if (bestBlock.length > 200) {
    const sentenceCount = (bestBlock.match(/[.!?]\s/g) ?? []).length;
    if (sentenceCount >= 3) {
      return bestBlock.trim();
    }
  }

  return null;
}
