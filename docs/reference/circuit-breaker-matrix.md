# Circuit Breaker Error Matrix

**Date:** 2026-07-22
**Version:** 1.0
**Status:** Baseline frozen

## Overview

Every provider/render error type has a corresponding retry strategy in the circuit breaker. This matrix documents the complete mapping.

## Error Matrix

| # | Error Type | Code | Trigger Condition | Strategy | Backoff Details | Test |
|---|-----------|------|-------------------|----------|----------------|------|
| 1 | `RateLimitError` | `RATE_LIMIT` | HTTP 429 from provider | **backoff** | Exponential backoff with jitter; base delay 1s, max 60s, factor 2x | `errors.test.ts` |
| 2 | `TimeoutError` | `TIMEOUT` | Request exceeds timeout (default 120s) | **jitter** | Retry with random jitter (0-2s); no exponential growth | `errors.test.ts` |
| 3 | `AuthError` | `AUTH_ERROR` | HTTP 401/403 from provider | **immediate_abort** | No retry — authentication failure is permanent | `errors.test.ts` |
| 4 | `ModelNotFoundError` | `MODEL_NOT_FOUND` | Provider returns model-not-found (404) | **immediate_abort** | No retry — model does not exist | `errors.test.ts` |
| 5 | `ValidationError` | `VALIDATION_ERROR` | Pass 2 JSON fails Zod schema validation after retry-with-feedback | **no_retry** | Feedback correction attempted first; if still invalid, fail hard | `errors.test.ts` |
| 6 | `PipelineError` | `PIPELINE_ERROR` | Render pipeline internal failure | **no_retry** | Pipeline errors indicate structural problems, not transient failures | `errors.test.ts` |
| 7 | `ConfigError` | `CONFIG_INVALID` | Invalid YAML schema, bad project config | **no_retry** | Configuration errors require manual fix | `errors.test.ts` |
| 8 | `StorageError` | `STORAGE_ERROR` | File I/O failure (disk full, permissions) | **no_retry** | Storage errors are environmental, not transient | `errors.test.ts` |
| 9 | `DagCycleError` | `DAG_CYCLE` | Cyclic dependency in causal graph | **no_retry** | Data model error requires YAML fix | `dag.test.ts` |
| 10 | `DagProviderError` | `DAG_PROVIDER_INVALID` | Missing/ambiguous causal provider | **no_retry** | Data model error requires YAML fix | `dag.test.ts` |
| 11 | `PreconditionMismatchError` | `PRECONDITION_MISMATCH` | Event precondition doesn't match state | **no_retry** | Data inconsistency requires data fix | `replay-set-unset.test.ts` |
| 12 | `ReferenceFormatError` | `REFERENCE_FORMAT` | Invalid reference data format | **no_retry** | Reference data corruption | `contracts.test.ts` |
| 13 | `CacheCorruptionError` | `CACHE_CORRUPTION` | Hash chain verification failed | **no_retry** | Cache invalidation and rebuild | `render-cache.test.ts` |
| 14 | `AssemblyIncompleteError` | `ASSEMBLY_INCOMPLETE` | Novel assembly missing required scenes | **no_retry** | Structural assembly failure | `assembler.test.ts` |
| 15 | `NetworkDeniedError` | `NETWORK_DENIED` | Network access blocked by policy | **no_retry** | Policy enforcement — no network allowed | `network-deny.test.ts` |
| 16 | `RuleConstraintViolationError` | `RULE_CONSTRAINT` | World rule constraint violated | **no_retry** | Rule violation in story logic | `rule.test.ts` |
| 17 | `NovalisticallyError` | (base) | Base error class, not thrown directly | N/A | Abstract base class | `errors.test.ts` |
| 18 | `sanitizeError()` | N/A | Sanitizes error for public output | N/A | Utility function, not an error class | `errors.test.ts` |

## Strategy Summary

| Strategy | Count | Description |
|----------|-------|-------------|
| `backoff` | 1 | Exponential backoff + jitter for rate limits |
| `jitter` | 1 | Random jitter for timeouts |
| `immediate_abort` | 2 | Auth/model-not-found — permanent failures |
| `no_retry` | 13 | Structural/config/data errors requiring manual fix |
| N/A | 1 | Base class + utility |

## Retry Configuration

From `packages/core/src/ai/circuit-breaker.ts`:

```typescript
const DEFAULT_RETRY_CONFIG = {
  maxAttemptsPerRound: 3,     // 3 attempts per LLM call round
  baseDelayMs: 1000,          // 1 second base delay
  maxDelayMs: 60000,          // 60 seconds maximum delay  
  backoffFactor: 2,           // Exponential factor
  jitterMaxMs: 2000,          // 2 seconds max jitter
};
```

### Retry Logic
- `getRetryStrategy(error)` uses `instanceof` type-aware dispatch
- RateLimitError → `{ strategy: 'backoff', delay: min(baseDelay * factor^attempt + jitter, maxDelay) }`
- TimeoutError → `{ strategy: 'jitter', delay: random(0, jitterMaxMs) }`
- AuthError / ModelNotFoundError → `{ strategy: 'immediate_abort' }`
- All other errors → `{ strategy: 'no_retry' }`

### Pass 2 Validation Retry
- Pass 2 JSON validation failures use *retry-with-feedback* (Instructor pattern)
- Zod validation errors are fed back to the LLM for correction
- This is separate from the circuit breaker retry system
- After all retry attempts exhausted → ValidationError (no_retry)

## Coverage Verification

All 17 error classes from `packages/core/src/errors.js` are mapped. The `sanitizeError` utility function is included as row 18 for completeness.

Test coverage: `packages/core/tests/errors.test.ts` covers all 17 error class instantiations and error code correctness.

---

*This matrix documents every provider/render error type, its trigger condition, retry strategy, and corresponding test reference.*
