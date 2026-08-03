/**
 * Workbench Host Git authoring boundary: controlled command runner, verified
 * system-Git capability probe, the strict AuthoringManifest, the deterministic
 * repository bootstrap, journal-backed submit recovery, and the exact-once
 * authoring submit service. Git belongs exclusively to this directory; Core,
 * browser, MCP and Agents never invoke Git directly.
 */

export type { GitBootstrapOptions, GitBootstrapResult } from './bootstrap.js';
export {
  DEFAULT_BOOTSTRAP_IGNORE_PATTERNS,
  GIT_BASELINE_SUBJECT,
  GitBootstrap,
  GitBootstrapConflictError,
  GitBootstrapDirtyError,
  GitBootstrapError,
  GitBootstrapInputError,
  GitBootstrapRefConflictError,
} from './bootstrap.js';
export type { GitCapability, GitCapabilityCheck, GitCapabilityProbeOptions } from './capability.js';
export {
  GitCapabilityError,
  probeGitCapability,
  probeSystemGit,
  requireGitCapability,
} from './capability.js';
export type {
  SubmitJournalPort,
  SubmitJournalRecord,
  SubmitRecoveryOptions,
  SubmitRecoveryOutcome,
  SubmitRecoveryProbe,
} from './recovery.js';
export {
  normalizeSubmitJournal,
  receiptFromRecord,
  resolveSubmitRecovery,
  SUBMIT_PHASE_COMPLETE,
  SUBMIT_PHASE_CONFLICT,
  SUBMIT_PHASE_STALE,
  SubmitRecovery,
} from './recovery.js';
export type {
  GitCommandRunner,
  GitCommandRunnerOptions,
  GitIdentity,
  GitPreflightCheck,
  GitPreflightCondition,
  GitRepositoryPreflight,
  GitRepositoryPreflightOptions,
  GitRunRequest,
  GitRunResult,
} from './runner.js';
export {
  ControlledGitRunner,
  GitArgsRejectedError,
  GitCommandError,
  GitDivergenceError,
  GitEnvironmentRejectedError,
  GitHostError,
  GitIsolationError,
  GitSpawnError,
  GitTimeoutError,
  WORKBENCH_AUTHORING_REF,
  WORKBENCH_GIT_IDENTITY,
} from './runner.js';
export type {
  AuthoringSubmitOutcome,
  AuthoringSubmitProvenance,
  AuthoringSubmitRejectionCode,
  CandidateValidationResult,
  CandidateValidator,
  GitAuthoringSubmitRequest,
  GitAuthoringSubmitServiceOptions,
  WorkingStateVectorConfirmation,
  WorkingStateVectorConfirmer,
} from './submit-service.js';
export {
  AuthoringSubmitInputError,
  AuthoringSubmitPreflightError,
  AuthoringSubmitRecoveryError,
  GitAuthoringSubmitError,
  GitAuthoringSubmitService,
} from './submit-service.js';
