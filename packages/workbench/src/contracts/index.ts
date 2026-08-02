/**
 * Browser-safe contract surface. Client code may depend on this barrel only.
 * It exports pure data DTOs (projection, presence, capability, session
 * state) — never host handles. Host-internal wire plumbing (persistence
 * operation maps, password hash records), host-only provider credential
 * stores (the OS credential adapter and its XDG file fallback), and the
 * shared ProjectSession/Core runtime implementation are intentionally NOT
 * re-exported here; no filesystem, Git, provider, or database handle ever
 * crosses this boundary.
 */

export type {
  PresenceUpdate,
  ProjectPresenceV1,
  ProjectSessionProjectionV1,
  ProjectSourceDiagnosticV1,
  SessionPresenceSurface,
} from '../host/project-session.js';
export type {
  AuthBackoffState,
  BinaryPayload,
  CapabilityState,
  ConsumeInviteResult,
  GitSubmissionJournal,
  GitSubmissionReceipt,
  InviteState,
  OperationCheckpoint,
  PersistYjsUpdateInput,
  ProjectRegistryEntry,
  SessionState,
  UiPreferences,
  UserRole,
  UserState,
  WorkingDocumentState,
  YjsDocumentKey,
} from './persistence.js';
