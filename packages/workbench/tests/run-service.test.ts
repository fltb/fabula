// ============================================================================
// WorkbenchAgentRunService tests (plan 9.4)
// ============================================================================
// Verifies the built-in Agent run loop over the shared executor + pi-ai model:
// turn/tool-call accounting against V3 bounds, catalog-only tool enforcement,
// store-first progress publication, cancellation mid-run, the restart sweep
// with explicit (never automatic) retry, and backpressure on a full queue.
// The store is the REAL persistence worker (real automaton/counters); the
// executor, model and operation queue are deterministic stubs.
// ============================================================================

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { type Api, AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectAccessRole } from '../src/contracts/configuration.js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../src/contracts/configuration.js';
import type {
  AgentConversationRecordV1,
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

/** One scripted streamFn call = one assistant turn. */
function toolTurn(
  id: string,
  name: string,
  args: Record<string, unknown>,
  text = '',
): AssistantMessageEventStream {
  const final = assistantPartial([
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    { type: 'toolCall', id, name, arguments: args },
  ]);
  return scriptedStream(
    [
      { type: 'start', partial: final },
      ...(text.length > 0 ? [textDelta(text, final)] : []),
      toolCallEnd({ type: 'toolCall', id, name, arguments: args }, final),
      doneEvent('toolUse', final),
    ],
    final,
  );
}

function textTurn(text: string): AssistantMessageEventStream {
  const final = assistantPartial([{ type: 'text', text }]);
  return scriptedStream(
    [{ type: 'start', partial: final }, textDelta(text, final), doneEvent('stop', final)],
    final,
  );
}
function finishTurn(): AssistantMessageEventStream {
  const final = assistantPartial([]);
  return scriptedStream([doneEvent('stop', final)], final);
}

interface ScriptedAgentModel {
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly script: Array<() => AssistantMessageEventStream>;
  readonly calls: Array<{
    readonly tools: readonly { name: string }[];
    readonly messages: readonly unknown[];
    readonly systemPrompt: string;
  }>;
}

/** Scripted model: one streamFn call per turn; each script entry yields that turn's stream. */
function scriptedModel(script: Array<() => AssistantMessageEventStream> = []): ScriptedAgentModel {
  const calls: Array<{
    readonly tools: readonly { name: string }[];
    readonly messages: readonly unknown[];
    readonly systemPrompt: string;
  }> = [];
  const streamFn: StreamFn = (_model, context) => {
    // Snapshot: the service mutates the same messages array across turns.
    calls.push({
      tools: context.tools ?? [],
      messages: [...context.messages],
      systemPrompt: context.systemPrompt,
    });
    const produce = script.shift() ?? finishTurn;
    return produce();
  };
  return { model: fakeModel, streamFn, script, calls };
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
  model: ScriptedAgentModel;
}

function harness(
  options: {
    readonly maxTurns?: number;
    readonly maxToolCalls?: number;
    readonly model?: ScriptedAgentModel;
    readonly executorResults?: Record<string, McpToolResult>;
    readonly isWorkflowComplete?: () => boolean | Promise<boolean>;
  } = {},
): Harness {
  const persistence = createRealPersistence();
  harnesses.push(persistence);
  const store = createAgentStore(persistence.client);
  const operations = new StubOperations();
  const executorCalls: ToolCallRecord[] = [];
  const executor = stubExecutor(options.executorResults ?? {}, executorCalls);
  const model = options.model ?? scriptedModel();
  const service = createWorkbenchAgentRunService({
    projectId: 'p1',
    store,
    executor,
    agentModel: { model: model.model, streamFn: model.streamFn },
    operations,
    agent: { maxTurns: options.maxTurns ?? 16, maxToolCalls: options.maxToolCalls ?? 64 },
    ...(options.isWorkflowComplete === undefined
      ? {}
      : { isWorkflowComplete: options.isWorkflowComplete }),
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
    model.script.push(() => toolTurn('t1', 'nova_status', {}, 'inspecting'));
    model.script.push(() => textTurn('all good'));

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
    expect(h.executorCalls[0]?.caller.grant.scopes).toEqual(
      PROJECT_ACCESS_ROLE_GRANTS.maintainer.scopes,
    );
  });

  it('folds the caller view context into the run system prompt', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    h.model.script.push(() => textTurn('ok'));
    await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'hello',
      principal: PRINCIPAL,
      context: {
        route: '/workspace/p1',
        view: 'scene-map',
        projectId: 'p1',
        projectName: '双城后转',
        selection: 'scene:E02',
        visible: ['场景列表'],
        actions: ['提交场景'],
      },
    });
    await h.operations.runEnqueued(0);
    const system = h.model.calls[0]?.systemPrompt ?? '';
    expect(system).toContain('Current caller view');
    expect(system).toContain('view: scene-map');
    expect(system).toContain('project: 双城后转');
    expect(system).toContain('selection: scene:E02');
    expect(system).toContain('actions available: 提交场景');
  });

  it('publishes progress only after records persist (store-first ordering)', async () => {
    const h = harness();
    const conversation = await createConversation(h);
    h.model.script.push(() => toolTurn('t1', 'nova_status', {}));
    h.model.script.push(() => textTurn('done'));

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

  it('force-terminates as succeeded when the workflow completes despite a re-confirming model', async () => {
    const h = harness({
      maxTurns: 16,
      isWorkflowComplete: () => completed,
    });
    let completed = false;
    const conversation = await createConversation(h);
    // Turn 1: the model executes a tool and finishes (chain reached publish).
    h.model.script.push(() => toolTurn('t1', 'nova_authoring_submit', {}));
    // The completion signal flips AFTER turn 1's tool executes; the model
    // wants another confirmation turn, but the gate stops it.
    completed = true;
    h.model.script.push(() => toolTurn('t2', 'nova_status', {}));

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'publish then confirm',
      principal: PRINCIPAL,
    });
    const outcome = await h.operations.runEnqueued(0);
    expect(outcome).toMatchObject({ status: 'succeeded' });
    // The model never got the second turn (no re-confirmation call ran).
    expect(h.executorCalls).toHaveLength(1);
    expect(h.executorCalls[0]?.name).toBe('nova_authoring_submit');
    const persisted = await h.store.getRun(run.runId);
    expect(persisted?.status).toBe('succeeded');
    expect(persisted?.turn).toBe(1);
    expect(persisted?.toolCalls).toBe(1);
  });

  it('fails with AGENT_MAX_TURNS_EXCEEDED when the model keeps calling tools', async () => {
    const h = harness({ maxTurns: 2, maxToolCalls: 8 });
    const conversation = await createConversation(h);
    h.model.script.push(() => toolTurn('t1', 'nova_status', {}));
    h.model.script.push(() => toolTurn('t2', 'nova_status', {}));

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
    h.model.script.push(() => {
      const final = assistantPartial([
        { type: 'toolCall', id: 't1', name: 'nova_status', arguments: {} },
        { type: 'toolCall', id: 't2', name: 'nova_authoring_submit', arguments: {} },
      ]);
      return scriptedStream(
        [
          { type: 'start', partial: final },
          toolCallEnd({ type: 'toolCall', id: 't1', name: 'nova_status', arguments: {} }, final),
          toolCallEnd(
            { type: 'toolCall', id: 't2', name: 'nova_authoring_submit', arguments: {} },
            final,
          ),
          doneEvent('toolUse', final),
        ],
        final,
      );
    });

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
    h.model.script.push(() => toolTurn('t1', 'nova_hallucinated_tool', {}));

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
    h.model.script.push(() => toolTurn('t1', 'nova_status', {}));
    h.model.script.push(() => textTurn('recovering'));

    const run = await h.service.sendMessage({
      conversationId: conversation.conversationId,
      message: 'status',
      principal: PRINCIPAL,
    });
    const outcome = await h.operations.runEnqueued(0);
    expect(outcome.status).toBe('succeeded');

    const calls = await h.store.listToolCalls({ runId: run.runId });
    expect(calls[0]).toMatchObject({ status: 'failed', resultRef: 'error:SOURCE_UNAVAILABLE' });
    // The model's second call saw the tool error as a toolResult message.
    const secondTurnMessages = h.model.calls[1]?.messages;
    expect(
      secondTurnMessages?.some(
        (m) => typeof m === 'object' && m !== null && 'role' in m && m.role === 'toolResult',
      ),
    ).toBe(true);
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
      const final = assistantPartial([
        { type: 'toolCall', id: 't1', name: 'nova_status', arguments: {} },
      ]);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'start', partial: final });
      stream.push(
        toolCallEnd({ type: 'toolCall', id: 't1', name: 'nova_status', arguments: {} }, final),
      );
      // The tool executes only after `done`; hold the gate so the run is
      // mid-stream when cancel fires, then release on the way out.
      void gate.then(() => {
        stream.push(doneEvent('toolUse', final));
        stream.end(final);
      });
      return stream;
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
    h.model.script.push(() => toolTurn('t1', 'nova_status', {}));
    h.model.script.push(() => textTurn('done'));
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
    expect(h.model.calls[0]?.messages).toMatchObject([{ role: 'user', content: 'retry me' }]);
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
