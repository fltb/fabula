/**
 * Browser Agent Chat client: same-origin guarded surface over the Host agent
 * chat routes. Identity comes from the transient session header; the client
 * never sends an actor, capability token, provider key, or Host path, and
 * mutations are enforced server-side by the project role gate.
 */

import {
  BROWSER_AGENT_CONVERSATION_HISTORY_PATH,
  BROWSER_AGENT_CONVERSATION_RUNS_PATH,
  BROWSER_AGENT_CONVERSATIONS_LIST_PATH,
  BROWSER_AGENT_CONVERSATIONS_PATH,
  BROWSER_AGENT_RUN_CANCEL_PATH,
  BROWSER_AGENT_RUN_PROGRESS_PATH,
  BROWSER_AGENT_RUN_RETRY_PATH,
} from '../contracts/agent-chat.js';
import type { AgentChatConversationListResultV1 } from '../contracts/agent-chat.js';
import type { BrowserApiErrorCode, BrowserApiErrorV1 } from '../contracts/browser-api.js';
import { BROWSER_SESSION_HEADER } from '../contracts/browser-api.js';
import type {
  AgentChatCancelResultV1,
  AgentChatConversationViewV1,
  AgentChatCreateConversationResultV1,
  AgentChatHistoryV1,
  AgentChatProgressEventV1,
  AgentChatRunViewV1,
  AgentChatSendMessageResultV1,
} from '../contracts/index.js';
import { isRecord } from './authoring-client.js';
import type { BrowserFetch } from './browser-read-client.js';

/** Error codes the Host Agent chat surface is allowed to produce. */
const AGENT_CHAT_ERROR_CODES: Readonly<Record<BrowserApiErrorCode, true>> = {
  SESSION_NOT_FOUND: true,
  SESSION_EXPIRED: true,
  PROJECT_MISMATCH: true,
  PROJECT_NOT_FOUND: true,
  INVALID_ROUTE_SELECTOR: true,
  GRAPH_UNAVAILABLE: true,
  SOURCE_UNAVAILABLE: true,
  REFERENCE_NOT_FOUND: true,
  REFERENCE_INVALID: true,
  REFERENCE_UNAVAILABLE: true,
  REFERENCE_CONFLICT: true,
  REVIEW_COMMENT_NOT_FOUND: true,
  REVIEW_INVALID: true,
  REVIEW_UNAVAILABLE: true,
  GATE_NOT_FOUND: true,
  GATE_NOT_OPEN: true,
  GATE_DECISION_INVALID: true,
  PUBLICATION_NOT_FOUND: true,
  PUBLICATION_INVALID: true,
  PUBLICATION_UNAVAILABLE: true,
  PUBLICATION_CONFLICT: true,
  AGENT_CHAT_UNAVAILABLE: true,
  AGENT_CHAT_CONVERSATION_NOT_FOUND: true,
  AGENT_CHAT_RUN_NOT_FOUND: true,
  AGENT_CHAT_INVALID: true,
  AGENT_CHAT_RUN_TERMINAL: true,
  AGENT_CHAT_QUEUE_FULL: true,
  SCENE_ADOPTION_NOT_FOUND: true,
  SCENE_ADOPTION_INVALID: true,
  SCENE_ADOPTION_UNAVAILABLE: true,
};

/** Typed non-2xx failure from the guarded Host Agent chat surface. */
export class BrowserAgentChatApiError extends Error {
  readonly status: number;
  readonly code: BrowserApiErrorV1['error']['code'] | null;

  constructor(status: number, code: BrowserApiErrorV1['error']['code'] | null, message: string) {
    super(message);
    this.name = 'BrowserAgentChatApiError';
    this.status = status;
    this.code = code;
  }
}

/** One progress event consumer; the stream closes itself at run termination. */
export type AgentChatProgressListener = (event: AgentChatProgressEventV1) => void;

export interface AgentChatClient {
  /** Create one conversation for the caller's project role. */
  createConversation(projectId: string, title?: string): Promise<AgentChatConversationViewV1>;
  /** List the caller's conversations, newest-updated first (plan 4.4). */
  listConversations(projectId: string): Promise<readonly AgentChatConversationViewV1[]>;
  /** Send one message and start a run (queued through the operation service). */
  sendMessage(
    projectId: string,
    conversationId: string,
    message: string,
  ): Promise<AgentChatRunViewV1>;
  /** Durable history of one conversation (runs + tool-call receipts + message projection). */
  history(projectId: string, conversationId: string): Promise<AgentChatHistoryV1>;
  /** Cancel a queued/running run. */
  cancel(projectId: string, runId: string): Promise<AgentChatCancelResultV1>;
  /** Explicit retry of an interrupted run (same idempotency key, never auto-replayed). */
  retry(projectId: string, runId: string): Promise<AgentChatCancelResultV1>;
  /**
   * Open the SSE progress stream for one run. The Host replays the durable
   * store first, then streams live events; returns an unsubscribe function.
   */
  openProgress(
    projectId: string,
    conversationId: string,
    runId: string,
    listener: AgentChatProgressListener,
  ): () => void;
}

