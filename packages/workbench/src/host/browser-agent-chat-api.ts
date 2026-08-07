/**
 * Browser Agent Chat surface (plan 9.5): guarded conversation/run routes over
 * the per-project WorkbenchAgentRunService.
 *
 * Every route follows the same principal pipeline as the other browser
 * surfaces: identity (session header) → project authorization (reader) →
 * catalog membership → service resolution. The routes are mounted by the
 * Host ONLY when the `agent-chat` capability is derived (V3 agent.enabled +
 * tool-call-ready model + parity flag), so a disabled Agent has no reachable
 * route at all — requests fail as 404 at the listener, never as a stub.
 *
 * The SSE progress route replays the durable store first (run status +
 * completed tool calls) and then streams live events; every live event was
 * persisted before it was published (records before SSE).
 */

import type { Context, Handler } from 'hono';
import type {
  AgentChatCancelResultV1,
  AgentChatConversationListResultV1,
  AgentChatConversationViewV1,
  AgentChatCreateConversationRequestV1,
  AgentChatCreateConversationResultV1,
  AgentChatHistoryV1,
  AgentChatProgressEventV1,
  AgentChatRunViewV1,
  AgentChatSendMessageRequestV1,
  AgentChatSendMessageResultV1,
} from '../contracts/agent-chat.js';
import {
  AGENT_CHAT_CONTRACT_VERSION,
  AGENT_CHAT_MESSAGE_MAX_LENGTH,
  BROWSER_AGENT_CONVERSATION_HISTORY_PATH,
  BROWSER_AGENT_CONVERSATION_RUNS_PATH,
  BROWSER_AGENT_CONVERSATIONS_LIST_PATH,
  BROWSER_AGENT_CONVERSATIONS_PATH,
  BROWSER_AGENT_RUN_CANCEL_PATH,
  BROWSER_AGENT_RUN_PROGRESS_PATH,
  BROWSER_AGENT_RUN_RETRY_PATH,
} from '../contracts/agent-chat.js';
import type {
  BrowserApiErrorCode,
  BrowserApiErrorV1,
  BrowserSessionPrincipalV1,
} from '../contracts/browser-api.js';
import { BROWSER_SESSION_HEADER } from '../contracts/browser-api.js';
import type { ProjectAccessRole } from '../contracts/configuration.js';
import { AgentChatServiceError, type WorkbenchAgentRunService } from './agent/run-service.js';
import type {
  BrowserPrincipalResolution,
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from './browser-read-api.js';
import type { HostListenerEnv } from './listener.js';
import type { ProjectAccessService } from './project-access-service.js';
import type { HostServer } from './server.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const EVENT_HEADERS = {
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'content-type': 'text/event-stream; charset=utf-8',
};

const AGENT_CHAT_ERROR_STATUS: Readonly<Record<BrowserApiErrorCode, number>> = {
  SESSION_NOT_FOUND: 401,
  SESSION_EXPIRED: 401,
  PROJECT_MISMATCH: 403,
  PROJECT_NOT_FOUND: 404,
  INVALID_ROUTE_SELECTOR: 400,
  GRAPH_UNAVAILABLE: 503,
  SOURCE_UNAVAILABLE: 503,
  REFERENCE_NOT_FOUND: 404,
  REFERENCE_INVALID: 400,
  REFERENCE_UNAVAILABLE: 503,
  REFERENCE_CONFLICT: 409,
  REVIEW_COMMENT_NOT_FOUND: 404,
  REVIEW_INVALID: 400,
  REVIEW_UNAVAILABLE: 503,
  GATE_NOT_FOUND: 404,
  GATE_NOT_OPEN: 409,
  GATE_DECISION_INVALID: 400,
  PUBLICATION_NOT_FOUND: 404,
  PUBLICATION_INVALID: 400,
  PUBLICATION_UNAVAILABLE: 503,
  PUBLICATION_CONFLICT: 409,
  AGENT_CHAT_UNAVAILABLE: 503,
  AGENT_CHAT_CONVERSATION_NOT_FOUND: 404,
  AGENT_CHAT_RUN_NOT_FOUND: 404,
  AGENT_CHAT_INVALID: 400,
  AGENT_CHAT_RUN_TERMINAL: 409,
  AGENT_CHAT_QUEUE_FULL: 409,
};

