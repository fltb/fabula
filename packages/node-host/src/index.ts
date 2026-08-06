export type {
  ProjectAuthorityLeaseV1,
  ProjectAuthorityTokenV1,
  ProjectWriteCoordinatorOptions,
  WorkbenchAuthorityReadyOptions,
} from './authority/project-write-coordinator.js';
export {
  computeProjectRootFingerprint,
  ProjectAuthorityTokenError,
  ProjectAuthorityUnavailableError,
  ProjectWriteCoordinator,
  StandaloneMutationBlockedError,
} from './authority/project-write-coordinator.js';

/** Public semantic adapters for the Node Host boundary. */

export type {
  AgentModelEvent,
  AgentModelMessage,
  AgentToolSpec,
  WorkbenchAgentModelOptions,
  WorkbenchAgentModelPort,
  WorkbenchAgentModelRunRequest,
} from './agent/workbench-agent-model.js';
export { createWorkbenchAgentModelAdapter } from './agent/workbench-agent-model.js';
export { FileRenderCacheRepository } from './cache/file-render-cache-repository.js';
export type {
  FileRenderCacheRepositoryOptions,
  LayeredCacheKey,
  RenderCacheRecord,
  RenderCacheRepository,
} from './cache/types.js';
export { FileExecutionRepository } from './execution/file-execution-repository.js';
export { withDirectoryLock } from './execution/types.js';
export type {
  FilePublicationWriteInput,
  FilePublicationWriteResult,
} from './output/file-publication-writer.js';
export {
  assertSafePublicationRelativePath,
  CANONICAL_PUBLICATION_FILENAME,
  CANONICAL_PUBLICATION_ID,
  derivePublicationRelativePath,
  FilePublicationWriter,
  hashPublicationMarkdown,
  normalizePublicationMarkdown,
  PUBLICATION_OUTPUT_DIRECTORY,
  PublicationPathError,
} from './output/file-publication-writer.js';
export type {
  ActivateNodePluginsOptions,
  ActiveNodePluginRecord,
  BlockedNodePluginRecord,
  DisabledNodePluginRecord,
  NodePluginActivationResult,
} from './plugins/activate.js';
export {
  activateNodePlugins,
  DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
  shutdownNodePlugins,
} from './plugins/activate.js';
export type {
  DiscoveredNodePlugin,
  LoadedNodePlugin,
  StampedPluginHooks,
  TrustedNodePluginEntry,
} from './plugins/node-plugin-catalog.js';
export {
  describeTrustedMismatch,
  discoverNodePlugins,
  NodePluginCatalog,
  PLUGIN_IDENTITY_MISMATCH,
  PluginIdentityMismatchError,
  pluginHookNames,
} from './plugins/node-plugin-catalog.js';
export type {
  AiSdkClientOptions,
  AiSdkModelClient,
  AiSdkProviderOptions,
} from './providers/ai-sdk.js';
export { AiSdkProvider, createAiSdkModelClient } from './providers/ai-sdk.js';
export type { DeterministicMockProviderOptions } from './providers/deterministic-mock.js';
export {
  createDeterministicMockProvider,
  DeterministicMockProvider,
} from './providers/deterministic-mock.js';
export type { FileMockPass2Options } from './providers/file-mock-pass2.js';
export {
  FileMockPass2Provider,
  loadReferenceEntries,
} from './providers/file-mock-pass2.js';
export {
  FileProjectStatusReporter,
  formatProjectStatus,
  PROJECT_STATUS_FILENAME,
  writeFileProjectStatus,
} from './reports/file-project-status-reporter.js';
export { writeFileValidationReport } from './reports/file-validation-reporter.js';
export type { FileCoreRuntimeOptions } from './runtime.js';
export { createFileCoreRuntimeServices } from './runtime.js';
export { FileProjectReferenceStore } from './source/file-project-reference-store.js';
export {
  FileProjectSourceLoader,
  FileProjectSourceLoaderImpl,
} from './source/file-project-source-loader.js';
export type { FileProjectSourceWriterAuthorityOptions } from './source/file-project-source-writer.js';
export {
  FileProjectSourceWriter,
  FileProjectSourceWriterImpl,
} from './source/file-project-source-writer.js';
export type {
  FileProjectReferenceStore as FileProjectReferenceStoreContract,
  FileProjectReferenceStoreOptions,
  FileProjectSourceLoaderOptions,
  FileProjectSourceWriterOptions,
  ReferenceContent,
  ReferenceContentRangeV1,
  ReferenceContentReadOptions,
  ReferenceContentReadV1,
  ReferenceLibraryDeleteInput,
  ReferenceLibraryImportInput,
  ReferenceLibraryItemV1,
  ReferenceLibraryManifestV1,
  ReferenceLibraryReadV1,
  ReferenceLibraryVerificationReport,
} from './source/types.js';
export { SourceConflictError, SourceInputError, SourcePathError } from './source/types.js';
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
  ReviewEventDraftV1,
  ReviewEventKindV1,
  ReviewEventReadResultV1,
  ReviewEventRecordV1,
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
