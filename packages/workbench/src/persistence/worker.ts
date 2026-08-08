import { DatabaseSync } from 'node:sqlite';
import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import { Kysely, SqliteDialect } from 'kysely';
import { AUTHORING_PHASE_VALUES } from '../contracts/authoring.js';
import { PROJECT_ACCESS_ROLES } from '../contracts/configuration.js';
import type {
  AgentConversationMessageRecordV1,
  AgentConversationRecordV1,
  AgentRunRecordV1,
  AgentRunStatusV1,
  AgentToolCallRecordV1,
  AgentToolCallStatusV1,
  AuditRecord,
  AuditSurface,
  AuthoringConflictRecord,
  AuthoringStateRecord,
  AuthoringWorkingDocumentRecord,
  AuthUserRecord,
  CapabilityVerifierReadState,
  CapabilityVerifierRecord,
  ConfigurationOperationRecord,
  ConsumeInviteResult,
  GitSubmissionJournal,
  GitSubmissionPhase,
  GitSubmissionReceipt,
  InviteState,
  McpDeviceVerifierReadState,
  McpDeviceVerifierRecord,
  NativeRevisionPhase,
  NativeRevisionTerminalPhase,
  PasswordHashRecord,
  PersistenceOperation,
  PersistencePayloads,
  PersistenceResults,
  ProjectMembershipMutationResult,
  ProjectMembershipState,
  ProjectOperationProgressV1,
  ProjectOperationRecordV1,
  ProjectOperationStatusV1,
  ProjectPublicationRecordV1,
  PublicationKindV1,
  PublicationStatusV1,
  RevisionMirrorExportRecord,
  RevokeInviteResult,
  SourceHeadCasResult,
  SourceHeadRecord,
  SourceMaterializationEntryRecord,
  SourceMaterializationRecord,
  SourceRevisionOperationRecord,
  SourceRevisionReceipt,
  SourceRevisionRecord,
  UserRole,
} from '../contracts/persistence.js';
import {
  AGENT_MESSAGE_ROLE_VALUES,
  AGENT_RUN_STATUS_VALUES,
  AGENT_TOOL_CALL_STATUS_VALUES,
  CANONICAL_PUBLICATION_ID,
  GIT_SUBMISSION_PHASE_COMPLETE,
  GIT_SUBMISSION_PHASE_CONFLICT,
  GIT_SUBMISSION_PHASE_STALE,
  GIT_SUBMISSION_PHASE_VALUES,
  NATIVE_REVISION_PHASE_VALUES,
  NATIVE_REVISION_TERMINAL_PHASE_VALUES,
  PROJECT_OPERATION_KIND_VALUES,
  PROJECT_OPERATION_STATUS_VALUES,
  PUBLICATION_KIND_VALUES,
  PUBLICATION_STATUS_VALUES,
} from '../contracts/persistence.js';

import { createKyselySqliteDatabase, type KyselySqliteBridge } from './kysely-sqlite-bridge.js';
import type { PersistenceRequest, PersistenceResponse } from './messages.js';
import { serializePersistenceError } from './messages.js';
import {
  type PersistenceMigrationStep,
  type PersistenceTable,
  persistenceSchema,
} from './schema.js';

export interface WorkerOptions {
  databasePath: string;
}
export interface WorkerDisposer {
  /**
   * Idempotently shuts the worker service down: detaches the message listener
   * so no further requests are accepted, drains already-queued work against
   * the still-open database, then closes the Kysely/DatabaseSync handles
   * exactly once and releases the worker's end of the message port. Safe to
   * call any number of times; every call returns the same close promise.
   */
  dispose(): Promise<void>;
}

type Database = InstanceType<typeof DatabaseSync>;
type WorkerDatabase = {
  raw: Database;
  kysely: Kysely<Record<string, never>>;
  prepare(sqlText: string): KyselySqliteBridge;
  exec(sqlText: string): void;
  close(): Promise<void>;
};
function createWorkerDatabase(databasePath: string): WorkerDatabase {
  const raw = new DatabaseSync(databasePath);
  const adapter = createKyselySqliteDatabase(raw);
  const kysely = new Kysely<Record<string, never>>({
    dialect: new SqliteDialect({ database: adapter }),
  });
  return {
    raw,
    kysely,
    prepare: (sqlText: string) => adapter.prepare(sqlText),
    exec: (sqlText: string) => raw.exec(sqlText),
    close: async () => {
      await kysely.destroy();
    },
  };
}
const asBlob = (value: Uint8Array | null | undefined): Uint8Array | null =>
  value == null ? null : new Uint8Array(value);
const text = (value: unknown): string => String(value);
const json = (value: unknown): string => JSON.stringify(value);
const parseJson = <T>(value: unknown): T => JSON.parse(text(value)) as T;

function sqlType(type: string): string {
  return type === 'integer' ? 'INTEGER' : type === 'blob' ? 'BLOB' : 'TEXT';
}

/** Render a full CREATE TABLE statement body (columns plus optional composite PK). */
function renderTableSql(table: PersistenceTable): string {
  const composite = table.primaryKey;
  const columns = table.columns
    .map((column) => {
      const check =
        column.values && column.values.length > 0
          ? ` CHECK (${column.name} IN (${column.values.map((v) => `'${v}'`).join(', ')}))`
          : '';
      return `${column.name} ${sqlType(column.type)}${column.nullable ? '' : ' NOT NULL'}${column.primaryKey && !composite ? ' PRIMARY KEY' : ''}${check}`;
    })
    .join(', ');
  const primaryKeyClause =
    composite && composite.length > 0 ? `, PRIMARY KEY (${composite.join(', ')})` : '';
  return `${columns}${primaryKeyClause}`;
}

function migrate(db: WorkerDatabase): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL);',
  );
  const migrationRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get();
  const current =
    migrationRow !== null &&
    typeof migrationRow === 'object' &&
    'version' in migrationRow &&
    migrationRow.version !== null
      ? Number(migrationRow.version)
      : 0;
  const newestBundled = persistenceSchema[persistenceSchema.length - 1]?.version ?? 0;
  // Fail closed instead of running against a schema created by a NEWER Host
  // version: the bundled migrations cannot know what that schema looks like,
  // so starting would risk corrupting rows this build does not understand.
  if (current > newestBundled) {
    throw {
      code: 'SCHEMA_VERSION_TOO_NEW',
      message: `Database schema version ${current} is newer than the bundled schema (${newestBundled}); refusing to start`,
      retryable: false,
    };
  }
  for (const migration of persistenceSchema) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (migration.steps) {
        for (const step of migration.steps) {
          applyMigrationStep(db, step);
        }
      } else {
        for (const table of migration.tables ?? []) {
          db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (${renderTableSql(table)})`);
        }
      }
      db.prepare(
        'INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?)',
      ).run([migration.version, migration.description, new Date().toISOString()]);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrationStep(db: WorkerDatabase, step: PersistenceMigrationStep): void {
  switch (step.kind) {
    case 'create-table': {
      const table = step.table;
      db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (${renderTableSql(table)})`);
      break;
    }
    case 'rebuild-table': {
      const table = step.table;
      const oldTable = step.copy.from;
      const copyCols = step.copy.columns.join(', ');
      let filterSql = '';
      if (step.copy.filter) {
        if (step.copy.filter.equals != null) {
          filterSql = ` WHERE ${step.copy.filter.column} = '${step.copy.filter.equals}'`;
        } else if (step.copy.filter.isNotNull) {
          filterSql = ` WHERE ${step.copy.filter.column} IS NOT NULL`;
        }
      }
      db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (${renderTableSql(table)})`);
      db.exec(
        `INSERT INTO ${table.name} (${copyCols}) SELECT ${copyCols} FROM ${oldTable}${filterSql}`,
      );
      break;
    }
    case 'create-index': {
      const unique = step.unique ? 'UNIQUE ' : '';
      let filter = '';
      if (step.filter) {
        if (step.filter.equals != null) {
          filter = ` WHERE ${step.filter.column} = '${step.filter.equals}'`;
        } else if (step.filter.isNotNull) {
          filter = ` WHERE ${step.filter.column} IS NOT NULL`;
        }
      }
      db.exec(
        `CREATE ${unique}INDEX IF NOT EXISTS ${step.name} ON ${step.table} (${step.columns.join(', ')})${filter}`,
      );
      break;
    }
    case 'virtual-table': {
      const opts = step.options?.length ? `, ${step.options.join(', ')}` : '';
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${step.name} USING ${step.using}(${step.columns.join(', ')}${opts})`,
      );
      break;
    }
    case 'copy-capability-verifiers': {
      db.exec(
        "INSERT OR IGNORE INTO capability_verifiers(device_id,token_hash,scope,expires_at,client_label,revoked_at,created_at) SELECT device_id,token_hash,scope,expires_at,client_label,revoked_at,created_at FROM device_verifiers WHERE device_id LIKE 'capability:%'",
      );
      break;
    }
  }
}

function mapUserRow(row: Record<string, unknown>): AuthUserRecord {
  return {
    userId: text(row.user_id),
    role: text(row.role) as UserRole,
    displayName: text(row.display_name),
    passwordHash:
      row.password_hash == null ? null : parseJson<PasswordHashRecord>(row.password_hash),
    capabilityVersion: Number(row.capability_version),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}
function mapInviteRow(row: Record<string, unknown>): InviteState {
  const role = text(row.role);
  if (!(PROJECT_ACCESS_ROLES as readonly string[]).includes(role)) {
    throw new Error('Persistence returned an unknown project access role.');
  }
  return {
    inviteId: text(row.invite_id),
    ...(row.project_id != null ? { projectId: text(row.project_id) } : {}),
    role: role as InviteState['role'],
    expiresAt: text(row.expires_at),
    ...(row.consumed_at != null ? { consumedAt: text(row.consumed_at) } : {}),
  };
}
function mapProjectMembershipRow(row: Record<string, unknown>): ProjectMembershipState {
  const role = text(row.role);
  if (!(PROJECT_ACCESS_ROLES as readonly string[]).includes(role)) {
    throw new Error('Persistence returned an unknown project access role.');
  }
  return {
    userId: text(row.user_id),
    projectId: text(row.project_id),
    role: role as ProjectMembershipState['role'],
    createdAt: text(row.created_at),
    revision: Number(row.revision),
    ...(row.revoked_at != null ? { revokedAt: text(row.revoked_at) } : {}),
    capabilityVersion: Number(row.capability_version),
  };
}

function membershipInputError(
  code: 'INVALID_INPUT' | 'USER_NOT_FOUND' | 'PROJECT_NOT_FOUND',
  message: string,
): never {
  throw { code, message, retryable: false };
}

function requireMembershipIdentifier(value: unknown, field: 'userId' | 'projectId'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    membershipInputError('INVALID_INPUT', `${field} must be a non-empty identifier.`);
  }
  return value;
}

function requireMembershipRole(value: unknown): ProjectMembershipState['role'] {
  if (typeof value !== 'string' || !(PROJECT_ACCESS_ROLES as readonly string[]).includes(value)) {
    membershipInputError('INVALID_INPUT', 'role must be a canonical project access role.');
  }
  return value as ProjectMembershipState['role'];
}

function mapCapabilityRow(row: Record<string, unknown>): PersistenceResults['loadCapability'] {
  return {
    capabilityId: text(row.capability_id),
    userId: text(row.user_id),
    projectId: text(row.project_id),
    scope: parseJson<string[]>(row.scope),
    version: Number(row.version),
    expiresAt: text(row.expires_at),
    ...(row.revoked_at != null ? { revokedAt: text(row.revoked_at) } : {}),
  };
}

/**
 * Tolerate any phase string a previous Host version may have stored: canonical
 * phases pass through unchanged; unknown legacy values read as an in-flight
 * phase so the row stays probe-resolvable and never fabricates a terminal
 * outcome.
 */
const parseGitSubmissionPhase = (value: unknown): GitSubmissionPhase =>
  GIT_SUBMISSION_PHASE_VALUES.find((phase) => phase === text(value)) ?? 'lock-acquired';

function mapGitJournalRow(row: Record<string, unknown>): GitSubmissionJournal {
  return {
    submitId: text(row.submit_id),
    projectId: text(row.project_id),
    phase: parseGitSubmissionPhase(row.phase),
    expectedGitHead: text(row.expected_git_head),
    ...(row.candidate_commit != null ? { candidateCommit: text(row.candidate_commit) } : {}),
    ...(row.receipt_hash != null ? { receiptHash: text(row.receipt_hash) } : {}),
    ...(row.diagnostic != null ? { diagnostic: text(row.diagnostic) } : {}),
    updatedAt: text(row.updated_at),
  };
}
/** Completed-phase rows become receipts; the source hash rides in the diagnostic slot. */
function mapGitReceiptRow(row: Record<string, unknown>): GitSubmissionReceipt {
  return {
    submitId: text(row.submit_id),
    projectId: text(row.project_id),
    commit: text(row.candidate_commit),
    sourceHash: row.diagnostic != null ? text(row.diagnostic) : '',
    receiptHash: text(row.receipt_hash),
    acceptedAt: text(row.updated_at),
  };
}

// ─── V2 row mappers ─────────────────────────────────────────────────────────

function mapConfigurationOperationRow(row: Record<string, unknown>): ConfigurationOperationRecord {
  return {
    operationId: text(row.operation_id),
    origin: text(row.origin),
    status: text(row.status),
    ...(row.active_revision != null ? { activeRevision: text(row.active_revision) } : {}),
    ...(row.candidate_revision != null ? { candidateRevision: text(row.candidate_revision) } : {}),
    changedFields: parseJson<string[]>(row.changed_fields),
    diagnostics: parseJson<{ code: string; message: string }[]>(row.diagnostics),
    ...(row.actor_id != null ? { actorId: text(row.actor_id) } : {}),
    at: text(row.at),
  };
}

/**
 * Tolerate any phase string a previous Host version may have stored. Unknown
 * values read as `recovery-required` so a coordinator restart never
 * fabricates a known phase from an unrecognized one.
 */
const parseAuthoringPhase = (value: unknown): string =>
  AUTHORING_PHASE_VALUES.find((phase) => phase === text(value)) ?? 'recovery-required';

function mapAuthoringStateRow(row: Record<string, unknown>): AuthoringStateRecord {
  return {
    projectId: text(row.project_id),
    phase: parseAuthoringPhase(row.phase),
    ...(row.accepted_source_hash != null
      ? { acceptedSourceHash: text(row.accepted_source_hash) }
      : {}),
    ...(row.observed_filesystem_hash != null
      ? { observedFilesystemHash: text(row.observed_filesystem_hash) }
      : {}),
    ...(row.workspace_digest != null ? { workspaceDigest: text(row.workspace_digest) } : {}),
    ...(row.candidate_hash != null ? { candidateHash: text(row.candidate_hash) } : {}),
    candidateValid: Number(row.candidate_valid) === 1,
    conflicts: parseJson<AuthoringConflictRecord[]>(row.conflicts),
    ...(row.fixed_git_head != null ? { fixedGitHead: text(row.fixed_git_head) } : {}),
    ...(row.pending_submit_id != null ? { pendingSubmitId: text(row.pending_submit_id) } : {}),
    ...(row.recovery_phase != null ? { recoveryPhase: text(row.recovery_phase) } : {}),
    updatedAt: text(row.updated_at),
  };
}

function mapAuditRow(row: Record<string, unknown>): AuditRecord {
  return {
    auditId: text(row.audit_id),
    at: text(row.at),
    ...(row.actor_id != null ? { actorId: text(row.actor_id) } : {}),
    surface: text(row.surface) as AuditSurface,
    operationKind: text(row.operation_kind),
    outcome: text(row.outcome) as AuditRecord['outcome'],
    ...(row.project_id != null ? { projectId: text(row.project_id) } : {}),
    ...(row.document_scope != null ? { documentScope: text(row.document_scope) } : {}),
    ...(row.capability_version != null
      ? { capabilityVersion: Number(row.capability_version) }
      : {}),
    ...(row.base_source_hash != null ? { baseSourceHash: text(row.base_source_hash) } : {}),
    ...(row.result_source_hash != null ? { resultSourceHash: text(row.result_source_hash) } : {}),
    ...(row.workspace_digest != null ? { workspaceDigest: text(row.workspace_digest) } : {}),
    ...(row.submit_id != null ? { submitId: text(row.submit_id) } : {}),
    ...(row.git_receipt_hash != null ? { gitReceiptHash: text(row.git_receipt_hash) } : {}),
    ...(row.detail != null ? { detail: text(row.detail) } : {}),
  };
}

/** Capability read projection; `tokenHash` is never returned. */
function toCapabilityVerifierRead(record: CapabilityVerifierRecord): CapabilityVerifierReadState {
  return {
    deviceId: record.deviceId,
    scope: record.scope,
    expiresAt: record.expiresAt,
    clientLabel: record.clientLabel,
    ...(record.revokedAt != null ? { revokedAt: record.revokedAt } : {}),
    createdAt: record.createdAt,
  };
}

/** MCP read projection mapped only from migration-4 durable columns. */
function toMcpDeviceVerifierRead(record: McpDeviceVerifierRecord): McpDeviceVerifierReadState {
  return {
    deviceId: record.deviceId,
    kind: record.kind,
    ...(record.projectId != null ? { projectId: record.projectId } : {}),
    ownerUserId: record.ownerUserId,
    scopes: record.scopes,
    grantRevision: record.grantRevision,
    expiresAt: record.expiresAt,
    ...(record.revokedAt != null ? { revokedAt: record.revokedAt } : {}),
    createdAt: record.createdAt,
  };
}

function mapCapabilityVerifierRow(row: Record<string, unknown>): CapabilityVerifierReadState {
  return {
    deviceId: text(row.device_id),
    scope: parseJson<string[]>(row.scope),
    expiresAt: text(row.expires_at),
    clientLabel: text(row.client_label),
    ...(row.revoked_at != null ? { revokedAt: text(row.revoked_at) } : {}),
    createdAt: text(row.created_at),
  };
}