function errorResponse(code: BrowserApiErrorCode, message: string): Response {
  const body: BrowserApiErrorV1 = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status: AGENT_CHAT_ERROR_STATUS[code],
    headers: JSON_HEADERS,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve the current project role for a browser principal (owner → maintainer). */
export type AgentChatRoleResolver = (
  userId: string,
  projectId: string,
) => ProjectAccessRole | null | Promise<ProjectAccessRole | null>;

/** Per-project run service registry; absent projects fail closed. */
export interface AgentChatServiceRegistry {
  get(
    projectId: string,
  ): WorkbenchAgentRunService | null | Promise<WorkbenchAgentRunService | null>;
}

export interface BrowserAgentChatApiOptions {
  readonly principal: BrowserPrincipalResolver;
  /** Shared ACL/lifecycle service; when present it is the authoritative role gate. */
  readonly access?: Pick<ProjectAccessService, 'authorize' | 'listProjects'>;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  /** Server-derived project ACL role for the caller (single role source). */
  readonly roleResolver: AgentChatRoleResolver;
  readonly services: AgentChatServiceRegistry;
  readonly now?: () => string;
}

export interface BrowserAgentChatApiSurface {
  register(host: HostServer): void;
}

class BrowserAgentChatApiImpl {
  constructor(readonly options: BrowserAgentChatApiOptions) {}

  /** Resolve the principal or short-circuit with the 401 error response. */
  async principalOrDeny(
    c: Context<HostListenerEnv>,
  ): Promise<Response | { principal: BrowserSessionPrincipalV1; sessionId: string | null }> {
    const resolution: BrowserPrincipalResolution = await this.options.principal.resolve(c.req.raw);
    if (!resolution.ok) {
      return errorResponse(
        resolution.failure,
        resolution.failure === 'SESSION_EXPIRED'
          ? 'The session has expired.'
          : 'The session is missing, revoked, or unknown.',
      );
    }
    const sessionId = c.req.raw.headers.get(BROWSER_SESSION_HEADER);
    return {
      principal: resolution.principal,
      sessionId: sessionId !== null && sessionId.length > 0 ? sessionId : null,
    };
  }

  async canAccess(principal: { readonly userId: string }, projectId: string): Promise<boolean> {
    if (this.options.access !== undefined) {
      return (
        await this.options.access.authorize({
          userId: principal.userId,
          projectId,
          requiredRole: 'reader',
        })
      ).ok;
    }
    return await this.options.authorization.canAccessProject(principal.userId, projectId);
  }

  async projectIsListed(principal: BrowserSessionPrincipalV1, projectId: string): Promise<boolean> {
    const projects =
      this.options.access !== undefined
        ? await this.options.access.listProjects(principal)
        : await this.options.catalog.listProjects(principal);
    return projects.some((project) => project.projectId === projectId);
  }

  /** Shared guard: identity → authorization → catalog → service resolution. */
  async guarded(c: Context<HostListenerEnv>): Promise<
    | Response
    | {
        projectId: string;
        service: WorkbenchAgentRunService;
        principal: BrowserSessionPrincipalV1;
        sessionId: string | null;
      }
  > {
    const resolved = await this.principalOrDeny(c);
    if (resolved instanceof Response) return resolved;
    const { principal, sessionId } = resolved;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    if (!(await this.canAccess(principal, projectId))) {
      return errorResponse('PROJECT_MISMATCH', 'The session is not authorized for this project.');
    }
    if (!(await this.projectIsListed(principal, projectId))) {
      return errorResponse('PROJECT_NOT_FOUND', "The project is not in this session's catalog.");
    }
    const service = await this.options.services.get(projectId);
    if (service === null) {
      return errorResponse(
        'AGENT_CHAT_UNAVAILABLE',
        'The Agent chat surface is not enabled for this project.',
      );
    }
    return { projectId, service, principal, sessionId };
  }

  async roleOf(
    principal: BrowserSessionPrincipalV1,
    projectId: string,
  ): Promise<ProjectAccessRole> {
    const role = await this.options.roleResolver(principal.userId, projectId);
    if (role !== null) return role;
    throw new AgentChatServiceError(
      'AGENT_CHAT_UNAVAILABLE',
      'The caller has no project role for the Agent surface.',
    );
  }
}

function createConversationHandler(api: BrowserAgentChatApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await api.guarded(c);
    if (guarded instanceof Response) return guarded;
    const body: unknown = await c.req.raw.json().catch(() => null);
    const request: AgentChatCreateConversationRequestV1 = isRecord(body)
      ? {
          version: AGENT_CHAT_CONTRACT_VERSION,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
        }
      : { version: AGENT_CHAT_CONTRACT_VERSION };
    const title = request.title ?? null;
    if (title !== null && (title.length > 128 || title.trim().length === 0)) {
      return errorResponse('AGENT_CHAT_INVALID', 'The conversation title is invalid.');
    }
    const role = await api.roleOf(guarded.principal, guarded.projectId);
    try {
      const conversation: AgentChatConversationViewV1 = await guarded.service.createConversation({
        principalUserId: guarded.principal.userId,
        role,
        title,
      });
      const result: AgentChatCreateConversationResultV1 = {
        version: AGENT_CHAT_CONTRACT_VERSION,
        conversation,
      };
      return json(result, 201);
    } catch (error) {
      return agentChatError(error);
    }
  };
}

