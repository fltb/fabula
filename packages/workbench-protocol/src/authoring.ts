export interface ProjectSourceDiagnosticV1 {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly logicalPath: string | null;
}
export type SessionPresenceSurfaceV1 = 'browser' | 'mcp' | 'yjs' | 'agent';
export interface ProjectPresenceV1 {
  readonly actorId: string;
  readonly surface: SessionPresenceSurfaceV1;
  readonly since: string;
}
export type PresenceUpdateV1 =
  | { readonly kind: 'join'; readonly actorId: string; readonly surface: SessionPresenceSurfaceV1; readonly at: string }
  | { readonly kind: 'leave'; readonly actorId: string; readonly surface: SessionPresenceSurfaceV1; readonly at: string };
export interface ProjectSessionProjectionV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly revision: number;
  readonly sourceHash: string | null;
  readonly documents: number;
  readonly events: number;
  readonly rendered: number;
  readonly pending: number;
  readonly blocked: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly diagnostics: readonly ProjectSourceDiagnosticV1[];
  readonly presence: readonly ProjectPresenceV1[];
  readonly generatedAt: string;
}
export interface AcceptedAuthoringProjectionV2 {
  readonly version: 2;
  readonly projectId: string;
  readonly acceptedRevisionId: string | null;
  readonly acceptedSourceHash: string | null;
  readonly materializedRevisionId: string | null;
  readonly materializedSourceHash: string | null;
}
export interface WorkingAuthoringProjectionV2 {
  readonly version: 2;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly catalogRevision: number;
  readonly stateVectorHash: string;
  readonly pendingOperationId: string | null;
}
export interface NativeRevisionMetadataV1 {
  readonly version: 1;
  readonly revisionId: string;
  readonly projectId: string;
  readonly parentRevisionId: string | null;
  readonly sourceHash: string;
  readonly bundleHash: string;
  readonly actorId: string;
  readonly origin: string;
  readonly acceptedAt: string;
}
export interface NativeRevisionReceiptV1 {
  readonly version: 1;
  readonly operationId: string;
  readonly revisionId: string;
  readonly receiptHash: string;
  readonly sourceHash: string;
  readonly phase: 'completed' | 'stale' | 'conflict' | 'recovery-required';
}
/**
 * The persisted manifest item used by the Host reference store.
 *
 * `objectKey` deliberately remains a Host-only storage key for this
 * persistence contract. Browser/MCP responses use `ReferenceItemV1` below,
 * which never exposes it.
 */
export interface ReferenceLibraryItemV1 {
  readonly referenceId: string;
  readonly displayName: string;
  readonly originalName: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly objectKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly sourceUrl?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
}

/** A browser-safe reference item returned by the reference MCP catalog. */
export interface ReferenceItemV1 {
  readonly version: 1;
  readonly referenceId: string;
  readonly displayName: string;
  readonly originalName: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly title: string | null;
  readonly authors: readonly string[];
  readonly sourceUrl: string | null;
  readonly license: string | null;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A bounded byte range in a reference object. */
export interface ReferenceRangeV1 {
  readonly version: 1;
  readonly offset: number;
  readonly length: number;
}

/** A browser-safe extracted/reference chunk. */
export interface ReferenceChunkV1 {
  readonly version: 1;
  readonly referenceId: string;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly range: ReferenceRangeV1;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly chunkHash: string;
  readonly locator: string;
  readonly quote: string | null;
}

/** A browser-safe content response; binary bytes are base64 encoded. */
export interface ReferenceContentV1 {
  readonly version: 1;
  readonly referenceId: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly range: ReferenceRangeV1;
  readonly dataBase64: string;
  readonly nextOffset: number | null;
}

/** A non-authoritative citation suitable for explicit rendering output. */
export interface ReferenceCitationV1 {
  readonly version: 1;
  readonly citationId: string;
  readonly referenceId: string;
  readonly chunkId: string;
  readonly contentHash: string;
  readonly chunkHash: string;
  readonly quote: string;
  readonly locator: string;
  readonly authoritative: false;
}

/** The observable state of an asynchronous reference operation. */
export interface ReferenceJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly operation: 'import' | 'delete' | 'retry';
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly referenceId: string | null;
  readonly bytesReceived: number;
  readonly totalBytes: number | null;
  readonly contentHash: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectReferencePacketV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly citations: readonly ReferenceCitationV1[];
}
