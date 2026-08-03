import type {
  ReferenceChunkV1,
  ReferenceCitationV1,
  ReferenceContentV1,
  ReferenceItemV1,
  ReferenceJobV1,
} from './authoring.js';

/** Version of the project-scoped reference MCP contract. */
export const REFERENCE_MCP_CONTRACT_VERSION = 1 as const;
export type ReferenceMcpContractVersion = typeof REFERENCE_MCP_CONTRACT_VERSION;

/** Host-bound reference list request; project identity is selected by the route. */
export interface McpReferenceListInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly pageSize?: number;
  readonly cursor?: string;
}
export interface McpReferenceListOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly items: readonly ReferenceItemV1[];
  readonly nextCursor: string | null;
}

export interface McpReferenceGetInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly referenceId: string;
}
export interface McpReferenceGetOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly item: ReferenceItemV1;
}

export interface McpReferenceSearchInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly query: string;
  readonly pageSize?: number;
  readonly cursor?: string;
  readonly filters?: {
    readonly referenceId?: string;
    readonly mediaType?: string;
    readonly tag?: string;
  };
}
export interface McpReferenceSearchOutputV1 extends McpReferenceListOutputV1 {}

export interface McpReferenceChunkGetInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly referenceId: string;
  readonly chunkId: string;
}
export interface McpReferenceChunkGetOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly chunk: ReferenceChunkV1;
}

export interface McpReferenceContentReadInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly referenceId: string;
  readonly offset: number;
  readonly limit: number;
}
export interface McpReferenceContentReadOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly content: ReferenceContentV1;
}

export interface McpReferenceImportBeginInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly referenceId: string;
  readonly originalName: string;
  readonly displayName?: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly sourceUrl?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
  readonly idempotencyKey: string;
}
export interface McpReferenceImportBeginOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly job: ReferenceJobV1;
}

export interface McpReferenceImportChunkInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly jobId: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly chunkHash: string;
  readonly dataBase64: string;
}
export interface McpReferenceImportChunkOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly job: ReferenceJobV1;
}

export interface McpReferenceImportCommitInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly jobId: string;
  readonly contentHash: string;
}
export interface McpReferenceImportCommitOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly job: ReferenceJobV1;
}

export interface McpReferenceJobGetInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly jobId: string;
}
export interface McpReferenceJobGetOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly job: ReferenceJobV1;
}
export interface McpReferenceRetryInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly jobId: string;
}
export interface McpReferenceRetryOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly job: ReferenceJobV1;
}

export interface McpReferenceDeleteInputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly referenceId: string;
}
export interface McpReferenceDeleteOutputV1 {
  readonly version: ReferenceMcpContractVersion;
  readonly job: ReferenceJobV1;
  readonly deletedReferenceId: string;
}

/**
 * Host-owned reference operation port. It is deliberately path-free: a Host
 * implementation closes over the project root and exposes only safe DTOs.
 */
export interface McpReferencePort {
  list(input: McpReferenceListInputV1): Promise<McpReferenceListOutputV1>;
  get(input: McpReferenceGetInputV1): Promise<McpReferenceGetOutputV1 | null>;
  search(input: McpReferenceSearchInputV1): Promise<McpReferenceSearchOutputV1>;
  getChunk(input: McpReferenceChunkGetInputV1): Promise<McpReferenceChunkGetOutputV1 | null>;
  readContent(input: McpReferenceContentReadInputV1): Promise<McpReferenceContentReadOutputV1>;
  importBegin(input: McpReferenceImportBeginInputV1): Promise<McpReferenceImportBeginOutputV1>;
  importChunk(input: McpReferenceImportChunkInputV1): Promise<McpReferenceImportChunkOutputV1>;
  importCommit(input: McpReferenceImportCommitInputV1): Promise<McpReferenceImportCommitOutputV1>;
  jobGet(input: McpReferenceJobGetInputV1): Promise<McpReferenceJobGetOutputV1 | null>;
  retry(input: McpReferenceRetryInputV1): Promise<McpReferenceRetryOutputV1>;
  delete(input: McpReferenceDeleteInputV1): Promise<McpReferenceDeleteOutputV1>;
}
