/**
 * Workbench Host Git authoring boundary: controlled command runner, verified
 * system-Git capability probe, and the strict AuthoringManifest. Git belongs
 * exclusively to this directory; Core, browser, MCP and Agents never invoke
 * Git directly.
 */

export type { GitCapability, GitCapabilityCheck, GitCapabilityProbeOptions } from './capability.js';
export {
  GitCapabilityError,
  probeGitCapability,
  probeSystemGit,
  requireGitCapability,
} from './capability.js';
export type {
  AdoptSceneClaim,
  AdoptSceneEnvelopeSubset,
  AuthoringEntry,
  AuthoringEntryKind,
  AuthoringManifestOptions,
  AuthoringMode,
  ManifestCheck,
  ManifestRejectionCode,
  PathClassification,
} from './manifest.js';
export {
  AUTHORING_TOPOLOGY,
  AuthoringManifest,
  adoptClaimFromEnvelope,
  classifyAuthoringPath,
  ENTITY_DIRECTORIES,
  ManifestValidationError,
  OPTIONAL_ROOT_AUTHORING_FILE,
  ROOT_AUTHORING_FILES,
  sceneBytesMatchClaim,
  validateAdoptClaim,
} from './manifest.js';
export type {
  GitCommandRunner,
  GitCommandRunnerOptions,
  GitIdentity,
  GitRunRequest,
  GitRunResult,
} from './runner.js';
export {
  ControlledGitRunner,
  GitCommandError,
  GitHostError,
  GitSpawnError,
  GitTimeoutError,
  WORKBENCH_GIT_IDENTITY,
} from './runner.js';
