// ============================================================================
// Default Configuration — built-in values for all configurable parameters
// ============================================================================

import type { ReleasePolicy } from '../types/index.ts';

export type { ReleasePolicy };

/**
 * Canonical default release policy: warning-only candidates are ACCEPTED but
 * their reasons/fingerprints are recorded with the decision. Legacy projects
 * without a `releasePolicy` always get this default — the policy is never
 * inferred from historical pending_waiver records.
 */
export const DEFAULT_RELEASE_POLICY: ReleasePolicy = {
  warnings: 'accept-and-record',
  openBlockingReviews: 'block',
};

/**
 * Resolve a possibly-partial project release policy to the canonical shape.
 * `openBlockingReviews` is a fixed literal for now; only `warnings` is
 * configurable.
 */
export function resolveReleasePolicy(value?: Partial<ReleasePolicy> | null): ReleasePolicy {
  return {
    warnings: value?.warnings ?? DEFAULT_RELEASE_POLICY.warnings,
    openBlockingReviews: 'block',
  };
}

export const DEFAULT_CONFIG = {
  /** How often (in events) to write a snapshot */
  snapshotInterval: 10,
  concurrency: 5,
  /** Minimum log level to emit */
  logLevel: 'info' as const,
  /** Trace level: 'off' | 'basic' | 'detailed' */
  traceLevel: 'off' as const,
  /** Default target word/character count for scene prose */
  defaultSceneTextTarget: 400,
  /** Whether to use render cache */
  cacheEnabled: true,
  /** Project release policy (defaults to accept-and-record). */
  releasePolicy: DEFAULT_RELEASE_POLICY,
};

export type DefaultConfig = typeof DEFAULT_CONFIG;
