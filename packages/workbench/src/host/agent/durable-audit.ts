import { randomUUID } from 'node:crypto';
/**
 * Host-only durable Agent audit adapter over the Phase 0 append-only audit
 * persistence operations (`appendAudit`/`listAudit`).
 *
 * The adapter is a standalone module: it never touches the persistence
 * schema, the worker, or launch composition. The integration owner wires it
 * as the ProjectSession audit sink (replacing the launch no-op sink) and can
 * additionally append typed entries for surfaces that do not run through a
 * session (suggestion generation, MCP, filesystem candidates).
 *
 * Strict no-secret contract: only the declared AuditRecord fields are
 * accepted (unknown fields are rejected before any write), values are
 * shape-validated (hex hashes, bounded identifiers, no control characters,
 * no absolute-path document scopes), and raw text, raw vectors/updates,
 * tokens, keys, and absolute paths can never enter a record through this
 * adapter. The durable sink bridge derives records from validated
 * `SessionAuditRecord`s, so grant-actor and capability-version truth always
 * come from the persisted grant, never from caller input.
 */
import type { AuditRecord, AuditSurface } from '../../contracts/persistence.js';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import type { SessionAuditRecord, SessionAuditSink } from '../project-session.js';

/** Default cap on one `detail` value. */
export const AGENT_AUDIT_MAX_DETAIL_CHARACTERS = 1_024;
export const AGENT_AUDIT_MAX_LIST_LIMIT = 500;

const SURFACES: readonly AuditSurface[] = [
  'browser',
  'agent',
  'mcp',
  'filesystem',
  'submit',
  'system',
];
const OUTCOMES = ['completed', 'failed', 'denied'] as const;
const HASH64 = /^[0-9a-f]{64}$/;
const RECEIPT_HASH = /^[0-9a-f]{32,128}$/;

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const APPEND_FIELDS = [
  'surface',
  'operationKind',
  'outcome',
  'actorId',
  'projectId',
  'documentScope',
  'capabilityVersion',
  'baseSourceHash',
  'resultSourceHash',
  'workspaceDigest',
  'submitId',
  'gitReceiptHash',
  'detail',
  'at',
] as const;
const LIST_FIELDS = ['limit', 'surface', 'projectId'] as const;

/** Strict, secret-free audit append input; mirrors AuditRecord minus the server-assigned id. */
export interface AgentAuditAppendInput {
  readonly surface: AuditSurface;
  readonly operationKind: string;
  readonly outcome: 'completed' | 'failed' | 'denied';
  readonly actorId?: string;
  readonly projectId?: string;
  /** Document scope (logical path or document id); absolute paths are rejected. */
  readonly documentScope?: string;
  readonly capabilityVersion?: number;
  readonly baseSourceHash?: string;
  readonly resultSourceHash?: string;
  readonly workspaceDigest?: string;
  readonly submitId?: string;
  readonly gitReceiptHash?: string;
  readonly detail?: string;
  /** Event time; defaults to the adapter clock when omitted. */
  readonly at?: string;
}

export interface AgentAuditListQuery {
  readonly limit: number;
  readonly surface?: AuditSurface;
  readonly projectId?: string;
}

export interface AgentDurableAuditOptions {
  /** Async-only typed persistence domain client (appendAudit/listAudit). */
  readonly client: Pick<PersistenceWorkerClient, 'request'>;
  readonly now?: () => string;
  readonly newAuditId?: () => string;
  readonly maxDetailCharacters?: number;
  readonly maxListLimit?: number;
}

/** Malformed audit input (unknown fields, invalid shapes, secret-like values). */
export class AgentAuditInputError extends Error {
  override readonly name = 'AgentAuditInputError';
}

function assertNoControlCharacters(value: string, field: string): void {
  if (containsControlCharacters(value)) {
    throw new AgentAuditInputError(`${field} must not contain control characters.`);
  }
}

function validateHash64(value: string, field: string): void {
  if (!HASH64.test(value)) {
    throw new AgentAuditInputError(`${field} must be a 64-character lowercase hex hash.`);
  }
}

function validateIdentifier(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new AgentAuditInputError(
      `${field} must be a non-empty string of at most ${maxLength} characters.`,
    );
  }
  assertNoControlCharacters(value, field);
  return value;
}

/**
 * Append-only, queryable durable audit over Phase 0 persistence. Construct
 * once per Host process and share; appends are validated strictly before any
 * write and the stored record is the exact validated projection.
 */
