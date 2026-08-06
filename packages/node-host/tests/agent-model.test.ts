// ============================================================================
// WorkbenchAgentModel adapter tests
// ============================================================================
// Verifies the AI SDK tool-calling adapter (plan 9.2): MCP JSON Schemas are
// converted into AI SDK `tool()` definitions via `jsonSchema()`, text /
// tool-call / finish events stream out of `generateText` steps, `maxSteps`
// is bounded by `maxTurns`, abort propagates via `abortSignal`, and the
// `supportsToolCalls` capability flag reflects the adapter options.
// ============================================================================

import type * as AiModule from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn()),
}));

type GenerateTextMock = (options: unknown) => Promise<unknown>;

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn<GenerateTextMock>(),
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual<AiModule>('ai');
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

// ── SUT ──────────────────────────────────────────────────────────────────────

import type {
  AgentModelEvent,
  AgentModelMessage,
  AgentToolSpec,
} from '../src/agent/workbench-agent-model.ts';
import { createWorkbenchAgentModelAdapter } from '../src/agent/workbench-agent-model.ts';

// ============================================================================
// Fixtures
// ============================================================================

const TOOL_SPECS: readonly AgentToolSpec[] = [
  {
    name: 'nova_status',
    description: 'Read the accepted-layer workflow status.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'nova_authoring_submit',
    description: 'Submit the working layer to the accepted source.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { expectedWorkspaceDigest: { type: 'string' } },
      required: ['expectedWorkspaceDigest'],
    },
  },
];

/** Minimal `generateText` result; the adapter only reads steps + finishReason. */
function mockResult(overrides: Record<string, unknown> = {}) {
  return {
    text: 'first draft',
    steps: [
      {
        callId: 'call-1',
        stepNumber: 0,
        text: 'first draft',
        toolCalls: [
          { type: 'tool-call', toolCallId: 'call-t1', toolName: 'nova_status', input: {} },
        ],
      },
    ],
    finishReason: 'stop',
    ...overrides,
  };
}

async function collect(
  request: Parameters<ReturnType<typeof createWorkbenchAgentModelAdapter>['run']>[0],
): Promise<AgentModelEvent[]> {
  const model = createWorkbenchAgentModelAdapter({ apiKey: 'test-key' });
  const events: AgentModelEvent[] = [];
  for await (const event of model.run(request)) events.push(event);
  return events;
}