function mapMcpDeviceVerifierRow(row: Record<string, unknown>): McpDeviceVerifierReadState {
  return {
    deviceId: text(row.device_id),
    kind: text(row.kind) as McpDeviceVerifierRecord['kind'],
    ...(row.project_id != null ? { projectId: text(row.project_id) } : {}),
    ownerUserId: text(row.owner_user_id),
    scopes: parseJson<string[]>(row.scopes),
    grantRevision: Number(row.grant_revision),
    expiresAt: text(row.expires_at),
    ...(row.revoked_at != null ? { revokedAt: text(row.revoked_at) } : {}),
    createdAt: text(row.created_at),
  };
}
/**
 * Tolerate any phase string from durable native revision rows. Canonical
 * phases pass through unchanged; unknown values read as `recovery-required`.
 */
const parseNativeRevisionPhase = (value: unknown): NativeRevisionPhase =>
  NATIVE_REVISION_PHASE_VALUES.find((phase) => phase === text(value)) ?? 'recovery-required';

const isNativeTerminalPhase = (value: unknown): value is NativeRevisionTerminalPhase =>
  NATIVE_REVISION_TERMINAL_PHASE_VALUES.includes(text(value) as NativeRevisionTerminalPhase);

function mapSourceRevisionRow(row: Record<string, unknown>): SourceRevisionRecord {
  return {
    revisionId: text(row.revision_id),
    projectId: text(row.project_id),
    ...(row.parent_revision_id != null ? { parentRevisionId: text(row.parent_revision_id) } : {}),
    operationId: text(row.operation_id),
    sourceHash: text(row.source_hash),
    bundleHash: text(row.bundle_hash),
    actorId: text(row.actor_id),
    origin: text(row.origin),
    createdAt: text(row.created_at),
    ...(row.accepted_at != null ? { acceptedAt: text(row.accepted_at) } : {}),
  };
}

function mapSourceRevisionOperationRow(
  row: Record<string, unknown>,
): SourceRevisionOperationRecord {
  return {
    operationId: text(row.operation_id),
    projectId: text(row.project_id),
    ...(row.expected_revision_id != null
      ? { expectedRevisionId: text(row.expected_revision_id) }
      : {}),
    ...(row.expected_source_hash != null
      ? { expectedSourceHash: text(row.expected_source_hash) }
      : {}),
    ...(row.revision_id != null ? { revisionId: text(row.revision_id) } : {}),
    phase: parseNativeRevisionPhase(row.phase),
    ...(row.receipt_hash != null ? { receiptHash: text(row.receipt_hash) } : {}),
    ...(row.diagnostic != null ? { diagnostic: text(row.diagnostic) } : {}),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/** Terminal-phase rows with a receipt hash become immutable receipts. */
function mapSourceRevisionReceiptRow(row: Record<string, unknown>): SourceRevisionReceipt {
  const phase = text(row.phase) as NativeRevisionTerminalPhase;
  return {
    operationId: text(row.operation_id),
    projectId: text(row.project_id),
    ...(row.revision_id != null ? { revisionId: text(row.revision_id) } : {}),
    ...(row.source_hash != null ? { sourceHash: text(row.source_hash) } : {}),
    ...(row.bundle_hash != null ? { bundleHash: text(row.bundle_hash) } : {}),
    phase,
    receiptHash: text(row.receipt_hash),
    acceptedAt: text(row.updated_at),
  };
}

function mapSourceHeadRow(row: Record<string, unknown>): SourceHeadRecord {
  return {
    projectId: text(row.project_id),
    ...(row.accepted_revision_id != null
      ? { acceptedRevisionId: text(row.accepted_revision_id) }
      : {}),
    ...(row.accepted_source_hash != null
      ? { acceptedSourceHash: text(row.accepted_source_hash) }
      : {}),
    ...(row.materialized_revision_id != null
      ? { materializedRevisionId: text(row.materialized_revision_id) }
      : {}),
    ...(row.materialized_source_hash != null
      ? { materializedSourceHash: text(row.materialized_source_hash) }
      : {}),
    updatedAt: text(row.updated_at),
  };
}

function mapSourceMaterializationRow(row: Record<string, unknown>): SourceMaterializationRecord {
  return {
    projectId: text(row.project_id),
    revisionId: text(row.revision_id),
    phase: parseNativeRevisionPhase(row.phase),
    expectedViewSourceHash: text(row.expected_view_source_hash),
    targetSourceHash: text(row.target_source_hash),
    treeHash: text(row.tree_hash),
    attempt: Number(row.attempt),
    ...(row.diagnostic != null ? { diagnostic: text(row.diagnostic) } : {}),
    updatedAt: text(row.updated_at),
  };
}

function mapSourceMaterializationEntryRow(
  row: Record<string, unknown>,
): SourceMaterializationEntryRecord {
  return {
    projectId: text(row.project_id),
    revisionId: text(row.revision_id),
    logicalPath: text(row.logical_path),
    ...(row.old_hash != null ? { oldHash: text(row.old_hash) } : {}),
    ...(row.target_hash != null ? { targetHash: text(row.target_hash) } : {}),
    ...(row.applied_hash != null ? { appliedHash: text(row.applied_hash) } : {}),
    state: text(row.state) as SourceMaterializationEntryRecord['state'],
  };
}

function mapAuthoringWorkingDocumentRow(
  row: Record<string, unknown>,
): AuthoringWorkingDocumentRecord {
  return {
    projectId: text(row.project_id),
    documentId: text(row.document_id),
    logicalPath: text(row.logical_path),
    kind: text(row.kind),
    state: text(row.state) as AuthoringWorkingDocumentRecord['state'],
    ...(row.base_revision_id != null ? { baseRevisionId: text(row.base_revision_id) } : {}),
    catalogRevision: Number(row.catalog_revision),
    updatedAt: text(row.updated_at),
  };
}

function mapRevisionMirrorExportRow(row: Record<string, unknown>): RevisionMirrorExportRecord {
  return {
    projectId: text(row.project_id),
    revisionId: text(row.revision_id),
    backend: text(row.backend),
    state: text(row.state) as RevisionMirrorExportRecord['state'],
    ...(row.external_id != null ? { externalId: text(row.external_id) } : {}),
    ...(row.diagnostic != null ? { diagnostic: text(row.diagnostic) } : {}),
    updatedAt: text(row.updated_at),
  };
}

// ─── V5: project operation queue rows ───────────────────────────────────────

/**
 * Tolerate any status string a previous Host version may have stored:
 * canonical statuses pass through unchanged; unknown values read as
 * `interrupted` so a restart never fabricates an active (queued/running)
 * operation from an unrecognized one. The transition validator rejects
 * writes on such rows until the caller reconciles them.
 */
const parseProjectOperationStatus = (value: unknown): ProjectOperationStatusV1 =>
  PROJECT_OPERATION_STATUS_VALUES.find((status) => status === text(value)) ?? 'interrupted';

function mapProjectOperationRow(row: Record<string, unknown>): ProjectOperationRecordV1 {
  const storedVersion = Number(row.version);
  if (storedVersion !== 1) {
    throw new Error('Persistence returned an unknown project operation record version.');
  }
  return {
    version: 1,
    projectId: text(row.project_id),
    operationId: text(row.operation_id),
    idempotencyKey: text(row.idempotency_key),
    kind: text(row.kind) as ProjectOperationRecordV1['kind'],
    status: parseProjectOperationStatus(row.status),
    actorId: text(row.actor_id),
    capabilityVersion: Number(row.capability_version),
    sourceHash: row.source_hash != null ? text(row.source_hash) : null,
    acceptedRevisionId: row.accepted_revision_id != null ? text(row.accepted_revision_id) : null,
    progress: row.progress != null ? parseJson<ProjectOperationProgressV1>(row.progress) : null,
    resultRef: row.result_ref != null ? text(row.result_ref) : null,
    errorCode: row.error_code != null ? text(row.error_code) : null,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function operationInputError(
  code: 'INVALID_INPUT' | 'ILLEGAL_OPERATION_TRANSITION' | 'IDEMPOTENCY_CONFLICT',
  message: string,
): never {
  throw { code, message, retryable: false };
}

function requireOperationIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    operationInputError('INVALID_INPUT', `${field} must be a non-empty identifier.`);
  }
  return value;
}

function requireOperationOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    operationInputError(
      'INVALID_INPUT',
      `${field} must be null or a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function requireOperationProgress(value: unknown): ProjectOperationProgressV1 | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    operationInputError('INVALID_INPUT', 'progress must be null or { completed, total }.');
  }
  const progress = value as { completed?: unknown; total?: unknown };
  if (
    typeof progress.completed !== 'number' ||
    !Number.isInteger(progress.completed) ||
    progress.completed < 0 ||
    typeof progress.total !== 'number' ||
    !Number.isInteger(progress.total) ||
    progress.total < 1 ||
    progress.completed > progress.total
  ) {
    operationInputError(
      'INVALID_INPUT',
      'progress requires integer 0 <= completed <= total with total >= 1.',
    );
  }
  return { completed: progress.completed, total: progress.total };
}

/**
 * Canonical worker-side status automaton. A new row must be created
 * `queued`; `interrupted -> queued` is the explicit retry path a Host uses
 * after restart-recovery marks crashed work interrupted (the same
 * idempotency key must be able to re-enter the queue), and
 * `interrupted -> cancelled` lets an operator discard recovered work.
 * `queued -> cancelled|stale` allow the queue to drop work that is
 * cancelled or superseded before it ever starts. Every other transition is
 * rejected with `ILLEGAL_OPERATION_TRANSITION`.
 */
const PROJECT_OPERATION_TRANSITIONS: Readonly<
  Record<ProjectOperationStatusV1, readonly ProjectOperationStatusV1[]>
> = {
  queued: ['running', 'cancelled', 'stale', 'interrupted'],
  running: ['succeeded', 'failed', 'stale', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  stale: [],
  cancelled: [],
  interrupted: ['queued', 'cancelled'],
};

function requireProjectOperationRecord(value: unknown): ProjectOperationRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    operationInputError('INVALID_INPUT', 'project operation record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    operationInputError('INVALID_INPUT', 'project operation record version must be 1.');
  }
  const projectId = requireOperationIdentifier(record.projectId, 'projectId');
  const operationId = requireOperationIdentifier(record.operationId, 'operationId');
  const idempotencyKey = requireOperationIdentifier(record.idempotencyKey, 'idempotencyKey');
  if (
    typeof record.kind !== 'string' ||
    !(PROJECT_OPERATION_KIND_VALUES as readonly string[]).includes(record.kind)
  ) {
    operationInputError('INVALID_INPUT', 'kind must be a canonical project operation kind.');
  }
  if (
    typeof record.status !== 'string' ||
    !(PROJECT_OPERATION_STATUS_VALUES as readonly string[]).includes(record.status)
  ) {
    operationInputError('INVALID_INPUT', 'status must be a canonical project operation status.');
  }
  const actorId = requireOperationIdentifier(record.actorId, 'actorId');
  if (
    typeof record.capabilityVersion !== 'number' ||
    !Number.isInteger(record.capabilityVersion) ||
    record.capabilityVersion < 0
  ) {
    operationInputError('INVALID_INPUT', 'capabilityVersion must be a non-negative integer.');
  }
  const sourceHash = requireOperationOptionalString(record.sourceHash, 'sourceHash', 512);
  const acceptedRevisionId = requireOperationOptionalString(
    record.acceptedRevisionId,
    'acceptedRevisionId',
    512,
  );
  const progress = requireOperationProgress(record.progress);
  const resultRef = requireOperationOptionalString(record.resultRef, 'resultRef', 1024);
  const errorCode = requireOperationOptionalString(record.errorCode, 'errorCode', 256);
  const createdAt = requireOperationOptionalString(record.createdAt, 'createdAt', 64);
  const updatedAt = requireOperationOptionalString(record.updatedAt, 'updatedAt', 64);
  if (createdAt === null || updatedAt === null) {
    operationInputError('INVALID_INPUT', 'createdAt and updatedAt are required timestamps.');
  }
  return {
    version: 1,
    projectId,
    operationId,
    idempotencyKey,
    kind: record.kind as ProjectOperationRecordV1['kind'],
    status: record.status as ProjectOperationRecordV1['status'],
    actorId,
    capabilityVersion: record.capabilityVersion,
    sourceHash,
    acceptedRevisionId,
    progress,
    resultRef,
    errorCode,
    createdAt,
    updatedAt,
  };
}

/** Immutable identity fields that must match the stored row on every update. */
function assertOperationIdentityUnchanged(
  existing: Record<string, unknown>,
  record: ProjectOperationRecordV1,
): void {
  if (
    text(existing.project_id) !== record.projectId ||
    text(existing.operation_id) !== record.operationId ||
    text(existing.idempotency_key) !== record.idempotencyKey ||
    text(existing.kind) !== record.kind ||
    text(existing.actor_id) !== record.actorId ||
    Number(existing.capability_version) !== record.capabilityVersion ||
    (existing.source_hash ?? null) !== (record.sourceHash ?? null) ||
    text(existing.created_at) !== record.createdAt
  ) {
    operationInputError(
      'INVALID_INPUT',
      'Project operation identity fields (projectId, operationId, idempotencyKey, kind, actorId, capabilityVersion, sourceHash, createdAt) are immutable.',
    );
  }
}

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/** Parse the `"<updatedAt>|<operationId>"` list cursor into its parts. */
function parseOperationListCursor(value: string): {
  updatedAt: string;
  operationId: string;
} {
  const separator = value.lastIndexOf('|');
  if (separator <= 0 || separator === value.length - 1) {
    operationInputError(
      'INVALID_INPUT',
      'listProjectOperations cursor must be "<updatedAt>|<operationId>".',
    );
  }
  const updatedAt = value.slice(0, separator);
  const operationId = value.slice(separator + 1);
  if (updatedAt.length === 0 || operationId.length === 0 || operationId.length > 256) {
    operationInputError(
      'INVALID_INPUT',
      'listProjectOperations cursor must be "<updatedAt>|<operationId>".',
    );
  }
  return { updatedAt, operationId };
}

// ─── V6: publication repository helpers ────────────────────────────────────

/**
 * Tolerate any status string a previous Host version may have stored:
 * canonical statuses pass through unchanged; unknown values read as `stale`
 * so a restart never fabricates a `current` artifact from an unrecognized
 * one. The transition validator rejects writes on such rows until the caller
 * reconciles them.
 */
const parsePublicationStatus = (value: unknown): PublicationStatusV1 =>
  PUBLICATION_STATUS_VALUES.find((status) => status === text(value)) ?? 'stale';

function mapProjectPublicationRow(row: Record<string, unknown>): ProjectPublicationRecordV1 {
  return {
    version: 1,
    projectId: text(row.project_id),
    publicationId: text(row.publication_id),
    kind: text(row.kind) as ProjectPublicationRecordV1['kind'],
    value: {
      sourceHash: text(row.source_hash),
      scopeHash: text(row.scope_hash),
      revisionIds: parseJson<readonly string[]>(row.revision_ids),
      novelHash: text(row.novel_hash),
      relativeOutputPath: text(row.relative_output_path),
      byteLength: Number(row.byte_length),
      actorId: text(row.actor_id),
      operationId: text(row.operation_id),
      createdAt: text(row.created_at),
      status: parsePublicationStatus(row.status),
    },
    updatedAt: text(row.updated_at),
  };
}

function publicationInputError(
  code: 'INVALID_INPUT' | 'ILLEGAL_OPERATION_TRANSITION',
  message: string,
): never {
  throw { code, message, retryable: false };
}

function requirePublicationIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    publicationInputError('INVALID_INPUT', `${field} must be a non-empty identifier.`);
  }
  return value;
}

function requirePublicationKind(value: unknown): PublicationKindV1 {
  if (
    typeof value !== 'string' ||
    !(PUBLICATION_KIND_VALUES as readonly string[]).includes(value)
  ) {
    publicationInputError('INVALID_INPUT', 'kind must be "canonical" or "custom".');
  }
  return value as PublicationKindV1;
}

function requirePublicationStatus(value: unknown): PublicationStatusV1 {
  if (
    typeof value !== 'string' ||
    !(PUBLICATION_STATUS_VALUES as readonly string[]).includes(value)
  ) {
    publicationInputError('INVALID_INPUT', 'status must be "current" or "stale".');
  }
  return value as PublicationStatusV1;
}

function requirePublicationHash(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    publicationInputError(
      'INVALID_INPUT',
      `${field} must be a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function requirePublicationRevisionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 1024) {
    publicationInputError('INVALID_INPUT', 'revisionIds must be an array of at most 1024 ids.');
  }
  const revisionIds = value.map((id) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 512) {
      publicationInputError(
        'INVALID_INPUT',
        'revisionIds must contain non-empty strings of at most 512 characters.',
      );
    }
    return id;
  });
  return revisionIds;
}

/**
 * Structural check on the project-relative output path. The exact allowed
 * shapes (`output/novel.md` canonical, `output/<publicationId>.md` custom)
 * are enforced by the Node Host `FilePublicationWriter`; the repository
 * refuses anything that could escape the project root so a bad row can never
 * masquerade as a readable artifact.
 */
function requirePublicationRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    publicationInputError(
      'INVALID_INPUT',
      'relativeOutputPath must be a non-empty string of at most 512 characters.',
    );
  }
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    publicationInputError(
      'INVALID_INPUT',
      'relativeOutputPath must be a project-relative path without traversal.',
    );
  }
  return value;
}

function requirePublicationByteLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    publicationInputError('INVALID_INPUT', 'byteLength must be a non-negative integer.');
  }
  return value;
}

function requirePublicationTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    publicationInputError(
      'INVALID_INPUT',
      `${field} must be a non-empty string of at most 64 characters.`,
    );
  }
  return value;
}

/**
 * Canonical worker-side status automaton. `current` and `stale` may flip in
 * either direction: demotion marks a superseded artifact, re-activation is
 * the idempotent re-publication of the same row after it was demoted. The
 * real write guard is the `expectedStatus` CAS on the update path; this
 * automaton only rejects statuses outside the canonical set.
 */
const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationStatusV1, readonly PublicationStatusV1[]>
> = {
  current: ['current', 'stale'],
  stale: ['stale', 'current'],
};

