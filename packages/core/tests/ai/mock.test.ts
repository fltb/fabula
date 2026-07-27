// ============================================================================
// AI Provider — Mock Provider — Unit Tests
// ============================================================================

import { describe, expect, it } from 'vitest';
import { MockProvider } from '../../src/ai/providers/mock.ts';
import type { CompletionRequest } from '../../src/ai/types.ts';

// ============================================================================
// Factory helpers
// ============================================================================

function userMsg(content: string) {
  return { role: 'user' as const, content };
}

function systemMsg(content: string) {
  return { role: 'system' as const, content };
}

// ============================================================================
// Tests
// ============================================================================

describe('MockProvider', () => {
  // ── Construction ──────────────────────────────────────────────────

  it('creates a provider with default options', () => {
    const p = new MockProvider();
    expect(p.name).toBe('mock');
    expect(p.callCount).toBe(0);
    expect(p.lastRequest).toBeUndefined();
  });

  // ── Basic completion ──────────────────────────────────────────────

  it('returns a response with the correct shape', async () => {
    const p = new MockProvider({ responses: ['Hello world'] });
    const req: CompletionRequest = { messages: [userMsg('test')] };
    const res = await p.complete(req);

    expect(res).toHaveProperty('id');
    expect(res.id).toMatch(/^mock-/);
    expect(res.model).toBe('mock-model');
    expect(res.content).toBe('Hello world');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toHaveProperty('promptTokens');
    expect(res.usage).toHaveProperty('completionTokens');
    expect(res.usage).toHaveProperty('totalTokens');
  });

  // ── Fixed responses ──────────────────────────────────────────────

  it('cycles through the provided responses list', async () => {
    const p = new MockProvider({ responses: ['A', 'B', 'C'] });
    const req: CompletionRequest = { messages: [userMsg('x')] };

    expect((await p.complete(req)).content).toBe('A');
    expect((await p.complete(req)).content).toBe('B');
    expect((await p.complete(req)).content).toBe('C');
    // After exhausting the list, falls back to echo
    const fourth = await p.complete(req);
    expect(fourth.content).toContain('Mock response');
  });

  it('echoes the last user message when responses are exhausted', async () => {
    const p = new MockProvider({ responses: ['Only one'] });
    const req: CompletionRequest = { messages: [userMsg('Write a scene about dragons.')] };

    const first = await p.complete(req);
    expect(first.content).toBe('Only one');

    const second = await p.complete(req);
    expect(second.content).toMatch(/^Mock response:/);
    expect(second.content).toContain('Write a scene about dragons');
  });

  it('returns generic fallback when no user message exists', async () => {
    const p = new MockProvider({ responses: [] });
    const req: CompletionRequest = { messages: [systemMsg('do it')] };
    const res = await p.complete(req);
    expect(res.content).toBe('Mock response');
  });

  // ── Generator ────────────────────────────────────────────────────

  it('uses the generator function when provided', async () => {
    const p = new MockProvider({
      generator: (req) => `Generated: ${req.messages.length} messages`,
    });
    const req: CompletionRequest = { messages: [systemMsg('a'), userMsg('b')] };
    const res = await p.complete(req);
    expect(res.content).toBe('Generated: 2 messages');
  });

  it('prefers generator over responses list', async () => {
    const p = new MockProvider({
      responses: ['Should not see this'],
      generator: () => 'Generator wins',
    });
    const res = await p.complete({ messages: [userMsg('hi')] });
    expect(res.content).toBe('Generator wins');
  });

  // ── Call tracking ────────────────────────────────────────────────

  it('tracks call count', async () => {
    const p = new MockProvider({ responses: ['a', 'b', 'c'] });
    expect(p.callCount).toBe(0);
    await p.complete({ messages: [userMsg('x')] });
    expect(p.callCount).toBe(1);
    await p.complete({ messages: [userMsg('x')] });
    expect(p.callCount).toBe(2);
    await p.complete({ messages: [userMsg('x')] });
    expect(p.callCount).toBe(3);
  });

  it('exposes the last request', async () => {
    const p = new MockProvider();
    const req: CompletionRequest = {
      messages: [userMsg('final')],
      model: 'my-model',
      temperature: 0.5,
    };
    await p.complete({ messages: [userMsg('first')] });
    await p.complete(req);
    expect(p.lastRequest).toBe(req);
    expect(p.lastRequest?.model).toBe('my-model');
  });

  it('records all requests in order', async () => {
    const p = new MockProvider({ responses: ['x', 'y'] });
    await p.complete({ messages: [userMsg('one')] });
    await p.complete({ messages: [userMsg('two')] });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0].messages[0].content).toBe('one');
    expect(p.calls[1].messages[0].content).toBe('two');
  });

  // ── Failure simulation ───────────────────────────────────────────

  it('throws on the configured failOnCall (1-indexed)', async () => {
    const p = new MockProvider({
      responses: ['ok', 'ok', 'ok'],
      failOnCall: 2,
      failMessage: 'Simulated crash',
    });
    // First call succeeds
    await expect(p.complete({ messages: [userMsg('x')] })).resolves.toBeDefined();
    // Second call fails
    await expect(p.complete({ messages: [userMsg('x')] })).rejects.toThrow('Simulated crash');
    // Third call succeeds again
    await expect(p.complete({ messages: [userMsg('x')] })).resolves.toBeDefined();
  });

  it('uses default fail message when failMessage is not set', async () => {
    const p = new MockProvider({
      failOnCall: 1,
    });
    await expect(p.complete({ messages: [userMsg('x')] })).rejects.toThrow(
      'Mock failure on call 1',
    );
  });

  it('does not throw when failOnCall is not reached', async () => {
    const p = new MockProvider({
      responses: ['a', 'b'],
      failOnCall: 10,
    });
    await expect(p.complete({ messages: [userMsg('x')] })).resolves.toBeDefined();
    await expect(p.complete({ messages: [userMsg('x')] })).resolves.toBeDefined();
  });

  // ── Latency ──────────────────────────────────────────────────────

  it('simulates latency when latencyMs is set', async () => {
    const p = new MockProvider({
      responses: ['slow'],
      latencyMs: 50,
    });
    const start = performance.now();
    await p.complete({ messages: [userMsg('x')] });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow slight timing fudge
  });

  it('completes immediately with zero latency', async () => {
    const p = new MockProvider({ responses: ['fast'] });
    const start = performance.now();
    await p.complete({ messages: [userMsg('x')] });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50); // should be near-instant
  });

  // ── Model passthrough ────────────────────────────────────────────

  it('uses the model from the request', async () => {
    const p = new MockProvider({ responses: ['custom model'] });
    const res = await p.complete({
      messages: [userMsg('hi')],
      model: 'deepseek-v4-flash',
    });
    expect(res.model).toBe('deepseek-v4-flash');
  });

  it('defaults model to mock-model when not specified', async () => {
    const p = new MockProvider({ responses: ['default model'] });
    const res = await p.complete({ messages: [userMsg('hi')] });
    expect(res.model).toBe('mock-model');
  });

  // ── Token estimation ─────────────────────────────────────────────

  it('estimates tokens based on content length / 4', async () => {
    const longContent = 'x'.repeat(100);
    const p = new MockProvider({ responses: [longContent] });
    const res = await p.complete({ messages: [userMsg('a'.repeat(40))] });
    expect(res.usage.promptTokens).toBe(10); // 40/4
    expect(res.usage.completionTokens).toBe(25); // 100/4
  });
});
