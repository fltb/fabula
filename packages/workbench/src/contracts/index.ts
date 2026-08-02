/**
 * Browser-safe contract surface. Client code may depend on this barrel only.
 * Host-internal wire plumbing (persistence operation maps, password hash
 * records) is intentionally NOT re-exported here.
 */
export type {
  BinaryPayload,
  YjsDocumentKey,
  WorkingDocumentState,
  PersistYjsUpdateInput,
  SessionState,
  InviteState,
  CapabilityState,
  UserRole,
  UserState,
  AuthBackoffState,
  ConsumeInviteResult,
  ProjectRegistryEntry,
  OperationCheckpoint,
  GitSubmissionJournal,
  GitSubmissionReceipt,
  UiPreferences,
} from './persistence.js';
