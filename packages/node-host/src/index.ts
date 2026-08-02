/** Public semantic adapters for the Node Host boundary. */

export { FileRenderCacheRepository } from './cache/file-render-cache-repository.js';
export type {
  FileRenderCacheRepositoryOptions,
  LayeredCacheKey,
  RenderCacheRecord,
  RenderCacheRepository,
} from './cache/types.js';
export { FileExecutionRepository } from './execution/file-execution-repository.js';
export type { LoadedNodePlugin } from './plugins/node-plugin-catalog.js';
export { NodePluginCatalog } from './plugins/node-plugin-catalog.js';
export type { AiSdkProviderOptions } from './providers/ai-sdk.js';
export { AiSdkProvider } from './providers/ai-sdk.js';
export type { FileMockPass2Options } from './providers/file-mock-pass2.js';
export {
  FileMockPass2Provider,
  loadReferenceEntries,
} from './providers/file-mock-pass2.js';
export { writeFileValidationReport } from './reports/file-validation-reporter.js';
export type { FileCoreRuntimeOptions } from './runtime.js';
export { createFileCoreRuntimeServices } from './runtime.js';
export {
  FileProjectSourceLoader,
  FileProjectSourceLoaderImpl,
} from './source/file-project-source-loader.js';
export {
  FileProjectSourceWriter,
  FileProjectSourceWriterImpl,
} from './source/file-project-source-writer.js';
export type {
  FileProjectSourceLoaderOptions,
  FileProjectSourceWriterOptions,
} from './source/types.js';
export { SourceConflictError, SourcePathError } from './source/types.js';
export {
  FileStateLogRepository,
  FileStateSnapshotRepository,
  StateLogCorruptionError,
} from './state/file-state-repositories.js';

/** Options for the project-relative execution artifact directory. */
export interface FileExecutionRepositoryOptions {
  readonly relativeDirectory?: string;
}

/** Options for the project-relative state event-log directory. */
export interface FileStateLogRepositoryOptions {
  readonly relativeDirectory?: string;
}

/** Options for the project-relative state snapshot directory. */
export interface FileStateSnapshotRepositoryOptions {
  readonly relativeDirectory?: string;
}

export type {
  AcceptedArtifactRecord,
  AcceptedSceneRecord,
  CommitResult,
  CommitSuccess,
  CoreExecutionRepository,
  OperationRecord,
  PublicationRecord,
  ReviewRecord,
  SceneRevisionRecord,
  StateAppendResult,
  StateAppendSuccess,
  StateEvent,
  StateLogReadResult,
  StateLogRepository,
  StateSnapshotRecord,
  StateSnapshotRepository,
  StateSnapshotWriteResult,
  StateStreamKey,
  StateVersionConflict,
  TraceRecord,
  VersionConflict,
} from '@novalistically/core';
