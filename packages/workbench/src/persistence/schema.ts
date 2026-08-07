/** Declarative persistence schema; executable SQL deliberately does not belong here. */
export interface PersistenceColumn {
  name: string;
  type: 'text' | 'integer' | 'blob' | 'json';
  nullable?: boolean;
  primaryKey?: boolean;
  /** A source-constant enum constraint, rendered by the worker migration engine. */
  values?: readonly string[];
}
export interface PersistenceTable {
  name: string;
  columns: readonly PersistenceColumn[];
  /** Table-level composite primary key; used instead of inline column PRIMARY KEY flags. */
  primaryKey?: readonly string[];
}
export interface PersistenceFilter {
  column: string;
  equals?: string;
  isNotNull?: boolean;
}
export type PersistenceMigrationStep =
  | { kind: 'create-table'; table: PersistenceTable }
  | {
      kind: 'rebuild-table';
      table: PersistenceTable;
      copy: { from: string; columns: readonly string[]; filter?: PersistenceFilter };
    }
  | {
      kind: 'create-index';
      name: string;
      table: string;
      columns: readonly string[];
      unique?: boolean;
      filter?: PersistenceFilter;
    }
  | {
      kind: 'virtual-table';
      name: string;
      using: 'fts5';
      columns: readonly string[];
      options?: readonly string[];
    }
  | { kind: 'copy-capability-verifiers' };