function listConversationsHandler(api: BrowserAgentChatApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await api.guarded(c);
    if (guarded instanceof Response) return guarded;
    try {
      const conversations = await guarded.service.listConversations(guarded.principal.userId);
      const result: AgentChatConversationListResultV1 = {
        version: AGENT_CHAT_CONTRACT_VERSION,
        conversations,
      };
      return json(result);
    } catch (error) {
      return agentChatError(error);
    }
  };
}

function sendMessageHandler(api: BrowserAgentChatApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await api.guarded(c);
    if (guarded instanceof Response) return guarded;
    const conversationId = c.req.param('conversationId');
    if (conversationId === undefined || conversationId.length === 0) {
      return errorResponse('AGENT_CHAT_CONVERSATION_NOT_FOUND', 'The conversation is missing.');
    }
    const body: unknown = await c.req.raw.json().catch(() => null);
    if (!isRecord(body) || typeof body.message !== 'string') {
      return errorResponse('AGENT_CHAT_INVALID', 'A message string is required.');
    }
    if (body.message.length === 0 || body.message.length > AGENT_CHAT_MESSAGE_MAX_LENGTH) {
      return errorResponse(
        'AGENT_CHAT_INVALID',
        `The message must be 1..${AGENT_CHAT_MESSAGE_MAX_LENGTH} characters.`,
      );
    }
    const role = await api.roleOf(guarded.principal, guarded.projectId);
    try {
      const run: AgentChatRunViewV1 = await guarded.service.sendMessage({
        conversationId,
        message: body.message,
        principal: {
          userId: guarded.principal.userId,
          role,
          capabilityVersion: guarded.principal.capabilityVersion,
          expiresAt: guarded.principal.expiresAt,
          sessionId: guarded.sessionId ?? null,
        },
      });
      const result: AgentChatSendMessageResultV1 = {
        version: AGENT_CHAT_CONTRACT_VERSION,
        message: body.message,
        run,
      };
      return json(result, 202);
    } catch (error) {
      return agentChatError(error);
    }
  };
}

function historyHandler(api: BrowserAgentChatApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await api.guarded(c);
    if (guarded instanceof Response) return guarded;
    const conversationId = c.req.param('conversationId');
    if (conversationId === undefined || conversationId.length === 0) {
      return errorResponse('AGENT_CHAT_CONVERSATION_NOT_FOUND', 'The conversation is missing.');
    }
    try {
      const history: AgentChatHistoryV1 | null = await guarded.service.history(conversationId);
      if (history === null) {
        return errorResponse(
          'AGENT_CHAT_CONVERSATION_NOT_FOUND',
          'The conversation does not exist.',
        );
      }
      return json(history);
    } catch (error) {
      return agentChatError(error);
    }
  };
}

