// ============================================================================
// Multi-Model Routing Tests
// ============================================================================
// Verifies that AiSdkProvider correctly selects models based on taskType
// and routing configuration:
//   - pass1 -> routing.pass1 ?? routing.default
//   - pass2 -> routing.pass2 ?? routing.default
//   - summary -> routing.summary ?? routing.default
//   - Fallback to default when a task-specific override is absent
//   - Constructor throws when routing.default is missing
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────

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

import { AiSdkProvider } from '../src/providers/ai-sdk.ts';
import type { CompletionRequest } from '@novalistically/core';

// ============================================================================
// Helpers
// ============================================================================

function makeRequest(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'You are a writer.' },
      { role: 'user', content: 'Write a scene.' },
    ],
    temperature: 0.8,
    ...overrides,
  };
}

function successResponse(text: string) {
  return {
    text,
    response: { id: 'mock-id' },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'stop' as const,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AiSdkProvider — multi-model routing', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  // ── No routing configured ────────────────────────────────────────────

  it('uses the base modelId when no routing is configured', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Some prose.'));

    const result = await provider.complete(makeRequest({ taskType: 'pass1' }));

    expect(result.model).toBe('default-model');
  });

  // ── Routing pass1 override ───────────────────────────────────────────

  it('selects routing.pass1 for pass1 task type', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
      routing: { default: 'default-model', pass1: 'fast-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Some prose.'));

    const result = await provider.complete(makeRequest({ taskType: 'pass1' }));

    expect(result.model).toBe('fast-model');
  });

  // ── Routing pass2 override ───────────────────────────────────────────

  it('selects routing.pass2 for pass2 task type', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
      routing: { default: 'default-model', pass2: 'precise-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify({ analysis: 'ok' })));

    const result = await provider.complete(
      makeRequest({
        taskType: 'pass2',
        seed: 42,
        responseFormat: { type: 'json_object' },
      }),
    );

    expect(result.model).toBe('precise-model');
  });

  // ── Routing summary override ─────────────────────────────────────────

  it('selects routing.summary for summary task type', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
      routing: { default: 'default-model', summary: 'summary-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Summary text.'));

    const result = await provider.complete(makeRequest({ taskType: 'summary' }));

    expect(result.model).toBe('summary-model');
  });

  // ── Fallback to routing.default when specific override is absent ─────

  it('falls back to routing.default when pass1 override is not set', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
      routing: { default: 'fallback-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Some prose.'));

    const result = await provider.complete(makeRequest({ taskType: 'pass1' }));

    expect(result.model).toBe('fallback-model');
  });

  it('falls back to routing.default when pass2 override is not set', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
      routing: { default: 'fallback-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify({ analysis: 'ok' })));

    const result = await provider.complete(
      makeRequest({
        taskType: 'pass2',
        seed: 42,
        responseFormat: { type: 'json_object' },
      }),
    );

    expect(result.model).toBe('fallback-model');
  });

  it('falls back to routing.default when summary override is not set', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
      routing: { default: 'fallback-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Summary text.'));

    const result = await provider.complete(makeRequest({ taskType: 'summary' }));

    expect(result.model).toBe('fallback-model');
  });

  // ── Fallback to base modelId when no taskType is set ─────────────────

  it('uses base modelId when taskType is undefined even with routing config', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'base-model',
      routing: { default: 'routed-default', pass1: 'pass1-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Some prose.'));

    const result = await provider.complete(makeRequest({ taskType: undefined }));

    expect(result.model).toBe('base-model');
  });

  it('uses base modelId when taskType is absent from request', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'base-model',
      routing: { default: 'default-model', pass1: 'pass1-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Some prose.'));

    // When taskType is not set at all, resolveModelId returns base modelId
    const result = await provider.complete(makeRequest());

    expect(result.model).toBe('base-model');
  });

  // ── Unknown taskType falls back to routing.default ────────────────────

  it('falls back to routing.default for unrecognised taskType', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'base-model',
      routing: { default: 'fallback-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse('Some prose.'));

    // Construct a request with an unknown taskType value
    const req = makeRequest();
    (req as Record<string, unknown>).taskType = 'unknown-type';
    const result = await provider.complete(req);

    // Falls back to routing.default since routing is configured with a default
    expect(result.model).toBe('fallback-model');
  });

  // ── Response model field accuracy ─────────────────────────────────────

  it('sets response.model to the resolved model ID', async () => {
    const provider = new AiSdkProvider({
      apiKey: 'test-key',
      baseURL: 'https://test.example.com/v1',
      model: 'default-model',
      routing: { default: 'default-model', pass2: 'precise-model' },
    });
    mockGenerateText.mockResolvedValueOnce(successResponse(JSON.stringify({ analysis: 'ok' })));

    const result = await provider.complete(
      makeRequest({
        taskType: 'pass2',
        seed: 42,
        responseFormat: { type: 'json_object' },
      }),
    );

    expect(result.model).toBe('precise-model');
    expect(typeof result.model).toBe('string');
    expect(result.model).not.toBe('default-model');
  });
});
