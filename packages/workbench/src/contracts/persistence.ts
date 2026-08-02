/**
 * Persistence worker wire protocol (host-internal).
 * The browser-facing surface is `contracts/index.ts`, which re-exports only
 * non-secret domain DTOs. This module carries host-only state such as password
 * hash records and the typed operation map; never import it from client code.
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
  | 'saveUiPreferences';

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
}

export interface PersistenceError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string>;
}
