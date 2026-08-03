import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { Context, Handler } from 'hono';
import {
  AGENT_CLIENT_CONTRACT_VERSION,
  BROWSER_AGENT_APPLY_PATH,
  BROWSER_AGENT_PROPOSAL_PATH,
  type AgentApplyRequestV1,
  type AgentApplyResponseV1,
  type AgentProposalRequestV1,
  type AgentProposalResponseV1,
} from '../client/agent-client.js';
import type { EditorAssistantContextV1 } from '../client/editor-assistant-contract.js';
import type { BrowserSessionPrincipalV1 } from '../contracts/browser-api.js';
import type { AgentSuggestionService, AgentSuggestionV1 } from './agent/suggestion-service.js';
import { WORKING_TEXT_TYPE, type AuthoringWorkingDocumentStore } from './authoring/document-store.js';
import type {
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from './browser-read-api.js';
import type { HostListenerEnv, MutationHttpMethod } from './listener.js';
import type { HostServer } from './server.js';

export interface BrowserAgentProject {
  readonly projectId: string;
  readonly documents: AuthoringWorkingDocumentStore;
  readonly suggestions: AgentSuggestionService;
  /** Scoped server capability: never a browser token. */
  issueCapability(input: {
    readonly principal: BrowserSessionPrincipalV1;
  }): Promise<{ readonly capabilityId: string; readonly scopes: readonly string[] }>;
}

export interface BrowserAgentProjectRegistry {
  get(projectId: string): BrowserAgentProject | null | Promise<BrowserAgentProject | null>;
}

export interface BrowserAgentApiOptions {
  readonly principal: BrowserPrincipalResolver;
  readonly authorization: BrowserProjectAuthorization;
  readonly catalog: BrowserProjectCatalog;
  readonly projects: BrowserAgentProjectRegistry;
}

export interface BrowserAgentApiSurface {
  register(host: HostServer): void;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function error(code: string, status: number): Response {
  return json({ error: { code } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validContext(value: unknown, projectId: string): value is EditorAssistantContextV1 {
  if (!isRecord(value) || value.version !== 1 || value.projectId !== projectId) return false;
  if (typeof value.documentId !== 'string' || value.documentId.length === 0) return false;
  if (typeof value.baseVector !== 'string' || !/^[a-f0-9]{64}$/.test(value.baseVector)) return false;
  if (!isRecord(value.selection)) return false;
  const from = value.selection.from;
  const to = value.selection.to;
  return (
    typeof from === 'number' &&
    Number.isInteger(from) &&
    typeof to === 'number' &&
    Number.isInteger(to) &&
    from >= 0 &&
    to >= from
  );
}

function safeDocumentText(project: BrowserAgentProject, documentId: string): Promise<string | null> {
  const descriptor = project.documents.descriptor(documentId);
  if (descriptor === null) return Promise.resolve(null);
  return project.documents
    .materializeDocument(documentId)
    .then((working) => working ?? project.documents.acceptedContent(descriptor.logicalPath));
}

function fullUpdate(
  current: Uint8Array | null,
  changes: readonly { readonly from: number; readonly length: number; readonly text: string }[],
): Uint8Array {
  const doc = new Y.Doc();
  if (current !== null) Y.applyUpdate(doc, current);
  const text = doc.getText(WORKING_TEXT_TYPE);
  for (const change of [...changes].reverse()) {
    if (change.length > 0) text.delete(change.from, change.length);
    if (change.text.length > 0) text.insert(change.from, change.text);
  }
  return Y.encodeStateAsUpdate(doc);
}

function vectorHash(vector: Uint8Array | null): string | null {
  return vector === null ? null : createHash('sha256').update(vector).digest('hex');
}

class BrowserAgentApi {
  readonly #suggestions = new Map<string, { readonly suggestion: AgentSuggestionV1; readonly documentText: string }>();

  constructor(readonly options: BrowserAgentApiOptions) {}

  async #project(
    c: Context<HostListenerEnv>,
    requiredRole: 'reader' | 'author' = 'reader',
  ): Promise<
    | { readonly principal: BrowserSessionPrincipalV1; readonly project: BrowserAgentProject }
    | Response
  > {
    const authenticated = await this.options.principal.resolve(c.req.raw);
    if (!authenticated.ok) return error(authenticated.failure, 401);
    const projectId = c.req.param('projectId');
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return error('PROJECT_NOT_FOUND', 404);
    }
    if (
      !(await this.options.authorization.canAccessProject(
        authenticated.principal.userId,
        projectId,
        requiredRole,
      ))
    ) {
      return error('PROJECT_NOT_FOUND', 404);
    }
    const projects = await this.options.catalog.listProjects(authenticated.principal);
    if (!projects.some((project) => project.projectId === projectId)) return error('PROJECT_NOT_FOUND', 404);
    const project = await this.options.projects.get(projectId);
    return project === null ? error('PROJECT_NOT_READY', 409) : { principal: authenticated.principal, project };
  }

  proposal(): Handler<HostListenerEnv> {
    return async (c) => {
      const access = await this.#project(c, 'reader');
      if (access instanceof Response) return access;
      const body: unknown = await c.req.raw.json().catch(() => null);
      if (!isRecord(body) || Object.keys(body).some((key) => key !== 'version' && key !== 'context' && key !== 'instruction')) {
        return error('INVALID_INPUT', 400);
      }
      if (body.version !== AGENT_CLIENT_CONTRACT_VERSION || !validContext(body.context, access.project.projectId) || typeof body.instruction !== 'string' || body.instruction.length === 0) {
        return error('INVALID_INPUT', 400);
      }
      const context = body.context;
      const digest = await access.project.documents.workspaceDigest();
      if (digest === null || digest.digest !== context.baseVector) {
        return json({
          status: 'stale',
          reason: 'stale-vector',
          replanRequired: true,
          currentVector: digest?.digest ?? null,
        } satisfies AgentProposalResponseV1);
      }
      const documentText = await safeDocumentText(access.project, context.documentId);
      const state = await access.project.documents.load({
        projectId: access.project.projectId,
        documentId: context.documentId,
      });
      if (documentText === null || state === null) return error('DOCUMENT_NOT_FOUND', 404);
      const generated = await access.project.suggestions.generate({
        projectId: access.project.projectId,
        documentId: context.documentId,
        ...(context.sceneId === undefined ? {} : { sceneId: context.sceneId }),
        documentText,
        baseVector: state.stateVector,
        selection: context.selection,
        instruction: body.instruction,
      });
      if (generated.status === 'proposal') {
        this.#suggestions.set(generated.suggestion.suggestionId, {
          suggestion: generated.suggestion,
          documentText,
        });
        return json({
          status: 'proposed',
          proposal: {
            version: 1,
            suggestionId: generated.suggestion.suggestionId,
            projectId: generated.suggestion.projectId,
            documentId: generated.suggestion.documentId,
            ...(generated.suggestion.sceneId === undefined ? {} : { sceneId: generated.suggestion.sceneId }),
            baseVector: context.baseVector,
            baseTextHash: generated.suggestion.baseTextHash,
            selection: generated.suggestion.selection,
            changes: generated.suggestion.changes,
            generatedAt: generated.suggestion.generatedAt,
          },
        } satisfies AgentProposalResponseV1);
      }
      if (generated.status === 'paused') {
        return json({ status: 'paused', reason: 'human-presence', replanRequired: true } satisfies AgentProposalResponseV1);
      }
      if (generated.status === 'stale') {
        return json({
          status: 'stale',
          reason: 'stale-vector',
          replanRequired: true,
          currentVector: digest?.digest ?? vectorHash(generated.liveStateVector),
        } satisfies AgentProposalResponseV1);
      }
      return json({ status: 'failed', errorCode: generated.errorCode } satisfies AgentProposalResponseV1, 422);
    };
  }

  apply(): Handler<HostListenerEnv> {
    return async (c) => {
      const access = await this.#project(c, 'author');
      if (access instanceof Response) return access;
      const body: unknown = await c.req.raw.json().catch(() => null);
      if (!isRecord(body) || Object.keys(body).some((key) => key !== 'version' && key !== 'context' && key !== 'proposal')) {
        return error('INVALID_INPUT', 400);
      }
      if (body.version !== AGENT_CLIENT_CONTRACT_VERSION || !validContext(body.context, access.project.projectId) || !isRecord(body.proposal) || typeof body.proposal.suggestionId !== 'string') {
        return error('INVALID_INPUT', 400);
      }
      const context = body.context;
      const stored = this.#suggestions.get(body.proposal.suggestionId);
      if (
        stored === undefined ||
        stored.suggestion.projectId !== context.projectId ||
        stored.suggestion.documentId !== context.documentId
      ) {
        return json({ status: 'stale', reason: 'context-changed', replanRequired: true, currentVector: null } satisfies AgentApplyResponseV1, 409);
      }
      const digest = await access.project.documents.workspaceDigest();
      if (digest === null || digest.digest !== context.baseVector) {
        return json({
          status: 'stale',
          reason: 'stale-vector',
          replanRequired: true,
          currentVector: digest?.digest ?? null,
        } satisfies AgentApplyResponseV1, 409);
      }
      const grant = await access.project.issueCapability({ principal: access.principal });
      const applied = await access.project.suggestions.applySuggestion({
        suggestion: stored.suggestion,
        documentText: stored.documentText,
        capabilityId: grant.capabilityId,
        scope: grant.scopes,
        materialize: async () => {
          const state = await access.project.documents.load({
            projectId: access.project.projectId,
            documentId: context.documentId,
          });
          return fullUpdate(state?.update ?? null, stored.suggestion.changes);
        },
      });
      if (applied.status === 'applied') {
        this.#suggestions.delete(stored.suggestion.suggestionId);
        return json({ status: 'applied', suggestionId: stored.suggestion.suggestionId } satisfies AgentApplyResponseV1);
      }
      if (applied.status === 'paused') {
        return json({ status: 'paused', reason: 'human-presence', replanRequired: true } satisfies AgentApplyResponseV1, 409);
      }
      if (applied.status === 'conflict') {
        return json({
          status: 'stale',
          reason: 'stale-vector',
          replanRequired: true,
          currentVector: digest?.digest ?? vectorHash(applied.liveStateVector),
        } satisfies AgentApplyResponseV1, 409);
      }
      return json({ status: 'failed', errorCode: applied.status === 'denied' ? 'SUBMIT_BLOCKED' : applied.errorCode } satisfies AgentApplyResponseV1, 422);
    };
  }

}

export function createBrowserAgentApi(options: BrowserAgentApiOptions): BrowserAgentApiSurface {
  const api = new BrowserAgentApi(options);
  const mutations: readonly { readonly method: MutationHttpMethod; readonly path: string; readonly handler: Handler<HostListenerEnv> }[] = [
    { method: 'POST', path: BROWSER_AGENT_PROPOSAL_PATH, handler: api.proposal() },
    { method: 'POST', path: BROWSER_AGENT_APPLY_PATH, handler: api.apply() },
  ];
  return {
    register(host) {
      for (const route of mutations) host.registerMutationRoute(route.method, route.path, route.handler);
    },
  };
}
