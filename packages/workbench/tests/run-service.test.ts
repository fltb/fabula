// ============================================================================
// WorkbenchAgentRunService tests (plan 9.4)
// ============================================================================
// Verifies the built-in Agent run loop over the shared executor + model port:
// turn/tool-call accounting against V3 bounds, catalog-only tool enforcement,
// store-first progress publication, cancellation mid-run, the restart sweep
// with explicit (never automatic) retry, and backpressure on a full queue.
// The store is the REAL persistence worker (real automaton/counters); the
// executor, model and operation queue are deterministic stubs.
// ============================================================================

import type {
  AgentModelEvent,
  AgentToolSpec,
  WorkbenchAgentModelPort,
} from '@novalistically/node-host';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectAccessRole } from '../src/contracts/configuration.js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../src/contracts/configuration.js';
import type {
  AgentConversationRecordV1,
  AgentRunRecordV1,
  AgentToolCallRecordV1,
  ProjectOperationRecordV1,
} from '../src/contracts/persistence.js';
import type {
  ProjectToolExecutor,
  ProjectToolExecutorPrincipal,
} from '../src/host/agent/project-tool-executor.js';
import {
  AgentChatServiceError,
  createWorkbenchAgentRunService,
  type WorkbenchAgentRunService,
} from '../src/host/agent/run-service.js';
import type { McpAuthorizedCaller } from '../src/host/mcp/auth.js';
import type { McpToolDefinition, McpToolResult } from '../src/host/mcp/registry.js';
import type {
  ProjectOperationEnqueueResult,
  ProjectOperationService,
} from '../src/host/operation-service.js';
import { type AgentStore, createAgentStore } from '../src/persistence/agent-store.js';
import { createRealPersistence } from './helpers/real-persistence.js';

