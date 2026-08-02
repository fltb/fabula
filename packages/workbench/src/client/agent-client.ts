import { BROWSER_API_BASE_PATH, BROWSER_SESSION_HEADER } from '../contracts/browser-api.js';
import type {
  EditorAssistantContextV1,
  EditorAssistantSelectionRangeV1,
} from './editor-assistant-contract.js';

/** Version of the safe browser Agent proposal surface. */
export const AGENT_CLIENT_CONTRACT_VERSION = 1 as const;
export type AgentClientContractVersion = typeof AGENT_CLIENT_CONTRACT_VERSION;

/** Guarded Host endpoint for contextual proposal generation. */
export const BROWSER_AGENT_PROPOSAL_PATH =
  `${BROWSER_API_BASE_PATH}/projects/:projectId/agent/proposals`;
/** Guarded Host endpoint for the explicit human apply mutation. */
export const BROWSER_AGENT_APPLY_PATH =
  `${BROWSER_AGENT_PROPOSAL_PATH}/:suggestionId/apply`;

export type AgentPauseReason =
  | 'human-typing'
  | 'human-presence'
  | 'lease'
  | 'rebase-required';

export type AgentStaleReason = 'stale-vector' | 'context-changed' | 'rebase-required';

/** One bounded, reviewable span replacement returned by the Host. */
export interface AgentProposalChangeV1 {
  readonly from: number;
  readonly length: number;
  readonly text: string;
  /** Optional safe excerpt supplied for a richer diff; never required to apply. */
  readonly before?: string;
}

/**
 * Safe, revision-bound Agent proposal. `baseVector` is a digest identity, not
 * raw Yjs state-vector bytes. The Host verifies the proposal against its own
 * working document before any apply effect.
 */
export interface AgentProposalV1 {
  readonly version: AgentClientContractVersion;
  readonly suggestionId: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly sceneId?: string;
  readonly baseVector: string;
  readonly baseTextHash?: string;
  readonly selection: EditorAssistantSelectionRangeV1;
  readonly changes: readonly AgentProposalChangeV1[];
  readonly generatedAt?: string;
}

export interface AgentProposalRequestV1 {
  readonly version: AgentClientContractVersion;
  readonly context: EditorAssistantContextV1;
  readonly instruction: string;
}

export interface AgentApplyRequestV1 {
  readonly version: AgentClientContractVersion;
  readonly context: EditorAssistantContextV1;
  readonly proposal: AgentProposalV1;
}

export interface AgentQueuedResponseV1 {
  readonly status: 'queued';
  readonly requestId: string | null;
  readonly operationId: string | null;
}

export interface AgentStreamingResponseV1 {
  readonly status: 'streaming';
  readonly requestId: string | null;
}

export interface AgentProposedResponseV1 {
  readonly status: 'proposed';
  readonly proposal: AgentProposalV1;
}

export interface AgentPausedResponseV1 {
  readonly status: 'paused';
  readonly reason: AgentPauseReason;
  readonly replanRequired: true;
}

export interface AgentStaleResponseV1 {
  readonly status: 'stale';
  readonly reason: AgentStaleReason;
  readonly replanRequired: true;
  readonly currentVector: string | null;
}

export interface AgentFailedResponseV1 {
  readonly status: 'failed';
  readonly errorCode: string;
}

export type AgentProposalResponseV1 =
  | AgentQueuedResponseV1
  | AgentStreamingResponseV1
  | AgentProposedResponseV1
  | AgentPausedResponseV1
  | AgentStaleResponseV1
  | AgentFailedResponseV1;

export interface AgentAppliedResponseV1 {
  readonly status: 'applied';
  readonly suggestionId: string;
}

export type AgentApplyResponseV1 =
  | AgentAppliedResponseV1
  | AgentQueuedResponseV1
  | AgentPausedResponseV1
  | AgentStaleResponseV1
  | AgentFailedResponseV1;

export type AgentFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AgentProgressEvent {
  readonly status: 'queued' | 'streaming';
  readonly requestId?: string | null;
}

export interface AgentRequestOptions {
  readonly signal?: AbortSignal;
  /** Receives only safe lifecycle state; response text is never exposed here. */
  readonly onStatus?: (event: AgentProgressEvent) => void;
}

