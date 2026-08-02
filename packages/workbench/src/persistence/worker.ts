import { DatabaseSync } from 'node:sqlite';
import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import { Kysely, SqliteDialect } from 'kysely';
import type {
  AuthUserRecord,
  ConsumeInviteResult,
  GitSubmissionJournal,
  GitSubmissionPhase,
  GitSubmissionReceipt,
  InviteState,
  PasswordHashRecord,
  PersistenceOperation,
  PersistencePayloads,
  PersistenceResults,
  UserRole,
} from '../contracts/persistence.js';
import {
  GIT_SUBMISSION_PHASE_COMPLETE,
  GIT_SUBMISSION_PHASE_CONFLICT,
  GIT_SUBMISSION_PHASE_STALE,
  GIT_SUBMISSION_PHASE_VALUES,
} from '../contracts/persistence.js';
import { createKyselySqliteDatabase, type KyselySqliteBridge } from './kysely-sqlite-bridge.js';
import type { PersistenceRequest, PersistenceResponse } from './messages.js';
import { serializePersistenceError } from './messages.js';
import { persistenceSchema } from './schema.js';

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
function migrate(db: WorkerDatabase): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL);',
  );
  const current = Number(
    (
      db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as {
        version: number;
      }
    ).version,
  );
  for (const migration of persistenceSchema) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of migration.tables) {
        const composite = table.primaryKey;
        const columns = table.columns
          .map(
            (column) =>
              `${column.name} ${sqlType(column.type)}${column.nullable ? '' : ' NOT NULL'}${column.primaryKey && !composite ? ' PRIMARY KEY' : ''}`,
          )
          .join(', ');
        const primaryKeyClause =
          composite && composite.length > 0 ? `, PRIMARY KEY (${composite.join(', ')})` : '';
        db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (${columns}${primaryKeyClause})`);
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
  return {
    inviteId: text(row.invite_id),
    ...(row.project_id != null ? { projectId: text(row.project_id) } : {}),
    role: text(row.role),
    expiresAt: text(row.expires_at),
    ...(row.consumed_at != null ? { consumedAt: text(row.consumed_at) } : {}),
  };
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

function start(port: MessagePort, options: WorkerOptions): WorkerDisposer {
  const db = createWorkerDatabase(options.databasePath);
  migrate(db);
  let queued = 0;
  let dbClosed = false;
  let closePromise: Promise<void> | undefined;
  const closeDatabase = async (): Promise<void> => {
    if (dbClosed) return;
    dbClosed = true;
    await db.close();
  };
  let queue = Promise.resolve();
  const respond = (request: PersistenceRequest, response: PersistenceResponse): void =>
    port.postMessage(response);
  const execute = (request: PersistenceRequest): unknown => {
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
        db.prepare('INSERT OR REPLACE INTO invites VALUES (?,?,?,?,?)').run(
          x.inviteId,
          x.projectId ?? null,
          x.role,
          x.expiresAt,
          x.consumedAt ?? null,
        );
        return x;
      }
      case 'consumeInvite': {
        const x = p as PersistencePayloads['consumeInvite'];
        const result = db
          .prepare(
            'UPDATE invites SET consumed_at=? WHERE invite_id=? AND consumed_at IS NULL AND expires_at>=?',
          )
          .run(x.consumedAt, x.inviteId, x.consumedAt);
        const row = db.prepare('SELECT * FROM invites WHERE invite_id=?').get(x.inviteId) as
          | Record<string, unknown>
          | undefined;
        if (!row) return { status: 'not-found' } satisfies ConsumeInviteResult;
        if (Number(result.changes) === 1)
          return { status: 'accepted', invite: mapInviteRow(row) } satisfies ConsumeInviteResult;
        if (row.consumed_at != null)
          return { status: 'already-consumed' } satisfies ConsumeInviteResult;
        return { status: 'expired' } satisfies ConsumeInviteResult;
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
    queued += 1;
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
        queued -= 1;
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
