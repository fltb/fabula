// ============================================================================
// AI Provider — Mock Provider
// ============================================================================

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
} from '../types.ts';

/**
 * In-process mock provider for tests and offline development.
 *
 * Supports three response modes:
 *  1. `responses` — fixed list, returns one per call
 *  2. `generator` — function that builds a response from the request
 *  3. `default`   — echoes the last user message back
 */
export interface MockProviderOptions {
  responses?: string[];
  generator?: (req: CompletionRequest) => string;
  /** Simulated latency per call, ms (default 0) */
  latencyMs?: number;
  /** Optional: emit an error once on the Nth call (1-indexed). The remaining calls succeed. */
  failOnCall?: number;
  failMessage?: string;
}

export class MockProvider implements LLMProvider {
  public readonly name = 'mock';
  public readonly calls: CompletionRequest[] = [];
  private readonly responses: string[];
  private readonly generator?: (req: CompletionRequest) => string;
  private readonly latencyMs: number;
  private readonly failOnCall?: number;
  private readonly failMessage?: string;
  private nextIndex = 0;

  constructor(options: MockProviderOptions = {}) {
    this.responses = options.responses ?? [];
    this.generator = options.generator;
    this.latencyMs = options.latencyMs ?? 0;
    this.failOnCall = options.failOnCall;
    this.failMessage = options.failMessage;
  }

  get callCount(): number {
    return this.calls.length;
  }

  get lastRequest(): CompletionRequest | undefined {
    return this.calls[this.calls.length - 1];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }

    this.calls.push(request);

    if (this.failOnCall !== undefined && this.calls.length === this.failOnCall) {
      throw new Error(this.failMessage ?? `Mock failure on call ${this.failOnCall}`);
    }

    let content: string;
    if (this.generator) {
      content = this.generator(request);
    } else if (this.nextIndex < this.responses.length) {
      content = this.responses[this.nextIndex++];
    } else {
      // Default: echo last user message with a brief narrative wrapper
      const lastUser = [...request.messages]
        .reverse()
        .find((m: Message) => m.role === 'user');
      content = lastUser
        ? `Mock response: ${lastUser.content.slice(0, 80)}…`
        : 'Mock response';
    }

    return {
      id: `mock-${this.calls.length}`,
      model: request.model ?? 'mock-model',
      content,
      usage: {
        promptTokens: request.messages.reduce((acc: number, m: Message) => acc + m.content.length / 4, 0),
        completionTokens: content.length / 4,
        totalTokens: 0,
      },
      finishReason: 'stop',
    };
  }
}
