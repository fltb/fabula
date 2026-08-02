/** Declarative persistence schema; executable SQL deliberately does not belong here. */
export interface PersistenceColumn {
  name: string;
  type: 'text' | 'integer' | 'blob' | 'json';
  nullable?: boolean;
  primaryKey?: boolean;
}
export interface PersistenceTable {
  name: string;
  columns: readonly PersistenceColumn[];
  /** Table-level composite primary key; used instead of inline column PRIMARY KEY flags. */
  primaryKey?: readonly string[];
}
export interface PersistenceMigration {
  version: number;
  description: string;
  tables: readonly PersistenceTable[];
}

export const persistenceSchema: readonly PersistenceMigration[] = [
  {
    version: 1,
    description: 'Initial Workbench domain persistence',
    tables: [
      {
        name: 'yjs_documents',
        primaryKey: ['project_id', 'document_id'],
        columns: [
          { name: 'project_id', type: 'text' },
          { name: 'document_id', type: 'text' },
          { name: 'state_vector', type: 'blob' },
          { name: 'document_update', type: 'blob' },
          { name: 'updated_at', type: 'text' },
        ],
      },
      {
        name: 'users',
        columns: [
          { name: 'user_id', type: 'text', primaryKey: true },
          { name: 'role', type: 'text' },
          { name: 'display_name', type: 'text' },
          { name: 'password_hash', type: 'json' },
          { name: 'capability_version', type: 'integer' },
          { name: 'created_at', type: 'text' },
          { name: 'updated_at', type: 'text' },
        ],
      },
      {
        name: 'auth_backoff',
        columns: [
          { name: 'subject', type: 'text', primaryKey: true },
          { name: 'failures', type: 'integer' },
          { name: 'updated_at', type: 'text' },
        ],
      },
      {
        name: 'sessions',
        columns: [
          { name: 'session_id', type: 'text', primaryKey: true },
          { name: 'user_id', type: 'text' },
          { name: 'expires_at', type: 'text' },
          { name: 'capability_version', type: 'integer' },
        ],
      },
      {
        name: 'invites',
        columns: [
          { name: 'invite_id', type: 'text', primaryKey: true },
          { name: 'project_id', type: 'text', nullable: true },
          { name: 'role', type: 'text' },
          { name: 'expires_at', type: 'text' },
          { name: 'consumed_at', type: 'text', nullable: true },
        ],
      },
      {
        name: 'capabilities',
        columns: [
          { name: 'capability_id', type: 'text', primaryKey: true },
          { name: 'user_id', type: 'text' },
          { name: 'project_id', type: 'text' },
          { name: 'scope', type: 'json' },
          { name: 'version', type: 'integer' },
          { name: 'expires_at', type: 'text' },
          { name: 'revoked_at', type: 'text', nullable: true },
        ],
      },
      {
        name: 'projects',
        columns: [
          { name: 'project_id', type: 'text', primaryKey: true },
          { name: 'display_name', type: 'text' },
          { name: 'root_label', type: 'text' },
          { name: 'created_at', type: 'text' },
          { name: 'updated_at', type: 'text' },
        ],
      },
      {
        name: 'operations',
        columns: [
          { name: 'operation_id', type: 'text', primaryKey: true },
          { name: 'checkpoint', type: 'text' },
          { name: 'version', type: 'integer' },
          { name: 'updated_at', type: 'text' },
        ],
      },
      {
        name: 'git_submissions',
        columns: [
          { name: 'submit_id', type: 'text', primaryKey: true },
          { name: 'project_id', type: 'text' },
          { name: 'phase', type: 'text' },
          { name: 'expected_git_head', type: 'text' },
          { name: 'candidate_commit', type: 'text', nullable: true },
          { name: 'receipt_hash', type: 'text', nullable: true },
          { name: 'diagnostic', type: 'text', nullable: true },
          { name: 'updated_at', type: 'text' },
        ],
      },
      {
        name: 'ui_preferences',
        columns: [
          { name: 'user_id', type: 'text', primaryKey: true },
          { name: 'preference_values', type: 'json' },
          { name: 'updated_at', type: 'text' },
        ],
      },
    ],
  },
  {
    version: 2,
    description:
      'Configuration operations, authoring coordination, append-only audit, and MCP device verifiers',
    tables: [
      {
        name: 'configuration_operations',
        columns: [
          { name: 'operation_id', type: 'text', primaryKey: true },
          { name: 'origin', type: 'text' },
          { name: 'status', type: 'text' },
          { name: 'active_revision', type: 'text', nullable: true },
          { name: 'candidate_revision', type: 'text', nullable: true },
          { name: 'changed_fields', type: 'json' },
          { name: 'diagnostics', type: 'json' },
          { name: 'actor_id', type: 'text', nullable: true },
          { name: 'at', type: 'text' },
        ],
      },
      {
        name: 'authoring_state',
        columns: [
          { name: 'project_id', type: 'text', primaryKey: true },
          { name: 'phase', type: 'text' },
          { name: 'accepted_source_hash', type: 'text', nullable: true },
          { name: 'observed_filesystem_hash', type: 'text', nullable: true },
          { name: 'workspace_digest', type: 'text', nullable: true },
          { name: 'candidate_hash', type: 'text', nullable: true },
          { name: 'candidate_valid', type: 'integer' },
          { name: 'conflicts', type: 'json' },
          { name: 'fixed_git_head', type: 'text', nullable: true },
          { name: 'pending_submit_id', type: 'text', nullable: true },
          { name: 'recovery_phase', type: 'text', nullable: true },
          { name: 'updated_at', type: 'text' },
        ],
      },
      {
        name: 'audit_log',
        columns: [
          { name: 'audit_id', type: 'text', primaryKey: true },
          { name: 'at', type: 'text' },
          { name: 'actor_id', type: 'text', nullable: true },
          { name: 'surface', type: 'text' },
          { name: 'operation_kind', type: 'text' },
          { name: 'outcome', type: 'text' },
          { name: 'project_id', type: 'text', nullable: true },
          { name: 'document_scope', type: 'text', nullable: true },
          { name: 'capability_version', type: 'integer', nullable: true },
          { name: 'base_source_hash', type: 'text', nullable: true },
          { name: 'result_source_hash', type: 'text', nullable: true },
          { name: 'workspace_digest', type: 'text', nullable: true },
          { name: 'submit_id', type: 'text', nullable: true },
          { name: 'git_receipt_hash', type: 'text', nullable: true },
          { name: 'detail', type: 'text', nullable: true },
        ],
      },
      {
        name: 'device_verifiers',
        columns: [
          { name: 'device_id', type: 'text', primaryKey: true },
          { name: 'token_hash', type: 'text' },
          { name: 'scope', type: 'json' },
          { name: 'expires_at', type: 'text' },
          { name: 'client_label', type: 'text' },
          { name: 'revoked_at', type: 'text', nullable: true },
          { name: 'created_at', type: 'text' },
        ],
      },
    ],
  },
];