function requireProjectPublicationRecord(value: unknown): ProjectPublicationRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    publicationInputError('INVALID_INPUT', 'project publication record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    publicationInputError('INVALID_INPUT', 'project publication record version must be 1.');
  }
  const projectId = requirePublicationIdentifier(record.projectId, 'projectId');
  const publicationId = requirePublicationIdentifier(record.publicationId, 'publicationId');
  const kind = requirePublicationKind(record.kind);
  if (kind === 'canonical' && publicationId !== CANONICAL_PUBLICATION_ID) {
    publicationInputError(
      'INVALID_INPUT',
      'canonical publications must use publicationId "canonical".',
    );
  }
  if (kind === 'custom') {
    if (publicationId === CANONICAL_PUBLICATION_ID) {
      publicationInputError(
        'INVALID_INPUT',
        'custom publications cannot use publicationId "canonical".',
      );
    }
    if (!/^[0-9a-f]{1,128}$/i.test(publicationId)) {
      publicationInputError(
        'INVALID_INPUT',
        'custom publicationId must be a non-empty hex string.',
      );
    }
  }
  if (record.value === null || typeof record.value !== 'object' || Array.isArray(record.value)) {
    publicationInputError('INVALID_INPUT', 'publication value must be an object.');
  }
  const valueRecord = record.value as Record<string, unknown>;
  const sourceHash = requirePublicationHash(valueRecord.sourceHash, 'sourceHash', 512);
  const scopeHash = requirePublicationHash(valueRecord.scopeHash, 'scopeHash', 512);
  const revisionIds = requirePublicationRevisionIds(valueRecord.revisionIds);
  const novelHash = requirePublicationHash(valueRecord.novelHash, 'novelHash', 128);
  const relativeOutputPath = requirePublicationRelativePath(valueRecord.relativeOutputPath);
  const byteLength = requirePublicationByteLength(valueRecord.byteLength);
  const actorId = requirePublicationIdentifier(valueRecord.actorId, 'actorId');
  const operationId = requirePublicationIdentifier(valueRecord.operationId, 'operationId');
  const createdAt = requirePublicationTimestamp(valueRecord.createdAt, 'createdAt');
  const status = requirePublicationStatus(valueRecord.status);
  const updatedAt = requirePublicationTimestamp(record.updatedAt, 'updatedAt');
  return {
    version: 1,
    projectId,
    publicationId,
    kind,
    value: {
      sourceHash,
      scopeHash,
      revisionIds,
      novelHash,
      relativeOutputPath,
      byteLength,
      actorId,
      operationId,
      createdAt,
      status,
    },
    updatedAt,
  };
}

/** Immutable identity fields that must match the stored row on every update. */
function assertPublicationIdentityUnchanged(
  existing: Record<string, unknown>,
  record: ProjectPublicationRecordV1,
): void {
  if (
    text(existing.project_id) !== record.projectId ||
    text(existing.publication_id) !== record.publicationId ||
    text(existing.kind) !== record.kind
  ) {
    publicationInputError(
      'INVALID_INPUT',
      'Publication identity fields (projectId, publicationId, kind) are immutable.',
    );
  }
}

/** Parse the `"<updatedAt>|<publicationId>"` list cursor into its parts. */
function parsePublicationListCursor(value: string): {
  updatedAt: string;
  publicationId: string;
} {
  const separator = value.lastIndexOf('|');
  if (separator <= 0 || separator === value.length - 1) {
    publicationInputError(
      'INVALID_INPUT',
      'listProjectPublications cursor must be "<updatedAt>|<publicationId>".',
    );
  }
  const updatedAt = value.slice(0, separator);
  const publicationId = value.slice(separator + 1);
  if (updatedAt.length === 0 || publicationId.length === 0 || publicationId.length > 256) {
    publicationInputError(
      'INVALID_INPUT',
      'listProjectPublications cursor must be "<updatedAt>|<publicationId>".',
    );
  }
  return { updatedAt, publicationId };
}

// ─── V7: durable agent record helpers ─────────────────────────────────────

/**
 * Tolerate any status string a previous Host version may have stored:
 * canonical statuses pass through unchanged; unknown values read as
 * `interrupted` so a restart never fabricates an active (queued/running) run
 * from an unrecognized one. The transition validator rejects writes on such
 * rows until the caller reconciles them.
 */
const parseAgentRunStatus = (value: unknown): AgentRunStatusV1 =>
  AGENT_RUN_STATUS_VALUES.find((status) => status === text(value)) ?? 'interrupted';

function mapAgentConversationRow(row: Record<string, unknown>): AgentConversationRecordV1 {
  return {
    version: 1,
    conversationId: text(row.conversation_id),
    projectId: text(row.project_id),
    principalUserId: text(row.principal_user_id),
    role: text(row.role) as AgentConversationRecordV1['role'],
    title: row.title != null ? text(row.title) : null,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapAgentRunRow(row: Record<string, unknown>): AgentRunRecordV1 {
  return {
    version: 1,
    runId: text(row.run_id),
    conversationId: text(row.conversation_id),
    projectId: text(row.project_id),
    operationId: row.operation_id != null ? text(row.operation_id) : null,
    principalUserId: text(row.principal_user_id),
    role: text(row.role) as AgentRunRecordV1['role'],
    status: parseAgentRunStatus(row.status),
    turn: Number(row.turn),
    maxTurns: Number(row.max_turns),
    toolCalls: Number(row.tool_calls),
    maxToolCalls: Number(row.max_tool_calls),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapAgentToolCallRow(row: Record<string, unknown>): AgentToolCallRecordV1 {
  return {
    version: 1,
    runId: text(row.run_id),
    callIndex: Number(row.call_index),
    toolName: text(row.tool_name),
    sanitizedArgsHash: text(row.sanitized_args_hash),
    resultRef: row.result_ref != null ? text(row.result_ref) : null,
    turn: Number(row.turn),
    status: text(row.status) as AgentToolCallRecordV1['status'],
    createdAt: text(row.created_at),
  };
}

function agentInputError(
  code:
    | 'INVALID_INPUT'
    | 'CONVERSATION_EXISTS'
    | 'CONVERSATION_NOT_FOUND'
    | 'RUN_EXISTS'
    | 'RUN_NOT_FOUND'
    | 'TOOL_CALL_NOT_FOUND'
    | 'ILLEGAL_RUN_TRANSITION'
    | 'ILLEGAL_TOOL_CALL_TRANSITION'
    | 'TOOL_CALL_APPEND_VIOLATION'
    | 'MESSAGE_EXISTS',
  message: string,
): never {
  throw { code, message, retryable: false };
}

function requireAgentIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    agentInputError('INVALID_INPUT', `${field} must be a non-empty identifier.`);
  }
  return value;
}

function requireAgentOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    agentInputError(
      'INVALID_INPUT',
      `${field} must be null or a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function requireAgentTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    agentInputError(
      'INVALID_INPUT',
      `${field} must be a non-empty string of at most 64 characters.`,
    );
  }
  return value;
}

function requireAgentRole(value: unknown): AgentRunRecordV1['role'] {
  if (typeof value !== 'string' || !(PROJECT_ACCESS_ROLES as readonly string[]).includes(value)) {
    agentInputError('INVALID_INPUT', 'role must be a canonical project access role.');
  }
  return value as AgentRunRecordV1['role'];
}

function requireAgentRunStatus(value: unknown): AgentRunStatusV1 {
  if (
    typeof value !== 'string' ||
    !(AGENT_RUN_STATUS_VALUES as readonly string[]).includes(value)
  ) {
    agentInputError('INVALID_INPUT', 'status must be a canonical agent run status.');
  }
  return value as AgentRunStatusV1;
}

function requireAgentToolCallStatus(value: unknown): AgentToolCallStatusV1 {
  if (
    typeof value !== 'string' ||
    !(AGENT_TOOL_CALL_STATUS_VALUES as readonly string[]).includes(value)
  ) {
    agentInputError('INVALID_INPUT', 'status must be "pending", "succeeded" or "failed".');
  }
  return value as AgentToolCallStatusV1;
}

function requireAgentCounter(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    agentInputError('INVALID_INPUT', `${field} must be an integer between 0 and ${max}.`);
  }
  return value;
}

function requireAgentBound(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    agentInputError('INVALID_INPUT', `${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function requireAgentHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{1,128}$/i.test(value)) {
    agentInputError(
      'INVALID_INPUT',
      `${field} must be a non-empty hex string of at most 128 characters.`,
    );
  }
  return value;
}

function requireAgentCallIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    agentInputError('INVALID_INPUT', 'callIndex must be an integer between 0 and 1000000.');
  }
  return value;
}

function requireAgentConversationRecord(value: unknown): AgentConversationRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    agentInputError('INVALID_INPUT', 'agent conversation record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    agentInputError('INVALID_INPUT', 'agent conversation record version must be 1.');
  }
  const conversationId = requireAgentIdentifier(record.conversationId, 'conversationId');
  const projectId = requireAgentIdentifier(record.projectId, 'projectId');
  const principalUserId = requireAgentIdentifier(record.principalUserId, 'principalUserId');
  const role = requireAgentRole(record.role);
  const title = requireAgentOptionalString(record.title, 'title', 512);
  const createdAt = requireAgentTimestamp(record.createdAt, 'createdAt');
  const updatedAt = requireAgentTimestamp(record.updatedAt, 'updatedAt');
  return {
    version: 1,
    conversationId,
    projectId,
    principalUserId,
    role,
    title,
    createdAt,
    updatedAt,
  };
}

function requireAgentRunRecord(value: unknown): AgentRunRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    agentInputError('INVALID_INPUT', 'agent run record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    agentInputError('INVALID_INPUT', 'agent run record version must be 1.');
  }
  const runId = requireAgentIdentifier(record.runId, 'runId');
  const conversationId = requireAgentIdentifier(record.conversationId, 'conversationId');
  const projectId = requireAgentIdentifier(record.projectId, 'projectId');
  const operationId = requireAgentOptionalString(record.operationId, 'operationId', 256);
  const principalUserId = requireAgentIdentifier(record.principalUserId, 'principalUserId');
  const role = requireAgentRole(record.role);
  const status = requireAgentRunStatus(record.status);
  if (status !== 'queued') {
    agentInputError('INVALID_INPUT', 'agent runs must be created with status "queued".');
  }
  const maxTurns = requireAgentBound(record.maxTurns, 'maxTurns', 1, 1000);
  const maxToolCalls = requireAgentBound(record.maxToolCalls, 'maxToolCalls', 1, 100000);
  const turn = requireAgentCounter(record.turn, 'turn', maxTurns);
  const toolCalls = requireAgentCounter(record.toolCalls, 'toolCalls', maxToolCalls);
  if (turn !== 0 || toolCalls !== 0) {
    agentInputError(
      'INVALID_INPUT',
      'agent runs must be created with turn and toolCalls counters at 0.',
    );
  }
  const createdAt = requireAgentTimestamp(record.createdAt, 'createdAt');
  const updatedAt = requireAgentTimestamp(record.updatedAt, 'updatedAt');
  return {
    version: 1,
    runId,
    conversationId,
    projectId,
    operationId,
    principalUserId,
    role,
    status,
    turn,
    maxTurns,
    toolCalls,
    maxToolCalls,
    createdAt,
    updatedAt,
  };
}

function requireAgentToolCallRecord(value: unknown): AgentToolCallRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    agentInputError('INVALID_INPUT', 'agent tool call record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    agentInputError('INVALID_INPUT', 'agent tool call record version must be 1.');
  }
  const runId = requireAgentIdentifier(record.runId, 'runId');
  const callIndex = requireAgentCallIndex(record.callIndex);
  const toolName = requireAgentIdentifier(record.toolName, 'toolName');
  const sanitizedArgsHash = requireAgentHash(record.sanitizedArgsHash, 'sanitizedArgsHash');
  const resultRef = requireAgentOptionalString(record.resultRef, 'resultRef', 1024);
  const turn = requireAgentCounter(record.turn, 'turn', 1000);
  const status = requireAgentToolCallStatus(record.status);
  const createdAt = requireAgentTimestamp(record.createdAt, 'createdAt');
  return {
    version: 1,
    runId,
    callIndex,
    toolName,
    sanitizedArgsHash,
    resultRef,
    turn,
    status,
    createdAt,
  };
}

function mapAgentMessageRow(row: Record<string, unknown>): AgentConversationMessageRecordV1 {
  return {
    version: 1,
    messageId: text(row.message_id),
    conversationId: text(row.conversation_id),
    runId: text(row.run_id),
    role: text(row.role) as AgentConversationMessageRecordV1['role'],
    content: text(row.content),
    toolName: row.tool_name != null ? text(row.tool_name) : null,
    callIndex: row.call_index != null ? Number(row.call_index) : null,
    createdAt: text(row.created_at),
  };
}

function requireAgentMessageRole(value: unknown): AgentConversationMessageRecordV1['role'] {
  if (
    typeof value !== 'string' ||
    !(AGENT_MESSAGE_ROLE_VALUES as readonly string[]).includes(value)
  ) {
    agentInputError('INVALID_INPUT', 'role must be "user", "assistant" or "tool_result".');
  }
  return value as AgentConversationMessageRecordV1['role'];
}

function requireAgentMessageContent(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100_000) {
    agentInputError('INVALID_INPUT', 'content must be a string of at most 100000 characters.');
  }
  return value;
}

function requireAgentOptionalCallIndex(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    agentInputError('INVALID_INPUT', 'callIndex must be null or an integer between 0 and 1000000.');
  }
  return value;
}

function requireAgentMessageRecord(value: unknown): AgentConversationMessageRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    agentInputError('INVALID_INPUT', 'agent message record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    agentInputError('INVALID_INPUT', 'agent message record version must be 1.');
  }
  const messageId = requireAgentIdentifier(record.messageId, 'messageId');
  const conversationId = requireAgentIdentifier(record.conversationId, 'conversationId');
  const runId = requireAgentIdentifier(record.runId, 'runId');
  const role = requireAgentMessageRole(record.role);
  const content = requireAgentMessageContent(record.content);
  const toolName = requireAgentOptionalString(record.toolName, 'toolName', 512);
  const callIndex = requireAgentOptionalCallIndex(record.callIndex);
  const createdAt = requireAgentTimestamp(record.createdAt, 'createdAt');
  return {
    version: 1,
    messageId,
    conversationId,
    runId,
    role,
    content,
    toolName,
    callIndex,
    createdAt,
  };
}

/**
 * Canonical worker-side run automaton (mirrors the operation queue without
 * `stale`): a run is created `queued`; `interrupted -> queued` is the explicit
 * retry path a Host uses after the restart sweep, and `interrupted -> cancelled`
 * lets an operator discard recovered work. Every other transition is rejected
 * with `ILLEGAL_RUN_TRANSITION`.
 */
const AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunStatusV1, readonly AgentRunStatusV1[]>> = {
  queued: ['running', 'cancelled', 'interrupted'],
  running: ['succeeded', 'failed', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: ['queued', 'cancelled'],
};

/**
 * Monotonic, bounded counter application shared by the transition and
 * checkpoint paths. Counters never decrease and never exceed their stored
 * bounds.
 */
function applyAgentRunCounters(
  existing: Record<string, unknown>,
  turn: number | undefined,
  toolCalls: number | undefined,
): { turn: number; toolCalls: number } {
  const base = mapAgentRunRow(existing);
  const nextTurn = turn ?? base.turn;
  const nextToolCalls = toolCalls ?? base.toolCalls;
  if (nextTurn < base.turn) {
    agentInputError('INVALID_INPUT', 'turn counters must not decrease.');
  }
  if (nextToolCalls < base.toolCalls) {
    agentInputError('INVALID_INPUT', 'toolCalls counters must not decrease.');
  }
  if (nextTurn > base.maxTurns) {
    agentInputError('INVALID_INPUT', `turn (${nextTurn}) exceeds maxTurns (${base.maxTurns}).`);
  }
  if (nextToolCalls > base.maxToolCalls) {
    agentInputError(
      'INVALID_INPUT',
      `toolCalls (${nextToolCalls}) exceeds maxToolCalls (${base.maxToolCalls}).`,
    );
  }
  return { turn: nextTurn, toolCalls: nextToolCalls };
}

/** Parse the `"<updatedAt>|<id>"` list cursor into its parts. */
function parseAgentListCursor(value: string): { updatedAt: string; id: string } {
  const separator = value.lastIndexOf('|');
  if (separator <= 0 || separator === value.length - 1) {
    agentInputError('INVALID_INPUT', 'agent list cursor must be "<updatedAt>|<id>".');
  }
  const updatedAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (updatedAt.length === 0 || id.length === 0 || id.length > 256) {
    agentInputError('INVALID_INPUT', 'agent list cursor must be "<updatedAt>|<id>".');
  }
  return { updatedAt, id };
}

/**
 * Exact per-operation payload field allowlist. The typed client makes unknown
 * fields impossible at compile time; this runtime check fails closed for
 * malformed wire input (a buggy or hostile caller) instead of silently
 * ignoring extra fields. `Record<PersistenceOperation, ...>` keeps the map
 * exhaustive: adding an operation without listing its fields is a compile
 * error.
 */
const KNOWN_PAYLOAD_FIELDS: Record<PersistenceOperation, readonly string[]> = {
  persistYjsUpdate: ['projectId', 'documentId', 'update', 'stateVector'],
  loadWorkingDocument: ['projectId', 'documentId'],
  getAuthState: [],
  bootstrapOwner: ['userId', 'displayName', 'passwordHash', 'capabilityVersion', 'createdAt'],
  acceptInviteUser: [
    'inviteId',
    'consumedAt',
    'userId',
    'displayName',
    'passwordHash',
    'capabilityVersion',
    'createdAt',
    'session',
  ],
  loadUser: ['userId'],
  loadOwner: [],
  resetOwnerPassword: ['userId', 'passwordHash', 'capabilityVersion', 'at'],
  recordAuthFailure: ['subject', 'at'],
  loadAuthBackoff: ['subject'],
  clearAuthBackoff: ['subject'],
  createSession: ['sessionId', 'userId', 'expiresAt', 'capabilityVersion'],
  loadSession: ['sessionId'],
  revokeSession: ['sessionId', 'reason'],
  createInvite: ['inviteId', 'projectId', 'role', 'expiresAt', 'consumedAt'],
  consumeInvite: ['inviteId', 'consumedAt'],
  listInvites: ['projectId'],
  revokeInvite: ['inviteId'],
  loadConfigurationOperation: ['operationId'],
  loadAudit: ['auditId'],
  loadProjectMembership: ['userId', 'projectId'],
  listProjectMemberships: ['projectId'],
  upsertProjectMembership: ['userId', 'projectId', 'role', 'at'],
  revokeProjectMembership: ['userId', 'projectId', 'at'],
  upsertCapability: [
    'capabilityId',
    'userId',
    'projectId',
    'scope',
    'version',
    'expiresAt',
    'revokedAt',
  ],
  loadCapability: ['capabilityId'],
  revokeCapability: ['capabilityId', 'reason'],
  listProjects: [],
  getProject: ['projectId'],
  upsertProject: ['projectId', 'displayName', 'rootLabel', 'createdAt', 'updatedAt'],
  removeProject: ['projectId'],
  checkpointOperation: ['operationId', 'checkpoint', 'version', 'updatedAt'],
  loadOperationCheckpoint: ['operationId'],
  beginGitSubmission: [
    'submitId',
    'projectId',
    'phase',
    'expectedGitHead',
    'candidateCommit',
    'receiptHash',
    'diagnostic',
    'updatedAt',
  ],
  checkpointGitSubmission: [
    'submitId',
    'projectId',
    'phase',
    'expectedGitHead',
    'candidateCommit',
    'receiptHash',
    'diagnostic',
    'updatedAt',
  ],
  completeGitSubmission: [
    'submitId',
    'projectId',
    'commit',
    'sourceHash',
    'receiptHash',
    'acceptedAt',
  ],
  loadGitSubmission: ['submitId'],
  loadUiPreferences: ['userId'],
  saveUiPreferences: ['userId', 'values', 'updatedAt'],
  createConfigurationOperation: [
    'operationId',
    'origin',
    'status',
    'activeRevision',
    'candidateRevision',
    'changedFields',
    'diagnostics',
    'actorId',
    'at',
  ],
  listConfigurationOperations: ['limit'],
  saveAuthoringState: [
    'projectId',
    'phase',
    'acceptedSourceHash',
    'observedFilesystemHash',
    'workspaceDigest',
    'candidateHash',
    'candidateValid',
    'conflicts',
    'fixedGitHead',
    'pendingSubmitId',
    'recoveryPhase',
    'updatedAt',
  ],
  loadAuthoringState: ['projectId'],
  appendAudit: [
    'auditId',
    'at',
    'actorId',
    'surface',
    'operationKind',
    'outcome',
    'projectId',
    'documentScope',
    'capabilityVersion',
    'baseSourceHash',
    'resultSourceHash',
    'workspaceDigest',
    'submitId',
    'gitReceiptHash',
    'detail',
  ],
  listAudit: ['limit', 'surface', 'projectId'],
  createDeviceVerifier: [
    'store',
    'deviceId',
    'tokenHash',
    'scope',
    'expiresAt',
    'clientLabel',
    'revokedAt',
    'createdAt',
    'kind',
    'projectId',
    'role',
    'ownerUserId',
    'scopes',
    'grantRevision',
  ],
  loadDeviceVerifierByTokenHash: ['tokenHash', 'store'],
  listDeviceVerifiers: ['store'],
  revokeDeviceVerifier: ['deviceId', 'revokedAt', 'store'],
  listSessions: ['userId'],
  // ─── V3: native revision operation fields ─────────────────────────────────
  createSourceRevision: [
    'revisionId',
    'projectId',
    'parentRevisionId',
    'operationId',
    'sourceHash',
    'bundleHash',
    'actorId',
    'origin',
    'createdAt',
    'acceptedAt',
  ],
  getSourceRevision: ['revisionId'],
  listSourceRevisions: ['projectId', 'cursor', 'limit'],
  createSourceRevisionOperation: [
    'operationId',
    'projectId',
    'expectedRevisionId',
    'expectedSourceHash',
    'revisionId',
    'phase',
    'receiptHash',
    'diagnostic',
    'createdAt',
    'updatedAt',
  ],
  checkpointSourceRevisionOperation: [
    'operationId',
    'projectId',
    'expectedRevisionId',
    'expectedSourceHash',
    'revisionId',
    'phase',
    'receiptHash',
    'diagnostic',
    'createdAt',
    'updatedAt',
  ],
  replaySourceRevisionReceipt: ['operationId'],
  loadSourceRevisionOperation: ['operationId'],
  getSourceHead: ['projectId'],
  casSourceHead: [
    'projectId',
    'expectedAcceptedRevisionId',
    'expectedAcceptedSourceHash',
    'acceptedRevisionId',
    'acceptedSourceHash',
    'updatedAt',
  ],
  createSourceMaterialization: [
    'projectId',
    'revisionId',
    'phase',
    'expectedViewSourceHash',
    'targetSourceHash',
    'treeHash',
    'attempt',
    'diagnostic',
    'updatedAt',
  ],
  checkpointSourceMaterialization: [
    'projectId',
    'revisionId',
    'phase',
    'expectedViewSourceHash',
    'targetSourceHash',
    'treeHash',
    'attempt',
    'diagnostic',
    'updatedAt',
  ],
  loadSourceMaterialization: ['projectId', 'revisionId'],
  loadSourceMaterializationEntries: ['projectId', 'revisionId'],
  upsertAuthoringWorkingDocument: [
    'projectId',
    'documentId',
    'logicalPath',
    'kind',
    'state',
    'baseRevisionId',
    'catalogRevision',
    'updatedAt',
  ],
  loadAuthoringWorkingDocument: ['projectId', 'documentId'],
  listAuthoringWorkingDocuments: ['projectId'],
  deleteAuthoringWorkingDocument: ['projectId', 'documentId'],
  createRevisionMirrorExport: [
    'projectId',
    'revisionId',
    'backend',
    'state',
    'externalId',
    'diagnostic',
    'updatedAt',
  ],
  checkpointRevisionMirrorExport: [
    'projectId',
    'revisionId',
    'backend',
    'state',
    'externalId',
    'diagnostic',
    'updatedAt',
  ],
  loadRevisionMirrorExport: ['projectId', 'revisionId', 'backend'],
  // ─── V5: durable project operation queue fields ──────────────────────────
  upsertProjectOperation: ['record', 'expectedStatus'],
  getProjectOperation: ['projectId', 'operationId'],
  listProjectOperations: ['projectId', 'status', 'limit', 'before'],
  getProjectOperationByIdempotencyKey: ['projectId', 'kind', 'idempotencyKey'],
  markProjectOperationsInterrupted: ['projectId', 'at'],
  countProjectOperations: ['projectId', 'status'],
  // ─── V6: durable publication repository fields ──────────────────────────
  upsertProjectPublication: ['record', 'expectedStatus'],
  getProjectPublication: ['projectId', 'publicationId'],
  listProjectPublications: ['projectId', 'limit', 'before'],
  // ─── V7: durable agent record fields ────────────────────────────────────
  // Conversation/run/tool-call records are sent as the payload itself (the
  // createDeviceVerifier precedent), so the allowlist is the record shape.
  createAgentConversation: [
    'version',
    'conversationId',
    'projectId',
    'principalUserId',
    'role',
    'title',
    'createdAt',
    'updatedAt',
  ],
  appendAgentConversation: ['conversationId', 'at', 'title'],
  getAgentConversation: ['conversationId'],
  listAgentConversations: ['projectId', 'principalUserId', 'limit', 'before'],
  createAgentRun: [
    'version',
    'runId',
    'conversationId',
    'projectId',
    'operationId',
    'principalUserId',
    'role',
    'status',
    'turn',
    'maxTurns',
    'toolCalls',
    'maxToolCalls',
    'createdAt',
    'updatedAt',
  ],
  transitionAgentRun: ['runId', 'status', 'expectedStatus', 'turn', 'toolCalls', 'at'],
  checkpointAgentRun: ['runId', 'turn', 'toolCalls', 'at'],
  markAgentRunsInterrupted: ['projectId', 'at'],
  getAgentRun: ['runId'],
  listAgentRuns: ['conversationId', 'projectId', 'status', 'limit', 'before'],
  appendAgentToolCall: [
    'version',
    'runId',
    'callIndex',
    'toolName',
    'sanitizedArgsHash',
    'resultRef',
    'turn',
    'status',
    'createdAt',
  ],
  updateAgentToolCallStatus: ['runId', 'callIndex', 'status', 'resultRef', 'at'],
  listAgentToolCalls: ['runId', 'after', 'limit'],
  appendAgentMessage: [
    'version',
    'messageId',
    'conversationId',
    'runId',
    'role',
    'content',
    'toolName',
    'callIndex',
    'createdAt',
  ],
  listAgentMessages: ['conversationId', 'limit'],
};

/** Fail closed on payload fields the operation does not declare. */
function rejectUnknownPayloadFields(
  operation: string,
  payload: unknown,
  known: readonly string[],
): void {
  const unknownFieldError = (field?: string): never => {
    throw {
      code: 'UNKNOWN_FIELD',
      message:
        field === undefined
          ? `Persistence operation ${operation} does not accept a payload`
          : `Unknown field "${field}" for persistence operation ${operation}`,
      retryable: false,
    };
  };
  if (payload == null) {
    if (known.length > 0 && !(known.length === 1 && known[0] === 'store')) {
      unknownFieldError();
    }
    return;
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) unknownFieldError();
  for (const key of Object.keys(payload)) {
    if (!known.includes(key)) unknownFieldError(key);
  }
}
function requireVerifierStore(operation: string, payload: unknown): 'mcp' | 'capability' {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw {
      code: 'INVALID_INPUT',
      message: `Persistence operation ${operation} requires an explicit verifier store`,
      retryable: false,
    };
  }
  const store = 'store' in payload ? payload.store : undefined;
  if (store !== 'mcp' && store !== 'capability') {
    throw {
      code: 'INVALID_INPUT',
      message: `Persistence operation ${operation} requires an explicit verifier store`,
      retryable: false,
    };
  }
  return store;
}