export interface AgentClientOptions {
  readonly fetch?: AgentFetch;
  /** Session is read for the active request only and is never returned or persisted. */
  readonly getSessionId?: () => string | null | undefined;
  readonly baseUrl?: string;
  readonly proposalPath?: string;
  readonly applyPath?: string;
}

export interface AgentClient {
  propose(
    request: AgentProposalRequestV1,
    options?: AgentRequestOptions,
  ): Promise<AgentProposalResponseV1>;
  applyProposal(
    request: AgentApplyRequestV1,
    options?: Pick<AgentRequestOptions, 'signal'>,
  ): Promise<AgentApplyResponseV1>;
}

/** Typed browser failure; its message is always a fixed public-safe string. */
export class AgentClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(displayAgentFailure(code));
    this.name = 'AgentClientError';
    this.status = status;
    this.code = safeErrorCode(code);
  }
}

const MAX_INSTRUCTION_CHARACTERS = 4_000;
const MAX_CHANGES = 256;
const MAX_CHANGE_TEXT_CHARACTERS = 8_192;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;

const FAILURE_COPY: Readonly<Record<string, string>> = {
  'agent.host-failed': 'The Host could not prepare an assistant proposal.',
  'agent.suggestion.invalid-response': 'The Host returned no reviewable proposal.',
  'agent.suggestion.input-too-large': 'This document is too large for a contextual proposal.',
  'agent.suggestion.instruction-too-long': 'Shorten the instruction and try again.',
  'agent.suggestion.integrity-mismatch': 'This proposal changed; request a fresh proposal.',
  'agent.suggestion.base-text-mismatch': 'The working document changed; request a fresh proposal.',
  'agent.suggestion.invalid-changes': 'The proposal is outside the current document context.',
  'agent.suggestion.materialize-invalid': 'The Host could not prepare this proposal for apply.',
  'agent.task.aborted': 'The assistant request was stopped.',
  'SESSION_NOT_FOUND': 'Your Host session is no longer available. Sign in again.',
  'SESSION_EXPIRED': 'Your Host session expired. Sign in again.',
  'PROJECT_NOT_FOUND': 'This project is no longer available in the Host.',
  'DOCUMENT_NOT_FOUND': 'This editor document is no longer available.',
  'HUMAN_EDITING': 'The editor is currently being edited; replan before applying.',
  'WORKSPACE_STALE': 'The working document changed; re-read the editor context.',
  'CONFLICT_REQUIRES_RESOLUTION': 'The working document has a conflict that needs review.',
  'INVALID_INPUT': 'The Host rejected this assistant request.',
};

function safeErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(value)) {
    return 'agent.host-failed';
  }
  return value;
}

/** Maps Host error codes to fixed copy; provider messages never reach the UI. */
export function displayAgentFailure(errorCode: string): string {
  return FAILURE_COPY[safeErrorCode(errorCode)] ?? FAILURE_COPY['agent.host-failed'];
}

/** Fixed action-oriented pause copy; Host/provider detail is intentionally omitted. */
export function displayAgentPause(reason: AgentPauseReason): string {
  switch (reason) {
    case 'human-typing':
      return 'Someone is typing in this document. Stop typing, then replan from the latest context.';
    case 'lease':
      return 'An editor lease is active for this document. Wait for it to end, then replan.';
    case 'rebase-required':
      return 'The document moved while the assistant was working. Re-read the context and replan.';
    case 'human-presence':
      return 'A collaborator is editing this document. Re-read the context before continuing.';
  }
}

