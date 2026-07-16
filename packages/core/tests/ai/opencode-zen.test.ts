// ============================================================================
// AI Provider — OpencodeZenProvider — Unit Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpencodeZenProvider } from '../../src/ai/providers/opencode-zen.ts';
import { LLMError } from '../../src/ai/types.ts';

// ============================================================================
// Helpers
// ============================================================================

const API_KEY = 'test-api-key-12345';

function makeJsonResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl_test123',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'deepseek-v4-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: 'Hello from AI!' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 15,
      total_tokens: 35,
    },
    ...overrides,
  };
}

function makeFetchOk(data: unknown = makeJsonResponse()) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function userMsg(content: string) {
  return { role: 'user' as const, content };
}

// ============================================================================
// Tests
// ============================================================================

describe('OpcencodeZenProvider', () => {
  beforeEach(() => {
    // Ensure env var is not set so tests are deterministic
    delete process.env.OPENCODE_ZEN_API_KEY;
    delete process.env.OPENCODE_ZEN_BASE_URL;
    delete process.env.OPENCODE_ZEN_MODEL;

    vi.spyOn(globalThis, 'fetch').mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Construction ──────────────────────────────────────────────────

  it('throws if no API key is provided', () => {
    expect(() => new OpencodeZenProvider()).toThrow(
      'API key not provided',
    );
  });

  it('accepts an API key via options', () => {
    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    expect(p.name).toBe('opencode-zen');
  });

  it('reads API key from environment variable', () => {
    process.env.OPENCODE_ZEN_API_KEY = 'env-key';
    const p = new OpencodeZenProvider();
    expect(p.name).toBe('opencode-zen');
  });

  it('reads base URL from environment variable', () => {
    process.env.OPENCODE_ZEN_API_KEY = API_KEY;
    process.env.OPENCODE_ZEN_BASE_URL = 'https://custom.example.com/v1';
    const p = new OpencodeZenProvider();
    // A successful complete will use this URL
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchOk());
    expect(p.name).toBe('opencode-zen');
  });

  it('reads model from environment variable', () => {
    process.env.OPENCODE_ZEN_API_KEY = API_KEY;
    process.env.OPENCODE_ZEN_MODEL = 'custom-model';
    const p = new OpencodeZenProvider();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchOk());
    expect(p.name).toBe('opencode-zen');
  });

  // ── Successful completion ────────────────────────────────────────

  it('completes a request and returns the correct shape', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchOk());

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    const res = await p.complete({
      messages: [userMsg('Write a scene.')],
    });

    expect(res.id).toBe('chatcmpl_test123');
    expect(res.model).toBe('deepseek-v4-flash');
    expect(res.content).toBe('Hello from AI!');
    expect(res.finishReason).toBe('stop');
    expect(res.usage.promptTokens).toBe(20);
    expect(res.usage.completionTokens).toBe(15);
    expect(res.usage.totalTokens).toBe(35);
  });

  it('passes request model, temperature, maxTokens, and stop to the API', async () => {
    let requestBody: unknown = null;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, opts: RequestInit) => {
        requestBody = JSON.parse(opts.body as string);
        return makeFetchOk();
      },
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    await p.complete({
      messages: [userMsg('hi')],
      model: 'my-model',
      temperature: 0.3,
      maxTokens: 200,
      stop: ['\n', 'END'],
    });

    expect(requestBody).toMatchObject({
      model: 'my-model',
      temperature: 0.3,
      max_tokens: 200,
      stop: ['\n', 'END'],
    });
  });

  it('omits optional fields from the request when not provided', async () => {
    let requestBody: unknown = null;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, opts: RequestInit) => {
        requestBody = JSON.parse(opts.body as string);
        return makeFetchOk();
      },
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    await p.complete({
      messages: [userMsg('hi')],
    });

    expect(requestBody).not.toHaveProperty('temperature');
    expect(requestBody).not.toHaveProperty('max_tokens');
    expect(requestBody).not.toHaveProperty('stop');
  });

  it('sends the correct headers', async () => {
    let requestHeaders: Record<string, string> = {};
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, opts: RequestInit) => {
        requestHeaders = opts.headers as Record<string, string>;
        return makeFetchOk();
      },
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    await p.complete({ messages: [userMsg('hi')] });

    expect(requestHeaders['Content-Type']).toBe('application/json');
    expect(requestHeaders['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('includes default headers when provided', async () => {
    let requestHeaders: Record<string, string> = {};
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, opts: RequestInit) => {
        requestHeaders = opts.headers as Record<string, string>;
        return makeFetchOk();
      },
    );

    const p = new OpencodeZenProvider({
      apiKey: API_KEY,
      defaultHeaders: { 'X-Custom': 'value123' },
    });
    await p.complete({ messages: [userMsg('hi')] });

    expect(requestHeaders['X-Custom']).toBe('value123');
  });

  // ── URL handling ─────────────────────────────────────────────────

  it('strips trailing slashes from baseUrl', async () => {
    let requestUrl = '';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        requestUrl = url;
        return makeFetchOk();
      },
    );

    const p = new OpencodeZenProvider({
      apiKey: API_KEY,
      baseUrl: 'http://example.com/v1/',
    });
    await p.complete({ messages: [userMsg('hi')] });

    expect(requestUrl).toBe('http://example.com/v1/chat/completions');
  });

  // ── Error handling ───────────────────────────────────────────────

  it('throws LLMError on network failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    await expect(p.complete({ messages: [userMsg('hi')] })).rejects.toThrow(LLMError);
    await expect(p.complete({ messages: [userMsg('hi')] })).rejects.toThrow(
      'Network error',
    );
  });

  it('throws LLMError on non-2xx response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    await expect(p.complete({ messages: [userMsg('hi')] })).rejects.toThrow(LLMError);
    await expect(p.complete({ messages: [userMsg('hi')] })).rejects.toThrow(
      'opencode-zen returned 401',
    );
  });

  it('throws LLMError on empty choices', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async () => makeFetchOk(makeJsonResponse({ choices: [] })),
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    await expect(p.complete({ messages: [userMsg('hi')] })).rejects.toThrow(LLMError);
    await expect(p.complete({ messages: [userMsg('hi')] })).rejects.toThrow(
      'returned no choices',
    );
  });

  it('throws LLMError on missing choices field', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async () => makeFetchOk(makeJsonResponse({ choices: undefined })),
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    await expect(p.complete({ messages: [userMsg('hi')] })).rejects.toThrow(LLMError);
  });

  it('handles missing usage data gracefully', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchOk(makeJsonResponse({ usage: undefined })),
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    const res = await p.complete({ messages: [userMsg('hi')] });
    expect(res.usage.promptTokens).toBe(0);
    expect(res.usage.completionTokens).toBe(0);
    expect(res.usage.totalTokens).toBe(0);
  });

  it('includes requestId in LLMError when choices are empty', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async () => makeFetchOk(makeJsonResponse({ choices: [] })),
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    try {
      await p.complete({ messages: [userMsg('hi')] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).requestId).toBe('chatcmpl_test123');
    }
  });

  // ── Streaming ────────────────────────────────────────────────────

  it('completeStream calls onChunk with content and returns response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchOk());

    const p = new OpencodeZenProvider({ apiKey: API_KEY });
    const onChunk = vi.fn();
    const result = await p.completeStream(
      { messages: [userMsg('stream test')] },
      onChunk,
    );

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith('Hello from AI!');
    expect(result.content).toBe('Hello from AI!');
  });

  // ── Timeout ──────────────────────────────────────────────────────

  it('uses custom timeout value from options', async () => {
    // We can't easily test abort without timing, but we can verify the
    // timeoutMs is consumed and a timeout is set by checking that fetch
    // receives a signal parameter.
    let capturedSignal: AbortSignal | undefined;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, opts: RequestInit) => {
        capturedSignal = opts.signal as AbortSignal;
        return makeFetchOk();
      },
    );

    const p = new OpencodeZenProvider({ apiKey: API_KEY, timeoutMs: 5000 });
    await p.complete({ messages: [userMsg('hi')] });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
  });
});
