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
  BrowserApiErrorCode,
  BrowserApiErrorV1,
  BrowserApiVersion,
  BrowserGraphRouteSelectorV1,
  BrowserProjectActivityV1,
  BrowserProjectListV1,
  BrowserProjectOverviewV1,
  BrowserProjectSummaryV1,
  BrowserSessionPrincipalV1,
} from './browser-api.js';
export type {
  WorkbenchBranchDecisionV1,
  WorkbenchBranchPathV1,
  WorkbenchBranchScopeV1,
  WorkbenchBranchSetV1,
  WorkbenchConditionV1,
  WorkbenchDiscourseCoordinateV1,
  WorkbenchGraphBoundaryReferenceV1,
  WorkbenchGraphCoordinateV1,
  WorkbenchGraphDomainV1,
  WorkbenchGraphEdgeClassV1,
  WorkbenchGraphEdgeV1,
  WorkbenchGraphNarrativeEllipsisV1,
  WorkbenchGraphNodeOriginV1,
  WorkbenchGraphNodeV1,
  WorkbenchGraphOutputV1,
  WorkbenchGraphProjectionV1,
  WorkbenchGraphReadV1,
  WorkbenchGraphResolutionV1,
  WorkbenchGraphViewV1,
  WorkbenchGraphViewVersion,
  WorkbenchOutputValueV1,
  WorkbenchPresencePredicateV1,
  WorkbenchReadOriginV1,
  WorkbenchReadPhaseV1,
  WorkbenchRouteChoiceV1,
  WorkbenchRouteEventScopeV1,
  WorkbenchRouteSelectorV1,
  WorkbenchRouteViewV1,
  WorkbenchSceneSequenceEntryV1,
  WorkbenchSceneStoryCoordinateV1,
  WorkbenchStoryCoordinateV1,
} from './graph.js';
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
export type { SceneAdoptionViewV1 } from './scene.js';
export type {
  SourceStudioDocumentDescriptorV1,
  SourceStudioStateV1,
  SourceStudioWorkingLayerV1,
} from './source-studio.js';
