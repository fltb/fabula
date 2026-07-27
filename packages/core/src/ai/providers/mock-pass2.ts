// ============================================================================
// AI Provider — Mock Pass 2 Provider
// ============================================================================
//
// A mock LLM provider that returns pre-written prose (Pass 1) and
// pre-written AnalysisResult JSON (Pass 2). Enables integration testing
// of post-render validators without real LLM calls.

import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisResult } from '../../types/analysis.ts';
import type { CompletionRequest, CompletionResponse, LLMProvider, Message } from '../types.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MockPass2Entry {
  prose: string;
  analysis: AnalysisResult;
}

export interface MockPass2Options {
  /** Map of eventId → {prose, analysis}. Takes priority over referenceDir. */
  entries?: Record<string, MockPass2Entry>;
  /** Directory containing reference/*.json files. Loaded as fallback. */
  referenceDir?: string;
  /** Simulated latency in ms */
  latencyMs?: number;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class MockPass2Provider implements LLMProvider {
  readonly name = 'mock-pass2';
  private entries: Map<string, MockPass2Entry>;
  private latencyMs: number;
  private referenceDir: string | undefined;
  private referenceLoaded = false;

  constructor(options: MockPass2Options = {}) {
    this.entries = new Map();
    this.latencyMs = options.latencyMs ?? 0;
    this.referenceDir = options.referenceDir;

    // Load inline entries
    if (options.entries) {
      for (const [eventId, entry] of Object.entries(options.entries)) {
        this.entries.set(eventId, entry);
      }
    }
  }

  /**
   * Load reference files from the configured referenceDir.
   * Looks for `<eventId>.json` files inside `referenceDir/`.
   * Each file should contain a full MockPass2Entry JSON object
   * (with `prose` and `analysis` fields).
   */
  loadReferenceDir(dir?: string): void {
    const baseDir = dir ?? this.referenceDir;
    if (!baseDir) {
      throw new Error(
        'MockPass2Provider: no referenceDir configured. Pass a directory or use entries.',
      );
    }

    const refDir = path.resolve(baseDir);
    if (!fs.existsSync(refDir)) {
      throw new Error(`MockPass2Provider: reference directory does not exist: ${refDir}`);
    }

    const files = fs
      .readdirSync(refDir)
      .filter((file) => file.endsWith('.json') && file !== 'system:genesis.json');
    for (const file of files) {
      const filePath = path.join(refDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MockPass2Entry;
      const eventId = path.basename(file, '.json');

      // Validate the entry shape
      if (typeof data.prose !== 'string' || !data.analysis) {
        throw new Error(
          `MockPass2Provider: invalid reference file ${filePath} — ` +
            'expected { prose: string, analysis: AnalysisResult }',
        );
      }

      // Only set if not already provided via inline entries
      if (!this.entries.has(eventId)) {
        this.entries.set(eventId, data);
      }
    }

    this.referenceLoaded = true;
  }

  /** Returns true if the given request appears to be a Pass 2 (analysis) request. */
  static isPass2Request(request: CompletionRequest): boolean {
    return request.seed !== undefined || request.responseFormat?.type === 'json_object';
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Auto-load reference directory on first call if not yet loaded
    if (!this.referenceLoaded && this.referenceDir) {
      this.loadReferenceDir();
    }

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

    const content = isPass2 ? JSON.stringify(entry.analysis) : entry.prose;

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
