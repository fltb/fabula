# Circuit Breaker Error Matrix

**Date:** 2026-07-31
**Version:** 2.0
**Status:** Synced with `packages/core/src/pipeline/circuit-breaker.ts` + `packages/core/src/errors.ts`

## Overview

`getRetryStrategy()`（`packages/core/src/pipeline/circuit-breaker.ts` — note: **not** `ai/circuit-breaker.ts`）是一个独立的错误分类辅助函数：目前**没有任何生产调用方**。渲染循环使用自己的断路器/字符串超时检测，`AiSdkProvider.complete()` 把一切 SDK 失败统一包装为未分类的 `LLMError`——因此生产中的 401/429/404 并不会走本文档描述的 immediate_abort/backoff 分支。本矩阵记录该函数的映射本身，以及错误类与代码（定义于 `packages/core/src/errors.ts`）。

## Error Matrix

`getRetryStrategy(error, attempt)` 内部是 `instanceof` 分派。只有五种错误类型被显式处理；**其余所有错误（包括未知/瞬时错误）落入默认分支：`backoff` 固定 500 ms 延迟**。下表各行的 Trigger Condition 描述的是该类错误被显式抛出时的语义；生产提供者目前不把 HTTP 状态翻译为这些类型，故这些条件不会自然触发。

| # | Error Type | Code | Trigger Condition | Strategy | Backoff Details | Test |
|---|-----------|------|-------------------|----------|----------------|------|
| 1 | `RateLimitError` | `PROVIDER_RATE_LIMIT` | HTTP 429 from provider | **backoff** | **Linear** delay, no jitter, no cap: `delayMs = 1000 * (attempt + 1)` (attempt starts at 0) | `errors.test.ts` |
| 2 | `TimeoutError` | `PROVIDER_TIMEOUT` | Request exceeds provider timeout | **jitter** | Random jitter: `delayMs = 500 + Math.random() * 1000` (500–1500 ms); no exponential growth | `errors.test.ts` |
| 3 | `AuthError` | `PROVIDER_AUTH` | HTTP 401/403 from provider | **immediate_abort** | No retry — authentication failure is permanent | `errors.test.ts` |
| 4 | `ModelNotFoundError` | `PROVIDER_MODEL_NOT_FOUND` | Provider returns model-not-found (404) | **immediate_abort** | No retry — model does not exist | `errors.test.ts` |
| 5 | `ValidationError` | `VALIDATION_FAILED` | Pass 2 JSON fails Zod schema validation after retry-with-feedback | **no_retry** | Feedback correction attempted first; if still invalid, fail hard | `errors.test.ts` |
| 6 | `PipelineError` | `PIPELINE_FAILURE` | Render pipeline internal failure | **backoff** (default branch) | Fixed 500 ms delay | `errors.test.ts` |
| 7 | `ConfigError` | `CONFIG_INVALID` | Invalid YAML schema, bad project config | **backoff** (default branch) | Fixed 500 ms delay | `errors.test.ts` |
| 8 | `StorageError` | `STORAGE_FAILURE` | File I/O failure (disk full, permissions) | **backoff** (default branch) | Fixed 500 ms delay | `errors.test.ts` |
| 9 | `StorageConflictError` | `STORAGE_CONFLICT` | Storage CAS/transaction conflict (stale expected hash) | **backoff** (default branch) | Fixed 500 ms delay | `storage-transaction.test.ts`, `editorial/revision-store.test.ts`, `editorial/operation-store.test.ts`, `review.test.ts` |
| 10 | `DagCycleError` | `DAG_CYCLE` | Cyclic dependency in causal graph | **backoff** (default branch) | Fixed 500 ms delay | `state/dag.test.ts` |
| 11 | `DagProviderError` | `DAG_PROVIDER_INVALID` | Missing/ambiguous causal provider | **backoff** (default branch) | Fixed 500 ms delay | `state/dag.test.ts` |
| 12 | `PreconditionMismatchError` | `PRECONDITION_MISMATCH` | Event precondition doesn't match state | **backoff** (default branch) | Fixed 500 ms delay | `state/replay-set-unset.test.ts`, `state/presence-aware-preconditions.test.ts` |
| 13 | `ReferenceFormatError` | `REFERENCE_FORMAT_INVALID` | Invalid reference data format | **backoff** (default branch) | Fixed 500 ms delay | `errors.test.ts` |
| 14 | `CacheCorruptionError` | `CACHE_CORRUPT` | Current cache reads catch unreadable meta.json, JSON parse errors, and even `CacheCorruptionError` itself and return `null` (a clean miss with a corrupt diagnostic; the cache test explicitly asserts a safe miss, not a throw) — cache corruption does not enter retry dispatch | **backoff** (default branch, only when thrown externally) | Fixed 500 ms delay | `render-cache.test.ts` |
| 15 | `AssemblyIncompleteError` | `ASSEMBLY_INCOMPLETE` | Novel assembly missing required scenes | **backoff** (default branch) | Fixed 500 ms delay | `errors.test.ts` |
| 16 | `NetworkDeniedError` | `NETWORK_DENIED` | Network access blocked by policy | **backoff** (default branch) | Fixed 500 ms delay | `network-deny.test.ts` |
| 17 | `RuleConstraintViolationError` | `RULE_CONSTRAINT_VIOLATION` | World rule constraint violated | **backoff** (default branch) | Fixed 500 ms delay | `state/rule-constraint-evaluation.test.ts` |
| 18 | `NovalisticallyError` | (base) | Base error class, not thrown directly | N/A | Abstract base class; never dispatched | `errors.test.ts` |
| 19 | `sanitizeError()` | N/A | Sanitizes error for public output | N/A | Utility function, not an error class | `errors.test.ts` |

