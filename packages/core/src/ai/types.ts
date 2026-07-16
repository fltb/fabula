// ============================================================================
// AI Provider — Type Definitions
// ============================================================================

// ——— Message Types ———

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ——— Request / Response ———

export interface CompletionRequest {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface CompletionResponse {
  id: string;
  model: string;
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
}

// ——— Provider Interface ———

export interface LLMProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  completeStream?(
    request: CompletionRequest,
    onChunk: (chunk: string) => void,
  ): Promise<CompletionResponse>;
}

// ——— Error Types ———

export class LLMError extends Error {
  public readonly statusCode: number | undefined;
  public readonly provider: string;
  public readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      provider?: string;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'LLMError';
    this.statusCode = options.statusCode;
    this.provider = options.provider ?? 'unknown';
    this.requestId = options.requestId;
    this.cause = options.cause;
  }

  /** True if the error was caused by an HTTP-level failure (non-2xx status) */
  get isHttpError(): boolean {
    return this.statusCode !== undefined;
  }

  /** True if the error is likely transient (network, timeout, 5xx) */
  get isRetryable(): boolean {
    if (this.statusCode === undefined) return true; // network error
    return this.statusCode >= 500 || this.statusCode === 429;
  }
}