/** Last `generateText` call the adapter made. */
function lastGenerateTextCall(): Record<string, unknown> {
  const calls = mockGenerateText.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

// ============================================================================
// Tests
// ============================================================================

describe('createWorkbenchAgentModelAdapter', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue(mockResult());
  });

  it('emits assistant-text, tool-call, and finish events from one step', async () => {
    const events = await collect({
      system: 'You are a writer.',
      messages: [],
      tools: TOOL_SPECS,
      maxTurns: 5,
    });

    expect(events).toEqual([
      { type: 'assistant-text', text: 'first draft' },
      { type: 'tool-call', id: 'call-t1', name: 'nova_status', args: {} },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('emits tool calls from every step in order', async () => {
    mockGenerateText.mockResolvedValue(
      mockResult({
        steps: [
          {
            callId: 'call-1',
            stepNumber: 0,
            text: 'step one',
            toolCalls: [{ type: 'tool-call', toolCallId: 'a', toolName: 'nova_status', input: {} }],
          },
          {
            callId: 'call-2',
            stepNumber: 1,
            text: '',
            toolCalls: [
              {
                type: 'tool-call',
                toolCallId: 'b',
                toolName: 'nova_authoring_submit',
                input: { expectedWorkspaceDigest: 'abc' },
              },
            ],
          },
        ],
      }),
    );

    const events = await collect({
      system: 'sys',
      messages: [],
      tools: TOOL_SPECS,
      maxTurns: 2,
    });

    expect(events).toEqual([
      { type: 'assistant-text', text: 'step one' },
      { type: 'tool-call', id: 'a', name: 'nova_status', args: {} },
      {
        type: 'tool-call',
        id: 'b',
        name: 'nova_authoring_submit',
        args: { expectedWorkspaceDigest: 'abc' },
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('converts MCP JSON Schemas into AI SDK tool input schemas', async () => {
    await collect({
      system: 'sys',
      messages: [],
      tools: TOOL_SPECS,
      maxTurns: 5,
    });

    const tools = lastGenerateTextCall().tools as Record<
      string,
      { description?: string; inputSchema: { jsonSchema: unknown } }
    >;
    expect(Object.keys(tools).sort()).toEqual(TOOL_SPECS.map((spec) => spec.name).sort());
    expect(tools['nova_status'].description).toBe(TOOL_SPECS[0].description);
    expect(tools['nova_status'].inputSchema.jsonSchema).toEqual(TOOL_SPECS[0].inputSchema);
    expect(tools['nova_authoring_submit'].inputSchema.jsonSchema).toEqual(
      TOOL_SPECS[1].inputSchema,
    );
  });

  it('bounds the tool loop by maxTurns via the stop condition, clamped to 1', async () => {
    await collect({ system: 'sys', messages: [], tools: TOOL_SPECS, maxTurns: 3 });
    const stopWhen = lastGenerateTextCall().stopWhen as (options: { steps: unknown[] }) => boolean;
    expect(typeof stopWhen).toBe('function');
    // The bound is reached exactly at maxTurns completed steps.
    expect(stopWhen({ steps: new Array(3) })).toBe(true);
    expect(stopWhen({ steps: new Array(2) })).toBe(false);

    mockGenerateText.mockClear();
    await collect({ system: 'sys', messages: [], tools: TOOL_SPECS, maxTurns: 0 });
    const clamped = lastGenerateTextCall().stopWhen as (options: { steps: unknown[] }) => boolean;
    expect(clamped({ steps: new Array(1) })).toBe(true);
  });

  it('propagates the caller abort signal to generateText', async () => {
    const controller = new AbortController();
    await collect({
      system: 'sys',
      messages: [],
      tools: TOOL_SPECS,
      maxTurns: 2,
      signal: controller.signal,
    });

    expect(lastGenerateTextCall().abortSignal).toBe(controller.signal);
  });

  it('passes system and converts user/assistant/tool messages', async () => {
    const messages: readonly AgentModelMessage[] = [
      { role: 'user', content: 'Check the status.' },
      { role: 'assistant', content: 'Calling status.' },
      { role: 'tool', toolCallId: 'call-t1', toolName: 'nova_status', result: { ok: true } },
      {
        role: 'tool',
        toolCallId: 'call-t2',
        toolName: 'nova_authoring_submit',
        result: 'boom',
        isError: true,
      },
    ];

    await collect({ system: 'system-prompt', messages, tools: TOOL_SPECS, maxTurns: 2 });

    const call = lastGenerateTextCall();
    expect(call.system).toBe('system-prompt');
    expect(call.messages).toEqual([
      { role: 'user', content: 'Check the status.' },
      { role: 'assistant', content: 'Calling status.' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-t1',
            toolName: 'nova_status',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-t2',
            toolName: 'nova_authoring_submit',
            output: { type: 'error-text', value: 'boom' },
          },
        ],
      },
    ]);
  });

  it('defaults supportsToolCalls to true and honors the capability flag', () => {
    expect(createWorkbenchAgentModelAdapter({ apiKey: 'test-key' }).supportsToolCalls).toBe(true);
    expect(
      createWorkbenchAgentModelAdapter({ apiKey: 'test-key', supportsToolCalls: true })
        .supportsToolCalls,
    ).toBe(true);
    expect(
      createWorkbenchAgentModelAdapter({ apiKey: 'test-key', supportsToolCalls: false })
        .supportsToolCalls,
    ).toBe(false);
  });

  it('throws when no API key is configured', () => {
    const previous = process.env.NOVALISTICALLY_AI_API_KEY;
    delete process.env.NOVALISTICALLY_AI_API_KEY;
    try {
      expect(() => createWorkbenchAgentModelAdapter({})).toThrow(/API key not provided/);
    } finally {
      if (previous === undefined) {
        delete process.env.NOVALISTICALLY_AI_API_KEY;
      } else {
        process.env.NOVALISTICALLY_AI_API_KEY = previous;
      }
    }
  });
});