function progressFrame(event: AgentChatProgressEventV1): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function progressHandler(api: BrowserAgentChatApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await api.guarded(c);
    if (guarded instanceof Response) return guarded;
    const conversationId = c.req.param('conversationId');
    const runId = c.req.param('runId');
    if (conversationId === undefined || runId === undefined || conversationId.length === 0) {
      return errorResponse('AGENT_CHAT_RUN_NOT_FOUND', 'The run is missing.');
    }
    const snapshot = await guarded.service.snapshot(runId).catch(() => null);
    if (snapshot === null || snapshot.run.conversationId !== conversationId) {
      return errorResponse('AGENT_CHAT_RUN_NOT_FOUND', 'The run does not exist.');
    }
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
          controller.close();
        };
        // Store first, then resume (plan 9.4): replay the durable state, then
        // subscribe for live events. A terminal run closes after the replay.
        try {
          controller.enqueue(progressFrame({ type: 'run-status', run: snapshot.run }));
          for (const call of snapshot.toolCalls) {
            controller.enqueue(progressFrame({ type: 'tool-call', runId, call }));
          }
        } catch {
          close();
          return;
        }
        unsubscribe = guarded.service.subscribeProgress(runId, (event) => {
          if (closed) return;
          try {
            controller.enqueue(progressFrame(event));
          } catch {
            close();
          }
        });
        if (snapshot.run.status !== 'queued' && snapshot.run.status !== 'running') {
          close();
        }
      },
      cancel() {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
      },
    });
    return new Response(stream, { headers: EVENT_HEADERS });
  };
}

function cancelHandler(api: BrowserAgentChatApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await api.guarded(c);
    if (guarded instanceof Response) return guarded;
    const runId = c.req.param('runId');
    if (runId === undefined || runId.length === 0) {
      return errorResponse('AGENT_CHAT_RUN_NOT_FOUND', 'The run is missing.');
    }
    try {
      const outcome = await guarded.service.cancel(runId);
      if (outcome.status === 'not-found') {
        return errorResponse('AGENT_CHAT_RUN_NOT_FOUND', 'The run does not exist.');
      }
      const result: AgentChatCancelResultV1 = {
        version: AGENT_CHAT_CONTRACT_VERSION,
        runId,
        status: outcome.run.status,
      };
      return json(result);
    } catch (error) {
      return agentChatError(error);
    }
  };
}

function retryHandler(api: BrowserAgentChatApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const guarded = await api.guarded(c);
    if (guarded instanceof Response) return guarded;
    const runId = c.req.param('runId');
    if (runId === undefined || runId.length === 0) {
      return errorResponse('AGENT_CHAT_RUN_NOT_FOUND', 'The run is missing.');
    }
    const role = await api.roleOf(guarded.principal, guarded.projectId);
    try {
      const outcome = await guarded.service.retry(runId, {
        userId: guarded.principal.userId,
        role,
        capabilityVersion: guarded.principal.capabilityVersion,
        expiresAt: guarded.principal.expiresAt,
        sessionId: guarded.sessionId ?? null,
      });
      if (outcome.status === 'not-found') {
        return errorResponse('AGENT_CHAT_RUN_NOT_FOUND', 'The run does not exist.');
      }
      if (outcome.status === 'unavailable') {
        return errorResponse(outcome.errorCode, outcome.message);
      }
      const result: AgentChatCancelResultV1 = {
        version: AGENT_CHAT_CONTRACT_VERSION,
        runId,
        status: outcome.run.status,
      };
      return json(result, 202);
    } catch (error) {
      return agentChatError(error);
    }
  };
}

function agentChatError(error: unknown): Response {
  if (error instanceof AgentChatServiceError) {
    return errorResponse(error.code, error.message);
  }
  return errorResponse(
    'AGENT_CHAT_UNAVAILABLE',
    'The Agent surface could not complete the request.',
  );
}

export function createBrowserAgentChatApi(
  options: BrowserAgentChatApiOptions,
): BrowserAgentChatApiSurface {
  const api = new BrowserAgentChatApiImpl(options);
  return {
    register(host: HostServer): void {
      host.registerMutationRoute(
        'POST',
        BROWSER_AGENT_CONVERSATIONS_PATH,
        createConversationHandler(api),
      );
      host.registerReadRoute(BROWSER_AGENT_CONVERSATIONS_LIST_PATH, listConversationsHandler(api));
      host.registerMutationRoute(
        'POST',
        BROWSER_AGENT_CONVERSATION_RUNS_PATH,
        sendMessageHandler(api),
      );
      host.registerReadRoute(BROWSER_AGENT_CONVERSATION_HISTORY_PATH, historyHandler(api));
      host.registerReadRoute(BROWSER_AGENT_RUN_PROGRESS_PATH, progressHandler(api));
      host.registerMutationRoute('POST', BROWSER_AGENT_RUN_CANCEL_PATH, cancelHandler(api));
      host.registerMutationRoute('POST', BROWSER_AGENT_RUN_RETRY_PATH, retryHandler(api));
    },
  };
}
