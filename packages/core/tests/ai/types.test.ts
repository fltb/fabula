// ============================================================================
// AI Provider — Type Definitions — Unit Tests
// ============================================================================

import { describe, expect, it } from 'vitest';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
} from '../../src/ai/types.ts';
import { LLMError } from '../../src/ai/types.ts';

// ============================================================================
// LLMError
// ============================================================================

describe('LLMError', () => {
  it('creates an error with default options', () => {
    const err = new LLMError('Something went wrong');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LLMError');
    expect(err.message).toBe('Something went wrong');
    expect(err.statusCode).toBeUndefined();
    expect(err.provider).toBe('unknown');
    expect(err.requestId).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('creates an error with all options', () => {
    const cause = new Error('root cause');
    const err = new LLMError('API error', {
      statusCode: 429,
      provider: 'opencode-zen',
      requestId: 'req_abc123',
      cause,
    });
    expect(err.name).toBe('LLMError');
    expect(err.message).toBe('API error');
    expect(err.statusCode).toBe(429);
    expect(err.provider).toBe('opencode-zen');
    expect(err.requestId).toBe('req_abc123');
    expect(err.cause).toBe(cause);
  });

  it('sets provider to unknown when not provided', () => {
    const err = new LLMError('err', { statusCode: 500 });
    expect(err.provider).toBe('unknown');
  });

  it('isHttpError returns true when statusCode is set', () => {
    const err = new LLMError('err', { statusCode: 400 });
    expect(err.isHttpError).toBe(true);
  });

  it('isHttpError returns false when statusCode is undefined', () => {
    const err = new LLMError('err');
    expect(err.isHttpError).toBe(false);
  });

  it('isRetryable returns true for network errors (undefined status)', () => {
    const err = new LLMError('network error');
    expect(err.isRetryable).toBe(true);
  });

  it('isRetryable returns true for 5xx status codes', () => {
    const err500 = new LLMError('err', { statusCode: 500 });
    const err502 = new LLMError('err', { statusCode: 502 });
    const err503 = new LLMError('err', { statusCode: 503 });
    expect(err500.isRetryable).toBe(true);
    expect(err502.isRetryable).toBe(true);
    expect(err503.isRetryable).toBe(true);
  });

  it('isRetryable returns true for 429 status code', () => {
    const err = new LLMError('rate limited', { statusCode: 429 });
    expect(err.isRetryable).toBe(true);
  });

  it('isRetryable returns false for 4xx non-429 status codes', () => {
    const err400 = new LLMError('bad request', { statusCode: 400 });
    const err401 = new LLMError('unauthorized', { statusCode: 401 });
    const err403 = new LLMError('forbidden', { statusCode: 403 });
    const err404 = new LLMError('not found', { statusCode: 404 });
    expect(err400.isRetryable).toBe(false);
    expect(err401.isRetryable).toBe(false);
    expect(err403.isRetryable).toBe(false);
    expect(err404.isRetryable).toBe(false);
  });

  it('preserves provider across multiple instances', () => {
    const err1 = new LLMError('err', { provider: 'mock' });
    const err2 = new LLMError('err', { provider: 'opencode-zen' });
    expect(err1.provider).toBe('mock');
    expect(err2.provider).toBe('opencode-zen');
  });
});

// ============================================================================
// Type shapes (structural / compile-time checks)
// ============================================================================

describe('Message type', () => {
  it('can be a system message', () => {
    const msg: Message = { role: 'system', content: 'You are a writer.' };
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('You are a writer.');
  });

  it('can be a user message', () => {
    const msg: Message = { role: 'user', content: 'Write a scene.' };
    expect(msg.role).toBe('user');
  });

  it('can be an assistant message', () => {
    const msg: Message = { role: 'assistant', content: 'Scene written.' };
    expect(msg.role).toBe('assistant');
  });

  it('accepts empty content', () => {
    const msg: Message = { role: 'user', content: '' };
    expect(msg.content).toBe('');
  });
});

describe('CompletionRequest type', () => {
  it('requires only messages', () => {
    const req: CompletionRequest = { messages: [] };
    expect(req.messages).toEqual([]);
    expect(req.model).toBeUndefined();
    expect(req.temperature).toBeUndefined();
    expect(req.maxTokens).toBeUndefined();
    expect(req.stop).toBeUndefined();
  });

  it('accepts all optional fields', () => {
    const req: CompletionRequest = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 500,
      stop: ['\n', 'END'],
    };
    expect(req.model).toBe('test-model');
    expect(req.temperature).toBe(0.7);
    expect(req.maxTokens).toBe(500);
    expect(req.stop).toHaveLength(2);
  });
});

describe('CompletionResponse type', () => {
  it('has the required shape', () => {
    const res: CompletionResponse = {
      id: 'resp_1',
      model: 'test-model',
      content: 'Hello, world!',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      finishReason: 'stop',
    };
    expect(res.id).toBe('resp_1');
    expect(res.model).toBe('test-model');
    expect(res.content).toBe('Hello, world!');
    expect(res.usage.promptTokens).toBe(10);
    expect(res.usage.completionTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(15);
    expect(res.finishReason).toBe('stop');
  });

  it('allows zero token counts', () => {
    const res: CompletionResponse = {
      id: 'resp_0',
      model: 'm',
      content: '',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    };
    expect(res.usage.totalTokens).toBe(0);
  });
});

describe('LLMProvider interface', () => {
  it('can be implemented by a minimal provider', () => {
    const provider: LLMProvider = {
      name: 'minimal',
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        return {
          id: '1',
          model: 'minimal',
          content: 'ok',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        };
      },
    };
    expect(provider.name).toBe('minimal');
  });

  it('can optionally implement completeStream', () => {
    const provider: LLMProvider = {
      name: 'streaming',
      async complete(req) {
        return {
          id: '1',
          model: 's',
          content: 'ok',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        };
      },
      async completeStream(req, onChunk) {
        const result = await this.complete(req);
        onChunk(result.content);
        return result;
      },
    };
    expect(typeof provider.completeStream).toBe('function');
  });
});
