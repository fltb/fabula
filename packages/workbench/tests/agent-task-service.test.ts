import { describe, expect, it } from 'vitest';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '@novalistically/core';
import {
  type AgentTaskProvider,
  type AgentTaskRequest,
  AgentTaskInputError,
  AgentTaskService,
  AGENT_TASK_MAX_OUTPUT_CHARACTERS,
  AGENT_TASK_MAX_PROMPT_CHARACTERS,
} from '../src/host/agent/index.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

class FakeTaskProvider implements AgentTaskProvider {
  readonly name = 'fake-provider';
  calls = 0;
  lastRequest: CompletionRequest | null = null;

  constructor(private readonly next: () => CompletionResponse | Error) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls += 1;
    this.lastRequest = request;
    const result = this.next();
    if (result instanceof Error) throw result;
    return result;
  }
}

function response(overrides: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    id: 'resp-1',
    model: 'fake-model',
    content: '[{"from":0,"length":3,"text":"hi"}]',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    ...overrides,
  };
}

function request(overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return { system: 'be strict', user: 'fix the document', ...overrides };
}

// ─── Provider execution ──────────────────────────────────────────────────────

describe('AgentTaskService provider execution', () => {
  it('returns a typed completed result with content, model, usage, and finish reason', async () => {
    const provider = new FakeTaskProvider(() => response({ model: 'model-x' }));
    const service = new AgentTaskService({ provider });
    const result = await service.run(request());
    expect(result).toEqual({
      status: 'completed',
      content: '[{"from":0,"length":3,"text":"hi"}]',
      model: 'model-x',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    expect(service.providerName).toBe('fake-provider');
    expect(provider.calls).toBe(1);
    expect(provider.lastRequest?.messages).toEqual([
      { role: 'system', content: 'be strict' },
      { role: 'user', content: 'fix the document' },
    ]);
  });

  it('forwards optional model/temperature/maxTokens/signal onto the provider request', async () => {
    const provider = new FakeTaskProvider(() => response());
    const service = new AgentTaskService({ provider });
    const signal = new AbortController().signal;
    await service.run(request({ model: 'm', temperature: 0.5, maxTokens: 400, signal }));
    expect(provider.lastRequest).toMatchObject({
      model: 'm',
      temperature: 0.5,
      maxTokens: 400,
      signal,
    });
  });

  it('maps a provider throw to a typed failed result and truncated message', async () => {
    const error = new Error('x'.repeat(10_000));
    (error as { code?: string }).code = 'E_PROVIDER_DOWN';
    const service = new AgentTaskService({
      provider: new FakeTaskProvider(() => error),
    });
    const result = await service.run(request());
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ errorCode: 'E_PROVIDER_DOWN' });
    expect(result.status === 'failed' && result.message.length).toBeLessThan(600);
  });

  it('reports a typed aborted code when the signal aborted and the provider failed', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new AgentTaskService({
      provider: new FakeTaskProvider(() => new Error('network reset')),
    });
    const result = await service.run(request({ signal: controller.signal }));
    expect(result).toMatchObject({ status: 'failed', errorCode: 'agent.task.aborted' });
  });

  it('truncates an oversized provider completion to the configured output cap', async () => {
    const oversized = 'y'.repeat(AGENT_TASK_MAX_OUTPUT_CHARACTERS + 5_000);
    const service = new AgentTaskService({
      provider: new FakeTaskProvider(() => response({ content: oversized })),
      maxOutputCharacters: 1_000,
    });
    const result = await service.run(request());
    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.content.length).toBe(1_001); // 1000 + ellipsis
  });
});

// ─── Strict input boundary ───────────────────────────────────────────────────

describe('AgentTaskService strict input boundary', () => {
  it('fails closed at construction without an injected provider', () => {
    expect(() => new AgentTaskService({ provider: undefined as never })).toThrow(TypeError);
    expect(
      () => new AgentTaskService({ provider: { name: '', complete: async () => response() } }),
    ).toThrow(TypeError);
  });

  it('rejects unknown fields before any provider call', async () => {
    const provider = new FakeTaskProvider(() => response());
    const service = new AgentTaskService({ provider });
    await expect(
      service.run({ ...request(), token: 'fc_secret' } as unknown as AgentTaskRequest),
    ).rejects.toThrow(AgentTaskInputError);
    expect(provider.calls).toBe(0); // nothing reached the provider
  });

  it('rejects empty prompts, oversized prompts, bad temperature, and bad maxTokens', async () => {
    const provider = new FakeTaskProvider(() => response());
    const service = new AgentTaskService({ provider });
    await expect(service.run(request({ system: '' }))).rejects.toThrow(AgentTaskInputError);
    await expect(service.run(request({ user: '' }))).rejects.toThrow(AgentTaskInputError);
    await expect(service.run(request({ temperature: 3 }))).rejects.toThrow(AgentTaskInputError);
    await expect(service.run(request({ maxTokens: 0 }))).rejects.toThrow(AgentTaskInputError);
    await expect(
      service.run(request({ system: 'a', user: 'b'.repeat(AGENT_TASK_MAX_PROMPT_CHARACTERS + 1) })),
    ).rejects.toThrow(AgentTaskInputError);
    expect(provider.calls).toBe(0);
  });

  it('accepts a provider shaped like the Core LLMProvider contract', async () => {
    const coreShaped: LLMProvider = {
      name: 'core-shaped',
      async complete() {
        return response();
      },
    };
    const service = new AgentTaskService({ provider: coreShaped });
    const result = await service.run(request());
    expect(result).toMatchObject({ status: 'completed' });
  });
});
