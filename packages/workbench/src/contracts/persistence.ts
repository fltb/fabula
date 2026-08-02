/**
 * Persistence worker wire protocol (host-internal).
 * The browser-facing surface is `contracts/index.ts`, which re-exports only
 * non-secret domain DTOs. This module carries host-only state such as password
 * hash records and the typed operation map; never import it from client code.
 * Version 2 of the schema adds configuration operation/audit/recovery
 * metadata, authoring coordination metadata, the append-only audit log, MCP
 * device token verifiers, and the dashboard queries over sessions/devices.
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
  role: string;
  expiresAt: string;
  consumedAt?: string;
}
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
export type AuditSurface =
  | 'browser'
  | 'agent'
  | 'mcp'
  | 'filesystem'
  | 'submit'
  | 'system';

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

// ─── V2: MCP device token verifier ──────────────────────────────────────────

/**
 * Durable MCP device verifier row. The worker stores ONLY the SHA-256 hash
 * of the one-time device credential plus scope/expiry/label/revocation — the
 * raw credential is shown once at pairing and never persisted. `tokenHash`
 * must never be returned by any result; reads map to
 * {@link DeviceVerifierReadState}.
 */
export interface DeviceVerifierRecord {
  deviceId: string;
  /** SHA-256 hex of the one-time device credential. Stored, never returned. */
  tokenHash: string;
  scope: string[];
  expiresAt: string;
  clientLabel: string;
  revokedAt?: string;
  createdAt: string;
}

/** Safe read projection of a device verifier: `tokenHash` is deliberately absent. */
export type DeviceVerifierReadState = Omit<DeviceVerifierRecord, 'tokenHash'>;

export type PersistenceOperation =
  | 'persistYjsUpdate'
  | 'loadWorkingDocument'
  | 'getAuthState'
  | 'bootstrapOwner'
  | 'acceptInviteUser'
  | 'loadUser'
  | 'loadOwner'
  | 'resetOwnerPassword'
  | 'recordAuthFailure'
  | 'loadAuthBackoff'
  | 'clearAuthBackoff'
  | 'createSession'
  | 'loadSession'
  | 'revokeSession'
  | 'createInvite'
  | 'consumeInvite'
  | 'listInvites'
  | 'upsertCapability'
  | 'loadCapability'
  | 'revokeCapability'
  | 'listProjects'
  | 'getProject'
  | 'upsertProject'
  | 'removeProject'
  | 'checkpointOperation'
  | 'loadOperationCheckpoint'
  | 'beginGitSubmission'
  | 'checkpointGitSubmission'
  | 'completeGitSubmission'
  | 'loadGitSubmission'
  | 'loadUiPreferences'
  | 'saveUiPreferences'
  | 'createConfigurationOperation'
  | 'listConfigurationOperations'
  | 'saveAuthoringState'
  | 'loadAuthoringState'
  | 'appendAudit'
  | 'listAudit'
  | 'createDeviceVerifier'
  | 'loadDeviceVerifierByTokenHash'
  | 'listDeviceVerifiers'
  | 'revokeDeviceVerifier'
  | 'listSessions';

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
  upsertCapability: CapabilityState;
  loadCapability: { capabilityId: string };
  revokeCapability: { capabilityId: string; reason?: string };
  listProjects: undefined;
  getProject: { projectId: string };
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
  createDeviceVerifier: DeviceVerifierRecord;
  loadDeviceVerifierByTokenHash: { tokenHash: string };
  listDeviceVerifiers: undefined;
  revokeDeviceVerifier: { deviceId: string; revokedAt: string };
  listSessions: { userId?: string };
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
  upsertCapability: CapabilityState;
  loadCapability: CapabilityState | null;
  revokeCapability: { revoked: true };
  listProjects: ProjectRegistryEntry[];
  getProject: ProjectRegistryEntry | null;
  upsertProject: ProjectRegistryEntry;
  removeProject: { removed: true };
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
  createDeviceVerifier: DeviceVerifierReadState;
  loadDeviceVerifierByTokenHash: DeviceVerifierReadState | null;
  listDeviceVerifiers: DeviceVerifierReadState[];
  revokeDeviceVerifier: { revoked: true };
  listSessions: SessionState[];
}

export interface PersistenceError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string>;
}