export class AgentDurableAudit {
  readonly #client: Pick<PersistenceWorkerClient, 'request'>;
  readonly #now: () => string;
  readonly #newAuditId: () => string;
  readonly #maxDetailCharacters: number;
  readonly #maxListLimit: number;

  constructor(options: AgentDurableAuditOptions) {
    const client = options.client;
    if (client === null || typeof client !== 'object' || typeof client.request !== 'function') {
      throw new TypeError('AgentDurableAudit requires an injected persistence client (request).');
    }
    const maxDetail = options.maxDetailCharacters ?? AGENT_AUDIT_MAX_DETAIL_CHARACTERS;
    if (!Number.isInteger(maxDetail) || maxDetail <= 0) {
      throw new TypeError('maxDetailCharacters must be a positive integer.');
    }
    const maxList = options.maxListLimit ?? AGENT_AUDIT_MAX_LIST_LIMIT;
    if (!Number.isInteger(maxList) || maxList <= 0) {
      throw new TypeError('maxListLimit must be a positive integer.');
    }
    this.#client = client;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newAuditId = options.newAuditId ?? randomUUID;
    this.#maxDetailCharacters = maxDetail;
    this.#maxListLimit = maxList;
  }

  /**
   * Append one strictly validated audit record. Unknown fields, invalid
   * shapes, control characters, non-hex hashes, and absolute-path document
   * scopes are rejected before any write; the returned record is the exact
   * persisted projection.
   */
  async append(input: AgentAuditAppendInput): Promise<AuditRecord> {
    this.#validateAppend(input);
    const record: AuditRecord = {
      auditId: this.#newAuditId(),
      at: input.at ?? this.#now(),
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      surface: input.surface,
      operationKind: input.operationKind,
      outcome: input.outcome,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.documentScope === undefined ? {} : { documentScope: input.documentScope }),
      ...(input.capabilityVersion === undefined
        ? {}
        : { capabilityVersion: input.capabilityVersion }),
      ...(input.baseSourceHash === undefined ? {} : { baseSourceHash: input.baseSourceHash }),
      ...(input.resultSourceHash === undefined ? {} : { resultSourceHash: input.resultSourceHash }),
      ...(input.workspaceDigest === undefined ? {} : { workspaceDigest: input.workspaceDigest }),
      ...(input.submitId === undefined ? {} : { submitId: input.submitId }),
      ...(input.gitReceiptHash === undefined ? {} : { gitReceiptHash: input.gitReceiptHash }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
    await this.#client.request('appendAudit', record);
    return record;
  }

  /** Query recent audit entries, newest first, filtered by surface/project when given. */
  async list(query: AgentAuditListQuery): Promise<AuditRecord[]> {
    this.#validateList(query);
    return this.#client.request('listAudit', {
      limit: query.limit,
      ...(query.surface === undefined ? {} : { surface: query.surface }),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
    });
  }

  /**
   * A ProjectSession-compatible audit sink. Maps validated session records
   * (grant-derived actor/version/kind, or typed denials) onto durable
   * agent-surface audit entries; a throwing append never changes an
   * operation result (the session already treats the sink as best-effort).
   */
  createSink(): SessionAuditSink {
    return {
      record: async (record: SessionAuditRecord): Promise<void> => {
        if (record.outcome === 'denied') {
          await this.append({
            surface: 'agent',
            operationKind: 'operation.denied',
            outcome: 'denied',
            projectId: record.projectId,
            detail: `capability:${record.capabilityId}; reason:${record.reason}`,
            at: record.at,
          });
          return;
        }
        await this.append({
          surface: 'agent',
          operationKind: record.kind,
          outcome: record.outcome,
          actorId: record.actorId,
          projectId: record.projectId,
          capabilityVersion: record.version,
          detail: record.detail,
          at: record.at,
        });
      },
    };
  }

  #validateAppend(input: AgentAuditAppendInput): void {
    if (input === null || typeof input !== 'object') {
      throw new AgentAuditInputError('AgentDurableAudit.append requires an input object.');
    }
    for (const key of Object.keys(input)) {
      if (!APPEND_FIELDS.includes(key as (typeof APPEND_FIELDS)[number])) {
        throw new AgentAuditInputError(
          `Unknown field "${key}" passed to AgentDurableAudit.append; audit entries are strict.`,
        );
      }
    }
    if (!SURFACES.includes(input.surface)) {
      throw new AgentAuditInputError(`surface must be one of: ${SURFACES.join(', ')}.`);
    }
    if (!OUTCOMES.includes(input.outcome)) {
      throw new AgentAuditInputError('outcome must be completed, failed, or denied.');
    }
    if (typeof input.operationKind !== 'string' || input.operationKind.length === 0) {
      throw new AgentAuditInputError('operationKind must be a non-empty string.');
    }
    if (input.operationKind.length > 256) {
      throw new AgentAuditInputError('operationKind must be at most 256 characters.');
    }
    assertNoControlCharacters(input.operationKind, 'operationKind');
    validateIdentifier(input.actorId, 'actorId', 256);
    validateIdentifier(input.projectId, 'projectId', 256);
    if (input.capabilityVersion !== undefined) {
      if (!Number.isInteger(input.capabilityVersion) || input.capabilityVersion <= 0) {
        throw new AgentAuditInputError('capabilityVersion must be a positive integer.');
      }
    }
    this.#validateDocumentScope(input.documentScope);
    if (input.baseSourceHash !== undefined) validateHash64(input.baseSourceHash, 'baseSourceHash');
    if (input.resultSourceHash !== undefined) {
      validateHash64(input.resultSourceHash, 'resultSourceHash');
    }
    if (input.workspaceDigest !== undefined) {
      validateHash64(input.workspaceDigest, 'workspaceDigest');
    }
    if (input.submitId !== undefined) {
      validateIdentifier(input.submitId, 'submitId', 256);
    }
    if (input.gitReceiptHash !== undefined) {
      if (typeof input.gitReceiptHash !== 'string' || !RECEIPT_HASH.test(input.gitReceiptHash)) {
        throw new AgentAuditInputError(
          'gitReceiptHash must be a lowercase hex hash of 32 to 128 characters.',
        );
      }
    }
    if (input.detail !== undefined) {
      if (typeof input.detail !== 'string' || input.detail.length === 0) {
        throw new AgentAuditInputError('detail must be a non-empty string.');
      }
      if (input.detail.length > this.#maxDetailCharacters) {
        throw new AgentAuditInputError(
          `detail must be at most ${this.#maxDetailCharacters} characters.`,
        );
      }
      assertNoControlCharacters(input.detail, 'detail');
    }
    if (input.at !== undefined) {
      if (typeof input.at !== 'string' || input.at.length === 0 || input.at.length > 64) {
        throw new AgentAuditInputError('at must be a non-empty string of at most 64 characters.');
      }
      assertNoControlCharacters(input.at, 'at');
    }
  }

  #validateDocumentScope(value: string | undefined): void {
    if (value === undefined) return;
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
      throw new AgentAuditInputError(
        'documentScope must be a non-empty string of at most 512 characters.',
      );
    }
    // Logical document identities cannot be host paths on either POSIX or Windows.
    if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
      throw new AgentAuditInputError('documentScope must not be an absolute path.');
    }
    if (value.split(/[/\\]/).includes('..')) {
      throw new AgentAuditInputError('documentScope must not contain path traversal segments.');
    }
  }

  #validateList(query: AgentAuditListQuery): void {
    if (query === null || typeof query !== 'object') {
      throw new AgentAuditInputError('AgentDurableAudit.list requires a query object.');
    }
    for (const key of Object.keys(query)) {
      if (!LIST_FIELDS.includes(key as (typeof LIST_FIELDS)[number])) {
        throw new AgentAuditInputError(
          `Unknown field "${key}" passed to AgentDurableAudit.list; audit queries are strict.`,
        );
      }
    }
    if (!Number.isInteger(query.limit) || query.limit <= 0 || query.limit > this.#maxListLimit) {
      throw new AgentAuditInputError(`limit must be an integer in [1, ${this.#maxListLimit}].`);
    }
    if (query.surface !== undefined && !SURFACES.includes(query.surface)) {
      throw new AgentAuditInputError(`surface must be one of: ${SURFACES.join(', ')}.`);
    }
    validateIdentifier(query.projectId, 'projectId', 256);
  }
}

/**
 * Create one durable audit adapter. Fails closed on a missing persistence
 * client: durable audit must never silently no-op.
 */
export function createAgentDurableAudit(options: AgentDurableAuditOptions): AgentDurableAudit {
  return new AgentDurableAudit(options);
}

/**
 * A ProjectSession-compatible durable sink over one adapter. The session
 * treats the sink as best-effort observability (a failing append never
 * changes an operation result); the sink itself surfaces append failures so
 * the session's own guard owns that decision.
 */
export function createDurableAuditSink(audit: AgentDurableAudit): SessionAuditSink {
  return audit.createSink();
}