function start(port: MessagePort, options: WorkerOptions): WorkerDisposer {
  const db = createWorkerDatabase(options.databasePath);
  migrate(db);
  let _queued = 0;
  let dbClosed = false;
  let closePromise: Promise<void> | undefined;
  const closeDatabase = async (): Promise<void> => {
    if (dbClosed) return;
    dbClosed = true;
    await db.close();
  };
  let queue = Promise.resolve();
  const respond = (_request: PersistenceRequest, response: PersistenceResponse): void =>
    port.postMessage(response);
  const execute = (request: PersistenceRequest): unknown => {
    const known = KNOWN_PAYLOAD_FIELDS[request.operation];
    if (known === undefined) {
      throw {
        code: 'UNKNOWN_OPERATION',
        message: `Unknown persistence operation: ${String(request.operation)}`,
        retryable: false,
      };
    }
    rejectUnknownPayloadFields(request.operation, request.payload, known);
    const p = request.payload as never;
    switch (request.operation) {
      case 'persistYjsUpdate': {
        const x = p as PersistencePayloads['persistYjsUpdate'];
        db.prepare(
          'INSERT INTO yjs_documents(project_id,document_id,state_vector,document_update,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,document_id) DO UPDATE SET state_vector=excluded.state_vector, document_update=excluded.document_update, updated_at=excluded.updated_at',
        ).run(
          x.projectId,
          x.documentId,
          asBlob(x.stateVector ?? new Uint8Array()),
          asBlob(x.update),
          new Date().toISOString(),
        );
        return {
          key: { projectId: x.projectId, documentId: x.documentId },
          stateVector: x.stateVector ?? new Uint8Array(),
          update: x.update,
          updatedAt: new Date().toISOString(),
        };
      }
      case 'loadWorkingDocument': {
        const x = p as PersistencePayloads['loadWorkingDocument'];
        const row = db
          .prepare('SELECT * FROM yjs_documents WHERE project_id=? AND document_id=?')
          .get(x.projectId, x.documentId) as Record<string, unknown> | undefined;
        return row
          ? {
              key: x,
              stateVector: new Uint8Array(row.state_vector as Uint8Array),
              update: new Uint8Array(row.document_update as Uint8Array),
              updatedAt: text(row.updated_at),
            }
          : null;
      }
      case 'getAuthState': {
        const row = db.prepare("SELECT user_id FROM users WHERE role='owner' LIMIT 1").get() as
          | Record<string, unknown>
          | undefined;
        return { ownerUserId: row && row.user_id != null ? text(row.user_id) : null };
      }
      case 'bootstrapOwner': {
        const x = p as PersistencePayloads['bootstrapOwner'];
        const existing = db.prepare("SELECT user_id FROM users WHERE role='owner' LIMIT 1").get() as
          | Record<string, unknown>
          | undefined;
        if (existing)
          throw {
            code: 'OWNER_EXISTS',
            message: 'An owner account already exists',
            retryable: false,
          };
        db.prepare(
          'INSERT INTO users(user_id,role,display_name,password_hash,capability_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          x.userId,
          'owner',
          x.displayName,
          json(x.passwordHash),
          x.capabilityVersion,
          x.createdAt,
          x.createdAt,
        );
        return mapUserRow(
          db.prepare('SELECT * FROM users WHERE user_id=?').get(x.userId) as Record<
            string,
            unknown
          >,
        );
      }
      case 'acceptInviteUser': {
        const x = p as PersistencePayloads['acceptInviteUser'];
        db.exec('BEGIN IMMEDIATE');
        try {
          const inviteRow = db.prepare('SELECT * FROM invites WHERE invite_id=?').get(x.inviteId) as
            | Record<string, unknown>
            | undefined;
          if (!inviteRow) {
            db.exec('COMMIT');
            return { status: 'not-found' };
          }
          if (inviteRow.consumed_at != null) {
            db.exec('COMMIT');
            return { status: 'already-consumed' };
          }
          if (text(inviteRow.expires_at) < x.consumedAt) {
            db.exec('COMMIT');
            return { status: 'expired' };
          }
          const projectId = inviteRow.project_id;
          const role = inviteRow.role;
          if (
            x.session.userId !== x.userId ||
            typeof projectId !== 'string' ||
            projectId.length === 0 ||
            typeof role !== 'string' ||
            !(PROJECT_ACCESS_ROLES as readonly string[]).includes(role)
          ) {
            db.exec('COMMIT');
            return { status: 'not-found' };
          }
          db.prepare(
            'UPDATE invites SET consumed_at=? WHERE invite_id=? AND consumed_at IS NULL',
          ).run(x.consumedAt, x.inviteId);
          db.prepare(
            'INSERT INTO users(user_id,role,display_name,password_hash,capability_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          ).run(
            x.userId,
            'user',
            x.displayName,
            json(x.passwordHash),
            x.capabilityVersion,
            x.createdAt,
            x.createdAt,
          );
          db.prepare(
            'INSERT INTO project_memberships(user_id,project_id,role,created_at,revoked_at,revision) VALUES(?,?,?,?,?,?)',
          ).run(x.userId, projectId, role, x.createdAt, null, 1);
          db.prepare(
            'INSERT INTO sessions(session_id,user_id,expires_at,capability_version) VALUES(?,?,?,?)',
          ).run(
            x.session.sessionId,
            x.session.userId,
            x.session.expiresAt,
            x.session.capabilityVersion,
          );
          const user = mapUserRow(
            db.prepare('SELECT * FROM users WHERE user_id=?').get(x.userId) as Record<
              string,
              unknown
            >,
          );
          const consumedInvite = mapInviteRow(
            db.prepare('SELECT * FROM invites WHERE invite_id=?').get(x.inviteId) as Record<
              string,
              unknown
            >,
          );
          db.exec('COMMIT');
          return { status: 'accepted', invite: consumedInvite, user, session: x.session };
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      case 'loadUser': {
        const x = p as PersistencePayloads['loadUser'];
        const row = db.prepare('SELECT * FROM users WHERE user_id=?').get(x.userId) as
          | Record<string, unknown>
          | undefined;
        return row ? mapUserRow(row) : null;
      }
      case 'loadOwner': {
        const row = db.prepare("SELECT * FROM users WHERE role='owner' LIMIT 1").get() as
          | Record<string, unknown>
          | undefined;
        return row ? mapUserRow(row) : null;
      }
      case 'resetOwnerPassword': {
        const x = p as PersistencePayloads['resetOwnerPassword'];
        const existing = db.prepare('SELECT user_id FROM users WHERE user_id=?').get(x.userId) as
          | Record<string, unknown>
          | undefined;
        if (!existing) throw { code: 'NOT_FOUND', message: 'User not found', retryable: false };
        db.exec('BEGIN IMMEDIATE');
        let revokedSessions = 0;
        let revokedCapabilities = 0;
        try {
          db.prepare(
            'UPDATE users SET password_hash=?, capability_version=?, updated_at=? WHERE user_id=?',
          ).run(json(x.passwordHash), x.capabilityVersion, x.at, x.userId);
          revokedSessions = Number(
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(x.userId).changes,
          );
          revokedCapabilities = Number(
            db
              .prepare(
                'UPDATE capabilities SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
              )
              .run(x.at, x.userId).changes,
          );
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        const row = db.prepare('SELECT * FROM users WHERE user_id=?').get(x.userId) as Record<
          string,
          unknown
        >;
        return { user: mapUserRow(row), revokedSessions, revokedCapabilities };
      }
      case 'recordAuthFailure': {
        const x = p as PersistencePayloads['recordAuthFailure'];
        const existing = db
          .prepare('SELECT failures FROM auth_backoff WHERE subject=?')
          .get(x.subject) as Record<string, unknown> | undefined;
        const failures = existing && existing.failures != null ? Number(existing.failures) + 1 : 1;
        db.prepare(
          'INSERT INTO auth_backoff(subject,failures,updated_at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET failures=excluded.failures, updated_at=excluded.updated_at',
        ).run(x.subject, failures, x.at);
        return { subject: x.subject, failures, updatedAt: x.at };
      }
      case 'loadAuthBackoff': {
        const x = p as PersistencePayloads['loadAuthBackoff'];
        const row = db.prepare('SELECT * FROM auth_backoff WHERE subject=?').get(x.subject) as
          | Record<string, unknown>
          | undefined;
        return row
          ? {
              subject: text(row.subject),
              failures: Number(row.failures),
              updatedAt: text(row.updated_at),
            }
          : null;
      }
      case 'clearAuthBackoff': {
        const x = p as PersistencePayloads['clearAuthBackoff'];
        db.prepare('DELETE FROM auth_backoff WHERE subject=?').run(x.subject);
        return { cleared: true };
      }
      case 'createSession': {
        const x = p as PersistencePayloads['createSession'];
        db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?)').run(
          x.sessionId,
          x.userId,
          x.expiresAt,
          x.capabilityVersion,
        );
        return x;
      }
      case 'loadSession': {
        const x = p as PersistencePayloads['loadSession'];
        const row = db.prepare('SELECT * FROM sessions WHERE session_id=?').get(x.sessionId) as
          | Record<string, unknown>
          | undefined;
        return row
          ? {
              sessionId: text(row.session_id),
              userId: text(row.user_id),
              expiresAt: text(row.expires_at),
              capabilityVersion: Number(row.capability_version),
            }
          : null;
      }
      case 'revokeSession': {
        const x = p as PersistencePayloads['revokeSession'];
        db.prepare('DELETE FROM sessions WHERE session_id=?').run(x.sessionId);
        return { revoked: true };
      }
      case 'createInvite': {
        const x = p as PersistencePayloads['createInvite'];
        if (
          typeof x.projectId !== 'string' ||
          x.projectId.length === 0 ||
          !(PROJECT_ACCESS_ROLES as readonly string[]).includes(x.role)
        ) {
          throw new TypeError('An invite requires a projectId and canonical project role.');
        }
        db.prepare('INSERT OR REPLACE INTO invites VALUES (?,?,?,?,?)').run(
          x.inviteId,
          x.projectId,
          x.role,
          x.expiresAt,
          x.consumedAt ?? null,
        );
        return x;
      }
      case 'consumeInvite': {
        const x = p as PersistencePayloads['consumeInvite'];
        const row = db.prepare('SELECT * FROM invites WHERE invite_id=?').get(x.inviteId) as
          | Record<string, unknown>
          | undefined;
        if (!row) return { status: 'not-found' } satisfies ConsumeInviteResult;
        if (
          typeof row.project_id !== 'string' ||
          row.project_id.length === 0 ||
          typeof row.role !== 'string' ||
          !(PROJECT_ACCESS_ROLES as readonly string[]).includes(row.role)
        ) {
          return { status: 'not-found' } satisfies ConsumeInviteResult;
        }
        const result = db
          .prepare(
            'UPDATE invites SET consumed_at=? WHERE invite_id=? AND consumed_at IS NULL AND expires_at>=?',
          )
          .run(x.consumedAt, x.inviteId, x.consumedAt);
        if (Number(result.changes) === 1) {
          const consumed = db
            .prepare('SELECT * FROM invites WHERE invite_id=?')
            .get(x.inviteId) as Record<string, unknown>;
          return {
            status: 'accepted',
            invite: mapInviteRow(consumed),
          } satisfies ConsumeInviteResult;
        }
        if (row.consumed_at != null)
          return { status: 'already-consumed' } satisfies ConsumeInviteResult;
        return { status: 'expired' };
      }
      case 'listInvites': {
        const x = p as PersistencePayloads['listInvites'];
        const rows = db
          .prepare(
            x.projectId ? 'SELECT * FROM invites WHERE project_id=?' : 'SELECT * FROM invites',
          )
          .all(...(x.projectId ? [x.projectId] : [])) as Record<string, unknown>[];
        return rows.map(mapInviteRow);
      }
      case 'revokeInvite': {
        const x = p as PersistencePayloads['revokeInvite'];
        if (typeof x.inviteId !== 'string' || x.inviteId.length === 0 || x.inviteId.length > 256) {
          throw {
            code: 'INVALID_INPUT',
            message: 'inviteId must be a non-empty identifier.',
            retryable: false,
          };
        }
        const deleted = db
          .prepare('DELETE FROM invites WHERE invite_id=? AND consumed_at IS NULL')
          .run(x.inviteId);
        if (Number(deleted.changes) === 1)
          return { status: 'revoked' } satisfies RevokeInviteResult;
        const row = db
          .prepare('SELECT consumed_at FROM invites WHERE invite_id=?')
          .get(x.inviteId) as Record<string, unknown> | undefined;
        return row === undefined
          ? ({ status: 'not-found' } satisfies RevokeInviteResult)
          : ({ status: 'already-consumed' } satisfies RevokeInviteResult);
      }
      case 'loadProjectMembership': {
        const x = p as PersistencePayloads['loadProjectMembership'];
        const userId = requireMembershipIdentifier(x.userId, 'userId');
        const projectId = requireMembershipIdentifier(x.projectId, 'projectId');
        const row = db
          .prepare(
            'SELECT pm.*, u.capability_version FROM project_memberships pm JOIN users u ON u.user_id=pm.user_id WHERE pm.user_id=? AND pm.project_id=? AND pm.revoked_at IS NULL',
          )
          .get(userId, projectId) as Record<string, unknown> | undefined;
        return row === undefined ? null : mapProjectMembershipRow(row);
      }
      case 'listProjectMemberships': {
        const x = p as PersistencePayloads['listProjectMemberships'];
        const projectId =
          x.projectId === undefined
            ? undefined
            : requireMembershipIdentifier(x.projectId, 'projectId');
        const rows = db
          .prepare(
            projectId === undefined
              ? 'SELECT pm.*, u.capability_version FROM project_memberships pm JOIN users u ON u.user_id=pm.user_id WHERE pm.revoked_at IS NULL ORDER BY pm.project_id, pm.user_id'
              : 'SELECT pm.*, u.capability_version FROM project_memberships pm JOIN users u ON u.user_id=pm.user_id WHERE pm.project_id=? AND pm.revoked_at IS NULL ORDER BY pm.user_id',
          )
          .all(...(projectId === undefined ? [] : [projectId])) as Record<string, unknown>[];
        return rows.map(mapProjectMembershipRow);
      }
      case 'upsertProjectMembership': {
        const x = p as PersistencePayloads['upsertProjectMembership'];
        const userId = requireMembershipIdentifier(x.userId, 'userId');
        const projectId = requireMembershipIdentifier(x.projectId, 'projectId');
        const role = requireMembershipRole(x.role);
        const at =
          x.at === undefined
            ? new Date().toISOString()
            : typeof x.at === 'string' && x.at.length > 0
              ? x.at
              : membershipInputError('INVALID_INPUT', 'at must be a non-empty timestamp.');
        db.exec('BEGIN IMMEDIATE');
        try {
          const user = db
            .prepare('SELECT capability_version FROM users WHERE user_id=?')
            .get(userId) as Record<string, unknown> | undefined;
          if (user === undefined)
            membershipInputError('USER_NOT_FOUND', 'The user does not exist.');
          const project = db
            .prepare('SELECT project_id FROM projects WHERE project_id=?')
            .get(projectId);
          if (project === undefined)
            membershipInputError('PROJECT_NOT_FOUND', 'The project does not exist.');
          const existing = db
            .prepare('SELECT revision FROM project_memberships WHERE user_id=? AND project_id=?')
            .get(userId, projectId) as Record<string, unknown> | undefined;
          const revision = existing === undefined ? 1 : Number(existing.revision) + 1;
          const capabilityVersion = Number(user?.capability_version) + 1;
          db.prepare(
            'INSERT INTO project_memberships(user_id,project_id,role,created_at,revoked_at,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET role=excluded.role, revoked_at=NULL, revision=excluded.revision',
          ).run(userId, projectId, role, at, null, revision);
          db.prepare('UPDATE users SET capability_version=?, updated_at=? WHERE user_id=?').run(
            capabilityVersion,
            at,
            userId,
          );
          db.prepare('UPDATE sessions SET capability_version=? WHERE user_id=?').run(
            capabilityVersion,
            userId,
          );
          const invalidated = db
            .prepare(
              'UPDATE capabilities SET revoked_at=? WHERE user_id=? AND project_id=? AND revoked_at IS NULL',
            )
            .run(at, userId, projectId).changes;
          const row = db
            .prepare(
              'SELECT pm.*, u.capability_version FROM project_memberships pm JOIN users u ON u.user_id=pm.user_id WHERE pm.user_id=? AND pm.project_id=? AND pm.revoked_at IS NULL',
            )
            .get(userId, projectId) as Record<string, unknown>;
          db.exec('COMMIT');
          return {
            membership: mapProjectMembershipRow(row),
            capabilityVersion,
            revokedCapabilities: Number(invalidated),
          } satisfies ProjectMembershipMutationResult;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      case 'revokeProjectMembership': {
        const x = p as PersistencePayloads['revokeProjectMembership'];
        const userId = requireMembershipIdentifier(x.userId, 'userId');
        const projectId = requireMembershipIdentifier(x.projectId, 'projectId');
        const at =
          x.at === undefined
            ? new Date().toISOString()
            : typeof x.at === 'string' && x.at.length > 0
              ? x.at
              : membershipInputError('INVALID_INPUT', 'at must be a non-empty timestamp.');
        db.exec('BEGIN IMMEDIATE');
        try {
          const user = db
            .prepare('SELECT capability_version FROM users WHERE user_id=?')
            .get(userId) as Record<string, unknown> | undefined;
          if (user === undefined)
            membershipInputError('USER_NOT_FOUND', 'The user does not exist.');
          const project = db
            .prepare('SELECT project_id FROM projects WHERE project_id=?')
            .get(projectId);
          if (project === undefined)
            membershipInputError('PROJECT_NOT_FOUND', 'The project does not exist.');
          db.prepare(
            'UPDATE project_memberships SET revoked_at=?, revision=revision+1 WHERE user_id=? AND project_id=?',
          ).run(at, userId, projectId);
          const capabilityVersion = Number(user?.capability_version) + 1;
          db.prepare('UPDATE users SET capability_version=?, updated_at=? WHERE user_id=?').run(
            capabilityVersion,
            at,
            userId,
          );
          db.prepare('UPDATE sessions SET capability_version=? WHERE user_id=?').run(
            capabilityVersion,
            userId,
          );
          const invalidated = db
            .prepare(
              'UPDATE capabilities SET revoked_at=? WHERE user_id=? AND project_id=? AND revoked_at IS NULL',
            )
            .run(at, userId, projectId).changes;
          const row = db
            .prepare(
              'SELECT pm.*, u.capability_version FROM project_memberships pm JOIN users u ON u.user_id=pm.user_id WHERE pm.user_id=? AND pm.project_id=?',
            )
            .get(userId, projectId) as Record<string, unknown> | undefined;
          db.exec('COMMIT');
          return {
            membership: row === undefined ? null : mapProjectMembershipRow(row),
            capabilityVersion,
            revokedCapabilities: Number(invalidated),
          } satisfies ProjectMembershipMutationResult;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      case 'upsertCapability': {
        const x = p as PersistencePayloads['upsertCapability'];
        db.prepare('INSERT OR REPLACE INTO capabilities VALUES (?,?,?,?,?,?,?)').run(
          x.capabilityId,
          x.userId,
          x.projectId,
          json(x.scope),
          x.version,
          x.expiresAt,
          x.revokedAt ?? null,
        );
        return x;
      }
      case 'loadCapability': {
        const x = p as PersistencePayloads['loadCapability'];
        const row = db
          .prepare('SELECT * FROM capabilities WHERE capability_id=?')
          .get(x.capabilityId) as Record<string, unknown> | undefined;
        return row ? mapCapabilityRow(row) : null;
      }
      case 'revokeCapability': {
        const x = p as PersistencePayloads['revokeCapability'];
        db.prepare('UPDATE capabilities SET revoked_at=? WHERE capability_id=?').run(
          new Date().toISOString(),
          x.capabilityId,
        );
        return { revoked: true };
      }
      case 'listProjects':
        return (
          db.prepare('SELECT * FROM projects ORDER BY project_id').all() as Record<
            string,
            unknown
          >[]
        ).map((row) => ({
          projectId: text(row.project_id),
          displayName: text(row.display_name),
          rootLabel: text(row.root_label),
          createdAt: text(row.created_at),
          updatedAt: text(row.updated_at),
        }));
      case 'getProject': {
        const x = p as PersistencePayloads['getProject'];
        const row = db.prepare('SELECT * FROM projects WHERE project_id=?').get(x.projectId) as
          | Record<string, unknown>
          | undefined;
        return row
          ? {
              projectId: text(row.project_id),
              displayName: text(row.display_name),
              rootLabel: text(row.root_label),
              createdAt: text(row.created_at),
              updatedAt: text(row.updated_at),
            }
          : null;
      }
      case 'upsertProject': {
        const x = p as PersistencePayloads['upsertProject'];
        db.prepare('INSERT OR REPLACE INTO projects VALUES (?,?,?,?,?)').run(
          x.projectId,
          x.displayName,
          x.rootLabel,
          x.createdAt,
          x.updatedAt,
        );
        return x;
      }
      case 'removeProject': {
        const x = p as PersistencePayloads['removeProject'];
        db.prepare('DELETE FROM projects WHERE project_id=?').run(x.projectId);
        return { removed: true };
      }
      case 'checkpointOperation': {
        const x = p as PersistencePayloads['checkpointOperation'];
        db.prepare('INSERT OR REPLACE INTO operations VALUES (?,?,?,?)').run(
          x.operationId,
          x.checkpoint,
          x.version,
          x.updatedAt,
        );
        return x;
      }
      case 'loadOperationCheckpoint': {
        const x = p as PersistencePayloads['loadOperationCheckpoint'];
        const row = db
          .prepare('SELECT * FROM operations WHERE operation_id=?')
          .get(x.operationId) as Record<string, unknown> | undefined;
        return row
          ? {
              operationId: text(row.operation_id),
              checkpoint: text(row.checkpoint),
              version: Number(row.version),
              updatedAt: text(row.updated_at),
            }
          : null;
      }
      case 'beginGitSubmission': {
        const x = p as PersistencePayloads['beginGitSubmission'];
        db.prepare(
          'INSERT INTO git_submissions(submit_id,project_id,phase,expected_git_head,candidate_commit,receipt_hash,diagnostic,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(submit_id) DO NOTHING',
        ).run(
          x.submitId,
          x.projectId,
          x.phase,
          x.expectedGitHead,
          x.candidateCommit ?? null,
          x.receiptHash ?? null,
          x.diagnostic ?? null,
          x.updatedAt,
        );
        return mapGitJournalRow(
          db.prepare('SELECT * FROM git_submissions WHERE submit_id=?').get(x.submitId) as Record<
            string,
            unknown
          >,
        );
      }
      case 'checkpointGitSubmission': {
        const x = p as PersistencePayloads['checkpointGitSubmission'];
        db.prepare(
          'INSERT INTO git_submissions(submit_id,project_id,phase,expected_git_head,candidate_commit,receipt_hash,diagnostic,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(submit_id) DO UPDATE SET phase=excluded.phase, expected_git_head=excluded.expected_git_head, candidate_commit=excluded.candidate_commit, receipt_hash=excluded.receipt_hash, diagnostic=excluded.diagnostic, updated_at=excluded.updated_at WHERE git_submissions.phase NOT IN (?,?,?)',
        ).run(
          x.submitId,
          x.projectId,
          x.phase,
          x.expectedGitHead,
          x.candidateCommit ?? null,
          x.receiptHash ?? null,
          x.diagnostic ?? null,
          x.updatedAt,
          GIT_SUBMISSION_PHASE_COMPLETE,
          GIT_SUBMISSION_PHASE_STALE,
          GIT_SUBMISSION_PHASE_CONFLICT,
        );
        return mapGitJournalRow(
          db.prepare('SELECT * FROM git_submissions WHERE submit_id=?').get(x.submitId) as Record<
            string,
            unknown
          >,
        );
      }
      case 'completeGitSubmission': {
        const x = p as PersistencePayloads['completeGitSubmission'];
        const existing = db
          .prepare('SELECT * FROM git_submissions WHERE submit_id=?')
          .get(x.submitId) as Record<string, unknown> | undefined;
        if (
          existing &&
          text(existing.phase) === GIT_SUBMISSION_PHASE_COMPLETE &&
          existing.candidate_commit != null &&
          existing.receipt_hash != null
        )
          return mapGitReceiptRow(existing);
        db.prepare(
          'INSERT INTO git_submissions(submit_id,project_id,phase,expected_git_head,candidate_commit,receipt_hash,diagnostic,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(submit_id) DO UPDATE SET phase=excluded.phase, candidate_commit=excluded.candidate_commit, receipt_hash=excluded.receipt_hash, diagnostic=excluded.diagnostic, updated_at=excluded.updated_at WHERE git_submissions.phase NOT IN (?,?,?) AND (git_submissions.candidate_commit IS NULL OR git_submissions.candidate_commit = excluded.candidate_commit)',
        ).run(
          x.submitId,
          x.projectId,
          GIT_SUBMISSION_PHASE_COMPLETE,
          '',
          x.commit,
          x.receiptHash,
          x.sourceHash,
          x.acceptedAt,
          GIT_SUBMISSION_PHASE_COMPLETE,
          GIT_SUBMISSION_PHASE_STALE,
          GIT_SUBMISSION_PHASE_CONFLICT,
        );
        const row = db.prepare('SELECT * FROM git_submissions WHERE submit_id=?').get(x.submitId) as
          | Record<string, unknown>
          | undefined;
        if (
          row &&
          text(row.phase) === GIT_SUBMISSION_PHASE_COMPLETE &&
          row.candidate_commit != null &&
          row.receipt_hash != null
        )
          return mapGitReceiptRow(row);
        throw {
          code: 'GIT_SUBMISSION_NOT_COMPLETABLE',
          message: `Cannot complete git submission ${x.submitId}: journal candidate does not match the receipt commit`,
          retryable: false,
        };
      }
      case 'loadGitSubmission': {
        const x = p as PersistencePayloads['loadGitSubmission'];
        const row = db.prepare('SELECT * FROM git_submissions WHERE submit_id=?').get(x.submitId) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        if (
          text(row.phase) === GIT_SUBMISSION_PHASE_COMPLETE &&
          row.candidate_commit != null &&
          row.receipt_hash != null
        )
          return mapGitReceiptRow(row);
        return mapGitJournalRow(row);
      }
      case 'loadUiPreferences': {
        const x = p as PersistencePayloads['loadUiPreferences'];
        const row = db.prepare('SELECT * FROM ui_preferences WHERE user_id=?').get(x.userId) as
          | Record<string, unknown>
          | undefined;
        return row
          ? {
              userId: text(row.user_id),
              values: parseJson(row.preference_values),
              updatedAt: text(row.updated_at),
            }
          : null;
      }
      case 'saveUiPreferences': {
        const x = p as PersistencePayloads['saveUiPreferences'];
        db.prepare('INSERT OR REPLACE INTO ui_preferences VALUES (?,?,?)').run(
          x.userId,
          json(x.values),
          x.updatedAt,
        );
        return x;
      }
      case 'createConfigurationOperation': {
        const x = p as PersistencePayloads['createConfigurationOperation'];
        db.prepare(
          'INSERT OR REPLACE INTO configuration_operations(operation_id,origin,status,active_revision,candidate_revision,changed_fields,diagnostics,actor_id,at) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          x.operationId,
          x.origin,
          x.status,
          x.activeRevision ?? null,
          x.candidateRevision ?? null,
          json(x.changedFields),
          json(x.diagnostics),
          x.actorId ?? null,
          x.at,
        );
        return mapConfigurationOperationRow(
          db
            .prepare('SELECT * FROM configuration_operations WHERE operation_id=?')
            .get(x.operationId) as Record<string, unknown>,
        );
      }
      case 'listConfigurationOperations': {
        const x = p as PersistencePayloads['listConfigurationOperations'];
        const rows = db
          .prepare('SELECT * FROM configuration_operations ORDER BY at DESC, operation_id LIMIT ?')
          .all(x.limit) as Record<string, unknown>[];
        return rows.map(mapConfigurationOperationRow);
      }
      case 'loadConfigurationOperation': {
        const x = p as PersistencePayloads['loadConfigurationOperation'];
        const row = db
          .prepare('SELECT * FROM configuration_operations WHERE operation_id=?')
          .get(x.operationId) as Record<string, unknown> | undefined;
        return row ? mapConfigurationOperationRow(row) : null;
      }
      case 'saveAuthoringState': {
        const x = p as PersistencePayloads['saveAuthoringState'];
        db.prepare(
          'INSERT INTO authoring_state(project_id,phase,accepted_source_hash,observed_filesystem_hash,workspace_digest,candidate_hash,candidate_valid,conflicts,fixed_git_head,pending_submit_id,recovery_phase,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET phase=excluded.phase, accepted_source_hash=excluded.accepted_source_hash, observed_filesystem_hash=excluded.observed_filesystem_hash, workspace_digest=excluded.workspace_digest, candidate_hash=excluded.candidate_hash, candidate_valid=excluded.candidate_valid, conflicts=excluded.conflicts, fixed_git_head=excluded.fixed_git_head, pending_submit_id=excluded.pending_submit_id, recovery_phase=excluded.recovery_phase, updated_at=excluded.updated_at',
        ).run(
          x.projectId,
          x.phase,
          x.acceptedSourceHash ?? null,
          x.observedFilesystemHash ?? null,
          x.workspaceDigest ?? null,
          x.candidateHash ?? null,
          x.candidateValid ? 1 : 0,
          json(x.conflicts),
          x.fixedGitHead ?? null,
          x.pendingSubmitId ?? null,
          x.recoveryPhase ?? null,
          x.updatedAt,
        );
        return mapAuthoringStateRow(
          db.prepare('SELECT * FROM authoring_state WHERE project_id=?').get(x.projectId) as Record<
            string,
            unknown
          >,
        );
      }
      case 'loadAuthoringState': {
        const x = p as PersistencePayloads['loadAuthoringState'];
        const row = db
          .prepare('SELECT * FROM authoring_state WHERE project_id=?')
          .get(x.projectId) as Record<string, unknown> | undefined;
        return row ? mapAuthoringStateRow(row) : null;
      }
      case 'appendAudit': {
        const x = p as PersistencePayloads['appendAudit'];
        db.prepare(
          'INSERT OR IGNORE INTO audit_log(audit_id,at,actor_id,surface,operation_kind,outcome,project_id,document_scope,capability_version,base_source_hash,result_source_hash,workspace_digest,submit_id,git_receipt_hash,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          x.auditId,
          x.at,
          x.actorId ?? null,
          x.surface,
          x.operationKind,
          x.outcome,
          x.projectId ?? null,
          x.documentScope ?? null,
          x.capabilityVersion ?? null,
          x.baseSourceHash ?? null,
          x.resultSourceHash ?? null,
          x.workspaceDigest ?? null,
          x.submitId ?? null,
          x.gitReceiptHash ?? null,
          x.detail ?? null,
        );
        return mapAuditRow(
          db.prepare('SELECT * FROM audit_log WHERE audit_id=?').get(x.auditId) as Record<
            string,
            unknown
          >,
        );
      }
      case 'listAudit': {
        const x = p as PersistencePayloads['listAudit'];
        const filters: string[] = [];
        const args: string[] = [];
        if (x.surface != null) {
          filters.push('surface=?');
          args.push(x.surface);
        }
        if (x.projectId != null) {
          filters.push('project_id=?');
          args.push(x.projectId);
        }
        const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
        const rows = db
          .prepare(`SELECT * FROM audit_log${where} ORDER BY at DESC, audit_id LIMIT ?`)
          .all(...args, String(x.limit)) as Record<string, unknown>[];
        return rows.map(mapAuditRow);
      }
      case 'loadAudit': {
        const x = p as PersistencePayloads['loadAudit'];
        const row = db.prepare('SELECT * FROM audit_log WHERE audit_id=?').get(x.auditId) as
          | Record<string, unknown>
          | undefined;
        return row ? mapAuditRow(row) : null;
      }
      case 'createDeviceVerifier': {
        const x = p as PersistencePayloads['createDeviceVerifier'];
        requireVerifierStore(request.operation, x);
        if (x.store === 'mcp') {
          if ('clientLabel' in x || 'role' in x) {
            throw {
              code: 'UNKNOWN_FIELD',
              message: 'MCP device verifiers do not accept clientLabel or role',
              retryable: false,
            };
          }
          db.prepare(
            'INSERT OR REPLACE INTO mcp_device_verifiers(device_id,verifier,kind,project_id,owner_user_id,scopes,grant_revision,expires_at,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          ).run(
            x.deviceId,
            x.tokenHash,
            x.kind,
            x.projectId ?? null,
            x.ownerUserId,
            json(x.scopes),
            x.grantRevision,
            x.expiresAt,
            x.revokedAt ?? null,
            x.createdAt,
          );
          return toMcpDeviceVerifierRead(x);
        }
        db.prepare(
          'INSERT OR REPLACE INTO capability_verifiers(device_id,token_hash,scope,expires_at,client_label,revoked_at,created_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          x.deviceId,
          x.tokenHash,
          json(x.scope),
          x.expiresAt,
          x.clientLabel,
          x.revokedAt ?? null,
          x.createdAt,
        );
        return toCapabilityVerifierRead(x);
      }
      case 'loadDeviceVerifierByTokenHash': {
        const x = p as PersistencePayloads['loadDeviceVerifierByTokenHash'];
        requireVerifierStore(request.operation, x);
        if (x.store === 'mcp') {
          const row = db
            .prepare(
              'SELECT device_id,kind,project_id,owner_user_id,scopes,grant_revision,expires_at,revoked_at,created_at FROM mcp_device_verifiers WHERE verifier=?',
            )
            .get(x.tokenHash) as Record<string, unknown> | undefined;
          return row ? mapMcpDeviceVerifierRow(row) : null;
        }
        const row = db
          .prepare(
            'SELECT device_id,scope,expires_at,client_label,revoked_at,created_at FROM capability_verifiers WHERE token_hash=?',
          )
          .get(x.tokenHash) as Record<string, unknown> | undefined;
        return row ? mapCapabilityVerifierRow(row) : null;
      }
      case 'listDeviceVerifiers': {
        const x = p as NonNullable<PersistencePayloads['listDeviceVerifiers']>;
        requireVerifierStore(request.operation, x);
        if (x.store === 'mcp') {
          const rows = db
            .prepare(
              'SELECT device_id,kind,project_id,owner_user_id,scopes,grant_revision,expires_at,revoked_at,created_at FROM mcp_device_verifiers ORDER BY created_at, device_id',
            )
            .all() as Record<string, unknown>[];
          return rows.map(mapMcpDeviceVerifierRow);
        }
        const rows = db
          .prepare(
            'SELECT device_id,scope,expires_at,client_label,revoked_at,created_at FROM capability_verifiers ORDER BY created_at, device_id',
          )
          .all() as Record<string, unknown>[];
        return rows.map(mapCapabilityVerifierRow);
      }
      case 'revokeDeviceVerifier': {
        const x = p as PersistencePayloads['revokeDeviceVerifier'];
        requireVerifierStore(request.operation, x);
        if (x.store === 'mcp') {
          db.prepare('UPDATE mcp_device_verifiers SET revoked_at=? WHERE device_id=?').run(
            x.revokedAt,
            x.deviceId,
          );
        } else {
          db.prepare('UPDATE capability_verifiers SET revoked_at=? WHERE device_id=?').run(
            x.revokedAt,
            x.deviceId,
          );
        }
        return { revoked: true };
      }
      case 'listSessions': {
        const x = p as PersistencePayloads['listSessions'];
        const rows = (
          x.userId != null
            ? db.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY expires_at').all(x.userId)
            : db.prepare('SELECT * FROM sessions ORDER BY expires_at').all()
        ) as Record<string, unknown>[];
        return rows.map((row) => ({
          sessionId: text(row.session_id),
          userId: text(row.user_id),
          expiresAt: text(row.expires_at),
          capabilityVersion: Number(row.capability_version),
        }));
      }
      // ─── V3: native revision operations ───────────────────────────────────
      case 'createSourceRevision': {
        const x = p as PersistencePayloads['createSourceRevision'];
        db.prepare(
          'INSERT INTO source_revisions(revision_id,project_id,parent_revision_id,operation_id,source_hash,bundle_hash,actor_id,origin,created_at,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(revision_id) DO NOTHING',
        ).run(
          x.revisionId,
          x.projectId,
          x.parentRevisionId ?? null,
          x.operationId,
          x.sourceHash,
          x.bundleHash,
          x.actorId,
          x.origin,
          x.createdAt,
          x.acceptedAt ?? null,
        );
        return mapSourceRevisionRow(
          db
            .prepare('SELECT * FROM source_revisions WHERE revision_id=?')
            .get(x.revisionId) as Record<string, unknown>,
        );
      }
      case 'getSourceRevision': {
        const x = p as PersistencePayloads['getSourceRevision'];
        const row = db
          .prepare('SELECT * FROM source_revisions WHERE revision_id=?')
          .get(x.revisionId) as Record<string, unknown> | undefined;
        return row ? mapSourceRevisionRow(row) : null;
      }
      case 'listSourceRevisions': {
        const x = p as PersistencePayloads['listSourceRevisions'];
        const limit = x.limit != null ? Math.min(Math.max(1, x.limit), 100) : 50;
        const rows = db
          .prepare(
            'SELECT * FROM source_revisions WHERE project_id=? AND (? IS NULL OR revision_id<?) ORDER BY revision_id DESC LIMIT ?',
          )
          .all(x.projectId, x.cursor ?? null, x.cursor ?? null, limit) as Record<string, unknown>[];
        return rows.map(mapSourceRevisionRow);
      }
      case 'createSourceRevisionOperation': {
        const x = p as PersistencePayloads['createSourceRevisionOperation'];
        db.prepare(
          'INSERT INTO source_revision_operations(operation_id,project_id,expected_revision_id,expected_source_hash,revision_id,phase,receipt_hash,diagnostic,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING',
        ).run(
          x.operationId,
          x.projectId,
          x.expectedRevisionId ?? null,
          x.expectedSourceHash ?? null,
          x.revisionId ?? null,
          x.phase,
          x.receiptHash ?? null,
          x.diagnostic ?? null,
          x.createdAt,
          x.updatedAt,
        );
        return mapSourceRevisionOperationRow(
          db
            .prepare('SELECT * FROM source_revision_operations WHERE operation_id=?')
            .get(x.operationId) as Record<string, unknown>,
        );
      }
      case 'checkpointSourceRevisionOperation': {
        const x = p as PersistencePayloads['checkpointSourceRevisionOperation'];
        db.prepare(
          'INSERT INTO source_revision_operations(operation_id,project_id,expected_revision_id,expected_source_hash,revision_id,phase,receipt_hash,diagnostic,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET revision_id=excluded.revision_id, phase=excluded.phase, receipt_hash=excluded.receipt_hash, diagnostic=excluded.diagnostic, updated_at=excluded.updated_at WHERE source_revision_operations.phase NOT IN (?,?,?,?)',
        ).run(
          x.operationId,
          x.projectId,
          x.expectedRevisionId ?? null,
          x.expectedSourceHash ?? null,
          x.revisionId ?? null,
          x.phase,
          x.receiptHash ?? null,
          x.diagnostic ?? null,
          x.createdAt,
          x.updatedAt,
          NATIVE_REVISION_TERMINAL_PHASE_VALUES[0],
          NATIVE_REVISION_TERMINAL_PHASE_VALUES[1],
          NATIVE_REVISION_TERMINAL_PHASE_VALUES[2],
          NATIVE_REVISION_TERMINAL_PHASE_VALUES[3],
        );
        return mapSourceRevisionOperationRow(
          db
            .prepare('SELECT * FROM source_revision_operations WHERE operation_id=?')
            .get(x.operationId) as Record<string, unknown>,
        );
      }
      case 'replaySourceRevisionReceipt': {
        const x = p as PersistencePayloads['replaySourceRevisionReceipt'];
        const row = db
          .prepare(
            'SELECT o.*, r.source_hash, r.bundle_hash FROM source_revision_operations o LEFT JOIN source_revisions r ON r.revision_id = o.revision_id WHERE o.operation_id=?',
          )
          .get(x.operationId) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (!isNativeTerminalPhase(row.phase) || row.receipt_hash == null) return null;
        return mapSourceRevisionReceiptRow(row);
      }
      case 'loadSourceRevisionOperation': {
        const x = p as PersistencePayloads['loadSourceRevisionOperation'];
        const row = db
          .prepare('SELECT * FROM source_revision_operations WHERE operation_id=?')
          .get(x.operationId) as Record<string, unknown> | undefined;
        return row ? mapSourceRevisionOperationRow(row) : null;
      }
      case 'getSourceHead': {
        const x = p as PersistencePayloads['getSourceHead'];
        const row = db.prepare('SELECT * FROM source_heads WHERE project_id=?').get(x.projectId) as
          | Record<string, unknown>
          | undefined;
        return row ? mapSourceHeadRow(row) : null;
      }
      case 'casSourceHead': {
        const x = p as PersistencePayloads['casSourceHead'];
        const result = db
          .prepare(
            'INSERT INTO source_heads(project_id,accepted_revision_id,accepted_source_hash,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET accepted_revision_id=excluded.accepted_revision_id, accepted_source_hash=excluded.accepted_source_hash, updated_at=excluded.updated_at WHERE (? IS NULL OR source_heads.accepted_revision_id=?) AND (? IS NULL OR source_heads.accepted_source_hash=?)',
          )
          .run(
            x.projectId,
            x.acceptedRevisionId,
            x.acceptedSourceHash,
            x.updatedAt,
            x.expectedAcceptedRevisionId ?? null,
            x.expectedAcceptedRevisionId ?? null,
            x.expectedAcceptedSourceHash ?? null,
            x.expectedAcceptedSourceHash ?? null,
          );
        const head = mapSourceHeadRow(
          db.prepare('SELECT * FROM source_heads WHERE project_id=?').get(x.projectId) as Record<
            string,
            unknown
          >,
        );
        const applied = Number(result.changes) === 1;
        return { applied, head } satisfies SourceHeadCasResult;
      }
      case 'createSourceMaterialization': {
        const x = p as PersistencePayloads['createSourceMaterialization'];
        db.prepare(
          'INSERT INTO source_materializations(project_id,revision_id,phase,expected_view_source_hash,target_source_hash,tree_hash,attempt,diagnostic,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,revision_id) DO NOTHING',
        ).run(
          x.projectId,
          x.revisionId,
          x.phase,
          x.expectedViewSourceHash,
          x.targetSourceHash,
          x.treeHash,
          x.attempt,
          x.diagnostic ?? null,
          x.updatedAt,
        );
        return mapSourceMaterializationRow(
          db
            .prepare('SELECT * FROM source_materializations WHERE project_id=? AND revision_id=?')
            .get(x.projectId, x.revisionId) as Record<string, unknown>,
        );
      }
      case 'checkpointSourceMaterialization': {
        const x = p as PersistencePayloads['checkpointSourceMaterialization'];
        db.prepare(
          'INSERT INTO source_materializations(project_id,revision_id,phase,expected_view_source_hash,target_source_hash,tree_hash,attempt,diagnostic,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,revision_id) DO UPDATE SET phase=excluded.phase, attempt=excluded.attempt, diagnostic=excluded.diagnostic, updated_at=excluded.updated_at',
        ).run(
          x.projectId,
          x.revisionId,
          x.phase,
          x.expectedViewSourceHash,
          x.targetSourceHash,
          x.treeHash,
          x.attempt,
          x.diagnostic ?? null,
          x.updatedAt,
        );
        return mapSourceMaterializationRow(
          db
            .prepare('SELECT * FROM source_materializations WHERE project_id=? AND revision_id=?')
            .get(x.projectId, x.revisionId) as Record<string, unknown>,
        );
      }
      case 'loadSourceMaterialization': {
        const x = p as PersistencePayloads['loadSourceMaterialization'];
        const row = db
          .prepare('SELECT * FROM source_materializations WHERE project_id=? AND revision_id=?')
          .get(x.projectId, x.revisionId) as Record<string, unknown> | undefined;
        return row ? mapSourceMaterializationRow(row) : null;
      }
      case 'loadSourceMaterializationEntries': {
        const x = p as PersistencePayloads['loadSourceMaterializationEntries'];
        const rows = db
          .prepare(
            'SELECT * FROM source_materialization_entries WHERE project_id=? AND revision_id=? ORDER BY logical_path',
          )
          .all(x.projectId, x.revisionId) as Record<string, unknown>[];
        return rows.map(mapSourceMaterializationEntryRow);
      }
      case 'upsertAuthoringWorkingDocument': {
        const x = p as PersistencePayloads['upsertAuthoringWorkingDocument'];
        db.prepare(
          'INSERT INTO authoring_working_documents(project_id,document_id,logical_path,kind,state,base_revision_id,catalog_revision,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,document_id) DO UPDATE SET logical_path=excluded.logical_path, kind=excluded.kind, state=excluded.state, base_revision_id=excluded.base_revision_id, catalog_revision=excluded.catalog_revision, updated_at=excluded.updated_at',
        ).run(
          x.projectId,
          x.documentId,
          x.logicalPath,
          x.kind,
          x.state,
          x.baseRevisionId ?? null,
          x.catalogRevision,
          x.updatedAt,
        );
        return mapAuthoringWorkingDocumentRow(
          db
            .prepare(
              'SELECT * FROM authoring_working_documents WHERE project_id=? AND document_id=?',
            )
            .get(x.projectId, x.documentId) as Record<string, unknown>,
        );
      }
      case 'loadAuthoringWorkingDocument': {
        const x = p as PersistencePayloads['loadAuthoringWorkingDocument'];
        const row = db
          .prepare('SELECT * FROM authoring_working_documents WHERE project_id=? AND document_id=?')
          .get(x.projectId, x.documentId) as Record<string, unknown> | undefined;
        return row ? mapAuthoringWorkingDocumentRow(row) : null;
      }
      case 'listAuthoringWorkingDocuments': {
        const x = p as PersistencePayloads['listAuthoringWorkingDocuments'];
        const rows = db
          .prepare(
            'SELECT * FROM authoring_working_documents WHERE project_id=? ORDER BY logical_path, document_id',
          )
          .all(x.projectId) as Record<string, unknown>[];
        return rows.map(mapAuthoringWorkingDocumentRow);
      }
      case 'deleteAuthoringWorkingDocument': {
        const x = p as PersistencePayloads['deleteAuthoringWorkingDocument'];
        db.prepare(
          'DELETE FROM authoring_working_documents WHERE project_id=? AND document_id=?',
        ).run(x.projectId, x.documentId);
        return { removed: true };
      }
      case 'createRevisionMirrorExport': {
        const x = p as PersistencePayloads['createRevisionMirrorExport'];
        db.prepare(
          'INSERT INTO revision_mirror_exports(project_id,revision_id,backend,state,external_id,diagnostic,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,revision_id,backend) DO NOTHING',
        ).run(
          x.projectId,
          x.revisionId,
          x.backend,
          x.state,
          x.externalId ?? null,
          x.diagnostic ?? null,
          x.updatedAt,
        );
        return mapRevisionMirrorExportRow(
          db
            .prepare(
              'SELECT * FROM revision_mirror_exports WHERE project_id=? AND revision_id=? AND backend=?',
            )
            .get(x.projectId, x.revisionId, x.backend) as Record<string, unknown>,
        );
      }
      case 'checkpointRevisionMirrorExport': {
        const x = p as PersistencePayloads['checkpointRevisionMirrorExport'];
        db.prepare(
          'INSERT INTO revision_mirror_exports(project_id,revision_id,backend,state,external_id,diagnostic,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,revision_id,backend) DO UPDATE SET state=excluded.state, external_id=excluded.external_id, diagnostic=excluded.diagnostic, updated_at=excluded.updated_at',
        ).run(
          x.projectId,
          x.revisionId,
          x.backend,
          x.state,
          x.externalId ?? null,
          x.diagnostic ?? null,
          x.updatedAt,
        );
        return mapRevisionMirrorExportRow(
          db
            .prepare(
              'SELECT * FROM revision_mirror_exports WHERE project_id=? AND revision_id=? AND backend=?',
            )
            .get(x.projectId, x.revisionId, x.backend) as Record<string, unknown>,
        );
      }
      case 'loadRevisionMirrorExport': {
        const x = p as PersistencePayloads['loadRevisionMirrorExport'];
        const row = db
          .prepare(
            'SELECT * FROM revision_mirror_exports WHERE project_id=? AND revision_id=? AND backend=?',
          )
          .get(x.projectId, x.revisionId, x.backend) as Record<string, unknown> | undefined;
        return row ? mapRevisionMirrorExportRow(row) : null;
      }
      // ─── V5: durable project operation queue ─────────────────────────────
      case 'upsertProjectOperation': {
        const x = p as PersistencePayloads['upsertProjectOperation'];
        const record = requireProjectOperationRecord(x.record);
        const existing = db
          .prepare('SELECT * FROM project_operations WHERE project_id=? AND operation_id=?')
          .get(record.projectId, record.operationId) as Record<string, unknown> | undefined;
        if (existing === undefined) {
          if (record.status !== 'queued') {
            operationInputError(
              'INVALID_INPUT',
              'A new project operation must be created in status "queued".',
            );
          }
          try {
            db.prepare(
              'INSERT INTO project_operations(project_id,operation_id,idempotency_key,kind,status,actor_id,capability_version,source_hash,accepted_revision_id,progress,result_ref,error_code,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            ).run(
              record.projectId,
              record.operationId,
              record.idempotencyKey,
              record.kind,
              record.status,
              record.actorId,
              record.capabilityVersion,
              record.sourceHash ?? null,
              record.acceptedRevisionId ?? null,
              record.progress !== null ? json(record.progress) : null,
              record.resultRef ?? null,
              record.errorCode ?? null,
              record.version,
              record.createdAt,
              record.updatedAt,
            );
          } catch (error) {
            if (isUniqueConstraintError(error)) {
              operationInputError(
                'IDEMPOTENCY_CONFLICT',
                `A project operation with idempotencyKey "${record.idempotencyKey}" already exists for kind "${record.kind}" in project "${record.projectId}".`,
              );
            }
            throw error;
          }
          return {
            record: mapProjectOperationRow(
              db
                .prepare('SELECT * FROM project_operations WHERE project_id=? AND operation_id=?')
                .get(record.projectId, record.operationId) as Record<string, unknown>,
            ),
            created: true,
            applied: true,
          } satisfies PersistenceResults['upsertProjectOperation'];
        }
        if (
          x.expectedStatus !== undefined &&
          parseProjectOperationStatus(existing.status) !== x.expectedStatus
        ) {
          return {
            record: mapProjectOperationRow(existing),
            created: false,
            applied: false,
          } satisfies PersistenceResults['upsertProjectOperation'];
        }
        assertOperationIdentityUnchanged(existing, record);
        const from = parseProjectOperationStatus(existing.status);
        const to = record.status;
        if (!PROJECT_OPERATION_TRANSITIONS[from].includes(to)) {
          operationInputError(
            'ILLEGAL_OPERATION_TRANSITION',
            `Cannot transition project operation ${record.projectId}/${record.operationId} from ${from} to ${to}.`,
          );
        }
        db.prepare(
          'UPDATE project_operations SET status=?, progress=?, result_ref=?, error_code=?, accepted_revision_id=?, updated_at=? WHERE project_id=? AND operation_id=?',
        ).run(
          record.status,
          record.progress !== null ? json(record.progress) : null,
          record.resultRef ?? null,
          record.errorCode ?? null,
          record.acceptedRevisionId ?? null,
          record.updatedAt,
          record.projectId,
          record.operationId,
        );
        return {
          record: mapProjectOperationRow(
            db
              .prepare('SELECT * FROM project_operations WHERE project_id=? AND operation_id=?')
              .get(record.projectId, record.operationId) as Record<string, unknown>,
          ),
          created: false,
          applied: true,
        } satisfies PersistenceResults['upsertProjectOperation'];
      }
      case 'getProjectOperation': {
        const x = p as PersistencePayloads['getProjectOperation'];
        requireOperationIdentifier(x.projectId, 'projectId');
        requireOperationIdentifier(x.operationId, 'operationId');
        const row = db
          .prepare('SELECT * FROM project_operations WHERE project_id=? AND operation_id=?')
          .get(x.projectId, x.operationId) as Record<string, unknown> | undefined;
        return row ? mapProjectOperationRow(row) : null;
      }
      case 'listProjectOperations': {
        const x = p as PersistencePayloads['listProjectOperations'];
        requireOperationIdentifier(x.projectId, 'projectId');
        const limit = x.limit != null ? Math.min(Math.max(1, x.limit), 100) : 50;
        const args: Array<string | number | null> = [x.projectId];
        let sql = 'SELECT * FROM project_operations WHERE project_id=?';
        if (x.status !== undefined) {
          if (!(PROJECT_OPERATION_STATUS_VALUES as readonly string[]).includes(x.status)) {
            operationInputError('INVALID_INPUT', 'status must be a canonical operation status.');
          }
          sql += ' AND status=?';
          args.push(x.status);
        }
        if (x.before !== undefined) {
          const cursor = parseOperationListCursor(x.before);
          sql += ' AND (updated_at < ? OR (updated_at = ? AND operation_id < ?))';
          args.push(cursor.updatedAt, cursor.updatedAt, cursor.operationId);
        }
        sql += ' ORDER BY updated_at DESC, operation_id DESC LIMIT ?';
        args.push(limit);
        const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
        return rows.map(mapProjectOperationRow);
      }
      case 'getProjectOperationByIdempotencyKey': {
        const x = p as PersistencePayloads['getProjectOperationByIdempotencyKey'];
        requireOperationIdentifier(x.projectId, 'projectId');
        requireOperationIdentifier(x.idempotencyKey, 'idempotencyKey');
        if (!(PROJECT_OPERATION_KIND_VALUES as readonly string[]).includes(x.kind)) {
          operationInputError('INVALID_INPUT', 'kind must be a canonical operation kind.');
        }
        const row = db
          .prepare(
            'SELECT * FROM project_operations WHERE project_id=? AND kind=? AND idempotency_key=?',
          )
          .get(x.projectId, x.kind, x.idempotencyKey) as Record<string, unknown> | undefined;
        return row ? mapProjectOperationRow(row) : null;
      }
      case 'markProjectOperationsInterrupted': {
        const x = p as PersistencePayloads['markProjectOperationsInterrupted'];
        requireOperationIdentifier(x.projectId, 'projectId');
        const at =
          x.at === undefined
            ? new Date().toISOString()
            : typeof x.at === 'string' && x.at.length > 0 && x.at.length <= 64
              ? x.at
              : operationInputError('INVALID_INPUT', 'at must be a non-empty timestamp.');
        const result = db
          .prepare(
            "UPDATE project_operations SET status='interrupted', updated_at=? WHERE project_id=? AND status IN ('queued','running')",
          )
          .run(at, x.projectId);
        return {
          updated: Number(result.changes),
        } satisfies PersistenceResults['markProjectOperationsInterrupted'];
      }
      case 'countProjectOperations': {
        const x = p as PersistencePayloads['countProjectOperations'];
        requireOperationIdentifier(x.projectId, 'projectId');
        if (x.status !== undefined) {
          if (!(PROJECT_OPERATION_STATUS_VALUES as readonly string[]).includes(x.status)) {
            operationInputError('INVALID_INPUT', 'status must be a canonical operation status.');
          }
        }
        const row = (
          x.status !== undefined
            ? db
                .prepare(
                  'SELECT COUNT(*) AS count FROM project_operations WHERE project_id=? AND status=?',
                )
                .get(x.projectId, x.status)
            : db
                .prepare('SELECT COUNT(*) AS count FROM project_operations WHERE project_id=?')
                .get(x.projectId)
        ) as Record<string, unknown>;
        return { count: Number(row.count) } satisfies PersistenceResults['countProjectOperations'];
      }
      // ─── V6: durable publication repository ─────────────────────────────
      case 'upsertProjectPublication': {
        const x = p as PersistencePayloads['upsertProjectPublication'];
        const record = requireProjectPublicationRecord(x.record);
        const existing = db
          .prepare('SELECT * FROM project_publications WHERE project_id=? AND publication_id=?')
          .get(record.projectId, record.publicationId) as Record<string, unknown> | undefined;
        const readRow = (): ProjectPublicationRecordV1 =>
          mapProjectPublicationRow(
            db
              .prepare('SELECT * FROM project_publications WHERE project_id=? AND publication_id=?')
              .get(record.projectId, record.publicationId) as Record<string, unknown>,
          );
        if (existing === undefined) {
          db.prepare(
            'INSERT INTO project_publications(project_id,publication_id,kind,status,source_hash,scope_hash,revision_ids,novel_hash,relative_output_path,byte_length,actor_id,operation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            record.projectId,
            record.publicationId,
            record.kind,
            record.value.status,
            record.value.sourceHash,
            record.value.scopeHash,
            json(record.value.revisionIds),
            record.value.novelHash,
            record.value.relativeOutputPath,
            record.value.byteLength,
            record.value.actorId,
            record.value.operationId,
            record.value.createdAt,
            record.updatedAt,
          );
          return {
            record: readRow(),
            created: true,
            applied: true,
          } satisfies PersistenceResults['upsertProjectPublication'];
        }
        if (
          x.expectedStatus !== undefined &&
          parsePublicationStatus(existing.status) !== x.expectedStatus
        ) {
          return {
            record: mapProjectPublicationRow(existing),
            created: false,
            applied: false,
          } satisfies PersistenceResults['upsertProjectPublication'];
        }
        assertPublicationIdentityUnchanged(existing, record);
        const from = parsePublicationStatus(existing.status);
        const to = record.value.status;
        if (!PUBLICATION_TRANSITIONS[from].includes(to)) {
          publicationInputError(
            'ILLEGAL_OPERATION_TRANSITION',
            `Cannot transition publication ${record.projectId}/${record.publicationId} from ${from} to ${to}.`,
          );
        }
        db.prepare(
          'UPDATE project_publications SET status=?, source_hash=?, scope_hash=?, revision_ids=?, novel_hash=?, relative_output_path=?, byte_length=?, actor_id=?, operation_id=?, created_at=?, updated_at=? WHERE project_id=? AND publication_id=?',
        ).run(
          record.value.status,
          record.value.sourceHash,
          record.value.scopeHash,
          json(record.value.revisionIds),
          record.value.novelHash,
          record.value.relativeOutputPath,
          record.value.byteLength,
          record.value.actorId,
          record.value.operationId,
          record.value.createdAt,
          record.updatedAt,
          record.projectId,
          record.publicationId,
        );
        return {
          record: readRow(),
          created: false,
          applied: true,
        } satisfies PersistenceResults['upsertProjectPublication'];
      }
      case 'getProjectPublication': {
        const x = p as PersistencePayloads['getProjectPublication'];
        requirePublicationIdentifier(x.projectId, 'projectId');
        requirePublicationIdentifier(x.publicationId, 'publicationId');
        const row = db
          .prepare('SELECT * FROM project_publications WHERE project_id=? AND publication_id=?')
          .get(x.projectId, x.publicationId) as Record<string, unknown> | undefined;
        return row ? mapProjectPublicationRow(row) : null;
      }
      case 'listProjectPublications': {
        const x = p as PersistencePayloads['listProjectPublications'];
        requirePublicationIdentifier(x.projectId, 'projectId');
        const limit = x.limit != null ? Math.min(Math.max(1, x.limit), 100) : 50;
        const args: Array<string | number | null> = [x.projectId];
        let sql = 'SELECT * FROM project_publications WHERE project_id=?';
        if (x.before !== undefined) {
          const cursor = parsePublicationListCursor(x.before);
          sql += ' AND (updated_at < ? OR (updated_at = ? AND publication_id < ?))';
          args.push(cursor.updatedAt, cursor.updatedAt, cursor.publicationId);
        }
        sql += ' ORDER BY updated_at DESC, publication_id DESC LIMIT ?';
        args.push(limit);
        const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
        return rows.map(mapProjectPublicationRow);
      }
      // ─── V7: durable agent records ─────────────────────────────────────
      case 'createAgentConversation': {
        const x = p as PersistencePayloads['createAgentConversation'];
        const record = requireAgentConversationRecord(x);
        const existing = db
          .prepare('SELECT conversation_id FROM agent_conversations WHERE conversation_id=?')
          .get(record.conversationId);
        if (existing !== undefined) {
          agentInputError(
            'CONVERSATION_EXISTS',
            `Agent conversation ${record.conversationId} already exists.`,
          );
        }
        db.prepare(
          'INSERT INTO agent_conversations(conversation_id,project_id,principal_user_id,role,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          record.conversationId,
          record.projectId,
          record.principalUserId,
          record.role,
          record.title,
          record.createdAt,
          record.updatedAt,
        );
        return mapAgentConversationRow(
          db
            .prepare('SELECT * FROM agent_conversations WHERE conversation_id=?')
            .get(record.conversationId) as Record<string, unknown>,
        );
      }
      case 'appendAgentConversation': {
        const x = p as PersistencePayloads['appendAgentConversation'];
        const conversationId = requireAgentIdentifier(x.conversationId, 'conversationId');
        const at = requireAgentTimestamp(x.at, 'at');
        const title =
          x.title === undefined ? undefined : requireAgentOptionalString(x.title, 'title', 512);
        const existing = db
          .prepare('SELECT * FROM agent_conversations WHERE conversation_id=?')
          .get(conversationId) as Record<string, unknown> | undefined;
        if (existing === undefined) {
          agentInputError(
            'CONVERSATION_NOT_FOUND',
            `Agent conversation ${conversationId} not found.`,
          );
        }
        if (title === undefined) {
          db.prepare('UPDATE agent_conversations SET updated_at=? WHERE conversation_id=?').run(
            at,
            conversationId,
          );
        } else {
          db.prepare(
            'UPDATE agent_conversations SET title=?, updated_at=? WHERE conversation_id=?',
          ).run(title, at, conversationId);
        }
        return mapAgentConversationRow(
          db
            .prepare('SELECT * FROM agent_conversations WHERE conversation_id=?')
            .get(conversationId) as Record<string, unknown>,
        );
      }
      case 'getAgentConversation': {
        const x = p as PersistencePayloads['getAgentConversation'];
        const conversationId = requireAgentIdentifier(x.conversationId, 'conversationId');
        const row = db
          .prepare('SELECT * FROM agent_conversations WHERE conversation_id=?')
          .get(conversationId) as Record<string, unknown> | undefined;
        return row ? mapAgentConversationRow(row) : null;
      }
      case 'listAgentConversations': {
        const x = p as PersistencePayloads['listAgentConversations'];
        if (x.projectId !== undefined) requireAgentIdentifier(x.projectId, 'projectId');
        if (x.principalUserId !== undefined) {
          requireAgentIdentifier(x.principalUserId, 'principalUserId');
        }
        const limit = x.limit != null ? Math.min(Math.max(1, x.limit), 100) : 50;
        const args: Array<string | number | null> = [];
        const where: string[] = [];
        if (x.projectId !== undefined) {
          where.push('project_id=?');
          args.push(x.projectId);
        }
        if (x.principalUserId !== undefined) {
          where.push('principal_user_id=?');
          args.push(x.principalUserId);
        }
        let sql = 'SELECT * FROM agent_conversations';
        if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
        if (x.before !== undefined) {
          const cursor = parseAgentListCursor(x.before);
          sql += `${where.length > 0 ? ' AND' : ' WHERE'} (updated_at < ? OR (updated_at = ? AND conversation_id < ?))`;
          args.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
        }
        sql += ' ORDER BY updated_at DESC, conversation_id DESC LIMIT ?';
        args.push(limit);
        const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
        return rows.map(mapAgentConversationRow);
      }
      case 'createAgentRun': {
        const x = p as PersistencePayloads['createAgentRun'];
        const record = requireAgentRunRecord(x);
        const conversation = db
          .prepare('SELECT project_id FROM agent_conversations WHERE conversation_id=?')
          .get(record.conversationId) as { project_id: unknown } | undefined;
        if (conversation === undefined) {
          agentInputError(
            'CONVERSATION_NOT_FOUND',
            `Agent conversation ${record.conversationId} not found; cannot create run ${record.runId}.`,
          );
        }
        if (text(conversation.project_id) !== record.projectId) {
          agentInputError(
            'INVALID_INPUT',
            `Agent run projectId ${record.projectId} does not match conversation ${record.conversationId} projectId ${text(conversation.project_id)}.`,
          );
        }
        const existing = db
          .prepare('SELECT run_id FROM agent_runs WHERE run_id=?')
          .get(record.runId);
        if (existing !== undefined) {
          agentInputError('RUN_EXISTS', `Agent run ${record.runId} already exists.`);
        }
        db.prepare(
          'INSERT INTO agent_runs(run_id,conversation_id,project_id,operation_id,principal_user_id,role,status,turn,max_turns,tool_calls,max_tool_calls,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          record.runId,
          record.conversationId,
          record.projectId,
          record.operationId,
          record.principalUserId,
          record.role,
          record.status,
          record.turn,
          record.maxTurns,
          record.toolCalls,
          record.maxToolCalls,
          record.createdAt,
          record.updatedAt,
        );
        return mapAgentRunRow(
          db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(record.runId) as Record<
            string,
            unknown
          >,
        );
      }
      case 'transitionAgentRun': {
        const x = p as PersistencePayloads['transitionAgentRun'];
        const runId = requireAgentIdentifier(x.runId, 'runId');
        const status = requireAgentRunStatus(x.status);
        const expectedStatus = requireAgentRunStatus(x.expectedStatus);
        const at = requireAgentTimestamp(x.at, 'at');
        const turn = x.turn === undefined ? undefined : requireAgentCounter(x.turn, 'turn', 1000);
        const toolCalls =
          x.toolCalls === undefined
            ? undefined
            : requireAgentCounter(x.toolCalls, 'toolCalls', 100000);
        const existing = db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(runId) as
          | Record<string, unknown>
          | undefined;
        if (existing === undefined) {
          agentInputError('RUN_NOT_FOUND', `Agent run ${runId} not found.`);
        }
        if (parseAgentRunStatus(existing.status) !== expectedStatus) {
          return {
            record: mapAgentRunRow(existing),
            applied: false,
          } satisfies PersistenceResults['transitionAgentRun'];
        }
        const from = parseAgentRunStatus(existing.status);
        if (!AGENT_RUN_TRANSITIONS[from].includes(status)) {
          agentInputError(
            'ILLEGAL_RUN_TRANSITION',
            `Cannot transition agent run ${runId} from ${from} to ${status}.`,
          );
        }
        const counters = applyAgentRunCounters(existing, turn, toolCalls);
        db.prepare(
          'UPDATE agent_runs SET status=?, turn=?, tool_calls=?, updated_at=? WHERE run_id=?',
        ).run(status, counters.turn, counters.toolCalls, at, runId);
        return {
          record: mapAgentRunRow(
            db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(runId) as Record<
              string,
              unknown
            >,
          ),
          applied: true,
        } satisfies PersistenceResults['transitionAgentRun'];
      }
      case 'checkpointAgentRun': {
        const x = p as PersistencePayloads['checkpointAgentRun'];
        const runId = requireAgentIdentifier(x.runId, 'runId');
        const at = requireAgentTimestamp(x.at, 'at');
        const turn = x.turn === undefined ? undefined : requireAgentCounter(x.turn, 'turn', 1000);
        const toolCalls =
          x.toolCalls === undefined
            ? undefined
            : requireAgentCounter(x.toolCalls, 'toolCalls', 100000);
        if (turn === undefined && toolCalls === undefined) {
          agentInputError(
            'INVALID_INPUT',
            'checkpointAgentRun requires at least one counter update.',
          );
        }
        const existing = db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(runId) as
          | Record<string, unknown>
          | undefined;
        if (existing === undefined) {
          agentInputError('RUN_NOT_FOUND', `Agent run ${runId} not found.`);
        }
        const status = parseAgentRunStatus(existing.status);
        if (status !== 'queued' && status !== 'running' && status !== 'interrupted') {
          agentInputError(
            'ILLEGAL_RUN_TRANSITION',
            `Cannot checkpoint counters of agent run ${runId} in terminal status ${status}.`,
          );
        }
        const counters = applyAgentRunCounters(existing, turn, toolCalls);
        db.prepare('UPDATE agent_runs SET turn=?, tool_calls=?, updated_at=? WHERE run_id=?').run(
          counters.turn,
          counters.toolCalls,
          at,
          runId,
        );
        return mapAgentRunRow(
          db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(runId) as Record<
            string,
            unknown
          >,
        );
      }
      case 'markAgentRunsInterrupted': {
        const x = p as PersistencePayloads['markAgentRunsInterrupted'];
        requireAgentIdentifier(x.projectId, 'projectId');
        const at =
          x.at === undefined ? new Date().toISOString() : requireAgentTimestamp(x.at, 'at');
        const result = db
          .prepare(
            "UPDATE agent_runs SET status='interrupted', updated_at=? WHERE project_id=? AND status IN ('queued','running')",
          )
          .run(at, x.projectId);
        return {
          updated: Number(result.changes),
        } satisfies PersistenceResults['markAgentRunsInterrupted'];
      }
      case 'getAgentRun': {
        const x = p as PersistencePayloads['getAgentRun'];
        const runId = requireAgentIdentifier(x.runId, 'runId');
        const row = db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(runId) as
          | Record<string, unknown>
          | undefined;
        return row ? mapAgentRunRow(row) : null;
      }
      case 'listAgentRuns': {
        const x = p as PersistencePayloads['listAgentRuns'];
        if (x.conversationId !== undefined)
          requireAgentIdentifier(x.conversationId, 'conversationId');
        if (x.projectId !== undefined) requireAgentIdentifier(x.projectId, 'projectId');
        if (x.status !== undefined) requireAgentRunStatus(x.status);
        const limit = x.limit != null ? Math.min(Math.max(1, x.limit), 100) : 50;
        const args: Array<string | number | null> = [];
        const where: string[] = [];
        if (x.conversationId !== undefined) {
          where.push('conversation_id=?');
          args.push(x.conversationId);
        }
        if (x.projectId !== undefined) {
          where.push('project_id=?');
          args.push(x.projectId);
        }
        if (x.status !== undefined) {
          where.push('status=?');
          args.push(x.status);
        }
        let sql = 'SELECT * FROM agent_runs';
        if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
        if (x.before !== undefined) {
          const cursor = parseAgentListCursor(x.before);
          sql += `${where.length > 0 ? ' AND' : ' WHERE'} (updated_at < ? OR (updated_at = ? AND run_id < ?))`;
          args.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
        }
        sql += ' ORDER BY updated_at DESC, run_id DESC LIMIT ?';
        args.push(limit);
        const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
        return rows.map(mapAgentRunRow);
      }
      case 'appendAgentToolCall': {
        const x = p as PersistencePayloads['appendAgentToolCall'];
        const record = requireAgentToolCallRecord(x);
        if (record.status !== 'pending' || record.resultRef !== null) {
          agentInputError(
            'INVALID_INPUT',
            'appended tool calls must be pending with no resultRef; use updateAgentToolCallStatus to record completion.',
          );
        }
        const run = db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(record.runId) as
          | Record<string, unknown>
          | undefined;
        if (run === undefined) {
          agentInputError('RUN_NOT_FOUND', `Agent run ${record.runId} not found.`);
        }
        const runStatus = parseAgentRunStatus(run.status);
        if (runStatus !== 'running') {
          agentInputError(
            'ILLEGAL_RUN_TRANSITION',
            `Cannot append tool calls to agent run ${record.runId} in status ${runStatus}; the run must be running.`,
          );
        }
        if (record.turn > Number(run.max_turns)) {
          agentInputError(
            'INVALID_INPUT',
            `tool call turn (${record.turn}) exceeds maxTurns (${text(run.max_turns)}) of run ${record.runId}.`,
          );
        }
        const countRow = db
          .prepare('SELECT COUNT(*) AS count FROM agent_tool_calls WHERE run_id=?')
          .get(record.runId) as { count: unknown };
        const expectedIndex = Number(countRow.count);
        if (record.callIndex !== expectedIndex) {
          agentInputError(
            'TOOL_CALL_APPEND_VIOLATION',
            `tool call callIndex ${record.callIndex} must equal the next ordinal ${expectedIndex} for run ${record.runId}; appends are strictly sequential.`,
          );
        }
        if (Number(run.tool_calls) !== expectedIndex) {
          agentInputError(
            'INVALID_INPUT',
            `tool call counter (${text(run.tool_calls)}) of run ${record.runId} does not match its appended call count (${expectedIndex}); the counter is kept in sync by appends.`,
          );
        }
        const nextToolCalls = expectedIndex + 1;
        if (nextToolCalls > Number(run.max_tool_calls)) {
          agentInputError(
            'INVALID_INPUT',
            `tool call append would exceed maxToolCalls (${text(run.max_tool_calls)}) of run ${record.runId}.`,
          );
        }
        db.prepare(
          'INSERT INTO agent_tool_calls(run_id,call_index,tool_name,sanitized_args_hash,result_ref,turn,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          record.runId,
          record.callIndex,
          record.toolName,
          record.sanitizedArgsHash,
          record.resultRef,
          record.turn,
          record.status,
          record.createdAt,
        );
        db.prepare('UPDATE agent_runs SET tool_calls=?, updated_at=? WHERE run_id=?').run(
          nextToolCalls,
          record.createdAt,
          record.runId,
        );
        return mapAgentToolCallRow(
          db
            .prepare('SELECT * FROM agent_tool_calls WHERE run_id=? AND call_index=?')
            .get(record.runId, record.callIndex) as Record<string, unknown>,
        );
      }
      case 'updateAgentToolCallStatus': {
        const x = p as PersistencePayloads['updateAgentToolCallStatus'];
        const runId = requireAgentIdentifier(x.runId, 'runId');
        const callIndex = requireAgentCallIndex(x.callIndex);
        const status = requireAgentToolCallStatus(x.status);
        const resultRef = requireAgentOptionalString(x.resultRef, 'resultRef', 1024);
        const _at = requireAgentTimestamp(x.at, 'at');
        if (status === 'pending') {
          agentInputError(
            'INVALID_INPUT',
            'updateAgentToolCallStatus target must be succeeded or failed.',
          );
        }
        if (status === 'succeeded' && resultRef === null) {
          agentInputError(
            'INVALID_INPUT',
            'resultRef is required when marking a tool call succeeded.',
          );
        }
        const existing = db
          .prepare('SELECT * FROM agent_tool_calls WHERE run_id=? AND call_index=?')
          .get(runId, callIndex) as Record<string, unknown> | undefined;
        if (existing === undefined) {
          agentInputError('TOOL_CALL_NOT_FOUND', `Tool call ${runId}#${callIndex} not found.`);
        }
        const from = requireAgentToolCallStatus(existing.status);
        if (from !== 'pending') {
          agentInputError(
            'ILLEGAL_TOOL_CALL_TRANSITION',
            `Cannot transition tool call ${runId}#${callIndex} from ${from} to ${status}; only pending calls may complete.`,
          );
        }
        db.prepare(
          'UPDATE agent_tool_calls SET status=?, result_ref=? WHERE run_id=? AND call_index=?',
        ).run(status, resultRef, runId, callIndex);
        return mapAgentToolCallRow(
          db
            .prepare('SELECT * FROM agent_tool_calls WHERE run_id=? AND call_index=?')
            .get(runId, callIndex) as Record<string, unknown>,
        );
      }
      case 'listAgentToolCalls': {
        const x = p as PersistencePayloads['listAgentToolCalls'];
        const runId = requireAgentIdentifier(x.runId, 'runId');
        const limit = x.limit != null ? Math.min(Math.max(1, x.limit), 100) : 50;
        const args: Array<string | number> = [runId];
        let sql = 'SELECT * FROM agent_tool_calls WHERE run_id=?';
        if (x.after !== undefined) {
          const after = requireAgentCallIndex(x.after);
          sql += ' AND call_index > ?';
          args.push(after);
        }
        sql += ' ORDER BY call_index ASC LIMIT ?';
        args.push(limit);
        const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
        return rows.map(mapAgentToolCallRow);
      }
      case 'appendAgentMessage': {
        const x = p as PersistencePayloads['appendAgentMessage'];
        const record = requireAgentMessageRecord(x);
        const conversation = db
          .prepare('SELECT conversation_id FROM agent_conversations WHERE conversation_id=?')
          .get(record.conversationId);
        if (conversation === undefined) {
          agentInputError(
            'CONVERSATION_NOT_FOUND',
            `Agent conversation ${record.conversationId} not found; cannot append message ${record.messageId}.`,
          );
        }
        const existing = db
          .prepare('SELECT message_id FROM agent_conversation_messages WHERE message_id=?')
          .get(record.messageId);
        if (existing !== undefined) {
          agentInputError('MESSAGE_EXISTS', `Agent message ${record.messageId} already exists.`);
        }
        db.prepare(
          'INSERT INTO agent_conversation_messages(message_id,conversation_id,run_id,role,content,tool_name,call_index,created_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          record.messageId,
          record.conversationId,
          record.runId,
          record.role,
          record.content,
          record.toolName,
          record.callIndex,
          record.createdAt,
        );
        return { appended: true } satisfies PersistenceResults['appendAgentMessage'];
      }
      case 'listAgentMessages': {
        const x = p as PersistencePayloads['listAgentMessages'];
        const conversationId = requireAgentIdentifier(x.conversationId, 'conversationId');
        const limit = x.limit != null ? Math.min(Math.max(1, x.limit), 100) : 50;
        const rows = db
          .prepare(
            'SELECT * FROM agent_conversation_messages WHERE conversation_id=? ORDER BY created_at ASC, message_id ASC LIMIT ?',
          )
          .all(conversationId, limit) as Record<string, unknown>[];
        return rows.map(mapAgentMessageRow);
      }
      default: {
        // Unreachable per the typed union, but reachable for malformed wire
        // input: fail closed instead of answering a bogus operation.
        throw {
          code: 'UNKNOWN_OPERATION',
          message: `Unknown persistence operation: ${String(request.operation)}`,
          retryable: false,
        };
      }
    }
  };
  const handleMessage = (request: PersistenceRequest): void => {
    _queued += 1;
    queue = queue.then(async () => {
      try {
        let response: PersistenceResponse;
        try {
          const result = execute(request);
          response = {
            correlationId: request.correlationId,
            ok: true,
            operation: request.operation,
            result,
          } as PersistenceResponse;
        } catch (error) {
          response = {
            correlationId: request.correlationId,
            ok: false,
            error: serializePersistenceError(error),
          };
        }
        try {
          respond(request, response);
        } catch {
          // The response could not be delivered (the port may already be
          // closed mid-drain). The request still executed; keep the serial
          // queue alive so later requests are not silently wedged behind it.
        }
      } finally {
        _queued -= 1;
      }
    });
  };
  port.addListener('message', handleMessage);

  return {
    dispose: (): Promise<void> => {
      if (closePromise) return closePromise;
      // Stop accepting new requests first. With the listener detached, all
      // requests already accepted remain serialized in `queue`.
      port.removeListener('message', handleMessage);
      const finish = async (): Promise<void> => {
        try {
          await closeDatabase();
        } finally {
          port.close();
        }
      };
      // Handle either settlement direction so cleanup itself remains complete
      // even if an unexpected response failure rejects the queue.
      closePromise = queue.then(finish, finish);
      return closePromise;
    },
  };
}

if (parentPort && workerData?.databasePath) start(parentPort, workerData as WorkerOptions);

export { createWorkerDatabase, migrate, type PersistenceOperation, start };
