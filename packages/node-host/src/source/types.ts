import type { ProjectSourceSnapshotV1, SourceChangeV1 } from '@novalistically/core';

export interface FileProjectSourceLoaderOptions {
  /** Optional parser hook; the default parser is YAML.parse. */
  readonly parse?: (content: string, logicalPath: string) => unknown;
}

export interface FileProjectSourceWriterOptions {
  readonly loader?: FileProjectSourceLoader;
}

export interface FileProjectSourceLoader {
  load(projectRoot: string): ProjectSourceSnapshotV1;
}

export interface FileProjectSourceWriter {
  apply(
    projectRoot: string,
    expectedSourceHash: string,
    changes: readonly SourceChangeV1[],
  ): Promise<ProjectSourceSnapshotV1>;
}

export class SourcePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcePathError';
  }
}

export class SourceConflictError extends Error {
  readonly expectedSourceHash: string;
  readonly actualSourceHash: string;

  constructor(expectedSourceHash: string, actualSourceHash: string) {
    super(`Source hash conflict: expected ${expectedSourceHash}, found ${actualSourceHash}`);
    this.name = 'SourceConflictError';
    this.expectedSourceHash = expectedSourceHash;
    this.actualSourceHash = actualSourceHash;
  }
}

export class SourceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceInputError';
  }
}

import type { ReferenceLibraryItemV1 as ProtocolReferenceLibraryItemV1 } from '@novalistically/workbench-protocol';

/** The portable reference manifest is the only index stored beside project YAML. */
export interface ReferenceLibraryManifestV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly revision: number;
  readonly items: readonly ReferenceLibraryItemV1[];
}

/** Metadata supplied when importing one immutable reference object. */
export type ReferenceLibraryItemV1 = ProtocolReferenceLibraryItemV1 & {
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly sourceUrl?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
};

export interface ReferenceLibraryReadV1 {
  readonly manifest: ReferenceLibraryManifestV1;
  /** SHA-256 of the exact canonical manifest bytes. */
  readonly manifestHash: string;
}

export type ReferenceContent =
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>
  | NodeJS.ReadableStream;

/** Inclusive start and exclusive end byte offsets for reference reads. */
export interface ReferenceContentRangeV1 {
  readonly start?: number;
  readonly endExclusive?: number;
}

/** Options for bounded, streaming content reads. */
export interface ReferenceContentReadOptions extends ReferenceContentRangeV1 {
  /**
   * Optional upper bound for bytes yielded by this read. This is checked
   * before opening the object and does not buffer the object in memory.
   */
  readonly maxBytes?: number;
}

/** A streaming object read; `content` never contains a filesystem path. */
export interface ReferenceContentReadV1 {
  readonly content: NodeJS.ReadableStream;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly start: number;
  readonly endExclusive: number;
}

export interface ReferenceLibraryImportOptions {
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxBytesPerProject?: number;
  readonly maxProjectBytes?: number;
  readonly maxItemsPerProject?: number;
}

export interface ReferenceLibraryImportInput {
  readonly referenceId: string;
  readonly content: ReferenceContent;
  readonly originalName: string;
  readonly displayName?: string;
  readonly mediaType: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly sourceUrl?: string;
  readonly license?: string;
  readonly tags?: readonly string[];
  /**
   * Per-object byte quota supplied by the caller. `maxFileBytes` is accepted
   * as a descriptive alias for integrations using Workbench configuration
   * names.
   */
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  /** Optional project-wide byte and item quotas supplied by the caller. */
  readonly maxBytesPerProject?: number;
  readonly maxProjectBytes?: number;
  readonly maxItemsPerProject?: number;
  readonly expectedManifestHash: string | null;
  readonly now?: string;
}

export interface ReferenceLibraryDeleteInput {
  readonly referenceId: string;
  readonly expectedManifestHash: string | null;
}

export interface ReferenceLibraryVerificationReport {
  readonly manifest: ReferenceLibraryReadV1 | null;
  readonly missing: readonly string[];
  readonly corrupt: readonly string[];
  readonly orphan: readonly string[];
}

export interface FileProjectReferenceStore {
  /** Read the current manifest. Returns null if library.json does not exist. */
  read(projectId: string, projectRoot: string): Promise<ReferenceLibraryReadV1 | null>;

  /**
   * Import a reference by streaming content to a temporary object, hashing
   * and counting it, then atomically committing the immutable object and
   * CAS-updating the manifest.
   */
  import(
    input: ReferenceLibraryImportInput,
    projectId: string,
    projectRoot: string,
  ): Promise<ReferenceLibraryReadV1>;

  /**
   * Stream a complete object or a bounded byte range. The returned stream
   * exposes no filesystem path and is opened only after manifest/object
   * validation.
   */
  readContent(
    projectId: string,
    projectRoot: string,
    referenceId: string,
    options?: ReferenceContentReadOptions,
  ): Promise<ReferenceContentReadV1>;

  /** Convenience form for an explicit bounded byte range. */
  readRange(
    projectId: string,
    projectRoot: string,
    referenceId: string,
    start: number,
    endExclusive: number,
    maxBytes?: number,
  ): Promise<ReferenceContentReadV1>;

  /**
   * Delete a reference by ID: CAS-manifest update, then GC orphaned objects.
   * Returns the updated manifest.
   */
  delete(
    input: ReferenceLibraryDeleteInput,
    projectId: string,
    projectRoot: string,
  ): Promise<ReferenceLibraryReadV1>;

  /**
   * Verify manifest integrity: rehash all referenced objects, report
   * missing, corrupt, and orphan (unreferenced) objects.
   */
  verify(projectId: string, projectRoot: string): Promise<ReferenceLibraryVerificationReport>;
}

export interface FileProjectReferenceStoreOptions {
  readonly now?: () => string;
  /** Default per-object import quota; omitted means no default quota. */
  readonly maxFileBytes?: number;
  readonly maxImportBytes?: number;
  /** Default project-wide import quotas; omitted means no default quota. */
  readonly maxBytesPerProject?: number;
  readonly maxProjectBytes?: number;
  readonly maxItemsPerProject?: number;
  /** Default bound for readContent/readRange, if configured. */
  readonly maxReadBytes?: number;
}
