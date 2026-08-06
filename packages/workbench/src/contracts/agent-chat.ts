/**
 * Browser Agent Chat contract (plan 9.4-9.5): secret-free conversation, run
 * and tool-call review DTOs plus the guarded browser route paths.
 *
 * Every DTO here is deliberately secret-free: messages are plain text the
 * caller already owns, tool calls carry only the sanitized argument hash and
 * a bounded result reference/summary, and run views carry status/counter
 * metadata. Capability tokens, provider keys, raw arguments and raw tool
 * results are never part of this surface — they exist only inside the Host.
 *
 * The durable source of truth for history is the agent persistence tables
 * (conversations/runs/tool calls); this contract is a projection of those
 * records plus the live SSE progress stream of a run.
 */

import { BROWSER_API_BASE_PATH } from './browser-api.js';
import type { AgentRunStatusV1, AgentToolCallStatusV1 } from './persistence.js';

/** Version of the browser agent chat contract carried by every DTO. */
export const AGENT_CHAT_CONTRACT_VERSION = 1 as const;
export type AgentChatContractVersion = typeof AGENT_CHAT_CONTRACT_VERSION;

/** Upper bound on one user message (16 KiB of text). */
export const AGENT_CHAT_MESSAGE_MAX_LENGTH = 16_000;
/** Upper bound on a conversation title (128 chars). */
export const AGENT_CHAT_TITLE_MAX_LENGTH = 128;
/** Upper bound on the sanitized result summary kept per tool call. */
export const AGENT_CHAT_RESULT_SUMMARY_MAX_LENGTH = 256;

// ─── Route paths ─────────────────────────────────────────────────────────────
// All agent chat routes are project-scoped and mounted through the same
// guarded browser seam; they are registered by the Host ONLY when the
// `agent-chat` capability is derived (V3 agent.enabled + tool-call-ready
// model + parity flag), so a disabled Agent has no reachable route at all.

/** `POST /api/v1/projects/:projectId/agent/conversations` — create a conversation. */
export const BROWSER_AGENT_CONVERSATIONS_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/agent/conversations`;
/** `POST /api/v1/projects/:projectId/agent/conversations/:conversationId/runs` — send message + start run. */
export const BROWSER_AGENT_CONVERSATION_RUNS_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/agent/conversations/:conversationId/runs`;
/** `GET /api/v1/projects/:projectId/agent/conversations/:conversationId/history` — durable history. */
export const BROWSER_AGENT_CONVERSATION_HISTORY_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/agent/conversations/:conversationId/history`;
/** `GET /api/v1/projects/:projectId/agent/conversations/:conversationId/runs/:runId/progress` — SSE progress. */
export const BROWSER_AGENT_RUN_PROGRESS_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/agent/conversations/:conversationId/runs/:runId/progress`;
/** `POST /api/v1/projects/:projectId/agent/runs/:runId/cancel` — cancel a queued/running run. */
export const BROWSER_AGENT_RUN_CANCEL_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/agent/runs/:runId/cancel`;
/** `POST /api/v1/projects/:projectId/agent/runs/:runId/retry` — explicit retry of an interrupted run. */
export const BROWSER_AGENT_RUN_RETRY_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/agent/runs/:runId/retry`;

// ─── Conversation DTOs ───────────────────────────────────────────────────────

/**
 * Safe read view of one conversation row. The title is a short label (the
 * first user message by default); the full transcript is not durable by
 * design — the durable records are runs and their tool-call receipts.
 */
export interface AgentChatConversationViewV1 {
  readonly version: AgentChatContractVersion;
  readonly conversationId: string;
  readonly projectId: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Create a conversation; the project id is taken from the route, never the body. */
export interface AgentChatCreateConversationRequestV1 {
  readonly version: AgentChatContractVersion;
  /** Optional short label; defaults to the first message when omitted. */
  readonly title?: string | null;
}

export interface AgentChatCreateConversationResultV1 {
  readonly version: AgentChatContractVersion;
  readonly conversation: AgentChatConversationViewV1;
}

// ─── Run DTOs ────────────────────────────────────────────────────────────────

/**
 * Safe read view of one durable run row: status/counters and the operation
 * handle only. No message content, no capability token, no provider key.
 */
export interface AgentChatRunViewV1 {
  readonly version: AgentChatContractVersion;
  readonly runId: string;
  readonly conversationId: string;
  readonly operationId: string | null;
  readonly status: AgentRunStatusV1;
  readonly turn: number;
  readonly maxTurns: number;
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Send one user message and start a run against the shared executor + model. */
export interface AgentChatSendMessageRequestV1 {
  readonly version: AgentChatContractVersion;
  readonly message: string;
}

export interface AgentChatSendMessageResultV1 {
  readonly version: AgentChatContractVersion;
  /** The user message echoed back (secret-free: it is the caller's own text). */
  readonly message: string;
  readonly run: AgentChatRunViewV1;
}

/**
 * One durable tool-call receipt of a run. Only the sanitized argument hash
 * and a bounded result reference/summary are ever exposed; raw arguments and
 * raw results stay inside the Host.
 */
export interface AgentChatToolCallReceiptV1 {
  readonly version: AgentChatContractVersion;
  readonly callIndex: number;
  readonly toolName: string;
  readonly status: AgentToolCallStatusV1;
  readonly turn: number;
  readonly sanitizedArgsHash: string;
  readonly resultRef: string | null;
  /** Bounded, secret-free summary (`ok:<digest>` / `error:<code>`). */
  readonly resultSummary: string | null;
  readonly createdAt: string;
}

/** One history entry: a run plus its append-only tool-call receipts. */
export interface AgentChatRunHistoryEntryV1 {
  readonly run: AgentChatRunViewV1;
  readonly toolCalls: readonly AgentChatToolCallReceiptV1[];
}

/** Durable history of one conversation, newest run first. */
export interface AgentChatHistoryV1 {
  readonly version: AgentChatContractVersion;
  readonly projectId: string;
  readonly conversation: AgentChatConversationViewV1;
  readonly runs: readonly AgentChatRunHistoryEntryV1[];
}

/** Cancel one queued/running run. */
export interface AgentChatCancelResultV1 {
  readonly version: AgentChatContractVersion;
  readonly runId: string;
  readonly status: AgentRunStatusV1;
}

// ─── Live SSE progress events ────────────────────────────────────────────────
// The progress stream replays the store first (run status + completed tool
// calls) and then emits live events; every event is published only AFTER its
// backing record was persisted (plan 4.7/9.4: records before SSE).

/** Run status changed (queued → running → terminal). */
export interface AgentChatRunStatusEventV1 {
  readonly type: 'run-status';
  readonly run: AgentChatRunViewV1;
}
/** One assistant text chunk streamed by the model. */
export interface AgentChatAssistantTextEventV1 {
  readonly type: 'assistant-text';
  readonly runId: string;
  readonly text: string;
  readonly at: string;
}
/** A tool call was appended (pending) or completed (succeeded/failed). */
export interface AgentChatToolCallEventV1 {
  readonly type: 'tool-call';
  readonly runId: string;
  readonly call: AgentChatToolCallReceiptV1;
}
/** A pending tool call completed with a sanitized result summary. */
export interface AgentChatToolResultEventV1 {
  readonly type: 'tool-result';
  readonly runId: string;
  readonly callIndex: number;
  readonly status: 'succeeded' | 'failed';
  readonly resultSummary: string | null;
  readonly at: string;
}

export type AgentChatProgressEventV1 =
  | AgentChatRunStatusEventV1
  | AgentChatAssistantTextEventV1
  | AgentChatToolCallEventV1
  | AgentChatToolResultEventV1;
