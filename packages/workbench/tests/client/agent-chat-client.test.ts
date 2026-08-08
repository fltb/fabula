import { describe, expect, it } from 'vitest';
import { createAgentChatClient } from '../../src/client/agent-chat-client';
import type { BrowserFetch } from '../../src/client/browser-read-client';

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const run = {
  version: 1,
  runId: 'run-1',
  conversationId: 'conv-1',
  operationId: 'op-1',
  status: 'queued',
  turn: 0,
  maxTurns: 16,
  toolCalls: 0,
  maxToolCalls: 64,
  errorCode: null,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
} as const;

describe('createAgentChatClient', () => {
  it('carries only the transient session header on guarded requests', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: BrowserFetch = async (input, init) => {
      calls.push({ input, init });
      return json(
        {
          version: 1,
          conversation: {
            version: 1,
            conversationId: 'conv-1',
            projectId: 'proj-a',
            title: null,
            createdAt: 'now',
            updatedAt: 'now',
          },
        },
        201,
      );
    };
    const client = createAgentChatClient({
      baseUrl: 'http://host.test',
      getSessionId: () => 'live-session',
      fetch,
    });
    const conversation = await client.createConversation('proj-a');
    expect(conversation.conversationId).toBe('conv-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('http://host.test/api/v1/projects/proj-a/agent/conversations');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('x-fabula-session')).toBe('live-session');
    expect(headers.get('accept')).toBe('application/json');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('routes send/history/cancel/retry to the exact guarded paths', async () => {
    const requested: string[] = [];
    const fetch: BrowserFetch = async (input, init) => {
      const url = String(input);
      requested.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/runs/run-1')) return json({ version: 1, run });
      if (url.endsWith('/history')) {
        return json({
          version: 1,
          projectId: 'proj-a',
          conversation: {
            version: 1,
            conversationId: 'conv-1',
            projectId: 'proj-a',
            title: null,
            createdAt: 'now',
            updatedAt: 'now',
          },
          runs: [],
        });
      }
      return json({ version: 1, message: 'hi', run });
    };
    const client = createAgentChatClient({ fetch, getSessionId: () => 's' });

    await client.sendMessage('proj-a', 'conv-1', 'hi');
    await client.history('proj-a', 'conv-1');
    await client.cancel('proj-a', 'run-1');
    await client.retry('proj-a', 'run-1');

    expect(requested).toEqual([
      'POST /api/v1/projects/proj-a/agent/conversations/conv-1/runs',
      'GET /api/v1/projects/proj-a/agent/conversations/conv-1/history',
      'POST /api/v1/projects/proj-a/agent/runs/run-1/cancel',
      'POST /api/v1/projects/proj-a/agent/runs/run-1/retry',
    ]);
  });

  it('never includes the message or run ids as query material (project-scoped routes only)', async () => {
    const requested: string[] = [];
    const fetch: BrowserFetch = async (input, _init) => {
      const url = String(input);
      requested.push(url);
      return json({ version: 1, message: 'secret words', run });
    };
    const client = createAgentChatClient({ fetch });
    await client.sendMessage('proj-a', 'conv-1', 'secret words');
    expect(requested[0]).toBe('/api/v1/projects/proj-a/agent/conversations/conv-1/runs');
    expect(requested[0]).not.toContain('secret');
  });

  it('throws a typed error with the Host code on non-2xx', async () => {
    const fetch: BrowserFetch = async () =>
      json({ error: { code: 'AGENT_CHAT_QUEUE_FULL', message: 'Queue is full.' } }, 409);
    const client = createAgentChatClient({ fetch });
    await expect(client.sendMessage('proj-a', 'conv-1', 'x')).rejects.toMatchObject({
      name: 'BrowserAgentChatApiError',
      status: 409,
      code: 'AGENT_CHAT_QUEUE_FULL',
    });
  });

  it('parses SSE frames from the progress stream and unsubscribes on demand', async () => {
    const frames = [
      'event: run-status\ndata: {"type":"run-status","run":{"version":1,"runId":"run-1","conversationId":"conv-1","operationId":"op-1","status":"running","turn":0,"maxTurns":16,"toolCalls":0,"maxToolCalls":64,"errorCode":null,"createdAt":"a","updatedAt":"b"}}\n\n',
      'event: assistant-text\ndata: {"type":"assistant-text","runId":"run-1","text":"hello","at":"now"}\n\n',
      'event: tool-call\ndata: {"type":"tool-call","runId":"run-1","call":{"version":1,"callIndex":0,"toolName":"nova_status","status":"pending","turn":1,"sanitizedArgsHash":"abc","resultRef":null,"resultSummary":null,"createdAt":"now"}}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    const fetch: BrowserFetch = async () => new Response(stream, { status: 200 });
    const client = createAgentChatClient({ fetch });
    const seen: string[] = [];
    const unsubscribe = client.openProgress('proj-a', 'conv-1', 'run-1', (event) => {
      seen.push(event.type);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    unsubscribe();
    expect(seen).toEqual(['run-status', 'assistant-text', 'tool-call']);
  });
});
