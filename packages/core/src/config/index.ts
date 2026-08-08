// ============================================================================
// Config — barrel exports
// ============================================================================

export type { DefaultConfig } from './defaults.js';
export {
  DEFAULT_CONFIG,
  DEFAULT_RELEASE_POLICY,
  resolveReleasePolicy,
} from './defaults.js';
export type { ConfigLayer } from './loader.js';
export { ConfigLoader, resolveConfig } from './loader.js';
export type { ProjectSkeletonFile } from './project-skeleton.js';
export { createMinimalProjectSource } from './project-skeleton.js';
