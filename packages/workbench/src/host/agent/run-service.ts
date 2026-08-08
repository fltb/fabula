import { createHash, randomUUID } from 'node:crypto';

/**
 * WorkbenchAgentRunService (plan 9.4): the built-in Agent's run loop.
 *
 * One service per project. It owns the durable agent conversation/run/tool-call
 * records (via {@link AgentStore}) and drives turns over the SAME shared
 * {@link ProjectToolExecutor} + pi-ai {@link Model} the external
 * MCP transport uses — it never re-implements handler, CAS, or scope logic.
 *
 * Invariants this service enforces:
 *   - Catalog-only tools: every model-emitted tool call must name a tool in
 *     the exact set handed to the model (the executor's scope-filtered
 *     registry listing — the same set an external device with the same role
 *     sees). Anything else fails the run with a typed code.
 *   - V3 bounds: `maxTurns` / `maxToolCalls` are enforced in the service loop;
 *     exceeding either fails the run with a typed code (never silently stops).
 *   - Store-first progress: every assistant-text/tool-call/run-status event is
 *     published to progress subscribers ONLY after its backing record was
 *     durably persisted, so SSE consumers never observe a state the store
 *     does not have.
 *   - Backpressure: a run is enqueued through the project
 *     {@link ProjectOperationService} (kind 'agent-run'); a full queue fails
 *     the run with `OPERATION_QUEUE_FULL`.
 *   - Restart semantics: the interrupted sweep turns queued/running runs into
 *     `interrupted`; they are NEVER auto-replayed. An explicit retry
 *     re-enqueues the same idempotency key while the Host still holds the
 *     run transcript in memory.
 *   - Cancellation: an AbortController per run is threaded into the model and
 *     checked at every turn boundary; cancelling aborts the in-flight model
 *     call, cancels the backing operation, and transitions the run record.
 *
 * Records carry principal identity and hashes only — never capability tokens,
 * provider keys, raw arguments, or raw tool results.
 */

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { type TSchema, Type } from '@earendil-works/pi-ai';
import type {
  AgentChatConversationViewV1,
  AgentChatHistoryV1,
  AgentChatMessageViewV1,
  AgentChatProgressEventV1,
  AgentChatRunHistoryEntryV1,
  AgentChatRunViewV1,
  AgentChatToolCallReceiptV1,
  AgentViewContextV1,
} from '../../contracts/agent-chat.js';
import {
  AGENT_CHAT_CONTRACT_VERSION,
  AGENT_CHAT_MESSAGE_MAX_LENGTH,
  AGENT_CHAT_RESULT_SUMMARY_MAX_LENGTH,
  AGENT_CHAT_TITLE_MAX_LENGTH,
} from '../../contracts/agent-chat.js';
import type { ProjectAccessRole } from '../../contracts/configuration.js';
import { PROJECT_ACCESS_ROLE_GRANTS } from '../../contracts/configuration.js';
import type {
  AgentConversationMessageRecordV1,
  AgentConversationRecordV1,
  AgentRunRecordV1,
  AgentToolCallRecordV1,
} from '../../contracts/persistence.js';
import type { AgentStore } from '../../persistence/agent-store.js';
import type {
  ProjectOperationRunnerResult,
  ProjectOperationService,
} from '../operation-service.js';
import type { ProjectToolExecutor, ProjectToolExecutorPrincipal } from './project-tool-executor.js';

/** Typed run-loop failure codes persisted on the backing operation record. */
export type AgentRunFailureCode =
  | 'AGENT_MAX_TURNS_EXCEEDED'
  | 'AGENT_MAX_TOOL_CALLS_EXCEEDED'
  | 'AGENT_TOOL_NOT_IN_CATALOG'
  | 'AGENT_MODEL_ERROR';

/** Typed service-level errors surfaced by the browser chat API as HTTP codes. */
export type AgentChatServiceErrorCode =
  | 'AGENT_CHAT_UNAVAILABLE'
  | 'AGENT_CHAT_CONVERSATION_NOT_FOUND'
  | 'AGENT_CHAT_RUN_NOT_FOUND'
  | 'AGENT_CHAT_RUN_TERMINAL'
  | 'AGENT_CHAT_INVALID'
  | 'AGENT_CHAT_QUEUE_FULL';

