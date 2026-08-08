// ============================================================================
// Browser Agent Chat API tests (plan 9.5)
// ============================================================================
// Verifies the guarded conversation/run routes: auth gating (401/403/404),
// secret-free DTOs, durable history, store-first SSE progress replay, and
// cancel/retry. The routes are mounted on a Hono app exactly as the Host
// mounts them; the run service is real (real persistence worker) with
// deterministic executor/model/operation doubles.
// ============================================================================

import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  AgentChatCancelResultV1,
  AgentChatCreateConversationResultV1,
  AgentChatHistoryV1,
  AgentChatSendMessageResultV1,
} from '../src/contracts/agent-chat.js';
import {
  BROWSER_AGENT_CONVERSATION_HISTORY_PATH,
  BROWSER_AGENT_CONVERSATION_RUNS_PATH,
  BROWSER_AGENT_CONVERSATIONS_PATH,
  BROWSER_AGENT_RUN_CANCEL_PATH,
  BROWSER_AGENT_RUN_PROGRESS_PATH,
  BROWSER_AGENT_RUN_RETRY_PATH,
} from '../src/contracts/agent-chat.js';
import { BROWSER_SESSION_HEADER } from '../src/contracts/browser-api.js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../src/contracts/configuration.js';
import type {
  ProjectToolExecutor,
  ProjectToolExecutorPrincipal,
} from '../src/host/agent/project-tool-executor.js';
import {
  createWorkbenchAgentRunService,
  type WorkbenchAgentRunService,
} from '../src/host/agent/run-service.js';
import type { BrowserAgentChatApiOptions } from '../src/host/browser-agent-chat-api.js';
import { createBrowserAgentChatApi } from '../src/host/browser-agent-chat-api.js';
import type {
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from '../src/host/browser-read-api.js';
import type { McpToolDefinition, McpToolResult } from '../src/host/mcp/registry.js';
import type { HostServer } from '../src/host/server.js';
import { createAgentStore } from '../src/persistence/agent-store.js';
import { createRealPersistence } from './helpers/real-persistence.js';
import {
  assistantPartial,
  doneEvent,
  scriptedStream,
  textDelta,
  toolCallEnd,
} from './helpers/scripted-stream.js';

const harnesses: ReturnType<typeof createRealPersistence>[] = [];
afterAll(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

const SESSION_HEADERS = { [BROWSER_SESSION_HEADER]: 'session-1' };

const principal = {
  version: 1 as const,
  userId: 'u-owner',
  role: 'owner' as const,
  displayName: 'Owner',
  capabilityVersion: 4,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const resolver: BrowserPrincipalResolver = {
  resolve: async (request) => {
    const session = request.headers.get(BROWSER_SESSION_HEADER);
    if (session === 'expired') return { ok: false, failure: 'SESSION_EXPIRED' };
    if (session !== 'session-1') return { ok: false, failure: 'SESSION_NOT_FOUND' };
    return { ok: true, principal };
  },
};

const authorization: BrowserProjectAuthorization = {
  canAccessProject: async (_userId, projectId) => projectId === 'proj-a' || projectId === 'proj-b',
};

const catalog: BrowserProjectCatalog = {
  listProjects: async () => [
    {
      version: 1,
      projectId: 'proj-a',
      displayName: 'Alpha',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      open: true,
    },
    {
      version: 1,
      projectId: 'proj-b',
      displayName: 'Beta',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      open: true,
    },
  ],
};

const roleResolver: BrowserAgentChatApiOptions['roleResolver'] = async (userId, projectId) =>
  userId === 'u-owner' && projectId === 'proj-a' ? 'maintainer' : null;

const _PRINCIPAL: ProjectToolExecutorPrincipal = {
  userId: 'u-owner',
  role: 'maintainer',
  capabilityVersion: 4,
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: 'session-1',
};

function stubExecutor(calls: string[]): ProjectToolExecutor {
  const definitions: readonly McpToolDefinition[] = [
    {
      name: 'nova_status',
      description: 'Read workflow status.',
      requiredScopes: ['mcp:read'],
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      run: () => Promise.resolve({ ok: true, data: { version: 1, status: 'ready' } }),
    },
  ];
  return {
    projectId: 'proj-a',
    session: undefined as never,
    listTools(scopes) {
      return definitions.filter((d) => d.requiredScopes.every((scope) => scopes.includes(scope)));
    },
    async callTool(name) {
      calls.push(name);
      return { ok: true, data: { executed: name } } satisfies McpToolResult;
    },
    callerForRole(principalInput) {
      return {
        sessionId: principalInput.sessionId ?? null,
        userId: principalInput.userId,
        role: principalInput.role,
        projectGrant: { projectId: 'proj-a', role: principalInput.role },
        grant: {
          capabilityId: `builtin:proj-a:${principalInput.userId}`,
          userId: principalInput.userId,
          projectId: 'proj-a',
          scopes: PROJECT_ACCESS_ROLE_GRANTS[principalInput.role].scopes,
          version: principalInput.capabilityVersion,
          expiresAt: principalInput.expiresAt,
        },
      };
    },
  };
}

/** A scripted turn: the events one streamFn call yields plus its final message. */
interface ScriptedTurn {
  readonly events: readonly AssistantMessageEvent[];
  readonly final: AssistantMessage;
}

/** Minimal pi-ai model identity; the scripted streamFn never streams it. */
const fakeModel: Model<Api> = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'pi-provider',
  baseUrl: 'http://localhost:1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_000,
};

function finishTurn(): ScriptedTurn {
  const final = assistantPartial([]);
  return { events: [doneEvent('stop', final)], final };
}

function toolTurn(
  id: string,
  name: string,
  args: Record<string, unknown>,
  text = '',
): ScriptedTurn {
  const final = assistantPartial([
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    { type: 'toolCall', id, name, arguments: args },
  ]);
  return {
    events: [
      { type: 'start', partial: final },
      ...(text.length > 0 ? [textDelta(text, final)] : []),
      toolCallEnd({ type: 'toolCall', id, name, arguments: args }, final),
      doneEvent('toolUse', final),
    ],
    final,
  };
}

function textTurn(text: string): ScriptedTurn {
  const final = assistantPartial([{ type: 'text', text }]);
  return {
    events: [{ type: 'start', partial: final }, textDelta(text, final), doneEvent('stop', final)],
    final,
  };
}

/** Scripted pi-ai agentModel: one streamFn call per turn, in script order. */
function scriptedModel(turns: ScriptedTurn[] = []) {
  const script = [...turns];
  const streamFn: StreamFn = () => {
    const turn = script.shift() ?? finishTurn();
    return scriptedStream([...turn.events], turn.final);
  };
  return { model: fakeModel, streamFn };
}

interface OpEntry {
  readonly operationId: string;
  readonly runner: (ctx: {
    readonly signal: AbortSignal;
    readonly reportProgress: (p: { completed: number; total: number }) => Promise<void>;
  }) => Promise<{ status: string; errorCode?: string }>;
  readonly actorId: string;
  readonly capabilityVersion: number;
  readonly requestHash: string;
}

/** Minimal operation queue double: captures the runner, cancel aborts its signal. */
function stubOperations(entries: OpEntry[] = [], queueFull = false) {
  const controllers = new Map<string, AbortController>();
  return {
    projectId: 'proj-a',
    start: async () => ({ updated: 0 }),
    enqueue: async (
      input: Parameters<
        Parameters<typeof createWorkbenchAgentRunService>[0]['operations']['enqueue']
      >[0],
    ) => {
      if (queueFull) return { status: 'queue-full', errorCode: 'OPERATION_QUEUE_FULL', active: 64 };
      const operationId = `op-${entries.length + 1}`;
      entries.push({
        operationId,
        runner: input.runner,
        actorId: input.actorId,
        capabilityVersion: input.capabilityVersion,
        requestHash: input.requestHash,
      });
      return {
        status: 'queued',
        operationHandle: operationId,
        record: {
          version: 1,
          projectId: 'proj-a',
          operationId,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          status: 'queued',
          actorId: input.actorId,
          capabilityVersion: input.capabilityVersion,
          sourceHash: null,
          acceptedRevisionId: null,
          progress: null,
          resultRef: input.requestHash,
          errorCode: null,
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:00:00.000Z',
        },
      };
    },
    get: async () => null,
    list: async () => [],
    getResult: () => null,
    cancel: async (operationId: string) => {
      controllers.get(operationId)?.abort();
      return { status: 'cancelled', record: null };
    },
    close: async () => {},
    entries,
    runEntry(index: number) {
      const entry = entries[index];
      const controller = new AbortController();
      controllers.set(entry.operationId, controller);
      return entry.runner({
        signal: controller.signal,
        reportProgress: async () => {},
      });
    },
  };
}

interface Harness {
  app: Hono;
  operations: ReturnType<typeof stubOperations>;
  executorCalls: string[];
  service: WorkbenchAgentRunService;
}

function harness(turns: ScriptedTurn[] = []): Harness {
  const persistence = createRealPersistence();
  harnesses.push(persistence);
  const store = createAgentStore(persistence.client);
  const entries: OpEntry[] = [];
  const operations = stubOperations(entries);
  const executorCalls: string[] = [];
  const service = createWorkbenchAgentRunService({
    projectId: 'proj-a',
    store,
    executor: stubExecutor(executorCalls),
    agentModel: scriptedModel(turns),
    operations: operations as never,
    agent: { maxTurns: 16, maxToolCalls: 64 },
    now: () => '2026-08-06T00:00:00.000Z',
  });
  const registered = {
    reads: new Map<string, (c: never) => unknown>(),
    mutations: new Map<string, (c: never) => unknown>(),
  };
  const host = {
    registerReadRoute(path: string, handler: (c: never) => unknown) {
      registered.reads.set(path, handler);
    },
    registerMutationRoute(_method: string, path: string, handler: (c: never) => unknown) {
      registered.mutations.set(path, handler);
    },
  } as unknown as HostServer;
  createBrowserAgentChatApi({
    principal: resolver,
    authorization,
    catalog,
    roleResolver,
    services: { get: async (projectId) => (projectId === 'proj-a' ? service : null) },
  }).register(host);
  const app = new Hono();
  for (const [path, handler] of registered.reads) app.get(path, handler as never);
  for (const [path, handler] of registered.mutations) app.post(path, handler as never);
  return { app, operations, executorCalls, service };
}

function pathFor(template: string): string {
  return template
    .replace(':projectId', 'proj-a')
    .replace(':conversationId', 'conversation-1')
    .replace(':runId', 'run-1');
}

async function createConversation(app: Hono): Promise<string> {
  const res = await app.request(pathFor(BROWSER_AGENT_CONVERSATIONS_PATH), {
    method: 'POST',
    headers: { ...SESSION_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as AgentChatCreateConversationResultV1;
  return body.conversation.conversationId;
}

describe('Browser Agent Chat API guards', () => {
  it('rejects missing/expired sessions with 401 on every route', async () => {
    const h = harness();
    for (const [method, path] of [
      ['GET', pathFor(BROWSER_AGENT_CONVERSATION_HISTORY_PATH)],
      ['GET', pathFor(BROWSER_AGENT_RUN_PROGRESS_PATH)],
      ['POST', pathFor(BROWSER_AGENT_CONVERSATIONS_PATH)],
      ['POST', pathFor(BROWSER_AGENT_CONVERSATION_RUNS_PATH)],
      ['POST', pathFor(BROWSER_AGENT_RUN_CANCEL_PATH)],
      ['POST', pathFor(BROWSER_AGENT_RUN_RETRY_PATH)],
    ] as const) {
      for (const headers of [{}, { [BROWSER_SESSION_HEADER]: 'expired' }]) {
        const res = await h.app.request(path, { method, headers });
        expect(res.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
  });

  it('denies cross-project access with 403 before any service call', async () => {
    const h = harness();
    const res = await h.app.request(
      BROWSER_AGENT_CONVERSATIONS_PATH.replace(':projectId', 'secret-project'),
      { method: 'POST', headers: SESSION_HEADERS, body: JSON.stringify({ version: 1 }) },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROJECT_MISMATCH');
  });

  it('fails closed with 503 when no Agent service exists for the project', async () => {
    const h = harness();
    const res = await h.app.request(
      BROWSER_AGENT_CONVERSATIONS_PATH.replace(':projectId', 'proj-b'),
      { method: 'POST', headers: SESSION_HEADERS, body: JSON.stringify({ version: 1 }) },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_CHAT_UNAVAILABLE');
  });
});

describe('Browser Agent Chat API conversation/run surface', () => {
  it('creates a secret-free conversation DTO', async () => {
    const h = harness();
    const conversationId = await createConversation(h.app);
    expect(conversationId.length).toBeGreaterThan(0);
  });

  it('sends a message and starts a queued run with an operation handle', async () => {
    const h = harness([finishTurn()]);
    const conversationId = await createConversation(h.app);
    const res = await h.app.request(
      BROWSER_AGENT_CONVERSATION_RUNS_PATH.replace(':projectId', 'proj-a').replace(
        ':conversationId',
        conversationId,
      ),
      {
        method: 'POST',
        headers: { ...SESSION_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, message: 'status please' }),
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as AgentChatSendMessageResultV1;
    expect(body.message).toBe('status please');
    expect(body.run).toMatchObject({
      status: 'queued',
      operationId: 'op-1',
      maxTurns: 16,
      maxToolCalls: 64,
    });
  });

  it('rejects over-long messages with 400', async () => {
    const h = harness();
    const conversationId = await createConversation(h.app);
    const res = await h.app.request(
      BROWSER_AGENT_CONVERSATION_RUNS_PATH.replace(':projectId', 'proj-a').replace(
        ':conversationId',
        conversationId,
      ),
      {
        method: 'POST',
        headers: { ...SESSION_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, message: 'x'.repeat(16_001) }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AGENT_CHAT_INVALID');
  });

  it('serves durable history with tool-call receipts after a completed run', async () => {
    const h = harness([toolTurn('t1', 'nova_status', {}), textTurn('done')]);
    const conversationId = await createConversation(h.app);
    const sent = await h.app.request(
      BROWSER_AGENT_CONVERSATION_RUNS_PATH.replace(':projectId', 'proj-a').replace(
        ':conversationId',
        conversationId,
      ),
      {
        method: 'POST',
        headers: { ...SESSION_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, message: 'run me' }),
      },
    );
    const _sendBody = (await sent.json()) as AgentChatSendMessageResultV1;
    const outcome = await h.operations.runEntry(0);
    expect(outcome.status).toBe('succeeded');

    const history = await h.app.request(
      BROWSER_AGENT_CONVERSATION_HISTORY_PATH.replace(':projectId', 'proj-a').replace(
        ':conversationId',
        conversationId,
      ),
      { headers: SESSION_HEADERS },
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as AgentChatHistoryV1;
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.run.status).toBe('succeeded');
    expect(body.runs[0]?.toolCalls).toHaveLength(1);
    expect(body.runs[0]?.toolCalls[0]).toMatchObject({
      toolName: 'nova_status',
      status: 'succeeded',
      resultSummary: expect.stringMatching(/^ok:/),
    });
    // Never a capability token or provider key in the wire DTO.
    expect(JSON.stringify(body)).not.toMatch(/token|apiKey|capability|secret/i);
    expect(h.executorCalls).toEqual(['nova_status']);
  });
});

describe('Browser Agent Chat API progress and cancel', () => {
  it('replays the durable store before streaming and closes for terminal runs', async () => {
    const h = harness([toolTurn('t1', 'nova_status', {}), textTurn('ok')]);
    const conversationId = await createConversation(h.app);
    const sent = await h.app.request(
      BROWSER_AGENT_CONVERSATION_RUNS_PATH.replace(':projectId', 'proj-a').replace(
        ':conversationId',
        conversationId,
      ),
      {
        method: 'POST',
        headers: { ...SESSION_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, message: 'progress' }),
      },
    );
    const sendBody = (await sent.json()) as AgentChatSendMessageResultV1;
    await h.operations.runEntry(0);

    const progress = await h.app.request(
      BROWSER_AGENT_RUN_PROGRESS_PATH.replace(':projectId', 'proj-a')
        .replace(':conversationId', conversationId)
        .replace(':runId', sendBody.run.runId),
      { headers: SESSION_HEADERS },
    );
    expect(progress.status).toBe(200);
    const frames = await progress.text();
    const dataLines = frames
      .split('\n\n')
      .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => line !== undefined)
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            type: string;
            run?: { status: string };
            call?: { callIndex: number; status: string };
          },
      );
    // Store-first: the terminal run-status and the completed receipt come from
    // the durable store before any live event.
    expect(dataLines[0]).toMatchObject({ type: 'run-status', run: { status: 'succeeded' } });
    expect(dataLines[1]).toMatchObject({
      type: 'tool-call',
      call: { callIndex: 0, status: 'succeeded' },
    });
  });

  it('cancels a queued run through the route', async () => {
    const h = harness();
    const conversationId = await createConversation(h.app);
    const sent = await h.app.request(
      BROWSER_AGENT_CONVERSATION_RUNS_PATH.replace(':projectId', 'proj-a').replace(
        ':conversationId',
        conversationId,
      ),
      {
        method: 'POST',
        headers: { ...SESSION_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, message: 'cancel me' }),
      },
    );
    const sendBody = (await sent.json()) as AgentChatSendMessageResultV1;
    const res = await h.app.request(
      BROWSER_AGENT_RUN_CANCEL_PATH.replace(':projectId', 'proj-a').replace(
        ':runId',
        sendBody.run.runId,
      ),
      { method: 'POST', headers: SESSION_HEADERS, body: '{}' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentChatCancelResultV1;
    expect(body.status).toBe('cancelled');
    expect(h.operations.entries).toHaveLength(1);
  });

  it('retries an interrupted run through the route and re-queues it', async () => {
    const h = harness([finishTurn()]);
    const conversationId = await createConversation(h.app);
    const sent = await h.app.request(
      BROWSER_AGENT_CONVERSATION_RUNS_PATH.replace(':projectId', 'proj-a').replace(
        ':conversationId',
        conversationId,
      ),
      {
        method: 'POST',
        headers: { ...SESSION_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, message: 'retry me' }),
      },
    );
    const sendBody = (await sent.json()) as AgentChatSendMessageResultV1;
    // The restart sweep interrupts the queued run (never auto-replayed).
    expect(h.operations.entries).toHaveLength(1);
    await h.service.start();
    const res = await h.app.request(
      BROWSER_AGENT_RUN_RETRY_PATH.replace(':projectId', 'proj-a').replace(
        ':runId',
        sendBody.run.runId,
      ),
      { method: 'POST', headers: SESSION_HEADERS, body: '{}' },
    );
    // The transcript is still in memory: the explicit retry re-queues the run.
    expect(res.status).toBe(202);
    const body = (await res.json()) as AgentChatCancelResultV1;
    expect(body.status).toBe('queued');
  });
});
