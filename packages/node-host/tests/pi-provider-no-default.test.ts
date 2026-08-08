import { describe, expect, it } from 'vitest';
import { createPiProviderStack, PiOpenAICompatibleProvider } from '../src/index.js';

describe('pi provider no-default runtime', () => {
  it('throws when baseURL/model are missing instead of defaulting', () => {
    expect(() => createPiProviderStack({})).toThrow(/baseURL and model are required/);
    expect(() => new PiOpenAICompatibleProvider({})).toThrow(/baseURL and model are required/);
  });

  it('constructs with explicit baseURL/model and passes advanced options through', () => {
    const stack = createPiProviderStack({
      baseURL: 'https://api.test/v1',
      modelId: 'test-model',
      reasoning: false,
      contextWindow: 32000,
      maxTokens: 8000,
      headers: { 'x-custom': 'v' },
    });
    expect(stack.model.baseUrl).toBe('https://api.test/v1');
    expect(stack.model.id).toBe('test-model');
    expect(stack.model.reasoning).toBe(false);
    expect(stack.model.contextWindow).toBe(32000);
    expect(stack.model.maxTokens).toBe(8000);
    expect(stack.model.headers).toEqual({ 'x-custom': 'v' });

    const provider = new PiOpenAICompatibleProvider({
      baseURL: 'https://api.test/v1',
      model: 'test-model',
      reasoning: false,
      contextWindow: 32000,
      maxTokens: 8000,
      headers: { 'x-custom': 'v' },
    });
    expect(provider.name).toBe('pi-openai-compatible');
  });
});
