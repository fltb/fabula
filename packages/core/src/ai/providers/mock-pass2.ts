// ============================================================================
// AI Provider — Mock Pass 2 Provider
// ============================================================================
//
// A mock LLM provider that returns pre-written prose (Pass 1) and
// pre-written AnalysisResult JSON (Pass 2). Enables integration testing
// of post-render validators without real LLM calls.

import type { AnalysisResult } from '../../types/analysis.ts';
import { extractExpectedProtocol } from '../prompts/render-analysis.ts';
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../types.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MockPass2Entry {
  prose: string;
  analysis: AnalysisResult;
}

export interface MockPass2Options {
  /** Deterministic eventId → prose and Pass 2 analysis fixtures. */
  entries?: Record<string, MockPass2Entry>;
  /** Simulated latency in milliseconds. */
  latencyMs?: number;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class MockPass2Provider implements LLMProvider {
  readonly name = 'mock-pass2';
  private entries: Map<string, MockPass2Entry>;
  private latencyMs: number;

  constructor(options: MockPass2Options = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}));
    this.latencyMs = options.latencyMs ?? 0;
  }


  /** Returns true if the given request appears to be a Pass 2 (analysis) request. */
  static isPass2Request(request: CompletionRequest): boolean {
    return request.seed !== undefined || request.responseFormat?.type === 'json_object';
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {

    const isPass2 = MockPass2Provider.isPass2Request(request);

    // Simulate latency
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }

    // Extract eventId from messages
    const eventId = this.extractEventId(request);
    const entry = this.entries.get(eventId);
    if (!entry) {
      throw new Error(
        `MockPass2Provider: no entry for event "${eventId}". ` +
          `Available: ${[...this.entries.keys()].join(', ') || '(none)'}`,
      );
    }

    let content: string;
    if (isPass2) {
      // A compliant model echoes the REAL protocol from the prompt. Extract it
      // and substitute it into the canned entry so fail-closed protocol
      // comparison succeeds under whatever protocol is currently active.
      const echoed = extractExpectedProtocol(request.messages);
      content = echoed
        ? JSON.stringify({ ...entry.analysis, protocol: echoed })
        : JSON.stringify(entry.analysis);
    } else {
      content = entry.prose;
    }

    // Estimate tokens (rough: 4 chars per token)
    const estimatedTokens = Math.ceil(content.length / 4);

    return {
      id: `mock-pass2-${eventId}-${isPass2 ? 'analysis' : 'prose'}`,
      model: 'mock-pass2',
      content,
      usage: {
        promptTokens: request.messages.reduce(
          (acc: number, m: Message) => acc + Math.ceil(m.content.length / 4),
          0,
        ),
        completionTokens: estimatedTokens,
        totalTokens: 0,
      },
      finishReason: 'stop',
    };
  }

  /**
   * Extract an event identifier from the request messages.
   *
   * Search order:
   *  1. `"eventId": "..."` in any message
   *  2. `"id": "..."` near scene-related fields
   *  3. The last user message content (truncated) as a fallback label
   */
  private extractEventId(request: CompletionRequest): string {
    const allText = request.messages
      .map((m) => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content))
          return (m.content as Array<{ type: string; text?: string }>)
            .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
            .join('');
        return '';
      })
      .join('\n');

    // Try to find eventId in JSON blocks
    const eventIdMatch = allText.match(/"eventId"\s*:\s*"([^"]+)"/);
    if (eventIdMatch) return eventIdMatch[1];

    // Fallback: look for "id" field near "sceneType" or "sceneBrief"
    const idMatch = allText.match(/"id"\s*:\s*"([^"]+)"/);
    if (idMatch) return idMatch[1];

    // Last resort: use a hash of the last user message
    const lastUser = [...request.messages].reverse().find((m: Message) => m.role === 'user');
    if (lastUser) {
      const hash = this.simpleHash(lastUser.content);
      return `msg-${hash}`;
    }

    throw new Error('MockPass2Provider: could not extract eventId from request');
  }

  /** Simple string hash for fallback id extraction. */
  private simpleHash(s: string): string {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      const char = s.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).slice(0, 8);
  }
}