const harnesses: ReturnType<typeof createRealPersistence>[] = [];
afterAll(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

const PRINCIPAL: ProjectToolExecutorPrincipal = {
  userId: 'u-owner',
  role: 'maintainer',
  capabilityVersion: 4,
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: 'session-live',
};

interface ToolCallRecord {
  readonly name: string;
  readonly caller: McpAuthorizedCaller;
  readonly input: unknown;
}

/** Deterministic executor over a tiny registry: nova_status + nova_authoring_submit. */
function stubExecutor(
  results: Record<string, McpToolResult>,
  calls: ToolCallRecord[] = [],
): ProjectToolExecutor {
  const definitions: readonly McpToolDefinition[] = [
    {
      name: 'nova_status',
      description: 'Read the workflow status.',
      requiredScopes: ['mcp:read'],
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      run: () => Promise.resolve({ ok: true, data: { version: 1, status: 'ready' } }),
    },
    {
      name: 'nova_authoring_submit',
      description: 'Submit the working layer.',
      requiredScopes: ['mcp:submit'],
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      run: () => Promise.resolve({ ok: true, data: { submitted: true } }),
    },
  ];
  return {
    projectId: 'p1',
    session: undefined as never,
    listTools(scopes) {
      return definitions.filter((definition) =>
        definition.requiredScopes.every((scope) => scopes.includes(scope)),
      );
    },
    async callTool(name, caller, input) {
      calls.push({ name, caller, input });
      return results[name] ?? { ok: true, data: { executed: name } };
    },
    callerForRole(principal) {
      const grant = {
        capabilityId: `builtin:p1:${principal.userId}`,
        userId: principal.userId,
        projectId: 'p1',
        scopes: PROJECT_ACCESS_ROLE_GRANTS[principal.role].scopes,
        version: principal.capabilityVersion,
        expiresAt: principal.expiresAt,
      };
      return {
        sessionId: principal.sessionId ?? null,
        userId: principal.userId,
        role: principal.role,
        projectGrant: { projectId: 'p1', role: principal.role },
        grant,
      };
    },
  };
}

/** Scripted model: one call per turn; each script entry yields that turn's events. */
class StubModel implements WorkbenchAgentModelPort {
  readonly supportsToolCalls = true;
  readonly calls: Array<{
    readonly tools: readonly AgentToolSpec[];
    readonly messages: unknown[];
  }> = [];
  readonly script: Array<() => AgentModelEvent[] | AsyncGenerator<AgentModelEvent>>;
  onRequest?: (request: { readonly signal?: AbortSignal; readonly maxTurns: number }) => void;

  constructor(script: Array<() => AgentModelEvent[] | AsyncGenerator<AgentModelEvent>> = []) {
    this.script = script;
  }

  async *run(request: {
    readonly tools: readonly AgentToolSpec[];
    readonly messages: readonly unknown[];
    readonly maxTurns: number;
    readonly signal?: AbortSignal;
  }): AsyncIterable<AgentModelEvent> {
    // Snapshot: the service mutates the same array across turns.
    this.calls.push({ tools: request.tools, messages: [...request.messages] });
    this.onRequest?.(request);
    const produce =
      this.script.shift() ?? (() => [{ type: 'finish' as const, finishReason: 'stop' }]);
    const events = produce();
    if (Symbol.asyncIterator in Object(events)) {
      yield* events as AsyncGenerator<AgentModelEvent>;
    } else {
      yield* events as AgentModelEvent[];
    }
  }
}

function textEvent(text: string): AgentModelEvent {
  return { type: 'assistant-text', text };
}
function toolEvent(id: string, name: string, args: unknown): AgentModelEvent {
  return { type: 'tool-call', id, name, args };
}
function finish(): AgentModelEvent {
  return { type: 'finish', finishReason: 'stop' };
}

/** Deterministic operation queue double: captures runners; cancel aborts the signal. */
class StubOperations implements ProjectOperationService {
  readonly projectId = 'p1';
  readonly enqueued: Array<{
    input: Parameters<ProjectOperationService['enqueue']>[0];
    operationId: string;
  }> = [];
  readonly records = new Map<string, ProjectOperationRecordV1>();
  controllers = new Map<string, AbortController>();
  queueFull = false;

  async start(): Promise<{ updated: number }> {
    return { updated: 0 };
  }
  async enqueue(
    input: Parameters<ProjectOperationService['enqueue']>[0],
  ): Promise<ProjectOperationEnqueueResult> {
    if (this.queueFull) {
      return { status: 'queue-full', errorCode: 'OPERATION_QUEUE_FULL', active: 64 };
    }
    const operationId = `op-${this.enqueued.length + 1}`;
    const at = '2026-08-06T00:00:00.000Z';
    const record: ProjectOperationRecordV1 = {
      version: 1,
      projectId: this.projectId,
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
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(operationId, record);
    this.enqueued.push({ input, operationId });
    return { status: 'queued', operationHandle: operationId, record };
  }
  async get(operationId: string): Promise<ProjectOperationRecordV1 | null> {
    return this.records.get(operationId) ?? null;
  }
  async list(): Promise<readonly ProjectOperationRecordV1[]> {
    return [...this.records.values()];
  }
  getResult(): unknown {
    return null;
  }
  async cancel(
    operationId: string,
  ): Promise<{ status: 'cancelled'; record: ProjectOperationRecordV1 }> {
    this.controllers.get(operationId)?.abort();
    const current = this.records.get(operationId);
    if (current === undefined) throw new Error('missing operation');
    const record = {
      ...current,
      status: 'cancelled' as const,
      updatedAt: '2026-08-06T00:00:01.000Z',
    };
    this.records.set(operationId, record);
    return { status: 'cancelled', record };
  }
  async close(): Promise<void> {}

  /** Invoke the n-th enqueued runner with a real AbortController; returns the outcome. */
  async runEnqueued(index = 0): Promise<{ status: string; errorCode?: string }> {
    const entry = this.enqueued[index];
    if (entry === undefined) throw new Error('no enqueued operation');
    const controller = new AbortController();
    this.controllers.set(entry.operationId, controller);
    const outcome = await entry.input.runner({
      session: undefined as never,
      operationId: entry.operationId,
      actorId: entry.input.actorId,
      capabilityVersion: entry.input.capabilityVersion,
      signal: controller.signal,
      reportProgress: async () => {},
    });
    // Mirror the real operation service: the terminal outcome lands on the
    // durable operation row (errorCode included).
    const current = this.records.get(entry.operationId);
    if (current !== undefined) {
      this.records.set(entry.operationId, {
        ...current,
        status: outcome.status === 'succeeded' ? 'succeeded' : outcome.status,
        errorCode: outcome.status === 'failed' ? (outcome.errorCode ?? null) : null,
        updatedAt: '2026-08-06T00:00:01.000Z',
      });
    }
    return outcome;
  }
}

interface Harness {
  store: AgentStore;
  operations: StubOperations;
  executorCalls: ToolCallRecord[];
  service: WorkbenchAgentRunService;
  model: StubModel;
}

function harness(
  options: {
    readonly maxTurns?: number;
    readonly maxToolCalls?: number;
    readonly model?: StubModel;
    readonly executorResults?: Record<string, McpToolResult>;
  } = {},
): Harness {
  const persistence = createRealPersistence();
  harnesses.push(persistence);
  const store = createAgentStore(persistence.client);
  const operations = new StubOperations();
  const executorCalls: ToolCallRecord[] = [];
  const executor = stubExecutor(options.executorResults ?? {}, executorCalls);
  const model = options.model ?? new StubModel();
  const service = createWorkbenchAgentRunService({
    projectId: 'p1',
    store,
    executor,
    model,
    operations,
    agent: { maxTurns: options.maxTurns ?? 16, maxToolCalls: options.maxToolCalls ?? 64 },
    now: () => '2026-08-06T00:00:00.000Z',
  });
  return { store, operations, executorCalls, service, model };
}

async function createConversation(
  h: Harness,
  role: ProjectAccessRole = 'maintainer',
): Promise<AgentConversationRecordV1> {
  return h.store.getConversation(
    (
      await h.service.createConversation({
        principalUserId: PRINCIPAL.userId,
        role,
        title: 'First chat',
      })
    ).conversationId,
  ) as Promise<AgentConversationRecordV1>;
}

describe('WorkbenchAgentRunService run loop', () => {
  it('drives turns over the shared executor and succeeds with persisted receipts', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    const model = h.model;
    model.script.push(() => [
      textEvent('inspecting'),
      toolEvent('t1', 'nova_status', {}),
      finish(),
    ]);
    model.script.push(() => [textEvent('all good'), finish()]);

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'Check the project status',
      principal: PRINCIPAL,
    });
    expect(run.status).toBe('queued');
    expect(run.operationId).toBe('op-1');

    const outcome = await h.operations.runEnqueued(0);
    expect(outcome).toMatchObject({ status: 'succeeded' });

    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('succeeded');
    expect(persisted?.turn).toBe(2);
    expect(persisted?.toolCalls).toBe(1);

    const toolCalls = await h.store.listToolCalls({ runId: run.runId });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolName: 'nova_status',
      status: 'succeeded',
      turn: 1,
      callIndex: 0,
      sanitizedArgsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      resultRef: expect.stringMatching(/^ok:[0-9a-f]{16}$/),
    });

    // The model saw exactly the executor's maintainer tool set (incl. submit).
    const toolNames = model.calls[0]?.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['nova_status', 'nova_authoring_submit']));
    expect(h.executorCalls).toHaveLength(1);
    expect(h.executorCalls[0]?.caller.grant.scopes).toEqual([
      'mcp:read',
      'mcp:render',
      'mcp:author',
      'mcp:submit',
    ]);
  });

  it('publishes progress only after records persist (store-first ordering)', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    h.model.script.push(() => [toolEvent('t1', 'nova_status', {}), finish()]);
    h.model.script.push(() => [textEvent('done'), finish()]);

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'status',
      principal: PRINCIPAL,
    });
    const events: string[] = [];
    const unsubscribe = h.service.subscribeProgress(run.runId, (event) => {
      if (event.type === 'tool-call') {
        // The pending receipt must already be durable when the event fires.
        void h.store.listToolCalls({ runId: run.runId }).then((calls) => {
          expect(calls.some((call) => call.callIndex === event.call.callIndex)).toBe(true);
        });
      }
      events.push(`${event.type}:${event.type === 'tool-call' ? event.call.status : event.type}`);
    });
    try {
      const outcome = await h.operations.runEnqueued(0);
      expect(outcome.status).toBe('succeeded');
      expect(events).toEqual([
        'run-status:run-status',
        'tool-call:pending',
        'tool-call:succeeded',
        'tool-result:tool-result',
        'assistant-text:assistant-text',
        'run-status:run-status',
      ]);
    } finally {
      unsubscribe();
    }
    // Tool-call records were persisted before the stream published them.
    const calls = await h.store.listToolCalls({ runId: run.runId });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('succeeded');
  });

  it('fails with AGENT_MAX_TURNS_EXCEEDED when the model keeps calling tools', async () => {
    const h = harness({ maxTurns: 2, maxToolCalls: 8 });
    const conversation = await createConversation(h);
    h.model.script.push(() => [toolEvent('t1', 'nova_status', {}), finish()]);
    h.model.script.push(() => [toolEvent('t2', 'nova_status', {}), finish()]);

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'loop',
      principal: PRINCIPAL,
    });
    const outcome = await h.operations.runEnqueued(0);
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'AGENT_MAX_TURNS_EXCEEDED' });

    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.turn).toBe(2);
    const operation = await h.operations.get('op-1');
    expect(operation?.errorCode).toBe('AGENT_MAX_TURNS_EXCEEDED');
  });

  it('fails with AGENT_MAX_TOOL_CALLS_EXCEEDED when a turn exceeds the tool budget', async () => {
    const h = harness({ maxTurns: 4, maxToolCalls: 1 });
    const conversation = await createConversation(h);
    h.model.script.push(() => [
      toolEvent('t1', 'nova_status', {}),
      toolEvent('t2', 'nova_authoring_submit', {}),
      finish(),
    ]);

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'two tools',
      principal: PRINCIPAL,
    });
    const outcome = await h.operations.runEnqueued(0);
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'AGENT_MAX_TOOL_CALLS_EXCEEDED' });

    // The second (over-budget) tool call was never executed.
    expect(h.executorCalls.map((call) => call.name)).toEqual(['nova_status']);
    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.toolCalls).toBe(1);
  });

  it('rejects tools outside the registry catalog before touching the executor', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    h.model.script.push(() => [toolEvent('t1', 'nova_hallucinated_tool', {}), finish()]);

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'hallucinate',
      principal: PRINCIPAL,
    });
    const outcome = await h.operations.runEnqueued(0);
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'AGENT_TOOL_NOT_IN_CATALOG' });
    expect(h.executorCalls).toHaveLength(0);

    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('failed');
    // No pending tool call record leaked for the rejected tool.
    const calls = await h.store.listToolCalls({ runId: run.runId });
    expect(calls).toHaveLength(0);
  });

  it('feeds a failed tool result back to the model with the error shape', async () => {
    const h = harness({
      executorResults: {
        nova_status: { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'no source' } },
      },
    });
    const conversation = await createConversation(h);
    h.model.script.push(() => [toolEvent('t1', 'nova_status', {}), finish()]);
    h.model.script.push(() => [textEvent('recovering'), finish()]);

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'status',
      principal: PRINCIPAL,
    });
    const outcome = await h.operations.runEnqueued(0);
    expect(outcome.status).toBe('succeeded');

    const calls = await h.store.listToolCalls({ runId: run.runId });
    expect(calls[0]).toMatchObject({ status: 'failed', resultRef: 'error:SOURCE_UNAVAILABLE' });
    // The model's second call saw the tool error as a tool message.
    const secondTurnMessages = h.model.calls[1]?.messages;
    expect(secondTurnMessages?.some((m) => (m as { role: string }).role === 'tool')).toBe(true);
  });
});

