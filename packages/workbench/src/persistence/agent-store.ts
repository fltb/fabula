import type {
  AgentConversationMessageRecordV1,
  AgentConversationRecordV1,
  AgentRunRecordV1,
  AgentToolCallRecordV1,
  AppendAgentConversationInput,
  CheckpointAgentRunInput,
  ListAgentConversationsInput,
  ListAgentRunsInput,
  ListAgentToolCallsInput,
  TransitionAgentRunInput,
  TransitionAgentRunResult,
  UpdateAgentToolCallStatusInput,
} from '../contracts/persistence.js';
import type { PersistenceWorkerClient } from './worker-client.js';

/**
 * Host-facing typed facade over the durable agent persistence tables
 * (`agent_conversations`, `agent_runs`, `agent_tool_calls`). The
 * WorkbenchAgentRunService and the agent chat surface call these methods
 * instead of raw RPC strings; every method maps 1:1 to a typed persistence
 * operation, so the run status automaton, the monotonic/bounded counters, the
 * append-only tool-call ordinal and the restart interrupted sweep stay
 * enforced worker-side. Records carry principal identity and hashes only —
 * never capability tokens or provider keys.
 */
export interface AgentStore {
  /** Create one conversation row; a duplicate id fails with `CONVERSATION_EXISTS`. */
  createConversation(record: AgentConversationRecordV1): Promise<AgentConversationRecordV1>;
  /** Append a message: bump `updatedAt` and optionally set `title`. */
  appendConversation(input: AppendAgentConversationInput): Promise<AgentConversationRecordV1>;
  /** Read one conversation by id; null when absent. */
  getConversation(conversationId: string): Promise<AgentConversationRecordV1 | null>;
  /** Page conversations newest-updated first, optionally filtered. */
  listConversations(
    input: ListAgentConversationsInput,
  ): Promise<readonly AgentConversationRecordV1[]>;
  /** Create a `queued` run bound to an existing conversation; fails `CONVERSATION_NOT_FOUND`. */
  createRun(record: AgentRunRecordV1): Promise<AgentRunRecordV1>;
  /**
   * Status transition with an `expectedStatus` CAS guard (`applied:false`
   * when the stored status differs) and optional monotonic counter updates.
   */
  transitionRun(input: TransitionAgentRunInput): Promise<TransitionAgentRunResult>;
  /** Advance `turn`/`toolCalls` counters of an active run without a status change. */
  checkpointRun(input: CheckpointAgentRunInput): Promise<AgentRunRecordV1>;
  /** Host-restart sweep: every queued/running run of the project becomes `interrupted`. */
  markRunsInterrupted(projectId: string, at?: string): Promise<{ updated: number }>;
  /** Read one run by id; null when absent. */
  getRun(runId: string): Promise<AgentRunRecordV1 | null>;
  /** Page runs newest-updated first, optionally filtered by conversation/project/status. */
  listRuns(input: ListAgentRunsInput): Promise<readonly AgentRunRecordV1[]>;
  /**
   * Append one pending tool call at the next sequential ordinal; the run's
   * `toolCalls` counter is advanced atomically. Non-sequential appends fail
   * with `TOOL_CALL_APPEND_VIOLATION`.
   */
  appendToolCall(record: AgentToolCallRecordV1): Promise<AgentToolCallRecordV1>;
  /** Complete a pending tool call: pending -> succeeded|failed with the result ref. */
  updateToolCallStatus(input: UpdateAgentToolCallStatusInput): Promise<AgentToolCallRecordV1>;
  /** Page a run's tool calls in append order. */
  listToolCalls(input: ListAgentToolCallsInput): Promise<readonly AgentToolCallRecordV1[]>;
  /** Append one message to a conversation's transcript; duplicate ids fail with `MESSAGE_EXISTS`. */
  appendMessage(input: {
    messageId: string;
    conversationId: string;
    runId: string;
    role: 'user' | 'assistant' | 'tool_result';
    content: string;
    toolName?: string | null;
    callIndex?: number | null;
    createdAt: string;
  }): Promise<{ appended: true }>;
  /** Page a conversation's messages oldest-first. */
  listMessages(input: {
    conversationId: string;
    limit?: number;
  }): Promise<AgentConversationMessageRecordV1[]>;
}

export function createAgentStore(client: PersistenceWorkerClient): AgentStore {
  return {
    createConversation: (record) => client.request('createAgentConversation', record),
    appendConversation: (input) => client.request('appendAgentConversation', input),
    getConversation: (conversationId) => client.request('getAgentConversation', { conversationId }),
    listConversations: (input) => client.request('listAgentConversations', input),
    createRun: (record) => client.request('createAgentRun', record),
    transitionRun: (input) => client.request('transitionAgentRun', input),
    checkpointRun: (input) => client.request('checkpointAgentRun', input),
    markRunsInterrupted: (projectId, at) =>
      client.request('markAgentRunsInterrupted', {
        projectId,
        ...(at !== undefined ? { at } : {}),
      }),
    getRun: (runId) => client.request('getAgentRun', { runId }),
    listRuns: (input) => client.request('listAgentRuns', input),
    appendToolCall: (record) => client.request('appendAgentToolCall', record),
    updateToolCallStatus: (input) => client.request('updateAgentToolCallStatus', input),
    listToolCalls: (input) => client.request('listAgentToolCalls', input),
    appendMessage: (input) =>
      client.request('appendAgentMessage', {
        version: 1,
        messageId: input.messageId,
        conversationId: input.conversationId,
        runId: input.runId,
        role: input.role,
        content: input.content,
        toolName: input.toolName ?? null,
        callIndex: input.callIndex ?? null,
        createdAt: input.createdAt,
      }),
    listMessages: (input) => client.request('listAgentMessages', input),
  };
}
