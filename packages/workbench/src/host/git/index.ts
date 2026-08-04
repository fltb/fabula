/** Optional Git mirror support for native revisions. Git never authorizes acceptance. */

export { createGitRevisionMirror, type GitRevisionMirrorOptions } from './revision-mirror.js';
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