describe('WorkbenchAgentRunService cancel and restart semantics', () => {
  it('cancels a queued run (operation cancelled, run record cancelled)', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'will cancel',
      principal: PRINCIPAL,
    });
    const outcome = await h.service.cancel(run.runId);
    expect(outcome.status).toBe('cancelled');
    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('cancelled');
    const operation = await h.operations.get('op-1');
    expect(operation?.status).toBe('cancelled');
  });

  it('cancels a running run mid-turn through the operation signal', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.model.script.push(() => {
      return (async function* blocked(): AsyncGenerator<AgentModelEvent> {
        yield toolEvent('t1', 'nova_status', {});
        await gate;
        yield finish();
      })();
    });

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'blocked run',
      principal: PRINCIPAL,
    });
    const pending = h.operations.runEnqueued(0);
    // Wait until the model call is in flight (tool call executed, gate held).
    await new Promise((resolve) => setTimeout(resolve, 30));
    const outcome = await h.service.cancel(run.runId);
    expect(outcome.status).toBe('cancelled');
    release?.();
    const runnerResult = await pending;
    expect(runnerResult.status).toBe('cancelled');
    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('cancelled');
  });

  it('sweeps queued/running runs to interrupted on start and never auto-replays', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'sweep me',
      principal: PRINCIPAL,
    });
    const { updated } = await h.service.start();
    expect(updated).toBe(1);
    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('interrupted');
    // No runner was invoked by the sweep (stub operations never auto-run).
    expect(h.model.calls).toHaveLength(0);
  });

  it('explicit retry re-enqueues an interrupted run with the same message', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    h.model.script.push(() => [toolEvent('t1', 'nova_status', {}), finish()]);
    h.model.script.push(() => [textEvent('done'), finish()]);
    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'retry me',
      principal: PRINCIPAL,
    });
    await h.service.start();
    expect((await h.store.getRun(run.runId))?.status).toBe('interrupted');

    const retried = await h.service.retry(run.runId, PRINCIPAL);
    expect(retried.status).toBe('queued');
    expect((await h.store.getRun(run.runId))?.status).toBe('queued');

    const outcome = await h.operations.runEnqueued(1);
    expect(outcome.status).toBe('succeeded');
    expect((await h.store.getRun(run.runId))?.status).toBe('succeeded');
    // The retried run re-executed from the stored user message.
    expect(h.model.calls[0]?.messages).toEqual([{ role: 'user', content: 'retry me' }]);
  });

  it('returns queue-full as a typed failure when the queue rejects the run', async () => {
    const h = harness();
    h.operations.queueFull = true;
    const conversation = await createConversation(h);
    await expect(
      h.service.sendMessage({
        conversationId: conversation.conversationId,
        message: 'full queue',
        principal: PRINCIPAL,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_CHAT_QUEUE_FULL' } satisfies { code: string });
    // No run row is created for work that never enqueued (no queued→failed
    // transition exists); the caller sees the typed code instead.
    const runs = await h.store.listRuns({ projectId: 'p1' });
    expect(runs).toHaveLength(0);
  });

  it('rejects messages for a foreign principal conversation', async () => {
    const h = harness();
    const conversation = await createConversation(h, 'maintainer');
    await expect(
      h.service.sendMessage({
        conversationId: conversation.conversationId,
        message: 'not mine',
        principal: { ...PRINCIPAL, userId: 'u-other' },
      }),
    ).rejects.toBeInstanceOf(AgentChatServiceError);
  });
});