export class AgentChatServiceError extends Error {
  override readonly name = 'AgentChatServiceError';
  constructor(
    readonly code: AgentChatServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkbenchAgentRunServiceOptions {
  readonly projectId: string;
  readonly store: AgentStore;
  /** The shared executor over this project's session (plan 9.1). */
  readonly executor: ProjectToolExecutor;
  /** pi-ai model + streamFn for this project's provider profile. */
  readonly agentModel: { readonly model: Model<Api>; readonly streamFn: StreamFn };
  /** The durable operation queue every run is enqueued through. */
  readonly operations: ProjectOperationService;
  /** V3 agent bounds: `{ maxTurns, maxToolCalls }` (enabled is the launch gate). */
  readonly agent: { readonly maxTurns: number; readonly maxToolCalls: number };
  /**
   * Optional workflow-completion signal (plan 9.4 hardening): when it resolves
   * true after a tool-executing turn, the run is force-terminated as
   * `succeeded` WITHOUT calling the model again — agents that keep
   * re-confirming finished work (deepseek/xai reasoning models are prone to
   * it) stop burning turns once the workflow goal is actually reached. The
   * launch wires it to "canonical publication is current".
   */
  readonly isWorkflowComplete?: () => boolean | Promise<boolean>;
  readonly now?: () => string;
}

export interface CreateAgentConversationInput {
  readonly principalUserId: string;
  readonly role: ProjectAccessRole;
  readonly title?: string | null;
}

export interface SendAgentMessageInput {
  readonly conversationId: string;
  readonly message: string;
  readonly principal: ProjectToolExecutorPrincipal;
  /** Caller-view snapshot folded into the run's system prompt. */
  readonly context?: AgentViewContextV1;
}

export type CancelAgentRunOutcome =
  | { readonly status: 'cancelled'; readonly run: AgentChatRunViewV1 }
  | { readonly status: 'not-found' }
  | { readonly status: 'terminal'; readonly run: AgentChatRunViewV1 };

export type RetryAgentRunOutcome =
  | { readonly status: 'queued'; readonly run: AgentChatRunViewV1 }
  | { readonly status: 'not-found' }
  | { readonly status: 'terminal'; readonly run: AgentChatRunViewV1 }
  | {
      readonly status: 'unavailable';
      readonly errorCode: 'AGENT_CHAT_INVALID';
      readonly message: string;
    };

export interface WorkbenchAgentRunService {
  readonly projectId: string;
  /** Restart recovery: every queued/running run of the project becomes `interrupted`. Never auto-replays. */
  start(): Promise<{ readonly updated: number }>;
  createConversation(input: CreateAgentConversationInput): Promise<AgentChatConversationViewV1>;
  /** The caller's conversations, newest-updated first (plan 4.3). */
  listConversations(principalUserId: string): Promise<AgentChatConversationViewV1[]>;
  sendMessage(input: SendAgentMessageInput): Promise<AgentChatRunViewV1>;
  getRun(runId: string): Promise<AgentChatRunViewV1 | null>;
  /** Store-first run snapshot (run status + completed tool calls) for SSE replay. */
  snapshot(runId: string): Promise<{
    readonly run: AgentChatRunViewV1;
    readonly toolCalls: readonly AgentChatToolCallReceiptV1[];
  } | null>;
  history(conversationId: string): Promise<AgentChatHistoryV1 | null>;
  cancel(runId: string): Promise<CancelAgentRunOutcome>;
  /** Explicit retry of an interrupted run (only while the transcript is in memory). */
  retry(runId: string, principal: ProjectToolExecutorPrincipal): Promise<RetryAgentRunOutcome>;
  /** Live progress subscription for one run; store-first events only. */
  subscribeProgress(runId: string, listener: (event: AgentChatProgressEventV1) => void): () => void;
  /** Stop accepting work and drop in-memory transcript/subscriber state. */
  close(): void;
}

/** Deterministic system prompt; lists exactly the tools the model may call. */
const RUN_RECORD_WAIT_ATTEMPTS = 100;
const RUN_RECORD_WAIT_INTERVAL_MS = 20;

export function buildAgentSystemPrompt(
  projectId: string,
  role: ProjectAccessRole,
  tools: readonly AgentTool[],
  context?: AgentViewContextV1,
): string {
  const lines = tools.map((tool) => `- ${tool.name}: ${tool.description}`);
  const view =
    context === undefined
      ? []
      : [
          '',
          'Current caller view (answer against this, do not guess):',
          `- route: ${context.route}`,
          `- view: ${context.view}`,
          ...(context.projectName === undefined ? [] : [`- project: ${context.projectName}`]),
          ...(context.selection === undefined ? [] : [`- selection: ${context.selection}`]),
          ...(context.visible === undefined || context.visible.length === 0
            ? []
            : [`- visible: ${context.visible.join(', ')}`]),
          ...(context.actions === undefined || context.actions.length === 0
            ? []
            : [`- actions available: ${context.actions.join(', ')}`]),
        ];
  return [
    `You are the Fabula Workbench authoring agent for project "${projectId}" (role: ${role}).`,
    'You may call ONLY the tools listed below; each call must use the documented input schema.',
    'Prefer calling tools over guessing: inspect status, then edit working documents, validate, submit, render, review gates, and publish — always through the available tools.',
    'Respond with concise prose between tool calls and a final summary when the work is done.',
    '',
    'Available tools:',
    ...lines,
    ...view,
  ].join('\n');
}

/** SHA-256 hex digest over the canonical JSON of a value (secret-free identity). */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Bounded, secret-free result summary stored as the tool call's result reference. */
export function resultSummaryOf(result: {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}): string {
  if (!result.ok) {
    return `error:${result.error?.code ?? 'UNKNOWN'}`;
  }
  const digest = digestOf(result.data).slice(0, 16);
  return `ok:${digest}`;
}

function runViewOf(run: AgentRunRecordV1, errorCode: string | null): AgentChatRunViewV1 {
  return {
    version: AGENT_CHAT_CONTRACT_VERSION,
    runId: run.runId,
    conversationId: run.conversationId,
    operationId: run.operationId,
    status: run.status,
    turn: run.turn,
    maxTurns: run.maxTurns,
    toolCalls: run.toolCalls,
    maxToolCalls: run.maxToolCalls,
    errorCode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function conversationViewOf(record: AgentConversationRecordV1): AgentChatConversationViewV1 {
  return {
    version: AGENT_CHAT_CONTRACT_VERSION,
    conversationId: record.conversationId,
    projectId: record.projectId,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function messageViewOf(record: AgentConversationMessageRecordV1): AgentChatMessageViewV1 {
  return {
    version: AGENT_CHAT_CONTRACT_VERSION,
    messageId: record.messageId,
    runId: record.runId,
    role: record.role,
    content: record.content,
    toolName: record.toolName,
    callIndex: record.callIndex,
    createdAt: record.createdAt,
  };
}

function receiptViewOf(record: AgentToolCallRecordV1): AgentChatToolCallReceiptV1 {
  return {
    version: AGENT_CHAT_CONTRACT_VERSION,
    callIndex: record.callIndex,
    toolName: record.toolName,
    status: record.status,
    turn: record.turn,
    sanitizedArgsHash: record.sanitizedArgsHash,
    resultRef: record.resultRef,
    // The bounded result ref IS the sanitized summary (ok:<digest> / error:<code>).
    resultSummary:
      record.resultRef === null
        ? null
        : record.resultRef.length > AGENT_CHAT_RESULT_SUMMARY_MAX_LENGTH
          ? record.resultRef.slice(0, AGENT_CHAT_RESULT_SUMMARY_MAX_LENGTH)
          : record.resultRef,
    createdAt: record.createdAt,
  };
}

export function createWorkbenchAgentRunService(
  options: WorkbenchAgentRunServiceOptions,
): WorkbenchAgentRunService {
  const { projectId, store, executor, agentModel, operations } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const maxTurns = Math.max(1, Math.floor(options.agent.maxTurns));
  const maxToolCalls = Math.max(1, Math.floor(options.agent.maxToolCalls));

  /** runId → initial transcript (user message) kept for explicit retry. */
  const transcripts = new Map<string, readonly AgentMessage[]>();
  /** runId → subscribers; publish() fires them only after store writes. */
  const subscribers = new Map<string, Set<(event: AgentChatProgressEventV1) => void>>();
  let closed = false;

  const publish = (runId: string, event: AgentChatProgressEventV1): void => {
    const set = subscribers.get(runId);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // A subscriber must never break the run loop.
      }
    }
  };

  const requireOpen = (): void => {
    if (closed) {
      throw new AgentChatServiceError('AGENT_CHAT_UNAVAILABLE', 'The Agent service is closed.');
    }
  };

  const runView = async (run: AgentRunRecordV1): Promise<AgentChatRunViewV1> => {
    let errorCode: string | null = null;
    if (run.status === 'failed' && run.operationId !== null) {
      const operation = await operations.get(run.operationId);
      errorCode = operation?.errorCode ?? null;
    }
    return runViewOf(run, errorCode);
  };

  /** Wait (bounded, abortable) for the run record created right after enqueue. */
  const waitForRunRecord = async (
    runId: string,
    signal: AbortSignal,
  ): Promise<AgentRunRecordV1 | null> => {
    for (let attempt = 0; attempt < RUN_RECORD_WAIT_ATTEMPTS; attempt += 1) {
      if (signal.aborted) return null;
      const run = await store.getRun(runId);
      if (run !== null) return run;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, RUN_RECORD_WAIT_INTERVAL_MS);
      await promise;
    }
    return null;
  };

  const failRun = async (
    runId: string,
    code: AgentRunFailureCode,
    message: string,
  ): Promise<ProjectOperationRunnerResult> => {
    await store
      .transitionRun({
        runId,
        status: 'failed',
        expectedStatus: 'running',
        at: now(),
      })
      .catch(() => null);
    return { status: 'failed', errorCode: code, message };
  };

  const runLoop = async (
    runId: string,
    input: SendAgentMessageInput,
    initialMessages: readonly AgentMessage[],
    ctx: {
      readonly signal: AbortSignal;
      readonly reportProgress: (progress: {
        readonly completed: number;
        readonly total: number;
      }) => Promise<void>;
    },
  ): Promise<ProjectOperationRunnerResult> => {
    const run = await waitForRunRecord(runId, ctx.signal);
    if (run === null) return { status: 'cancelled' };
    const started = await store.transitionRun({
      runId,
      status: 'running',
      expectedStatus: 'queued',
      at: now(),
    });
    if (!started.applied) {
      // Raced a cancel/interrupt while queued: report the durable state.
      publish(runId, { type: 'run-status', run: await runView(started.record) });
      return started.record.status === 'cancelled'
        ? { status: 'cancelled' }
        : { status: 'failed', errorCode: 'AGENT_MODEL_ERROR', message: 'The run left the queue.' };
    }
    publish(runId, { type: 'run-status', run: await runView(started.record) });

    const principal = input.principal;
    const scopes = PROJECT_ACCESS_ROLE_GRANTS[principal.role].scopes;
    const caller = executor.callerForRole(principal);
    const tools: AgentTool[] = executor.listTools(scopes).map((definition) => ({
      name: definition.name,
      description: definition.description,
      // Registry schemas are concrete JSON Schema objects, not TypeBox kinds.
      // Type.Unsafe wraps them for pi-ai; validateToolArguments falls back to
      // JSON-schema validation + coercion for non-TypeBox schemas.
      parameters: Type.Unsafe(definition.inputSchema as unknown as TSchema),
      label: definition.name,
      // The bounded summary is computed here; details carry {ok, errorCode,
      // summary} so subscribers persist the sanitized record.
      execute: async (_toolCallId: string, params: unknown) => {
        const result = await executor.callTool(definition.name, caller, params);
        const summary = resultSummaryOf(result);
        return {
          content: [{ type: 'text', text: summary }],
          // McpToolResult is a discriminated union; narrow before touching error.
          details: { ok: result.ok, errorCode: result.ok ? null : result.error.code, summary },
        };
      },
    }));
    const toolNames = new Set(tools.map((t) => t.name));
    const system = buildAgentSystemPrompt(projectId, principal.role, tools, input.context);

    let failure: { code: AgentRunFailureCode; message: string } | null = null;
    let toolCallsUsed = 0;
    let turn = 0;
    let current = started.record;
    const assistantTextByTurn: string[] = []; // per-turn accumulation (index = turn - 1)
    const callIndexByCallId = new Map<string, number>(); // toolCallId → callIndex

    const agent = new Agent({
      streamFn: options.agentModel.streamFn,
      initialState: {
        systemPrompt: system,
        model: options.agentModel.model,
        thinkingLevel: 'off',
        tools,
        messages: [],
      },
      // Decision: sequential execution (one-at-a-time, same as the old
      // hand-written loop). MCP tools carry authoring side effects, so
      // parallel execution would make store-first ordering and callIndex
      // assignment nondeterministic.
      toolExecution: 'sequential',
      beforeToolCall: async () => {
        // Abort gate: blocks the call when the run was cancelled (a late
        // cancellation races between tool_execution_start and here); the
        // agent's own signal check in pi-agent-core covers agent.abort().
        if (ctx.signal.aborted) return { block: true, reason: 'ABORTED', terminate: true };
        // A failure marker (catalog/budget/maxTurns) already aborted the
        // agent; keep any later call in the batch from executing and hint
        // termination so the run settles promptly.
        if (failure !== null) return { block: true, reason: failure.code, terminate: true };
        return undefined;
      },
      afterToolCall: async () => {
        if (options.isWorkflowComplete !== undefined && (await options.isWorkflowComplete())) {
          return { terminate: true };
        }
        return undefined;
      },
    });
    const onAbort = () => agent.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      switch (event.type) {
        case 'turn_start':
          turn += 1;
          if (turn > maxTurns) {
            failure = {
              code: 'AGENT_MAX_TURNS_EXCEEDED',
              message: 'The run exceeded its turn budget.',
            };
            agent.abort();
            return;
          }
          void store.checkpointRun({ runId, turn, at: now() }).catch(() => undefined);
          return;
        case 'message_update': {
          const e = event.assistantMessageEvent;
          if (e.type === 'text_delta') {
            assistantTextByTurn[turn - 1] = (assistantTextByTurn[turn - 1] ?? '') + e.delta;
            publish(runId, { type: 'assistant-text', runId, text: e.delta, at: now() });
          }
          return;
        }
        case 'tool_execution_start': {
          // pi-agent-core short-circuits unknown tools BEFORE beforeToolCall
          // (prepareToolCall → immediate 'Tool X not found' error), so the
          // catalog gate must live here — this event fires unconditionally
          // per model-emitted call. Gated calls get NO tool-call record, the
          // run is aborted, and the failure marker fails it afterwards (old
          // loop failed the run before persisting anything for such calls).
          if (ctx.signal.aborted) return;
          if (!toolNames.has(event.toolName)) {
            failure = {
              code: 'AGENT_TOOL_NOT_IN_CATALOG',
              message: `The model requested a tool outside the registry: ${event.toolName}`,
            };
            agent.abort();
            return;
          }
          if (toolCallsUsed >= maxToolCalls) {
            failure = {
              code: 'AGENT_MAX_TOOL_CALLS_EXCEEDED',
              message: 'The run exceeded its tool-call budget.',
            };
            agent.abort();
            return;
          }
          toolCallsUsed += 1;
          const callIndex = current.toolCalls;
          callIndexByCallId.set(event.toolCallId, callIndex);
          const pending = await store.appendToolCall({
            version: 1,
            runId,
            callIndex,
            toolName: event.toolName,
            sanitizedArgsHash: digestOf(event.args),
            resultRef: null,
            turn,
            status: 'pending',
            createdAt: now(),
          });
          publish(runId, { type: 'tool-call', runId, call: receiptViewOf(pending) });
          return;
        }
        case 'tool_execution_end': {
          const callIndex = callIndexByCallId.get(event.toolCallId);
          if (callIndex === undefined) return; // defensive: end without a seen start is not persisted
          const details = (event.result?.details ?? {}) as {
            ok?: boolean;
            errorCode?: string | null;
            summary?: string | null;
          };
          const summary = details.summary ?? null;
          // pi-agent-core marks isError only when execute() THROWS; a failed
          // executor result returns normally with details.ok === false. The
          // durable status must reflect the real executor outcome (old-loop
          // semantics: status = result.ok ? succeeded : failed).
          const failed = event.isError || details.ok === false;
          const completed = await store.updateToolCallStatus({
            runId,
            callIndex,
            status: failed ? 'failed' : 'succeeded',
            resultRef: summary,
            at: now(),
          });
          // Plan 4.3: persist the sanitized tool result as a message (the
          // summary embeds the error code when the call failed).
          await store.appendMessage({
            messageId: randomUUID(),
            conversationId: run.conversationId,
            runId,
            role: 'tool_result',
            content: summary ?? `error:${details.errorCode ?? 'UNKNOWN'}`,
            toolName: event.toolName,
            callIndex,
            createdAt: now(),
          });
          publish(runId, { type: 'tool-call', runId, call: receiptViewOf(completed) });
          publish(runId, {
            type: 'tool-result',
            runId,
            callIndex,
            status: failed ? 'failed' : 'succeeded',
            resultSummary: summary,
            at: now(),
          });
          current = { ...current, toolCalls: Math.max(current.toolCalls, callIndex + 1) };
          return;
        }
        case 'turn_end': {
          const text = assistantTextByTurn[turn - 1];
          if (text !== undefined && text.length > 0) {
            // Plan 4.3: one assistant message per turn (accumulated text, not deltas).
            await store.appendMessage({
              messageId: randomUUID(),
              conversationId: run.conversationId,
              runId,
              role: 'assistant',
              content: text,
              createdAt: now(),
            });
          }
          return;
        }
      }
    });
    let loopError: unknown = null;
    try {
      await agent.prompt([...initialMessages]);
      await agent.waitForIdle();
    } catch (error) {
      loopError = error;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      unsubscribe();
    }

    if (ctx.signal.aborted) {
      const cancelled = await store.transitionRun({
        runId,
        status: 'cancelled',
        expectedStatus: 'running',
        at: now(),
      });
      publish(runId, { type: 'run-status', run: await runView(cancelled.record) });
      return { status: 'cancelled' };
    }
    if (loopError !== null) {
      return failRun(runId, 'AGENT_MODEL_ERROR', errorMessageOf(loopError));
    }
    if (
      failure === null &&
      agent.state.errorMessage !== undefined &&
      agent.state.errorMessage.length > 0
    ) {
      failure = { code: 'AGENT_MODEL_ERROR', message: errorMessageOf(agent.state.errorMessage) };
    }
    if (failure !== null) {
      return failRun(runId, failure.code, failure.message);
    }
    const finalTurn = Math.max(1, turn);
    const finished = await store.transitionRun({
      runId,
      status: 'succeeded',
      expectedStatus: 'running',
      turn: finalTurn,
      toolCalls: current.toolCalls,
      at: now(),
    });
    publish(runId, { type: 'run-status', run: await runView(finished.record) });
    return {
      status: 'succeeded',
      result: {
        runId,
        conversationId: started.record.conversationId,
        projectId,
        status: 'succeeded',
        turn: finalTurn,
        toolCalls: current.toolCalls,
      },
    };
  };

  return {
    projectId,
    async start() {
      return store.markRunsInterrupted(projectId, now());
    },

    async createConversation(input) {
      requireOpen();
      const title =
        input.title === undefined || input.title === null
          ? null
          : input.title.length > AGENT_CHAT_TITLE_MAX_LENGTH
            ? input.title.slice(0, AGENT_CHAT_TITLE_MAX_LENGTH)
            : input.title;
      const at = now();
      const record = await store.createConversation({
        version: 1,
        conversationId: randomUUID(),
        projectId,
        principalUserId: input.principalUserId,
        role: input.role,
        title,
        createdAt: at,
        updatedAt: at,
      });
      return conversationViewOf(record);
    },

    async listConversations(principalUserId) {
      const records = await store.listConversations({ projectId, principalUserId });
      return records.map(conversationViewOf);
    },

    async sendMessage(input) {
      requireOpen();
      if (typeof input.message !== 'string' || input.message.length === 0) {
        throw new AgentChatServiceError('AGENT_CHAT_INVALID', 'A message is required.');
      }
      if (input.message.length > AGENT_CHAT_MESSAGE_MAX_LENGTH) {
        throw new AgentChatServiceError(
          'AGENT_CHAT_INVALID',
          `The message exceeds ${AGENT_CHAT_MESSAGE_MAX_LENGTH} characters.`,
        );
      }
      const conversation = await store.getConversation(input.conversationId);
      if (
        conversation === null ||
        conversation.projectId !== projectId ||
        conversation.principalUserId !== input.principal.userId
      ) {
        throw new AgentChatServiceError(
          'AGENT_CHAT_CONVERSATION_NOT_FOUND',
          'The conversation does not exist for this principal.',
        );
      }
      // Default the conversation title to the first message (bounded snippet).
      if (conversation.title === null) {
        const snippet =
          input.message.length > AGENT_CHAT_TITLE_MAX_LENGTH
            ? input.message.slice(0, AGENT_CHAT_TITLE_MAX_LENGTH)
            : input.message;
        await store.appendConversation({
          conversationId: input.conversationId,
          at: now(),
          title: snippet,
        });
      }
      const runId = randomUUID();
      const initialMessages: AgentMessage[] = [
        { role: 'user', content: input.message, timestamp: Date.now() },
      ];
      transcripts.set(runId, initialMessages);
      const requestHash = digestOf({
        conversationId: input.conversationId,
        message: input.message,
      });
      const at = now();

      const enqueue = await operations.enqueue({
        kind: 'agent-run',
        idempotencyKey: runId,
        actorId: input.principal.userId,
        capabilityVersion: input.principal.capabilityVersion,
        sourceHash: null,
        acceptedRevisionId: null,
        requestHash,
        runner: async (ctx) =>
          runLoop(runId, input, initialMessages, {
            signal: ctx.signal,
            reportProgress: ctx.reportProgress,
          }),
      });

      if (enqueue.status === 'queue-full' || enqueue.status === 'closed') {
        // Backpressure (plan 9.4): a run that cannot enqueue is rejected with
        // the typed queue-full code. The run automaton has no queued→failed
        // transition, so no run row is created for work that never started.
        transcripts.delete(runId);
        throw new AgentChatServiceError(
          'AGENT_CHAT_QUEUE_FULL',
          'The project operation queue is full; try again later.',
        );
      }
      if (enqueue.status === 'conflict' || enqueue.status === 'replayed') {
        // A fresh UUID can only collide through an impossible race; fail closed.
        transcripts.delete(runId);
        throw new AgentChatServiceError(
          'AGENT_CHAT_INVALID',
          'The run could not be enqueued; try again.',
        );
      }
      const record = await store.createRun({
        version: 1,
        runId,
        conversationId: input.conversationId,
        projectId,
        operationId: enqueue.operationHandle,
        principalUserId: input.principal.userId,
        role: input.principal.role,
        status: 'queued',
        turn: 0,
        maxTurns,
        toolCalls: 0,
        maxToolCalls,
        createdAt: at,
        updatedAt: at,
      });
      // Plan 4.3 (store-first): the user message is durable before any run
      // progress is published.
      await store.appendMessage({
        messageId: randomUUID(),
        conversationId: input.conversationId,
        runId,
        role: 'user',
        content: input.message,
        createdAt: at,
      });
      publish(runId, { type: 'run-status', run: runViewOf(record, null) });
      return runViewOf(record, null);
    },

    async getRun(runId) {
      const run = await store.getRun(runId);
      if (run === null || run.projectId !== projectId) return null;
      return runView(run);
    },

    async snapshot(runId) {
      const run = await store.getRun(runId);
      if (run === null || run.projectId !== projectId) return null;
      const toolCalls = await store.listToolCalls({ runId, limit: 100 });
      return { run: await runView(run), toolCalls: toolCalls.map(receiptViewOf) };
    },

    async history(conversationId) {
      const conversation = await store.getConversation(conversationId);
      if (conversation === null || conversation.projectId !== projectId) return null;
      const runs = await store.listRuns({ conversationId, limit: 100 });
      const entries: AgentChatRunHistoryEntryV1[] = [];
      for (const run of runs) {
        const toolCalls = await store.listToolCalls({ runId: run.runId, limit: 100 });
        entries.push({
          run: await runView(run),
          toolCalls: toolCalls.map(receiptViewOf),
        });
      }
      const messages = await store.listMessages({ conversationId });
      return {
        version: AGENT_CHAT_CONTRACT_VERSION,
        projectId,
        conversation: conversationViewOf(conversation),
        runs: entries,
        messages: messages.map(messageViewOf),
      };
    },

    async cancel(runId) {
      const run = await store.getRun(runId);
      if (run === null || run.projectId !== projectId) return { status: 'not-found' };
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
        return { status: 'terminal', run: await runView(run) };
      }
      // Abort the backing operation first (its controller is the signal the
      // run loop observes), then persist the run transition. The run loop
      // notices the abort and its own CAS guard makes this idempotent.
      if (run.operationId !== null) {
        await operations.cancel(run.operationId).catch(() => null);
      }
      const transitioned = await store.transitionRun({
        runId,
        status: 'cancelled',
        expectedStatus: run.status,
        at: now(),
      });
      publish(runId, { type: 'run-status', run: await runView(transitioned.record) });
      if (!transitioned.applied) {
        return { status: 'terminal', run: await runView(transitioned.record) };
      }
      return { status: 'cancelled', run: await runView(transitioned.record) };
    },

    async retry(runId, principal) {
      const run = await store.getRun(runId);
      if (run === null || run.projectId !== projectId) return { status: 'not-found' };
      if (run.status !== 'interrupted') {
        return { status: 'terminal', run: await runView(run) };
      }
      const initialMessages = transcripts.get(runId);
      if (initialMessages === undefined || initialMessages.length === 0) {
        return {
          status: 'unavailable',
          errorCode: 'AGENT_CHAT_INVALID',
          message:
            'The interrupted run transcript is unavailable after a Host restart; send a new message.',
        };
      }
      const firstUser = initialMessages.find((message) => message.role === 'user');
      if (
        firstUser === undefined ||
        firstUser.role !== 'user' ||
        typeof firstUser.content !== 'string'
      ) {
        return {
          status: 'unavailable',
          errorCode: 'AGENT_CHAT_INVALID',
          message: 'The interrupted run has no message to retry.',
        };
      }
      const requestHash = digestOf({
        conversationId: run.conversationId,
        message: firstUser.content,
      });
      const requeued = await store.transitionRun({
        runId,
        status: 'queued',
        expectedStatus: 'interrupted',
        at: now(),
      });
      if (!requeued.applied) {
        return { status: 'terminal', run: await runView(requeued.record) };
      }
      const input: SendAgentMessageInput = {
        conversationId: run.conversationId,
        message: firstUser.content,
        principal: {
          userId: run.principalUserId,
          role: run.role,
          capabilityVersion: principal.capabilityVersion,
          expiresAt: principal.expiresAt,
        },
      };
      const enqueue = await operations.enqueue({
        kind: 'agent-run',
        idempotencyKey: runId,
        actorId: run.principalUserId,
        capabilityVersion: principal.capabilityVersion,
        sourceHash: null,
        acceptedRevisionId: null,
        requestHash,
        runner: async (ctx) =>
          runLoop(runId, input, initialMessages, {
            signal: ctx.signal,
            reportProgress: ctx.reportProgress,
          }),
      });
      if (enqueue.status === 'queue-full' || enqueue.status === 'closed') {
        await store
          .transitionRun({ runId, status: 'interrupted', expectedStatus: 'queued', at: now() })
          .catch(() => null);
        throw new AgentChatServiceError(
          'AGENT_CHAT_QUEUE_FULL',
          'The project operation queue is full; try again later.',
        );
      }
      if (enqueue.status === 'conflict' || enqueue.status === 'replayed') {
        return { status: 'terminal', run: await runView(requeued.record) };
      }
      publish(runId, { type: 'run-status', run: await runView(requeued.record) });
      return { status: 'queued', run: await runView(requeued.record) };
    },

    subscribeProgress(runId, listener) {
      const set = subscribers.get(runId) ?? new Set();
      set.add(listener);
      subscribers.set(runId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) subscribers.delete(runId);
      };
    },

    close() {
      closed = true;
      transcripts.clear();
      subscribers.clear();
    },
  };
}

function errorMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 512 ? `${message.slice(0, 512)}…` : message;
}