/** Fixed action-oriented stale copy; stale proposals are never treated as applied. */
export function displayAgentStale(reason: AgentStaleReason): string {
  switch (reason) {
    case 'context-changed':
      return 'The editor selection changed. Refresh the assistant context before continuing.';
    case 'rebase-required':
      return 'The working document changed. Rebase the assistant context before continuing.';
    case 'stale-vector':
      return 'The working document changed since this proposal was requested. Re-read and replan.';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function safeOptionalIdentifier(value: unknown): string | null {
  return value === null || value === undefined ? null : safeIdentifier(value);
}

function safeVector(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : null;
}

function safeSelection(value: unknown): EditorAssistantSelectionRangeV1 | null {
  if (!isObject(value)) return null;
  const from = value.from;
  const to = value.to;
  if (
    typeof from !== 'number' ||
    !Number.isInteger(from) ||
    from < 0 ||
    typeof to !== 'number' ||
    !Number.isInteger(to) ||
    to < from
  ) {
    return null;
  }
  return { from, to };
}

function validateContext(context: EditorAssistantContextV1): void {
  if (
    !isObject(context) ||
    context.version !== AGENT_CLIENT_CONTRACT_VERSION ||
    safeIdentifier(context.projectId) === null ||
    safeIdentifier(context.documentId) === null ||
    safeVector(context.baseVector) === null ||
    safeSelection(context.selection) === null ||
    (context.sceneId !== undefined && safeIdentifier(context.sceneId) === null)
  ) {
    throw new TypeError('Agent requests require a safe editor document context.');
  }
}

function copyContext(context: EditorAssistantContextV1): EditorAssistantContextV1 {
  validateContext(context);
  return {
    version: AGENT_CLIENT_CONTRACT_VERSION,
    projectId: context.projectId,
    documentId: context.documentId,
    ...(context.sceneId === undefined ? {} : { sceneId: context.sceneId }),
    selection: { from: context.selection.from, to: context.selection.to },
    baseVector: context.baseVector,
  };
}

function normalizeChange(value: unknown): AgentProposalChangeV1 | null {
  if (!isObject(value)) return null;
  const from = value.from;
  const length = value.length;
  const text = value.text;
  if (
    typeof from !== 'number' ||
    !Number.isInteger(from) ||
    from < 0 ||
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    typeof text !== 'string' ||
    text.length > MAX_CHANGE_TEXT_CHARACTERS
  ) {
    return null;
  }
  if (value.before !== undefined && typeof value.before !== 'string') return null;
  const before =
    typeof value.before === 'string'
      ? value.before.slice(0, MAX_CHANGE_TEXT_CHARACTERS)
      : undefined;
  return {
    from,
    length,
    text: text.slice(0, MAX_CHANGE_TEXT_CHARACTERS),
    ...(before === undefined ? {} : { before }),
  };
}


function normalizeProposal(value: unknown, context: EditorAssistantContextV1): AgentProposalV1 {
  if (!isObject(value)) throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  const suggestionId = safeIdentifier(value.suggestionId ?? value.proposalId);
  const projectId = safeIdentifier(value.projectId);
  const documentId = safeIdentifier(value.documentId);
  const baseVector = safeVector(
    value.baseVector ?? value.baseVectorDigest ?? value.baseVectorHash ?? value.stateVectorHash,
  );
  const selection = safeSelection(value.selection);
  const rawChanges = value.changes;
  const sceneId = value.sceneId;
  const normalizedSceneId = sceneId === undefined ? undefined : safeIdentifier(sceneId);
  if (suggestionId === null) {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  if (projectId === null || projectId !== context.projectId) {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  if (documentId === null || documentId !== context.documentId) {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  if (baseVector === null || baseVector !== context.baseVector || selection === null) {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  if (!Array.isArray(rawChanges) || rawChanges.length > MAX_CHANGES) {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  if (
    normalizedSceneId === null ||
    (normalizedSceneId !== undefined && normalizedSceneId !== context.sceneId)
  ) {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  const changes: AgentProposalChangeV1[] = [];
  let previousEnd = 0;
  for (const rawChange of rawChanges) {
    const change = normalizeChange(rawChange);
    if (change === null || change.from < previousEnd) {
      throw new AgentClientError(502, 'agent.suggestion.invalid-response');
    }
    previousEnd = change.from + change.length;
    changes.push(change);
  }
  const baseTextHash = value.baseTextHash;
  if (baseTextHash !== undefined && (typeof baseTextHash !== 'string' || !HASH_PATTERN.test(baseTextHash))) {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  const generatedAt = value.generatedAt;
  if (generatedAt !== undefined && typeof generatedAt !== 'string') {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  return {
    version: AGENT_CLIENT_CONTRACT_VERSION,
    suggestionId,
    projectId,
    documentId,
    ...(normalizedSceneId === undefined ? {} : { sceneId: normalizedSceneId }),
    baseVector,
    ...(baseTextHash === undefined ? {} : { baseTextHash }),
    selection,
    changes,
    ...(generatedAt === undefined ? {} : { generatedAt }),
  };
}

function normalizePauseReason(value: unknown): AgentPauseReason {
  switch (value) {
    case 'human-typing':
    case 'human-presence':
    case 'lease':
    case 'rebase-required':
      return value;
    case 'human-editing':
      return 'human-typing';
    default:
      return 'rebase-required';
  }
}

function normalizeStaleReason(value: unknown): AgentStaleReason {
  switch (value) {
    case 'stale-vector':
    case 'context-changed':
    case 'rebase-required':
      return value;
    default:
      return 'stale-vector';
  }
}

function normalizeResponse(value: unknown, context: EditorAssistantContextV1): AgentProposalResponseV1 {
  if (!isObject(value) || typeof value.status !== 'string') {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  switch (value.status) {
    case 'queued':
      return {
        status: 'queued',
        requestId: safeOptionalIdentifier(value.requestId),
        operationId: safeOptionalIdentifier(value.operationId),
      };
    case 'streaming':
      return { status: 'streaming', requestId: safeOptionalIdentifier(value.requestId) };
    case 'proposal':
    case 'proposed':
      return {
        status: 'proposed',
        proposal: normalizeProposal(value.proposal ?? value.suggestion ?? value, context),
      };
    case 'paused':
      return { status: 'paused', reason: normalizePauseReason(value.reason), replanRequired: true };
    case 'conflict':
      return {
        status: 'stale',
        reason: 'rebase-required',
        replanRequired: true,
        currentVector: null,
      };
    case 'stale':
      return {
        status: 'stale',
        reason: normalizeStaleReason(value.reason),
        replanRequired: true,
        currentVector: safeVector(
          value.currentVector ?? value.currentVectorDigest ?? value.currentVectorHash,
        ),
      };
    case 'denied':
    case 'failed':
    case 'failure':
    case 'error':
      return { status: 'failed', errorCode: safeErrorCode(value.errorCode ?? value.code) };
    default:
      throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
}

function normalizeApplyResponse(value: unknown, request: AgentApplyRequestV1): AgentApplyResponseV1 {
  if (!isObject(value) || typeof value.status !== 'string') {
    throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
  switch (value.status) {
    case 'applied':
      return { status: 'applied', suggestionId: safeIdentifier(value.suggestionId) ?? request.proposal.suggestionId };
    case 'queued':
      return {
        status: 'queued',
        requestId: safeOptionalIdentifier(value.requestId),
        operationId: safeOptionalIdentifier(value.operationId),
      };
    case 'paused':
      return { status: 'paused', reason: normalizePauseReason(value.reason), replanRequired: true };
    case 'conflict':
      return {
        status: 'stale',
        reason: 'rebase-required',
        replanRequired: true,
        currentVector: null,
      };
    case 'stale':
      return {
        status: 'stale',
        reason: normalizeStaleReason(value.reason),
        replanRequired: true,
        currentVector: safeVector(
          value.currentVector ?? value.currentVectorDigest ?? value.currentVectorHash,
        ),
      };
    case 'denied':
    case 'failed':
    case 'failure':
    case 'error':
      return { status: 'failed', errorCode: safeErrorCode(value.errorCode ?? value.code) };
    default:
      throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function errorCodeFromBody(value: unknown): string {
  if (!isObject(value)) return 'agent.host-failed';
  const error = isObject(value.error) ? value.error : value;
  return safeErrorCode(error.code ?? error.errorCode);
}

async function assertResponse(response: Response): Promise<unknown> {
  const value = await readJson(response);
  if (!response.ok) throw new AgentClientError(response.status, errorCodeFromBody(value));
  return value;
}

async function readEventStream(
  response: Response,
  context: EditorAssistantContextV1,
  onStatus?: (event: AgentProgressEvent) => void,
): Promise<AgentProposalResponseV1> {
  if (response.body === null) throw new AgentClientError(502, 'agent.suggestion.invalid-response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let last: AgentProposalResponseV1 | undefined;
  const consume = (chunk: string): AgentProposalResponseV1 | null => {
    pending += chunk;
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() ?? '';
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data.length === 0 || data === '[DONE]') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new AgentClientError(502, 'agent.suggestion.invalid-response');
      }
      const normalized = normalizeResponse(parsed, context);
      last = normalized;
      if (normalized.status === 'queued' || normalized.status === 'streaming') {
        onStatus?.({ status: normalized.status, requestId: normalized.requestId });
        continue;
      }
      return normalized;
    }
    return null;
  };
  while (true) {
    const result = await reader.read();
    if (result.done) {
      const tail = decoder.decode();
      const terminal = consume(`${tail}\n\n`);
      if (terminal !== null) return terminal;
      break;
    }
    const terminal = consume(decoder.decode(result.value, { stream: true }));
    if (terminal !== null) return terminal;
  }
  if (last !== undefined) return last;
  throw new AgentClientError(502, 'agent.suggestion.invalid-response');
}

function proposalUrl(path: string, projectId: string): string {
  return path.replace(':projectId', encodeURIComponent(projectId));
}

function applyUrl(path: string, projectId: string, suggestionId: string): string {
  return path
    .replace(':projectId', encodeURIComponent(projectId))
    .replace(':suggestionId', encodeURIComponent(suggestionId));
}

/**
 * Creates the browser-only Agent transport. It calls same-origin guarded Host
 * endpoints and never receives a provider handle, capability token, or raw Yjs
 * payload. The Host resolves the document bytes and capability actor itself.
 */
export function createAgentClient(options: AgentClientOptions = {}): AgentClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') throw new Error('Browser Fetch API is unavailable.');
  const prefix = options.baseUrl ?? '';
  const proposalPath = options.proposalPath ?? BROWSER_AGENT_PROPOSAL_PATH;
  const applyPath = options.applyPath ?? BROWSER_AGENT_APPLY_PATH;

  const headers = (): Headers => {
    const value = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    const sessionId = options.getSessionId?.();
    if (typeof sessionId === 'string' && sessionId.length > 0) value.set(BROWSER_SESSION_HEADER, sessionId);
    return value;
  };

  return {
    async propose(request, requestOptions = {}) {
      validateContext(request.context);
      if (
        !isObject(request) ||
        request.version !== AGENT_CLIENT_CONTRACT_VERSION ||
        typeof request.instruction !== 'string' ||
        request.instruction.trim().length === 0 ||
        request.instruction.length > MAX_INSTRUCTION_CHARACTERS
      ) {
        throw new TypeError('Agent proposal instructions must be short and non-empty.');
      }
      const context = copyContext(request.context);
      requestOptions.onStatus?.({ status: 'queued', requestId: null });
      let response: Response;
      try {
        response = await execute(`${prefix}${proposalUrl(proposalPath, context.projectId)}`, {
          method: 'POST',
          headers: headers(),
          credentials: 'same-origin',
          signal: requestOptions.signal,
          body: JSON.stringify({
            version: AGENT_CLIENT_CONTRACT_VERSION,
            context,
            instruction: request.instruction.trim(),
          } satisfies AgentProposalRequestV1),
        });
      } catch (error) {
        if (requestOptions.signal?.aborted) throw new AgentClientError(499, 'agent.task.aborted');
        throw new AgentClientError(0, 'agent.host-failed');
      }
      if (!response.ok) {
        const value = await readJson(response);
        throw new AgentClientError(response.status, errorCodeFromBody(value));
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        return readEventStream(response, context, requestOptions.onStatus);
      }
      requestOptions.onStatus?.({ status: 'streaming', requestId: null });
      return normalizeResponse(await assertResponse(response), context);
    },

    async applyProposal(request, requestOptions = {}) {
      validateContext(request.context);
      if (
        !isObject(request) ||
        request.version !== AGENT_CLIENT_CONTRACT_VERSION ||
        !isObject(request.proposal) ||
        request.proposal.projectId !== request.context.projectId ||
        request.proposal.documentId !== request.context.documentId
      ) {
        throw new TypeError('Agent apply requires a proposal bound to the active editor context.');
      }
      const context = copyContext(request.context);
      const proposal = normalizeProposal(request.proposal, context);
      let response: Response;
      try {
        response = await execute(
          `${prefix}${applyUrl(applyPath, context.projectId, proposal.suggestionId)}`,
          {
            method: 'POST',
            headers: headers(),
            credentials: 'same-origin',
            signal: requestOptions.signal,
            body: JSON.stringify({
              version: AGENT_CLIENT_CONTRACT_VERSION,
              context,
              proposal,
            } satisfies AgentApplyRequestV1),
          },
        );
      } catch (error) {
        if (requestOptions.signal?.aborted) throw new AgentClientError(499, 'agent.task.aborted');
        throw new AgentClientError(0, 'agent.host-failed');
      }
      if (!response.ok) {
        const value = await readJson(response);
        throw new AgentClientError(response.status, errorCodeFromBody(value));
      }
      return normalizeApplyResponse(await assertResponse(response), request);
    },
  };
}