export interface AgentChatClientOptions {
  /** Supplies the transient session only for each request; never persisted. */
  readonly getSessionId?: () => string | null | undefined;
  readonly fetch?: BrowserFetch;
  /** Optional same-origin prefix for embedded hosts and tests. */
  readonly baseUrl?: string;
}

function failureFrom(value: unknown): { readonly code: string; readonly message: string } | null {
  if (!isRecord(value)) return null;
  const nested = value.error;
  if (isRecord(nested) && typeof nested.code === 'string' && typeof nested.message === 'string') {
    return { code: nested.code, message: nested.message };
  }
  return null;
}

async function decode<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = failureFrom(value);
    const code = failure?.code;
    throw new BrowserAgentChatApiError(
      response.status,
      code !== undefined && AGENT_CHAT_ERROR_CODES[code as BrowserApiErrorCode] === true
        ? (code as BrowserApiErrorCode)
        : null,
      failure?.message ?? `Host agent chat request failed with HTTP ${response.status}.`,
    );
  }
  return value as T;
}

/**
 * Create a same-origin agent chat client. Every request carries only the
 * transient session header; the project id comes from the route, never from
 * the caller.
 */
export function createAgentChatClient(options: AgentChatClientOptions = {}): AgentChatClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') throw new Error('Browser Fetch API is unavailable.');
  const prefix = options.baseUrl ?? '';

  const headersFor = (accept: string): Headers => {
    const headers = new Headers({ accept });
    const sessionId = options.getSessionId?.();
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      headers.set(BROWSER_SESSION_HEADER, sessionId);
    }
    return headers;
  };

  const pathFor = (template: string, projectId: string): string =>
    template.replace(':projectId', encodeURIComponent(projectId));

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const headers = headersFor('application/json');
    headers.set('content-type', 'application/json');
    return decode<T>(
      await execute(`${prefix}${path}`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(body),
      }),
    );
  };

  const get = async <T>(path: string): Promise<T> =>
    decode<T>(
      await execute(`${prefix}${path}`, {
        method: 'GET',
        headers: headersFor('application/json'),
        credentials: 'same-origin',
      }),
    );

  return {
    async createConversation(projectId, title) {
      const result = await post<AgentChatCreateConversationResultV1>(
        pathFor(BROWSER_AGENT_CONVERSATIONS_PATH, projectId),
        { version: 1, ...(title === undefined ? {} : { title }) },
      );
      return result.conversation;
    },
    async listConversations(projectId) {
      const result = await get<AgentChatConversationListResultV1>(
        pathFor(BROWSER_AGENT_CONVERSATIONS_LIST_PATH, projectId),
      );
      return result.conversations;
    },
    async sendMessage(projectId, conversationId, message) {
      const result = await post<AgentChatSendMessageResultV1>(
        pathFor(BROWSER_AGENT_CONVERSATION_RUNS_PATH, projectId).replace(
          ':conversationId',
          encodeURIComponent(conversationId),
        ),
        { version: 1, message },
      );
      return result.run;
    },
    async history(projectId, conversationId) {
      return get<AgentChatHistoryV1>(
        pathFor(BROWSER_AGENT_CONVERSATION_HISTORY_PATH, projectId).replace(
          ':conversationId',
          encodeURIComponent(conversationId),
        ),
      );
    },
    async cancel(projectId, runId) {
      return post<AgentChatCancelResultV1>(
        pathFor(BROWSER_AGENT_RUN_CANCEL_PATH, projectId).replace(
          ':runId',
          encodeURIComponent(runId),
        ),
        {},
      );
    },
    async retry(projectId, runId) {
      return post<AgentChatCancelResultV1>(
        pathFor(BROWSER_AGENT_RUN_RETRY_PATH, projectId).replace(
          ':runId',
          encodeURIComponent(runId),
        ),
        {},
      );
    },
    openProgress(projectId, conversationId, runId, listener) {
      let controller: AbortController | null = new AbortController();
      let active = true;
      const url = `${prefix}${pathFor(BROWSER_AGENT_RUN_PROGRESS_PATH, projectId)
        .replace(':conversationId', encodeURIComponent(conversationId))
        .replace(':runId', encodeURIComponent(runId))}`;
      void (async () => {
        try {
          const response = await execute(url, {
            method: 'GET',
            headers: headersFor('text/event-stream'),
            credentials: 'same-origin',
            signal: controller?.signal,
          });
          if (!response.ok || response.body === null) {
            // The durable store is the source of truth; a failed stream just
            // closes and the caller re-reads history.
            return;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (active) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
              if (dataLine !== undefined) {
                try {
                  const event = JSON.parse(dataLine.slice(6)) as AgentChatProgressEventV1;
                  listener(event);
                } catch {
                  // A malformed frame is skipped; the stream is authoritative.
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch {
          // Aborted by the caller (unsubscribe) or the network dropped: the
          // durable store remains the source of truth for a reconnect.
        } finally {
          active = false;
          controller = null;
        }
      })();
      return () => {
        active = false;
        controller?.abort();
        controller = null;
      };
    },
  };
}
