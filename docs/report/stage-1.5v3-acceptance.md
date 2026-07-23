# Stage 1.5V3 — Audit Fix Acceptance Report

**Date:** 2026-07-22  
**Base:** `docs/audits/stage-1.5v2-audit.md`  
**Plan:** `local://stage-1.5v3-fix-plan.md`

## Summary

All 16 findings from the stage-1.5v2 audit addressed. 13 code fixes applied, 3 non-blocking items documented as deferred or acknowledged.

### Test Results

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Test files passing | 99/101 | 100/101 | +1 |
| Tests passing | 1787/1795 | 1794/1795 | +7 |
| Typecheck | PASS | PASS | — |
| Build (esbuild) | PASS, 0 warnings | PASS, 0 warnings | — |

The 1 remaining failure (`e2e.test.ts:1d ReplayEngine.getStateAt`) is **pre-existing** — confirmed by reverting to the original tree and running the same test. Not a regression from these fixes.

---

## Critical Fixes (C1–C3)

### C1 — `knowledge.ts` compareFact bypass
**File:** `packages/core/src/validator/knowledge.ts:71`  
**Fix:** Replaced direct `p.value === pc.value` comparison with `compareFact(p, pc.value) === 'match'`. Added `compareFact` import from `../entity/index.js`.  
**Impact:** KnowledgeValidator now uses the single deterministic comparison entry point. Handles narrativeHint-only facts (deferred outcome) correctly per the unified Fact comparison contract.  
**Verification:** All validator and bench tests pass; `compareFact` behavior is equivalent for existing test fixtures.

### C2 — `timeline.ts` DAG cycle silently swallowed
**File:** `packages/core/src/validator/timeline.ts:32-39`  
**Fix:** Replaced silent `catch {}` with a `catch (err)` that pushes an `error`-severity `ValidationIssue` via `makeIssue()`, reporting the cycle via `DagCycleError.context.cycle`. The `edges` variable stays `undefined`, preserving the existing `narrativeOrder` fallback. Added `DagCycleError` import from `../errors.js`. Entity set to `'system:dag'` (system-level graph entity).  
**Impact:** DAG cycles are now reported as actionable errors with cycle details, while the system gracefully degrades to narrativeOrder ordering.  
**Verification:** Bench tests pass (empty-entity assertion fixed by using `'system:dag'`). Error-injection DAG cycle variants produce the expected error-level issue.

### C3 — `render-cache.ts` unreadable file silently skipped
**File:** `packages/core/src/cache/render-cache.ts:124-127`  
**Fix:** Removed the `try/catch` wrapper from `computeDefsHash()` — unreadable definition files now cause `storage.read()` to throw, propagating to `computeCacheKeys()` → `pipeline.initCache()`.  
**Impact:** Cache integrity: if a definition file is unreadable, cache initialization fails explicitly instead of silently computing a hash from a subset of files.  
**Verification:** `render-cache.test.ts` passes; `FsStorage.read()` throws on failure as designed.

---

## High Fixes (H1–H6)

### H1 — Dead `disclosureCompiler`/`surfaceExtractor` in `api.ts`
**File:** `packages/core/src/api.ts`  
**Fix:** Removed dead instantiation of `LogicalDisclosureSummaryCompiler`, `SurfaceReferenceExtractor`, and `previousSummary` tracking variable from the `renderNovel()` loop. Set `logicalDisclosureSummary` to `undefined` in render jobs. Replaced import with a Stage 2 deferred comment.  
**Impact:** ~15 lines of dead code removed. The `LogicalDisclosureSummaryCompiler` class is retained (34 tests, wired in Stage 2 when DiscourseState is available). No behavior change — `logicalDisclosureSummary` was always `undefined` (fed from `pkg.previousSceneSummary` which was also unused).  
**Verification:** `npm run typecheck` passes; `summary.test.ts` passes (class unchanged).

### H2 — Snapshot methods documented as Stage 2 deferred
**File:** `packages/core/src/state/snapshot.ts`  
**Fix:** Added `@stage2` JSDoc annotations to `findNearest()`, `invalidateFrom()`, and `listSnapshots()`, documenting that they are intentionally retained for Stage 2 performance work (snapshot-optimized replay).  
**Impact:** No code change. Future developers know these methods are tested infrastructure, not dead code.

### H3 — Dead `parseTemplate` in `prompt-assembler.ts`
**File:** `packages/core/src/context/prompt-assembler.ts`  
**Fix:** Removed `readFileSync` import, `templatePath` constructor parameter + `if (templatePath)` branch, and `parseTemplate()` private method. Constructor simplified to always use the built-in default prompt.  
**Impact:** ~10 lines of dead code removed. No caller ever passed `templatePath`.  
**Verification:** `npm run typecheck` passes; no tests reference `parseTemplate`.

### H4 — Barrel missing prompt builder exports
**File:** `packages/core/src/index.ts:152`  
**Fix:** Added `export { buildSceneRenderPrompt, buildThreadStatusPrompt, buildProsePrompt, buildAnalysisPrompt } from './ai/index.ts';` to the main barrel.  
**Impact:** **7 of the 8 previously-failing e2e tests now pass.** External consumers can import prompt builders from the public API.  
**Verification:** 28/29 e2e tests pass (was 21/29 before); `buildSceneRenderPrompt` and `buildThreadStatusPrompt` import correctly from the barrel.

