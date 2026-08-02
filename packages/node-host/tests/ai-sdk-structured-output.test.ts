// ============================================================================
// AiSdkProvider — Structured Output Mode (JSON Object) Tests
// ============================================================================
// Verifies that Pass 2 requests with responseFormat { type: 'json_object' }
// trigger JSON output mode in the AI SDK generateText call, while Pass 1
// requests remain in default text mode. Malformed or schema-invalid Pass 2 JSON
// is returned as raw text — pipeline owns validation and retry-with-feedback.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────
// vi.mock factories are hoisted above imports, so use vi.hoisted() to
// expose the spy reference across the hoisting boundary.

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn()),
}));

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn<any>(),
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return {
    ...(actual as any),
    generateText: mockGenerateText,
  };
});

// ── SUT ──────────────────────────────────────────────────────────────────

import { generateText, Output } from 'ai';
import { AiSdkProvider } from '../src/providers/ai-sdk.ts';
import type { CompletionRequest } from '@novalistically/core';

// ============================================================================
// Helpers
// ============================================================================

function makePass1Request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'You are a writer.' },
      { role: 'user', content: 'Write a scene.' },
    ],
    temperature: 0.8,
    ...overrides,
  };
}

function makePass2Request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'You are an analyst.' },
      { role: 'user', content: 'Analyze the scene.' },
    ],
    temperature: 0.3,
    seed: 42,
    responseFormat: { type: 'json_object' },
    ...overrides,
  };
}

/**
 * Default mock return value for a successful generateText call.
 * Callers override via `mockGenerateText.mockResolvedValueOnce(...)`.
 */
function successResponse(text: string) {
  return {
    text,
    response: { id: 'mock-id' },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'stop' as const,
  };
}

const VALID_ANALYSIS = {
  eventId: 'E1',
  analysis: {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 8,
      maxScore: 10,
      strengths: ['clear prose'],
      weaknesses: [],
      estimatedWordCount: 100,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
  },
};

// ============================================================================
// Tests
// ============================================================================

describe('AiSdkProvider — structured output mode', () => {
  let provider: AiSdkProvider;

  beforeEach(() => {
    provider = new AiSdkProvider({ apiKey: 'test-key', baseURL: 'https://test.example.com/v1' });
    mockGenerateText.mockReset();
  });

  // ── Pass 2 sends JSON output mode ───────────────────────────────────

  it('passes Output.json() to generateText for Pass 2 requests', async () => {
    const expectedOutput = Output.json();

    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify(VALID_ANALYSIS)));

    await provider.complete(makePass2Request());

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const args = mockGenerateText.mock.calls[0][0];
    expect(args).toHaveProperty('output');
    // The output spec should be structurally equivalent to Output.json()
    expect(JSON.stringify(args.output)).toBe(JSON.stringify(expectedOutput));
  });

  // ── Pass 2 via responseFormat alone (no seed) ───────────────────────

  it('uses JSON mode when only responseFormat is set (no seed)', async () => {
    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify(VALID_ANALYSIS)));

    const req = makePass2Request();
    delete req.seed;
    await provider.complete(req);

    const args = mockGenerateText.mock.calls[0][0];
    expect(args).toHaveProperty('output');
  });

  // ── Pass 1 stays in text mode ───────────────────────────────────────

  it('calls generateText without output for Pass 1 requests', async () => {
    mockGenerateText.mockResolvedValueOnce(
      successResponse('The scene opened with a gentle rain falling on the cobblestones.'),
    );

    await provider.complete(makePass1Request());

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const args = mockGenerateText.mock.calls[0][0];
    expect(args).not.toHaveProperty('output');
  });

  // ── Schema-invalid Pass 2 JSON passes through as raw text ──────────

  it('passes through schema-invalid Pass 2 JSON text to pipeline', async () => {
    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify({ foo: 'bar' })));

    const result = await provider.complete(makePass2Request());

    expect(result.content).toBe(JSON.stringify({ foo: 'bar' }));
  });

  // ── Non-JSON Pass 2 response passes through as raw text ─────────────

  it('passes through non-JSON Pass 2 text to pipeline', async () => {
    mockGenerateText.mockResolvedValueOnce(successResponse('This is not JSON at all.'));

    const result = await provider.complete(makePass2Request());

    expect(result.content).toBe('This is not JSON at all.');
  });

  // ── Correct content still passes through schema ─────────────────────

  it('passes through valid Pass 2 analysis', async () => {
    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify(VALID_ANALYSIS)));

    const result = await provider.complete(makePass2Request());

    expect(result.content).toBe(JSON.stringify(VALID_ANALYSIS));
    expect(result.model).toBeTruthy();
    expect(typeof result.model).toBe('string');
    expect(result.finishReason).toBe('stop');
  });

  // ── Model defaults to configured value ──────────────────────────────

  it('uses configured model identifier in response', async () => {
    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify(VALID_ANALYSIS)));

    const customProvider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'custom-model-v1',
    });
    const result = await customProvider.complete(makePass2Request());

    expect(result.model).toBe('custom-model-v1');
  });

  // ── Regression: structured output would fail if dropped ─────────────

  it('fails as regression test if output is removed from Pass 2 call', async () => {
    const expectedOutput = Output.json();

    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify(VALID_ANALYSIS)));

    await provider.complete(makePass2Request());

    // If someone deletes the output: Output.json() line from ai-sdk.ts,
    // this assertion catches it.
    const args = mockGenerateText.mock.calls[0][0];
    expect(args).toHaveProperty('output');

    // Verify the output spec has the correct responseFormat shape
    const outputResponseFormat = await args.output.responseFormat;
    expect(outputResponseFormat).toEqual({ type: 'json' });
  });
});
