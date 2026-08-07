import type { ProjectAccessRole } from './configuration.js';

/**
 * Persistence worker wire protocol (host-internal).
 * The browser-facing surface is `contracts/index.ts`, which re-exports only
 * non-secret domain DTOs. This module carries host-only state such as password
 * hash records and the typed operation map; never import it from client code.
 * Version 2 adds configuration operation/audit/recovery metadata, authoring
 * metadata, the append-only audit log, MCP device token
 * verifiers, and the dashboard queries over sessions/devices. Version 4 adds
 * durable project membership rows and isolated verifier stores. Version 5
 * adds the durable project operation queue with worker-enforced status
 * transitions and per-key idempotency. Version 6 adds the durable per-project
 * publication repository with CAS status transitions.
 * The worker never stores `workbench.yaml` contents and never stores secrets:
 * provider keys live in the credential store, and device verifiers persist
 * only the SHA-256 hash of the one-time credential (the raw credential is
 * shown once at pairing and never stored or returned).
 */

export type BinaryPayload = Uint8Array;

export interface YjsDocumentKey {
  projectId: string;
  documentId: string;
}
export interface WorkingDocumentState {
  key: YjsDocumentKey;
  stateVector: BinaryPayload;
  update: BinaryPayload;
  updatedAt: string;
}
export interface PersistYjsUpdateInput extends YjsDocumentKey {
  update: BinaryPayload;
  stateVector?: BinaryPayload;
}

export interface SessionState {
  sessionId: string;
  userId: string;
  expiresAt: string;
  capabilityVersion: number;
}
export interface InviteState {
  inviteId: string;
  projectId?: string;
  role: ProjectAccessRole;
  expiresAt: string;
  consumedAt?: string;
}
/**
 * Typed outcome of revoking an invite. The row is deleted only while it is
 * still unconsumed; an unknown or already-consumed invite is a typed failure,
 * never a silent success.
 */
export type RevokeInviteResult =
  | { status: 'revoked' }
  | { status: 'not-found' }
  | { status: 'already-consumed' };
export interface CapabilityState {
  capabilityId: string;
  userId: string;
  projectId: string;
  scope: string[];
  version: number;
  expiresAt: string;
  revokedAt?: string;
}