export interface PersistenceMigration {
  version: number;
  description: string;
  /** Kept for the v1/v2 source descriptors; new migrations use ordered steps. */
  tables?: readonly PersistenceTable[];
  steps?: readonly PersistenceMigrationStep[];
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
  {
    version: 3,
    description: 'Native immutable source revisions and materialization journal',
    steps: [
      {
        kind: 'create-table',
        table: {
          name: 'source_revisions',
          columns: [
            { name: 'revision_id', type: 'text', primaryKey: true },
            { name: 'project_id', type: 'text' },
            { name: 'parent_revision_id', type: 'text', nullable: true },
            { name: 'operation_id', type: 'text' },
            { name: 'source_hash', type: 'text' },
            { name: 'bundle_hash', type: 'text' },
            { name: 'actor_id', type: 'text' },
            { name: 'origin', type: 'text' },
            { name: 'created_at', type: 'text' },
            { name: 'accepted_at', type: 'text', nullable: true },
          ],
        },
      },
      {
        kind: 'create-table',
        table: {
          name: 'source_revision_operations',
          columns: [
            { name: 'operation_id', type: 'text', primaryKey: true },
            { name: 'project_id', type: 'text' },
            { name: 'expected_revision_id', type: 'text', nullable: true },
            { name: 'expected_source_hash', type: 'text', nullable: true },
            { name: 'revision_id', type: 'text', nullable: true },
            {
              name: 'phase',
              type: 'text',
              values: [
                'prepared',
                'accepted',
                'materializing',
                'materialized',
                'completed',
                'stale',
                'conflict',
                'recovery-required',
              ],
            },
            { name: 'receipt_hash', type: 'text', nullable: true },
            { name: 'diagnostic', type: 'text', nullable: true },
            { name: 'created_at', type: 'text' },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-table',
        table: {
          name: 'source_heads',
          columns: [
            { name: 'project_id', type: 'text', primaryKey: true },
            { name: 'accepted_revision_id', type: 'text', nullable: true },
            { name: 'accepted_source_hash', type: 'text', nullable: true },
            { name: 'materialized_revision_id', type: 'text', nullable: true },
            { name: 'materialized_source_hash', type: 'text', nullable: true },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-table',
        table: {
          name: 'source_materializations',
          primaryKey: ['project_id', 'revision_id'],
          columns: [
            { name: 'project_id', type: 'text' },
            { name: 'revision_id', type: 'text' },
            {
              name: 'phase',
              type: 'text',
              values: [
                'prepared',
                'accepted',
                'materializing',
                'materialized',
                'completed',
                'stale',
                'conflict',
                'recovery-required',
              ],
            },
            { name: 'expected_view_source_hash', type: 'text' },
            { name: 'target_source_hash', type: 'text' },
            { name: 'tree_hash', type: 'text' },
            { name: 'attempt', type: 'integer' },
            { name: 'diagnostic', type: 'text', nullable: true },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-table',
        table: {
          name: 'source_materialization_entries',
          primaryKey: ['project_id', 'revision_id', 'logical_path'],
          columns: [
            { name: 'project_id', type: 'text' },
            { name: 'revision_id', type: 'text' },
            { name: 'logical_path', type: 'text' },
            { name: 'old_hash', type: 'text', nullable: true },
            { name: 'target_hash', type: 'text', nullable: true },
            { name: 'applied_hash', type: 'text', nullable: true },
            { name: 'state', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-table',
        table: {
          name: 'authoring_working_documents',
          primaryKey: ['project_id', 'document_id'],
          columns: [
            { name: 'project_id', type: 'text' },
            { name: 'document_id', type: 'text' },
            { name: 'logical_path', type: 'text' },
            { name: 'kind', type: 'text' },
            { name: 'state', type: 'text', values: ['active', 'tombstone'] },
            { name: 'base_revision_id', type: 'text', nullable: true },
            { name: 'catalog_revision', type: 'integer' },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-index',
        name: 'authoring_working_documents_active_path',
        table: 'authoring_working_documents',
        unique: true,
        columns: ['project_id', 'logical_path'],
        filter: { column: 'state', equals: 'active' },
      },
      {
        kind: 'create-table',
        table: {
          name: 'revision_mirror_exports',
          primaryKey: ['project_id', 'revision_id', 'backend'],
          columns: [
            { name: 'project_id', type: 'text' },
            { name: 'revision_id', type: 'text' },
            { name: 'backend', type: 'text' },
            { name: 'state', type: 'text' },
            { name: 'external_id', type: 'text', nullable: true },
            { name: 'diagnostic', type: 'text', nullable: true },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
    ],
  },
  {
    version: 4,
    description: 'Project memberships and isolated capability/MCP verifier stores',
    steps: [
      {
        kind: 'create-table',
        table: {
          name: 'project_memberships',
          primaryKey: ['user_id', 'project_id'],
          columns: [
            { name: 'user_id', type: 'text' },
            { name: 'project_id', type: 'text' },
            {
              name: 'role',
              type: 'text',
              values: ['reader', 'author', 'maintainer'],
            },
            { name: 'created_at', type: 'text' },
            { name: 'revoked_at', type: 'text', nullable: true },
            { name: 'revision', type: 'integer' },
          ],
        },
      },
      {
        kind: 'create-table',
        table: {
          name: 'capability_verifiers',
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
      },
      {
        kind: 'create-table',
        table: {
          name: 'mcp_device_verifiers',
          columns: [
            { name: 'device_id', type: 'text', primaryKey: true },
            { name: 'verifier', type: 'text' },
            {
              name: 'kind',
              type: 'text',
              values: ['project', 'admin'],
            },
            { name: 'project_id', type: 'text', nullable: true },
            { name: 'owner_user_id', type: 'text' },
            { name: 'scopes', type: 'json' },
            { name: 'grant_revision', type: 'integer' },
            { name: 'expires_at', type: 'text' },
            { name: 'revoked_at', type: 'text', nullable: true },
            { name: 'created_at', type: 'text' },
          ],
        },
      },
      { kind: 'copy-capability-verifiers' },
    ],
  },
  {
    version: 5,
    description: 'Durable project operation queue with status transitions and idempotency',
    steps: [
      {
        kind: 'create-table',
        table: {
          name: 'project_operations',
          primaryKey: ['project_id', 'operation_id'],
          columns: [
            { name: 'project_id', type: 'text' },
            { name: 'operation_id', type: 'text' },
            { name: 'idempotency_key', type: 'text' },
            {
              name: 'kind',
              type: 'text',
              values: [
                'authoring-submit',
                'render',
                'revise',
                'render-tree',
                'review',
                'release-gate',
                'publish',
                'agent-run',
              ],
            },
            {
              name: 'status',
              type: 'text',
              values: [
                'queued',
                'running',
                'succeeded',
                'failed',
                'stale',
                'cancelled',
                'interrupted',
              ],
            },
            { name: 'actor_id', type: 'text' },
            { name: 'capability_version', type: 'integer' },
            { name: 'source_hash', type: 'text', nullable: true },
            { name: 'accepted_revision_id', type: 'text', nullable: true },
            { name: 'progress', type: 'json', nullable: true },
            { name: 'result_ref', type: 'text', nullable: true },
            { name: 'error_code', type: 'text', nullable: true },
            { name: 'version', type: 'integer' },
            { name: 'created_at', type: 'text' },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-index',
        name: 'project_operations_status_updated',
        table: 'project_operations',
        columns: ['project_id', 'status', 'updated_at'],
      },
      {
        kind: 'create-index',
        name: 'project_operations_idempotency',
        table: 'project_operations',
        unique: true,
        columns: ['project_id', 'kind', 'idempotency_key'],
      },
    ],
  },
  {
    version: 6,
    description: 'Durable per-project publication repository with CAS status transitions',
    steps: [
      {
        kind: 'create-table',
        table: {
          name: 'project_publications',
          primaryKey: ['project_id', 'publication_id'],
          columns: [
            { name: 'project_id', type: 'text' },
            { name: 'publication_id', type: 'text' },
            {
              name: 'kind',
              type: 'text',
              values: ['canonical', 'custom'],
            },
            {
              name: 'status',
              type: 'text',
              values: ['current', 'stale'],
            },
            { name: 'source_hash', type: 'text' },
            { name: 'scope_hash', type: 'text' },
            { name: 'revision_ids', type: 'json' },
            { name: 'novel_hash', type: 'text' },
            { name: 'relative_output_path', type: 'text' },
            { name: 'byte_length', type: 'integer' },
            { name: 'actor_id', type: 'text' },
            { name: 'operation_id', type: 'text' },
            { name: 'created_at', type: 'text' },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-index',
        name: 'project_publications_updated',
        table: 'project_publications',
        columns: ['project_id', 'updated_at'],
      },
    ],
  },
  {
    version: 7,
    description: 'Durable agent conversations, runs and tool calls',
    steps: [
      {
        kind: 'create-table',
        table: {
          name: 'agent_conversations',
          columns: [
            { name: 'conversation_id', type: 'text', primaryKey: true },
            { name: 'project_id', type: 'text' },
            { name: 'principal_user_id', type: 'text' },
            {
              name: 'role',
              type: 'text',
              values: ['reader', 'author', 'maintainer'],
            },
            { name: 'title', type: 'text', nullable: true },
            { name: 'created_at', type: 'text' },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-table',
        table: {
          name: 'agent_runs',
          columns: [
            { name: 'run_id', type: 'text', primaryKey: true },
            { name: 'conversation_id', type: 'text' },
            { name: 'project_id', type: 'text' },
            { name: 'operation_id', type: 'text', nullable: true },
            { name: 'principal_user_id', type: 'text' },
            {
              name: 'role',
              type: 'text',
              values: ['reader', 'author', 'maintainer'],
            },
            {
              name: 'status',
              type: 'text',
              values: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'],
            },
            { name: 'turn', type: 'integer' },
            { name: 'max_turns', type: 'integer' },
            { name: 'tool_calls', type: 'integer' },
            { name: 'max_tool_calls', type: 'integer' },
            { name: 'created_at', type: 'text' },
            { name: 'updated_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-index',
        name: 'agent_runs_status_updated',
        table: 'agent_runs',
        columns: ['project_id', 'status', 'updated_at'],
      },
      {
        kind: 'create-index',
        name: 'agent_runs_conversation',
        table: 'agent_runs',
        columns: ['conversation_id'],
      },
      {
        kind: 'create-table',
        table: {
          name: 'agent_tool_calls',
          primaryKey: ['run_id', 'call_index'],
          columns: [
            { name: 'run_id', type: 'text' },
            { name: 'call_index', type: 'integer' },
            { name: 'tool_name', type: 'text' },
            { name: 'sanitized_args_hash', type: 'text' },
            { name: 'result_ref', type: 'text', nullable: true },
            { name: 'turn', type: 'integer' },
            {
              name: 'status',
              type: 'text',
              values: ['pending', 'succeeded', 'failed'],
            },
            { name: 'created_at', type: 'text' },
          ],
        },
      },
    ],
  },
  {
    version: 8,
    description: 'Agent conversation messages for transcript history',
    steps: [
      {
        kind: 'create-table',
        table: {
          name: 'agent_conversation_messages',
          columns: [
            { name: 'message_id', type: 'text', primaryKey: true },
            { name: 'conversation_id', type: 'text' },
            { name: 'run_id', type: 'text' },
            {
              name: 'role',
              type: 'text',
              values: ['user', 'assistant', 'tool_result'],
            },
            { name: 'content', type: 'text' },
            { name: 'tool_name', type: 'text', nullable: true },
            { name: 'call_index', type: 'integer', nullable: true },
            { name: 'created_at', type: 'text' },
          ],
        },
      },
      {
        kind: 'create-index',
        name: 'agent_conversation_messages_conversation_created',
        table: 'agent_conversation_messages',
        columns: ['conversation_id', 'created_at'],
      },
    ],
  },
];
