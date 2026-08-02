/**
 * Browser-safe contract surface. Client code may depend on this barrel only.
 * Host-internal wire plumbing (persistence operation maps, password hash
 * records) and host-only provider credential stores (the OS credential
 * adapter and its XDG file fallback) are intentionally NOT re-exported here;
 * any future provider-secret type must stay in the host layer and never be
 * added to this barrel.
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