## Strategy Summary

| Strategy | Count | Description |
|----------|-------|-------------|
| `backoff` | 13 | `RateLimitError` (linear `1000 * (attempt + 1)`) + the default branch (fixed 500 ms) covering the 12 remaining concrete error classes |
| `jitter` | 1 | `TimeoutError` — random 500–1500 ms |
| `immediate_abort` | 2 | Auth/model-not-found — permanent failures |
| `no_retry` | 1 | `ValidationError` — schema validation failure |
| N/A | 2 | Base class + utility |

## Retry Configuration

There is **no `DEFAULT_RETRY_CONFIG` export**. The delay formulas live directly in `getRetryStrategy()` (`packages/core/src/pipeline/circuit-breaker.ts`):

```typescript
// Explicit dispatch
RateLimitError  → { shouldRetry: true,  delayMs: 1000 * (attempt + 1), strategy: 'backoff' }
TimeoutError    → { shouldRetry: true,  delayMs: 500 + Math.random() * 1000, strategy: 'jitter' }
AuthError       → { shouldRetry: false, delayMs: 0, strategy: 'immediate_abort' }
ModelNotFoundError → { shouldRetry: false, delayMs: 0, strategy: 'immediate_abort' }
ValidationError → { shouldRetry: false, delayMs: 0, strategy: 'no_retry' }
// Default — transient/unknown error
anything else   → { shouldRetry: true,  delayMs: 500, strategy: 'backoff' }  // fixed delay
```

There is no exponential factor, no max-delay cap, and no base/jitter mix in the current implementation: rate-limit delays grow **linearly** (`1000ms`, `2000ms`, `3000ms`, …), timeouts get a flat 500–1500 ms jitter, and the default branch is a **fixed 500 ms** backoff.

### Circuit Breaker State Machine

`createCircuitBreaker(config?)` drives the render pipeline's three-round escalation:

```typescript
const cfg = {
  maxRounds: 3,            // default
  maxAttemptsPerRound: 2,  // default
  failureThreshold: 3,     // consecutive failures before the breaker opens
  escalationDelay: 0,      // ms between rounds (default 0) — configured but NEVER read; no inter-round delay
};
```

- Total attempt cap: `maxRounds * maxAttemptsPerRound` = 6 attempts; reaching it opens the breaker (`escalatedStrategy: 'abort'`).
- Round 1 → `retry`, Round 2 → `prompt_fix`, Round 3 → `abort` are strategy labels only. Round 1 is not a same-prompt retry: validation retries append the prior error messages to the retry prompt (`previousErrorMessages`, injected when `attempts > 1`). `escalate()` sets the round-3 label to `abort` without opening the breaker, so the remaining round-3 attempts still run — actual stopping comes from the total-attempt cap or `failureThreshold` opening the breaker.
- `recordFailure()` increments consecutive failures; at `failureThreshold` the breaker opens. `recordSuccess()` resets the counter. `escalate()` advances the round and resets consecutive failures.

### Pass 2 Validation Retry

- Pass 2 JSON validation failures use *retry-with-feedback* (Instructor pattern), handled in the pipeline (`pipeline/render.ts`), not by the circuit breaker's `getRetryStrategy()`.
- Zod validation errors are fed back to the LLM for correction — up to 4 sub-attempts (initial + up to 3 feedback retries).
- The `ValidationError` class is still mapped to `no_retry` by `getRetryStrategy()` when thrown externally; inside the pipeline, schema failures surface as `Pass2RejectionCategory` (`empty` / `parse` / `validation`) and exhaust to `needsReview` rather than throwing.

## Coverage Verification

All 17 concrete error classes from `packages/core/src/errors.ts` plus the `NovalisticallyError` base are accounted for (18 classes, rows 1–18); `sanitizeError` is included as row 19 for completeness. Error codes follow the `defineError()` table in `errors.ts`: `CONFIG_INVALID`, `STORAGE_FAILURE`, `STORAGE_CONFLICT`, `VALIDATION_FAILED`, `DAG_PROVIDER_INVALID`, `DAG_CYCLE`, `PRECONDITION_MISMATCH`, `REFERENCE_FORMAT_INVALID`, `CACHE_CORRUPT`, `PIPELINE_FAILURE`, `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_MODEL_NOT_FOUND`, `ASSEMBLY_INCOMPLETE`, `NETWORK_DENIED`, `RULE_CONSTRAINT_VIOLATION`.

Test coverage: `packages/core/tests/errors.test.ts` instantiates all concrete error classes **except `StorageConflictError`** (its class table omits that class), verifies each exact code, and tests the `getRetryStrategy` dispatch — the five explicit branches plus generic unknown/string fallthrough to the 500 ms default branch (not every default-branch class). `StorageConflictError` behavior is exercised by the storage/editorial CAS-conflict tests: `storage-transaction.test.ts`, `editorial/revision-store.test.ts`, `editorial/operation-store.test.ts`, and `review.test.ts` (see row 9's Test column).

---

*This matrix documents every provider/render error type, its trigger condition, retry strategy, and corresponding test reference.*