export type UserRole = 'owner' | 'user';
export interface UserState {
  userId: string;
  role: UserRole;
  displayName: string;
  capabilityVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** Versioned password hash record. Host-side secret: never re-exported through the browser contract barrel. */
export interface PasswordHashRecord {
  version: 1;
  algorithm: 'argon2id';
  saltBase64: string;
  hashBase64: string;
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

/** Full stored user row including the password hash; host-to-worker wire only. */
export interface AuthUserRecord extends UserState {
  passwordHash: PasswordHashRecord | null;
}

export interface AuthBackoffState {
  subject: string;
  failures: number;
  updatedAt: string;
}

export interface BootstrapOwnerInput {
  userId: string;
  displayName: string;
  passwordHash: PasswordHashRecord;
  capabilityVersion: number;
  createdAt: string;
}
export interface AcceptInviteUserInput {
  inviteId: string;
  consumedAt: string;
  userId: string;
  displayName: string;
  passwordHash: PasswordHashRecord;
  capabilityVersion: number;
  createdAt: string;
  session: SessionState;
}
export interface ResetOwnerPasswordInput {
  userId: string;
  passwordHash: PasswordHashRecord;
  capabilityVersion: number;
  at: string;
}
export interface ResetOwnerPasswordResult {
  user: AuthUserRecord;
  revokedSessions: number;
  revokedCapabilities: number;
}
export interface RecordAuthFailureInput {
  subject: string;
  at: string;
}
export interface AuthState {
  ownerUserId: string | null;
}

export type ConsumeInviteResult =
  | { status: 'accepted'; invite: InviteState }
  | { status: 'already-consumed' }
  | { status: 'expired' }
  | { status: 'not-found' };
export type AcceptInviteUserResult =
  | { status: 'accepted'; invite: InviteState; user: AuthUserRecord; session: SessionState }
  | { status: 'already-consumed' }
  | { status: 'expired' }
  | { status: 'not-found' };

export interface ProjectRegistryEntry {
  projectId: string;
  displayName: string;
  rootLabel: string;
  createdAt: string;
  updatedAt: string;
}
/** Durable, host-safe project ACL row. Revoked rows are never returned by active reads. */
export interface ProjectMembershipState {
  userId: string;
  projectId: string;
  role: ProjectAccessRole;
  createdAt: string;
  revision: number;
  revokedAt?: string;
  /** Current user capability generation, included for invalidation-aware admin reads. */
  capabilityVersion: number;
}
export interface LoadProjectMembershipInput {
  userId: string;
  projectId: string;
}
export interface ListProjectMembershipsInput {
  projectId?: string;
}
export interface UpsertProjectMembershipInput {
  userId: string;
  projectId: string;
  role: ProjectAccessRole;
  /** Host timestamp; omitted callers use the worker clock. */
  at?: string;
}
export interface RevokeProjectMembershipInput {
  userId: string;
  projectId: string;
  /** Host timestamp; omitted callers use the worker clock. */
  at?: string;
}
export interface ProjectMembershipMutationResult {
  membership: ProjectMembershipState | null;
  capabilityVersion: number;
  revokedCapabilities: number;
}

export interface OperationCheckpoint {
  operationId: string;
  checkpoint: string;
  version: number;
  updatedAt: string;
}
/**
 * Submit pipeline phases recorded in the durable journal. A phase names the
 * exact step a crash interrupted (or the typed outcome that ended the submit),
 * so a `submitId` retry can replay to the same result instead of inventing a
 * second commit. `manifest-rejected` marks an AuthoringManifest policy failure:
 * the candidate never reached the index, and retrying the same `submitId` must
 * reproduce the same typed rejection. `stale` and `conflict` are the two
 * distinct terminal stale/conflict outcomes recorded by recovery. Readers of
 * older rows must tolerate any phase string stored by a previous Host version.
 */
export const GIT_SUBMISSION_PHASE_VALUES = [
  'lock-acquired',
  'yjs-acked',
  'candidate-materialized',
  'manifest-rejected',
  'candidate-validated',
  'commit-created',
  'ref-cas',
  'stale',
  'conflict',
  'primary-synced',
  'receipt-written',
  'complete',
] as const;

/** Canonical phase of the durable submit journal (single source of truth). */
export type GitSubmissionPhase = (typeof GIT_SUBMISSION_PHASE_VALUES)[number];

/** Journal phase written when a submit is accepted; the row becomes immutable. */
export const GIT_SUBMISSION_PHASE_COMPLETE = 'complete' satisfies GitSubmissionPhase;
/** Terminal journal phase recorded when the expected base head no longer matches. */
export const GIT_SUBMISSION_PHASE_STALE = 'stale' satisfies GitSubmissionPhase;
/** Terminal journal phase recorded when the ref CAS cannot be resolved (external divergence, ambiguous submitId). */
export const GIT_SUBMISSION_PHASE_CONFLICT = 'conflict' satisfies GitSubmissionPhase;

export interface GitSubmissionJournal {
  submitId: string;
  projectId: string;
  phase: GitSubmissionPhase;
  expectedGitHead: string;
  candidateCommit?: string;
  receiptHash?: string;
  diagnostic?: string;
  updatedAt: string;
}
export interface GitSubmissionReceipt {
  submitId: string;
  projectId: string;
  commit: string;
  sourceHash: string;
  receiptHash: string;
  acceptedAt: string;
}
/**
 * Non-secret Git baseline provenance returned by Workbench bootstrap/reopen of
 * the fixed authoring ref. Carries only public commit identity (ref, commit,
 * tree, message, paths); never credentials, provider keys or other secrets.
 * `status` distinguishes the baseline created by this call from one that
 * already existed at the fixed ref (idempotent reopen).
 */
export interface GitBaselineRecord {
  readonly projectId: string;
  readonly status: 'created' | 'reopened';
  /** Fixed authoring ref, e.g. `refs/heads/workbench`. */
  readonly ref: string;
  /** Full commit object id at the ref. */
  readonly commit: string;
  /** Full tree object id of the ref head. */
  readonly tree: string;
  /** Commits reachable from the ref (1 immediately after first bootstrap). */
  readonly commitCount: number;
  /** Committer timestamp of the ref head (ISO 8601). */
  readonly committedAt: string;
  /** Ref head commit message (non-secret provenance). */
  readonly message: string;
  /** Tree paths at the ref head, sorted. */
  readonly entries: readonly string[];
}
export interface UiPreferences {
  userId: string;
  values: Record<string, string | number | boolean | null>;
  updatedAt: string;
}

// ─── V2: configuration operation/audit/recovery metadata ────────────────────

/**
 * One durable configuration change record (setup/dashboard/MCP/filesystem/
 * dotenv-import). Stores only metadata: revisions, changed field names,
 * diagnostics, origin and actor — never `workbench.yaml` contents, never
 * secrets, never filesystem paths.
 */
export interface ConfigurationOperationRecord {
  operationId: string;
  /** Which adapter produced the change (`setup` | `dashboard` | `mcp` | `filesystem` | `dotenv-import`). */
  origin: string;
  /** Receipt status: `applied` | `restart-required` | `invalid` | `stale`. */
  status: string;
  /** Content-hash revision that remained active after the change. */
  activeRevision?: string;
  /** Content-hash revision of the candidate that was applied or rejected. */
  candidateRevision?: string;
  /** Changed field paths (e.g. `network.port`), stable order. */
  changedFields: string[];
  diagnostics: { code: string; message: string }[];
  /** Authenticated actor id; absent for watcher/system-originated changes. */
  actorId?: string;
  at: string;
}

// ─── V2: authoring coordination metadata ────────────────────────────────────

/** Per-document working-vs-external conflict persisted by the coordinator. */
export interface AuthoringConflictRecord {
  logicalPath: string;
  kind: 'working-vs-external';
  baseSourceHash: string;
  workingHash: string;
  externalHash: string;
}

/**
 * One per-project row of durable coordinator state. Stores identity only —
 * hashes, phase, submit/recovery ids — never raw source, never Yjs bytes,
 * never secrets. External candidate content lives in the Host-private
 * staging bundle; SQLite holds just the hashes and metadata.
 */
export interface AuthoringStateRecord {
  projectId: string;
  /** Canonical coordinator phase (`AuthoringPhaseV1` string). */
  phase: string;
  /** Accepted last-valid source identity. */
  acceptedSourceHash?: string;
  /** Most recent full authoring-tree hash the watcher observed. */
  observedFilesystemHash?: string;
  /** Current stable workspace vector digest. */
  workspaceDigest?: string;
  /** Hash of the staged external candidate bundle, when one exists. */
  candidateHash?: string;
  /** Whether the staged candidate passed Core validation. */
  candidateValid: boolean;
  conflicts: AuthoringConflictRecord[];
  /** Fixed Git authoring ref head observed at the last accepted submit. */
  fixedGitHead?: string;
  /** Submit id of an in-flight/pending submit, when one exists. */
  pendingSubmitId?: string;
  /** Crash-recovery phase, when the coordinator is mid-recovery. */
  recoveryPhase?: string;
  updatedAt: string;
}

// ─── V2: append-only audit ──────────────────────────────────────────────────

/** Which surface produced an audited effect. */
export type AuditSurface = 'browser' | 'agent' | 'mcp' | 'filesystem' | 'submit' | 'system';

/**
 * One append-only audit entry. Records provenance (actor/surface/operation),
 * scope identity (project/document/capability version), base/result source
 * hashes, the workspace digest, and the Git submit receipt identity — never
 * raw source, tokens, keys, or any secret.
 */
export interface AuditRecord {
  auditId: string;
  at: string;
  actorId?: string;
  surface: AuditSurface;
  operationKind: string;
  outcome: 'completed' | 'failed' | 'denied';
  projectId?: string;
  /** Document scope (logical path or document id) the effect addressed. */
  documentScope?: string;
  capabilityVersion?: number;
  baseSourceHash?: string;
  resultSourceHash?: string;
  workspaceDigest?: string;
  submitId?: string;
  gitReceiptHash?: string;
  detail?: string;
}

// ─── V2: verifier stores ─────────────────────────────────────────────────────

/** Capability verifier row. Capability metadata is intentionally separate from MCP devices. */
export interface CapabilityVerifierRecord {
  deviceId: string;
  /** SHA-256 hex of the opaque capability token. Stored, never returned. */
  tokenHash: string;
  scope: string[];
  expiresAt: string;
  clientLabel: string;
  revokedAt?: string;
  createdAt: string;
}

/** Safe capability-verifier projection; `tokenHash` is deliberately absent. */
export type CapabilityVerifierReadState = Omit<CapabilityVerifierRecord, 'tokenHash'>;

/**
 * MCP device verifier row mapped to the migration-4 durable columns.
 *
 * `clientLabel` and `role` are deliberately not fields here: labels are
 * one-time claim metadata and role is pairing policy, neither of which is
 * persisted by `mcp_device_verifiers`.
 */
export interface McpDeviceVerifierRecord {
  deviceId: string;
  /** SHA-256 hex of the opaque device credential; persisted as `verifier`. */
  tokenHash: string;
  kind: 'project' | 'admin';
  projectId?: string;
  ownerUserId: string;
  scopes: string[];
  grantRevision: number;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

/** Safe MCP device projection; the verifier digest is deliberately absent. */
export type McpDeviceVerifierReadState = Omit<McpDeviceVerifierRecord, 'tokenHash'>;

/** Backward-compatible names for capability-only callers. */
export type DeviceVerifierRecord = CapabilityVerifierRecord;
export type DeviceVerifierReadState = CapabilityVerifierReadState;

/** Physical verifier table selected by a persistence operation. */
export type DeviceVerifierStore = 'capability' | 'mcp';

// ─── V3: native immutable source revisions ─────────────────────────────────

export const NATIVE_REVISION_PHASE_VALUES = [
  'prepared',
  'accepted',
  'materializing',
  'materialized',
  'completed',
  'stale',
  'conflict',
  'recovery-required',
] as const;
export type NativeRevisionPhase = (typeof NATIVE_REVISION_PHASE_VALUES)[number];
export const NATIVE_REVISION_TERMINAL_PHASE_VALUES = [
  'completed',
  'stale',
  'conflict',
  'recovery-required',
] as const;
export type NativeRevisionTerminalPhase = (typeof NATIVE_REVISION_TERMINAL_PHASE_VALUES)[number];
export type WorkingDocumentPhase = 'active' | 'tombstone';
export type MaterializationEntryState = 'pending' | 'applied' | 'external';
export type RevisionMirrorExportState = 'pending' | 'exported' | 'failed';

export interface SourceRevisionRecord {
  revisionId: string;
  projectId: string;
  parentRevisionId?: string;
  operationId: string;
  sourceHash: string;
  bundleHash: string;
  actorId: string;
  origin: string;
  createdAt: string;
  acceptedAt?: string;
}
export interface SourceRevisionOperationRecord {
  operationId: string;
  projectId: string;
  expectedRevisionId?: string;
  expectedSourceHash?: string;
  revisionId?: string;
  phase: NativeRevisionPhase;
  receiptHash?: string;
  diagnostic?: string;
  createdAt: string;
  updatedAt: string;
}
export interface SourceRevisionReceipt {
  operationId: string;
  projectId: string;
  revisionId?: string;
  sourceHash?: string;
  bundleHash?: string;
  phase: NativeRevisionTerminalPhase;
  receiptHash: string;
  acceptedAt: string;
}
export interface SourceHeadRecord {
  projectId: string;
  acceptedRevisionId?: string;
  acceptedSourceHash?: string;
  materializedRevisionId?: string;
  materializedSourceHash?: string;
  updatedAt: string;
}
export interface SourceHeadCasInput {
  projectId: string;
  expectedAcceptedRevisionId?: string;
  expectedAcceptedSourceHash?: string;
  acceptedRevisionId: string;
  acceptedSourceHash: string;
  updatedAt: string;
}
export interface SourceHeadCasResult {
  applied: boolean;
  head: SourceHeadRecord;
}
export interface SourceMaterializationRecord {
  projectId: string;
  revisionId: string;
  phase: NativeRevisionPhase;
  expectedViewSourceHash: string;
  targetSourceHash: string;
  treeHash: string;
  attempt: number;
  diagnostic?: string;
  updatedAt: string;
}
export interface SourceMaterializationEntryRecord {
  projectId: string;
  revisionId: string;
  logicalPath: string;
  oldHash?: string;
  targetHash?: string;
  appliedHash?: string;
  state: MaterializationEntryState;
}
export interface AuthoringWorkingDocumentRecord {
  projectId: string;
  documentId: string;
  logicalPath: string;
  kind: string;
  state: WorkingDocumentPhase;
  baseRevisionId?: string;
  catalogRevision: number;
  updatedAt: string;
}
export interface RevisionMirrorExportRecord {
  projectId: string;
  revisionId: string;
  backend: string;
  state: RevisionMirrorExportState;
  externalId?: string;
  diagnostic?: string;
  updatedAt: string;
}

// ─── V5: durable project operation queue ────────────────────────────────────

export const PROJECT_OPERATION_KIND_VALUES = [
  'authoring-submit',
  'render',
  'revise',
  'render-tree',
  'review',
  'release-gate',
  'publish',
  'agent-run',
] as const;
export type ProjectOperationKindV1 = (typeof PROJECT_OPERATION_KIND_VALUES)[number];

export const PROJECT_OPERATION_STATUS_VALUES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'stale',
  'cancelled',
  'interrupted',
] as const;
export type ProjectOperationStatusV1 = (typeof PROJECT_OPERATION_STATUS_VALUES)[number];

/** Statuses that never leave the queue again without an explicit retry. */
export const PROJECT_OPERATION_TERMINAL_STATUS_VALUES = [
  'succeeded',
  'failed',
  'stale',
  'cancelled',
  'interrupted',
] as const;
export type ProjectOperationTerminalStatusV1 =
  (typeof PROJECT_OPERATION_TERMINAL_STATUS_VALUES)[number];

/** Durable progress of a long-running operation; `completed` never exceeds `total`. */
export interface ProjectOperationProgressV1 {
  readonly completed: number;
  readonly total: number;
}

/**
 * One durable row of the per-project operation queue. Identity fields
 * (project/operation id, idempotency key, kind, actor, capability version,
 * source hash, createdAt) are immutable after creation; only status,
 * progress, acceptedRevisionId, resultRef, errorCode and updatedAt change.
 * The worker enforces the canonical status transitions and the per-key
 * idempotency unique constraint; hosts read this table instead of keeping
 * in-memory operation receipts.
 */
export interface ProjectOperationRecordV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly kind: ProjectOperationKindV1;
  readonly status: ProjectOperationStatusV1;
  readonly actorId: string;
  readonly capabilityVersion: number;
  readonly sourceHash: string | null;
  readonly acceptedRevisionId: string | null;
  readonly progress: ProjectOperationProgressV1 | null;
  readonly resultRef: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Create or status-transition one project operation row. */
export interface UpsertProjectOperationInput {
  /**
   * Full record: creation requires `status: 'queued'`; updates must preserve
   * the immutable identity fields (they are validated worker-side).
   */
  readonly record: ProjectOperationRecordV1;
  /**
   * CAS guard for the update path: when the stored status differs the upsert
   * is a no-op returning `applied:false` with the stored record. Omit on
   * create (creation is unconditional; the idempotency unique index is the
   * only conflict surface).
   */
  readonly expectedStatus?: ProjectOperationStatusV1;
}
export interface UpsertProjectOperationResult {
  readonly record: ProjectOperationRecordV1;
  /** True when this call inserted the row. */
  readonly created: boolean;
  /** False only when `expectedStatus` did not match the stored status. */
  readonly applied: boolean;
}

/** Paginated read of a project's operation queue, newest-updated first. */
export interface ListProjectOperationsInput {
  readonly projectId: string;
  /** Restrict the page to one status (active views filter `queued`/`running`). */
  readonly status?: ProjectOperationStatusV1;
  /** Page size; clamped to 1..100, default 50. */
  readonly limit?: number;
  /**
   * Keyset cursor: `"<updatedAt>|<operationId>"` of the last row of the
   * previous page. `updatedAt` is the row's last transition time (newest
   * first, `operationId` breaks ties). Omit for the first page.
   */
  readonly before?: string;
}

// ─── V6: durable publication repository ────────────────────────────────────

export const PUBLICATION_KIND_VALUES = ['canonical', 'custom'] as const;
export type PublicationKindV1 = (typeof PUBLICATION_KIND_VALUES)[number];

export const PUBLICATION_STATUS_VALUES = ['current', 'stale'] as const;
export type PublicationStatusV1 = (typeof PUBLICATION_STATUS_VALUES)[number];

/**
 * Fixed publication id of the canonical novel. Custom branch publications use
 * `sha256(branchPath/discourseBranch/title identity)` hex ids computed
 * host-side; the worker validates the hex format.
 */
export const CANONICAL_PUBLICATION_ID = 'canonical' as const;

/**
 * Strict stored value of one publication row. Every field is written by the
 * Host service that produced the artifact: hashes identify the exact accepted
 * source/scope and the exact novel bytes on disk, `relativeOutputPath` is the
 * project-relative file the `FilePublicationWriter` wrote (never an absolute
 * Host path), and `status` mirrors the row's `current`/`stale` column.
 */
export interface PublicationValueV1 {
  readonly sourceHash: string;
  readonly scopeHash: string;
  readonly revisionIds: readonly string[];
  readonly novelHash: string;
  readonly relativeOutputPath: string;
  readonly byteLength: number;
  readonly actorId: string;
  readonly operationId: string;
  readonly createdAt: string;
  readonly status: PublicationStatusV1;
}

/**
 * One durable row of the per-project publication repository
 * (`project_publications`), keyed by `(projectId, publicationId)`. Identity
 * fields (project/publication id, kind) are immutable after creation; the
 * value is replaced wholesale by a re-publication of the same id and
 * `updatedAt` is the row's last transition time.
 */
export interface ProjectPublicationRecordV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly publicationId: string;
  readonly kind: PublicationKindV1;
  readonly value: PublicationValueV1;
  readonly updatedAt: string;
}

/** Create or replace one publication row. */
export interface UpsertProjectPublicationInput {
  /**
   * Full record: creation is unconditional; updates replace the stored value
   * (identity fields projectId/publicationId/kind are validated immutable
   * worker-side).
   */
  readonly record: ProjectPublicationRecordV1;
  /**
   * CAS guard for the update path (mirrors `upsertProjectOperation`): when
   * the stored status differs the upsert is a no-op returning
   * `applied:false` with the stored record. Omit on create.
   */
  readonly expectedStatus?: PublicationStatusV1;
}
export interface UpsertProjectPublicationResult {
  readonly record: ProjectPublicationRecordV1;
  /** True when this call inserted the row. */
  readonly created: boolean;
  /** False only when `expectedStatus` did not match the stored status. */
  readonly applied: boolean;
}

/** Paginated read of a project's publications, newest-updated first. */
export interface ListProjectPublicationsInput {
  readonly projectId: string;
  /** Page size; clamped to 1..100, default 50. */
  readonly limit?: number;
  /**
   * Keyset cursor: `"<updatedAt>|<publicationId>"` of the last row of the
   * previous page (newest first, `publicationId` breaks ties). Omit for the
   * first page.
   */
  readonly before?: string;
}

// ─── V7: durable agent conversations, runs and tool calls ────────────────

/** Durable status of one agent run. There is no `stale`: a run is never
 * superseded, only cancelled or interrupted by a restart. */
export const AGENT_RUN_STATUS_VALUES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type AgentRunStatusV1 = (typeof AGENT_RUN_STATUS_VALUES)[number];

/** Append-only status of one tool call within a run. */
export const AGENT_TOOL_CALL_STATUS_VALUES = ['pending', 'succeeded', 'failed'] as const;
export type AgentToolCallStatusV1 = (typeof AGENT_TOOL_CALL_STATUS_VALUES)[number];

/** Role of one agent message (`agent_conversation_messages`). */
export const AGENT_MESSAGE_ROLE_VALUES = ['user', 'assistant', 'tool_result'] as const;
export type AgentMessageRoleV1 = (typeof AGENT_MESSAGE_ROLE_VALUES)[number];

/**
 * One durable row of an agent conversation (`agent_conversations`), keyed by
 * `conversationId`. The row stores principal identity and the project access
 * role the principal held when the conversation was created; capability
 * tokens and provider keys are deliberately never persisted.
 */
export interface AgentConversationRecordV1 {
  readonly version: 1;
  readonly conversationId: string;
  readonly projectId: string;
  readonly principalUserId: string;
  readonly role: ProjectAccessRole;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One durable agent run (`agent_runs`), keyed by `runId`. The run snapshots
 * the principal identity/role, bounds its work with `maxTurns`/`maxToolCalls`,
 * and counts progress in `turn`/`toolCalls`. Status follows the canonical
 * automaton: `queued -> running -> succeeded|failed|cancelled`, with a restart
 * sweep turning queued/running work into `interrupted` (never auto-replayed).
 */
export interface AgentRunRecordV1 {
  readonly version: 1;
  readonly runId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly operationId: string | null;
  readonly principalUserId: string;
  readonly role: ProjectAccessRole;
  readonly status: AgentRunStatusV1;
  readonly turn: number;
  readonly maxTurns: number;
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One append-only tool call of a run (`agent_tool_calls`), keyed by
 * `(runId, callIndex)`. The ordinal is enforced worker-side: appends must be
 * strictly sequential with no gaps or overwrites. Only the sanitized argument
 * hash is stored — never raw arguments, capability tokens or provider keys.
 */
export interface AgentToolCallRecordV1 {
  readonly version: 1;
  readonly runId: string;
  readonly callIndex: number;
  readonly toolName: string;
  readonly sanitizedArgsHash: string;
  readonly resultRef: string | null;
  readonly turn: number;
  readonly status: AgentToolCallStatusV1;
  readonly createdAt: string;
}

/** Append one message to a conversation: bump `updatedAt` and optionally set `title`. */
export interface AppendAgentConversationInput {
  readonly conversationId: string;
  readonly at: string;
  readonly title?: string;
}

/**
 * One append-only message of a conversation (`agent_conversation_messages`),
 * keyed by `messageId`. Messages carry the conversation and the run that
 * produced them; tool payloads are never stored — `tool_result` messages
 * reference their call with `toolName`/`callIndex` and hold only the
 * sanitized result text, so user and assistant messages leave both `null`.
 */
export interface AgentConversationMessageRecordV1 {
  readonly version: 1;
  readonly messageId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly role: AgentMessageRoleV1;
  readonly content: string;
  readonly toolName: string | null;
  readonly callIndex: number | null;
  readonly createdAt: string;
}

/** Paginated read of conversations, newest-updated first. */
export interface ListAgentConversationsInput {
  readonly projectId?: string;
  readonly principalUserId?: string;
  /** Page size; clamped to 1..100, default 50. */
  readonly limit?: number;
  /** Keyset cursor: `"<updatedAt>|<conversationId>"` of the last row of the previous page. */
  readonly before?: string;
}

/**
 * Status transition of one agent run (mirrors `upsertProjectOperation`).
 * `expectedStatus` is a CAS guard: a mismatch returns `applied:false` with
 * the stored record. `turn`/`toolCalls` counters may be advanced atomically
 * with the transition; they are monotonic and bounded by maxTurns/maxToolCalls.
 */
export interface TransitionAgentRunInput {
  readonly runId: string;
  readonly status: AgentRunStatusV1;
  readonly expectedStatus: AgentRunStatusV1;
  readonly turn?: number;
  readonly toolCalls?: number;
  readonly at: string;
}
export interface TransitionAgentRunResult {
  readonly record: AgentRunRecordV1;
  /** False only when `expectedStatus` did not match the stored status. */
  readonly applied: boolean;
}

/** Counter-only update of an active run (status unchanged). */
export interface CheckpointAgentRunInput {
  readonly runId: string;
  readonly turn?: number;
  readonly toolCalls?: number;
  readonly at: string;
}

/** Paginated read of runs, newest-updated first. */
export interface ListAgentRunsInput {
  readonly conversationId?: string;
  readonly projectId?: string;
  readonly status?: AgentRunStatusV1;
  /** Page size; clamped to 1..100, default 50. */
  readonly limit?: number;
  /** Keyset cursor: `"<updatedAt>|<runId>"` of the last row of the previous page. */
  readonly before?: string;
}

/** Complete a pending tool call: pending -> succeeded|failed, recording the result ref. */
export interface UpdateAgentToolCallStatusInput {
  readonly runId: string;
  readonly callIndex: number;
  readonly status: 'succeeded' | 'failed';
  /**
   * Required on success (the result artifact); may stay null on failure (the
   * operation record carries the error).
   */
  readonly resultRef: string | null;
  readonly at: string;
}

/** Paginated read of a run's tool calls in append order. */
export interface ListAgentToolCallsInput {
  readonly runId: string;
  /** Keyset: return rows with call_index greater than `after`. */
  readonly after?: number;
  /** Page size; clamped to 1..100, default 50. */
  readonly limit?: number;
}

/** Paginated read of a conversation's messages, oldest first. */
export interface ListAgentMessagesInput {
  readonly conversationId: string;
  /** Page size; clamped to 1..100, default 50. */
  readonly limit?: number;
}

type PersistenceOperationKeyParity = [
  Exclude<keyof PersistencePayloads, keyof PersistenceResults>,
  Exclude<keyof PersistenceResults, keyof PersistencePayloads>,
] extends [never, never]
  ? true
  : false;
type AssertPersistenceOperationKeyParity<T extends true> = T;
/** Operation keys shared by the payload and result maps. */
export type PersistenceOperation =
  AssertPersistenceOperationKeyParity<PersistenceOperationKeyParity> extends true
    ? keyof PersistencePayloads & keyof PersistenceResults
    : never;

export interface PersistencePayloads {
  persistYjsUpdate: PersistYjsUpdateInput;
  loadWorkingDocument: YjsDocumentKey;
  getAuthState: undefined;
  bootstrapOwner: BootstrapOwnerInput;
  acceptInviteUser: AcceptInviteUserInput;
  loadUser: { userId: string };
  loadOwner: undefined;
  resetOwnerPassword: ResetOwnerPasswordInput;
  recordAuthFailure: RecordAuthFailureInput;
  loadAuthBackoff: { subject: string };
  clearAuthBackoff: { subject: string };
  createSession: SessionState;
  loadSession: { sessionId: string };
  revokeSession: { sessionId: string; reason?: string };
  createInvite: InviteState;
  consumeInvite: { inviteId: string; consumedAt: string };
  listInvites: { projectId?: string };
  revokeInvite: { inviteId: string };
  loadConfigurationOperation: { operationId: string };
  loadAudit: { auditId: string };
  loadProjectMembership: LoadProjectMembershipInput;
  listProjectMemberships: ListProjectMembershipsInput;
  upsertProjectMembership: UpsertProjectMembershipInput;
  revokeProjectMembership: RevokeProjectMembershipInput;
  upsertCapability: CapabilityState;
  loadCapability: { capabilityId: string };
  revokeCapability: { capabilityId: string; reason?: string };
  getProject: { projectId: string };
  listProjects: undefined;
  createDeviceVerifier:
    | (CapabilityVerifierRecord & { store: 'capability' })
    | (McpDeviceVerifierRecord & { store: 'mcp' });
  upsertProject: ProjectRegistryEntry;
  removeProject: { projectId: string };
  checkpointOperation: OperationCheckpoint;
  loadOperationCheckpoint: { operationId: string };
  beginGitSubmission: GitSubmissionJournal;
  checkpointGitSubmission: GitSubmissionJournal;
  completeGitSubmission: GitSubmissionReceipt;
  loadGitSubmission: { submitId: string };
  loadUiPreferences: { userId: string };
  saveUiPreferences: UiPreferences;
  createConfigurationOperation: ConfigurationOperationRecord;
  listConfigurationOperations: { limit: number };
  saveAuthoringState: AuthoringStateRecord;
  loadAuthoringState: { projectId: string };
  appendAudit: AuditRecord;
  listAudit: { limit: number; surface?: AuditSurface; projectId?: string };
  loadDeviceVerifierByTokenHash: { tokenHash: string; store: DeviceVerifierStore };
  listDeviceVerifiers: { store: DeviceVerifierStore };
  revokeDeviceVerifier: { deviceId: string; revokedAt: string; store: DeviceVerifierStore };
  listSessions: { userId?: string };
  // ─── V3: native revision operations ───────────────────────────────────────
  createSourceRevision: SourceRevisionRecord;
  getSourceRevision: { revisionId: string };
  listSourceRevisions: { projectId: string; cursor?: string; limit?: number };
  createSourceRevisionOperation: SourceRevisionOperationRecord;
  checkpointSourceRevisionOperation: SourceRevisionOperationRecord;
  replaySourceRevisionReceipt: { operationId: string };
  loadSourceRevisionOperation: { operationId: string };
  getSourceHead: { projectId: string };
  casSourceHead: SourceHeadCasInput;
  createSourceMaterialization: SourceMaterializationRecord;
  checkpointSourceMaterialization: SourceMaterializationRecord;
  loadSourceMaterialization: { projectId: string; revisionId: string };
  loadSourceMaterializationEntries: { projectId: string; revisionId: string };
  upsertAuthoringWorkingDocument: AuthoringWorkingDocumentRecord;
  loadAuthoringWorkingDocument: { projectId: string; documentId: string };
  listAuthoringWorkingDocuments: { projectId: string };
  deleteAuthoringWorkingDocument: { projectId: string; documentId: string };
  createRevisionMirrorExport: RevisionMirrorExportRecord;
  checkpointRevisionMirrorExport: RevisionMirrorExportRecord;
  loadRevisionMirrorExport: { projectId: string; revisionId: string; backend: string };
  // ─── V5: durable project operation queue ─────────────────────────────────
  upsertProjectOperation: UpsertProjectOperationInput;
  getProjectOperation: { projectId: string; operationId: string };
  listProjectOperations: ListProjectOperationsInput;
  getProjectOperationByIdempotencyKey: {
    projectId: string;
    kind: ProjectOperationKindV1;
    idempotencyKey: string;
  };
  markProjectOperationsInterrupted: { projectId: string; at?: string };
  countProjectOperations: { projectId: string; status?: ProjectOperationStatusV1 };
  // ─── V6: durable publication repository ─────────────────────────────────
  upsertProjectPublication: UpsertProjectPublicationInput;
  getProjectPublication: { projectId: string; publicationId: string };
  listProjectPublications: ListProjectPublicationsInput;
  // ─── V7: durable agent records ─────────────────────────────────────────
  createAgentConversation: AgentConversationRecordV1;
  appendAgentConversation: AppendAgentConversationInput;
  getAgentConversation: { conversationId: string };
  listAgentConversations: ListAgentConversationsInput;
  createAgentRun: AgentRunRecordV1;
  transitionAgentRun: TransitionAgentRunInput;
  checkpointAgentRun: CheckpointAgentRunInput;
  markAgentRunsInterrupted: { projectId: string; at?: string };
  getAgentRun: { runId: string };
  listAgentRuns: ListAgentRunsInput;
  appendAgentToolCall: AgentToolCallRecordV1;
  updateAgentToolCallStatus: UpdateAgentToolCallStatusInput;
  listAgentToolCalls: ListAgentToolCallsInput;
  appendAgentMessage: AgentConversationMessageRecordV1;
  listAgentMessages: ListAgentMessagesInput;
}

export interface PersistenceResults {
  persistYjsUpdate: WorkingDocumentState;
  loadWorkingDocument: WorkingDocumentState | null;
  getAuthState: AuthState;
  bootstrapOwner: AuthUserRecord;
  acceptInviteUser: AcceptInviteUserResult;
  loadUser: AuthUserRecord | null;
  loadOwner: AuthUserRecord | null;
  resetOwnerPassword: ResetOwnerPasswordResult;
  recordAuthFailure: AuthBackoffState;
  loadAuthBackoff: AuthBackoffState | null;
  clearAuthBackoff: { cleared: true };
  createSession: SessionState;
  loadSession: SessionState | null;
  revokeSession: { revoked: true };
  createInvite: InviteState;
  consumeInvite: ConsumeInviteResult;
  listInvites: InviteState[];
  revokeInvite: RevokeInviteResult;
  loadConfigurationOperation: ConfigurationOperationRecord | null;
  loadAudit: AuditRecord | null;
  loadProjectMembership: ProjectMembershipState | null;
  listProjectMemberships: ProjectMembershipState[];
  upsertProjectMembership: ProjectMembershipMutationResult;
  revokeProjectMembership: ProjectMembershipMutationResult;
  upsertCapability: CapabilityState;
  loadCapability: CapabilityState | null;
  revokeCapability: { revoked: true };
  listProjects: ProjectRegistryEntry[];
  upsertProject: ProjectRegistryEntry;
  removeProject: { removed: true };
  createDeviceVerifier: CapabilityVerifierReadState | McpDeviceVerifierReadState;
  getProject: ProjectRegistryEntry | null;
  loadDeviceVerifierByTokenHash: CapabilityVerifierReadState | McpDeviceVerifierReadState | null;
  listDeviceVerifiers: (CapabilityVerifierReadState | McpDeviceVerifierReadState)[];
  checkpointOperation: OperationCheckpoint;
  loadOperationCheckpoint: OperationCheckpoint | null;
  beginGitSubmission: GitSubmissionJournal;
  checkpointGitSubmission: GitSubmissionJournal;
  completeGitSubmission: GitSubmissionReceipt;
  loadGitSubmission: GitSubmissionJournal | GitSubmissionReceipt | null;
  loadUiPreferences: UiPreferences | null;
  saveUiPreferences: UiPreferences;
  createConfigurationOperation: ConfigurationOperationRecord;
  listConfigurationOperations: ConfigurationOperationRecord[];
  saveAuthoringState: AuthoringStateRecord;
  loadAuthoringState: AuthoringStateRecord | null;
  appendAudit: AuditRecord;
  listAudit: AuditRecord[];
  revokeDeviceVerifier: { revoked: true };
  listSessions: SessionState[];
  // ─── V3: native revision operation results ────────────────────────────────
  createSourceRevision: SourceRevisionRecord;
  getSourceRevision: SourceRevisionRecord | null;
  listSourceRevisions: SourceRevisionRecord[];
  createSourceRevisionOperation: SourceRevisionOperationRecord;
  checkpointSourceRevisionOperation: SourceRevisionOperationRecord;
  replaySourceRevisionReceipt: SourceRevisionReceipt | null;
  loadSourceRevisionOperation: SourceRevisionOperationRecord | null;
  getSourceHead: SourceHeadRecord | null;
  casSourceHead: SourceHeadCasResult;
  createSourceMaterialization: SourceMaterializationRecord;
  checkpointSourceMaterialization: SourceMaterializationRecord;
  loadSourceMaterialization: SourceMaterializationRecord | null;
  loadSourceMaterializationEntries: SourceMaterializationEntryRecord[];
  upsertAuthoringWorkingDocument: AuthoringWorkingDocumentRecord;
  loadAuthoringWorkingDocument: AuthoringWorkingDocumentRecord | null;
  listAuthoringWorkingDocuments: AuthoringWorkingDocumentRecord[];
  deleteAuthoringWorkingDocument: { removed: true };
  createRevisionMirrorExport: RevisionMirrorExportRecord;
  checkpointRevisionMirrorExport: RevisionMirrorExportRecord;
  loadRevisionMirrorExport: RevisionMirrorExportRecord | null;
  // ─── V5: durable project operation queue results ─────────────────────────
  upsertProjectOperation: UpsertProjectOperationResult;
  getProjectOperation: ProjectOperationRecordV1 | null;
  listProjectOperations: ProjectOperationRecordV1[];
  getProjectOperationByIdempotencyKey: ProjectOperationRecordV1 | null;
  markProjectOperationsInterrupted: { updated: number };
  countProjectOperations: { count: number };
  // ─── V6: durable publication repository results ─────────────────────────
  upsertProjectPublication: UpsertProjectPublicationResult;
  getProjectPublication: ProjectPublicationRecordV1 | null;
  listProjectPublications: ProjectPublicationRecordV1[];
  // ─── V7: durable agent record results ──────────────────────────────────
  createAgentConversation: AgentConversationRecordV1;
  appendAgentConversation: AgentConversationRecordV1;
  getAgentConversation: AgentConversationRecordV1 | null;
  listAgentConversations: AgentConversationRecordV1[];
  createAgentRun: AgentRunRecordV1;
  transitionAgentRun: TransitionAgentRunResult;
  checkpointAgentRun: AgentRunRecordV1;
  markAgentRunsInterrupted: { updated: number };
  getAgentRun: AgentRunRecordV1 | null;
  listAgentRuns: AgentRunRecordV1[];
  appendAgentToolCall: AgentToolCallRecordV1;
  updateAgentToolCallStatus: AgentToolCallRecordV1;
  listAgentToolCalls: AgentToolCallRecordV1[];
  appendAgentMessage: { appended: true };
  listAgentMessages: AgentConversationMessageRecordV1[];
}

export interface PersistenceError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string>;
}