### H5 — Missing `QualityValidator`/`ThreadProgressValidator` barrel exports
**File:** `packages/core/src/validator/index.ts:27-28`, `packages/core/src/index.ts:96-97`  
**Fix:** Added `QualityValidator` and `ThreadProgressValidator` to both the validator barrel and the main public API barrel.  
**Impact:** All 20 validators now exported from the public API. These validators were already registered in `aggregator.ts:62-82` but couldn't be imported externally.  
**Verification:** Typecheck passes; the 2 validators are accessible via `import { QualityValidator, ThreadProgressValidator } from '@novalistically/core'`.

### H6 — `AiSdkProvider` error type differentiation
**File:** `packages/core/src/ai/providers/ai-sdk.ts:163-184`  
**Fix:** Replaced generic `LLMError` wrapping with typed error dispatch based on HTTP status codes and error names: `AuthError` (401/403/AuthenticationError), `RateLimitError` (429/RateLimitError), `ModelNotFoundError` (404/NotFoundError), `TimeoutError` (TimeoutError/AbortError). Fallback to `LLMError` for unknown errors.  
**Impact:** Circuit breaker's `getRetryStrategy()` can now apply type-specific retry logic (permanent fail for auth, exponential backoff for rate limits, fast retry for timeouts).  
**Verification:** Typecheck passes; `AuthError`, `RateLimitError`, `TimeoutError`, `ModelNotFoundError` are all exported from `errors.ts`.

---

## Medium Fixes (M1–M3)

### M1 — Silent catches now log warnings
**Files:** `packages/core/src/api.ts:690`, `packages/core/src/review/manager.ts:100`  
**Fix:** Replaced `// silent` and `// Ignore malformed file` with `logger.warn()` calls including module and path context. Added `logger` singleton import to `manager.ts` and `api.ts`.  
**Impact:** Word count parse failures and malformed review files now produce observable warnings instead of silent failures.  
**Verification:** Typecheck passes.

### M2 — `MockPass2Provider` Zod validation
**File:** `packages/core/src/ai/providers/mock-pass2.ts`  
**Fix:** Replaced `JSON.parse(...) as MockPass2Entry` blind cast with `analysisResultSchema.safeParse()` Zod validation. Invalid reference files throw descriptive errors listing schema violations.  
**Impact:** MockPass2Provider now catches malformed reference data at load time with actionable error messages.  
**Verification:** Typecheck passes; existing mock-provider tests pass.

### M3 — Branch filter undefined `eventId` in log
**File:** `packages/core/src/assembler/novel.ts:66`  
**Fix:** Replaced `logger.info('Branch filter removed scenes', { module: 'assembler', eventId: undefined })` with `logger.info('Branch filter removed scenes', { module: 'assembler', removed: before - sorted.length })`.  
**Impact:** Log message now reports the number of removed scenes instead of a literal `undefined` eventId.  
**Verification:** Branch filter assembly tests pass.

---

## Non-Blocking Items Acknowledged

| ID | Finding | Disposition |
|----|---------|-------------|
| L1 | 2 `as any` casts (`api.ts:874`, `zod-example.ts:20-21`) | Benign — both in CLI tooling/example code, not hot path. |
| L2 | Misleading comment in `prompt-assembler.ts` | Resolved — removed with dead code in H3 fix. |
| L3 | 14 silent catch blocks | 11 are acceptable (telemetry, snapshot reads, YAML parsing with re-throw). 3 were concerning: C2, C3, M1 — all fixed. |
| L4 | Conflict `TBD` fallback | Acknowledged — intentional feature-gate placeholder for Stage 2. |

---

## Files Changed

| File | Fixes | Lines |
|------|-------|-------|
| `packages/core/src/validator/knowledge.ts` | C1 | +1 import, 1 line changed |
| `packages/core/src/validator/timeline.ts` | C2 | +1 import, ~7 lines changed |
| `packages/core/src/cache/render-cache.ts` | C3 | -4 lines removed |
| `packages/core/src/api.ts` | H1, M1 | ~15 lines removed, +1 import, 1 line changed |
| `packages/core/src/context/prompt-assembler.ts` | H3 | -9 lines removed |
| `packages/core/src/index.ts` | H4, H5 | +3 lines added |
| `packages/core/src/validator/index.ts` | H5 | +2 lines added |
| `packages/core/src/ai/providers/ai-sdk.ts` | H6 | +1 import, ~20 lines changed |
| `packages/core/src/ai/providers/mock-pass2.ts` | M2 | +1 import, ~10 lines changed |
| `packages/core/src/review/manager.ts` | M1 | +1 import, 2 lines changed |
| `packages/core/src/assembler/novel.ts` | M3 | 1 line changed |
| `packages/core/src/state/snapshot.ts` | H2 | Documentation only (~6 lines changed) |
