/**
 * Host-only authentication backoff policy. The persistence worker records
 * failure counts; this policy turns a count into a lock window derived from
 * the last failure time, so no clock is persisted and the lock is fully
 * deterministic for a given policy.
 */
export interface BackoffPolicy { initialDelayMs: number; factor: number; maxDelayMs: number }

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = { initialDelayMs: 500, factor: 2, maxDelayMs: 60_000 };

export function backoffDelayMs(failures: number, policy: BackoffPolicy): number {
  if (failures <= 1) return Math.min(policy.initialDelayMs, policy.maxDelayMs);
  const raw = policy.initialDelayMs * policy.factor ** (failures - 1);
  return Math.min(raw, policy.maxDelayMs);
}
