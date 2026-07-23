// ============================================================================
// AI Provider — No-Op Provider
// ============================================================================
//
// Minimal provider that always returns an empty string response. Useful as a
// baseline for measuring provider-extensibility cost and for testing pipeline
// paths that should tolerate empty results.
// ============================================================================

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
} from '../types.ts';

export class NoOpProvider implements LLMProvider {
  public readonly name = 'noop';

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'noop-0',
      model: request.model ?? 'noop-model',
      content: '',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    };
  }
}
