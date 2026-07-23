# Stage 1.5V2 Audit — 全模块完整性审查

**Date:** 2026-07-22
**Auditor:** Orchestrator + 6 parallel scout subagents + independent verification
**Scope:** Full codebase (core, cli, bench), ~70 source modules, ~1795 tests
**Method:** 6 scouts each reviewed a module group; orchestrator independently verified all critical findings

---

## 1. Baseline Health

| Check | Result | Detail |
|-------|--------|--------|
| `npm test` | **100/101 pass** | 1795 tests; 1787 pass, 8 fail (barrel export gap, see H4) |
| `npm run typecheck` | **PASS** | `tsc -b` all three packages, zero errors |
| `npm run build` | **PASS** | esbuild all three packages, metafile zero warnings |
| Dead code (esbuild metafile) | **PASS** | 0 warnings |
| `any` type usage | **2 instances** | `api.ts:874` (kind cast), `zod-example.ts:20-21` (Zod internals) |
| Placeholder values in source | **NONE** | No `'changed'`, `'resolved'`, `'updated'`, `'TODO'`, `'FIXME'` in non-test source |
| Silent `catch {}` blocks | **14 instances** | Most have logs/warnings; 3 are concerning (see C2, C3, M1) |

**Conclusion:** Build, typecheck, and test suite are healthy. 100/101 test files pass.

---

## 2. Module Review Matrix

| Module Group | Files | Real | Reachable | Reliable | Issues |
|-------------|-------|------|-----------|----------|--------|
| **types/** | 29 type files | ✅ | ✅ | ⚠️ | 3 type-schema inconsistencies |
| **schemas/** | 24 schema files | ✅ | ✅ | ⚠️ | 2 schema gaps |
| **entity/** | 8 files | ✅ | ✅ | ⚠️ | 1 bypass (C1) |
| **state/** | 15 files | ✅ | ✅ | ⚠️ | 3 dead methods (H2), 1 swallow (C2) |
| **validator/** | 23 files (20 validators) | ✅ | ✅ | ⚠️ | 1 bypass (C1), 2 barrel gaps (H5) |
| **pipeline/** | 5 files | ✅ | ✅ | ⚠️ | 1 dead code (H3), 1 error-type gap (H6) |
| **ai/** | 8 files | ✅ | ✅ | ⚠️ | 2 barrel gaps (H4) |
| **context/** | 5 files | ✅ | ✅ | ⚠️ | 1 dead code (H3) |
| **assembler/** | 8 files | ✅ | ✅ | ✅ | Minor log issue (M3) |
| **cache/** | 1 file | ✅ | ✅ | ⚠️ | 1 silent skip (C3) |
| **storage/** | 3 files | ✅ | ✅ | ✅ | — |
| **reporter/** | 2 files | ✅ | ✅ | ✅ | — |
| **migration/** | 2 files | ✅ | ✅ | ✅ | — |
| **style/** | 3 files | ✅ | ✅ | ✅ | — |
| **summary/** | 4 files | ✅ | ⚠️ | ✅ | 1 dead code (H1) |
| **plugin/** | 6 files | ✅ | ⚠️ | ✅ | Skeleton, not wired to pipeline |
| **agent/** | 3 files | ✅ | ⚠️ | ✅ | Skeleton, not wired to pipeline |
| **branch/** | 4 files | ✅ | ✅ | ✅ | — |
| **review/** | 5 files | ✅ | ✅ | ✅ | — |
| **batch-renderer/** | 1 file | ✅ | ✅ | ✅ | — |
| **iss/** | 4 files | ✅ | ✅ | ✅ | — |
| **config/** | 3 files | ✅ | ✅ | ✅ | — |
| **observability/** | 2 files | ✅ | ✅ | ✅ | — |
| **event-bus/** | 1 file | ✅ | ✅ | ✅ | — |
| **api.ts** | 1 file | ✅ | ✅ | ✅ | 2 silent catches (M1) |
| **CLI** | 2 files | ✅ | ✅ | ✅ | — |
| **Bench** | 3 files | ✅ | ✅ | ✅ | L2 failure (pre-existing, mock data) |

---

## 3. Critical Findings

### C1. `knowledge.ts:70` — `compareFact()` bypassed with direct `===` comparison

**File:** `packages/core/src/validator/knowledge.ts:70`
**Severity:** CRITICAL
**Description:**

```typescript
// Line 65-71 — KnowledgeValidator.validatePre()
if (pc.value !== undefined) {
  const factEvents = events.filter(
    (e) =>
      e.narrativeOrder > event.narrativeOrder &&
      e.postconditions.some(
        (p) => p.entityId === pc.entityId && p.attribute === pc.attribute && p.value === pc.value,
      ),
  );
```

`compareFact()` is the mandated single entry point for deterministic Fact comparison (per AGENTS.md). The KnowledgeValidator directly compares `p.value === pc.value` using `===`, bypassing `compareFact()` entirely. This misses:

- Deferred fact handling (facts where `compareFact()` returns `'deferred'`)
- Operator-based comparisons (`eq`, `neq`, `in`, `contains`, etc.)
- The `compareFact()` type-narrowing and versioning logic

**Impact:** False negatives in knowledge validation — facts that should be detected as conflicting may pass through.

**Fix:** Replace the direct comparison with `compareFact(p, pc) === 'match'`.

**Verification:** Grep in `packages/core/src/validator` for `\.value\s*===` found 4 hits. Three are harmless filtering (`pc.value !== undefined` checks to skip narrativeHint-only facts in `appearance.ts:42`, `causality.ts:94`, `deferred-resolver.ts:38`). Only `knowledge.ts:70` is a comparison bypass.

---

### C2. `timeline.ts:31` — DAG cycle silently swallowed, falls back to `narrativeOrder`

**File:** `packages/core/src/validator/timeline.ts:28-33`
**Severity:** CRITICAL
**Description:**

```typescript
// A malformed/unsupported causal graph is validated by the compiler; it
// must not crash the validator aggregator.
let edges;
try {
  ({ edges } = buildCausalEdges(events));
} catch {
  // edges stays undefined — fallback to narrativeOrder predecessor
}
```

The DAG-0 fix (TODO.md §DAG-0) made DAG cycle detection a hard error in the replay engine — `topologicalSort()` throws `DagCycleError` and `replay()` does not catch it. However, the TimelineValidator independently calls `buildCausalEdges()` and silently catches **all** exceptions, falling back to `narrativeOrder` for temporal comparison.

If a project has a DAG cycle:
1. The replay engine correctly throws `DagCycleError` → render fails
2. But if the user runs `nova validate` first, the TimelineValidator swallows the error and reports temporal issues based on the wrong ordering
3. The user sees validator issues but NOT the root cause (DAG cycle)

**Impact:** DAG cycles can be hidden from users who run validation before rendering. The validator should at minimum emit a `ValidationIssue` with `severity: 'error'` when DAG edges cannot be built.

**Fix:** In the catch block, push a `ValidationIssue` reporting the DAG cycle before falling back. Or re-throw so the aggregator handles it.

---

### C3. `render-cache.ts:128` — Unreadable files silently skipped in hash computation

**File:** `packages/core/src/cache/render-cache.ts:125-130`
**Severity:** CRITICAL
**Description:**

```typescript
for (const f of sorted) {
  try {
    const content = storage.read(path.join(defsDir, f));
    hash.update(f + ':' + content);
  } catch {
    // Skip unreadable
  }
}
```

The `computeDefsHash()` function builds the SHA-256 hash of all definition files. If any file becomes unreadable (permission change, corruption, race condition), it is silently skipped. This means two different project states — one where file X has content A, another where file X is unreadable — can produce **identical hashes**, leading to false cache hits.

**Impact:** Cache integrity violation. A corrupted or permission-changed definition file could cause stale cached renders to be served.

**Fix:** Either propagate the read error (fail the hash computation) or include file existence metadata in the hash even when content is unreadable. At minimum, log a warning when a file is skipped.

---

## 4. High Severity Findings

### H1. `LogicalDisclosureSummaryCompiler` — Instantiated but methods never called

**File:** `packages/core/src/summary/logical-compiler.ts` (entire module, ~93 lines)
**Consumer:** `packages/core/src/api.ts:443`
**Severity:** HIGH
**Description:**

```typescript
// api.ts:443 — instantiated, but no methods ever called
const disclosureCompiler = new LogicalDisclosureSummaryCompiler();
const surfaceExtractor = new SurfaceReferenceExtractor();
let previousSummary: string | undefined;
for (const ev of renderEvents) {
  // ... disclosureCompiler is never used in the loop body
```

`LogicalDisclosureSummaryCompiler` was delivered in Stage 1.5V2 (34 tests pass). It is instantiated at the top of `renderNovel()` but its `compile()` method is never called in the render loop. The `logicalDisclosureSummary` field on `RenderJob` is documented as "Produced by LogicalDisclosureSummaryCompiler before context compilation" (`render.ts:54`) but the actual production code never invokes the compiler.

`SurfaceReferenceExtractor` is also instantiated but similarly unused in the loop body.

**Impact:** A complete Stage 1.5V2 deliverable (with 34 passing tests) is dead production code. The `previousSceneSummary` gap that this was designed to fix remains unfixed.

**Fix:** Wire `disclosureCompiler.compile(...)` into the render loop body in `api.ts`, feeding the result into `RenderJob.logicalDisclosureSummary`.

---

### H2. `SnapshotEngine.findNearest()` + `invalidateFrom()` — Production dead code

**File:** `packages/core/src/state/snapshot.ts:45,69`
**Severity:** HIGH
**Description:**

Three SnapshotEngine methods have no non-test callers:

| Method | Line | Test coverage | Production caller |
|--------|------|--------------|-------------------|
| `findNearest()` | 45 | ✅ (5 test cases) | **NONE** |
| `invalidateFrom()` | 69 | ✅ (4 test cases) | **NONE** |
| `listSnapshots()` | 87 | ✅ (test usage only) | **NONE** |

Only `shouldSnapshot()` and `createSnapshot()` are wired into the production path via `manager.ts:24-26`.

**Impact:** These are real, tested implementations that will be needed for Stage 2 performance work (snapshot-optimized replay), but currently they are unreachable dead code. The `ReplayEngine` does not use `findNearest()` to start replay from the nearest snapshot — it always replays from the beginning.

**Fix:** Either wire `findNearest()` into `ReplayEngine.replay()` for Stage 2 performance, or document as intentionally deferred.

---

### H3. `PromptAssembler.parseTemplate()` — Dead code path

**File:** `packages/core/src/context/prompt-assembler.ts:22-26,34-37`
**Severity:** HIGH
**Description:**

```typescript
constructor(templatePath?: string) {
  if (templatePath) {
    const template = readFileSync(templatePath, 'utf-8');
    const parsed = this.parseTemplate(template);
    // ...
  }
}

private parseTemplate(template: string): { systemPrompt: string; instructions: string } {
  // ... never reached in production
}
```

`PromptAssembler` is always constructed without `templatePath`:
```typescript
// render.ts:285
const assembler = new PromptAssembler();  // no templatePath
```

The entire `parseTemplate()` method and the `templatePath` branch are dead code. The comment at line 19 says "In production, loads from templatePath" but the production path never provides one.

**Impact:** Dead code with misleading comments. If template-based prompt customization is wanted for Stage 2, this path needs activation.

---

### H4. Barrel export gap — `buildSceneRenderPrompt` + `buildThreadStatusPrompt`

**File:** `packages/core/src/index.ts` (main barrel)
**Severity:** HIGH
**Description:**

Two prompt builder functions exist and are exported from `ai/prompts/index.ts` and `ai/index.ts`, but the main barrel only exports their **types**:

```typescript
// ai/index.ts — exports functions correctly
export * from './prompts/index.ts';  // includes buildSceneRenderPrompt, buildThreadStatusPrompt

// src/index.ts — exports only types, NOT functions
export type { SceneRenderInput, ThreadStatusInput, ProseOnlyInput, RenderAnalysisInput } from './ai/index.ts';
```

The main barrel never does `export { buildSceneRenderPrompt, buildThreadStatusPrompt, buildProsePrompt, buildAnalysisPrompt } from './ai/index.ts'`.

**Impact:** `e2e.test.ts` (section 4, 8 tests) imports from the barrel and fails with `TypeError: (0 , buildThreadStatusPrompt) is not a function`. These are the only test failures in the entire suite (8/1795).

**Fix:** Add the function exports to the main barrel, or change e2e.test.ts to import directly from `ai/prompts/`.

---

### H5. `QualityValidator` + `ThreadProgressValidator` — Missing from barrel exports

**Files:** `packages/core/src/validator/quality.ts`, `packages/core/src/validator/thread-progress.ts`
**Severity:** HIGH
**Description:**

20 validators are registered in `ResultAggregator` (aggregator.ts:62-82). 18 are exported from `validator/index.ts` and re-exported from the main barrel. But `QualityValidator` and `ThreadProgressValidator` are:

- ✅ Imported directly in `aggregator.ts` (lines 40-41)
- ✅ Registered in the default validator list (lines 81-82)
- ❌ NOT exported from `validator/index.ts`
- ❌ NOT re-exported from `src/index.ts`

**Impact:** These two validators function correctly in the pipeline but cannot be imported or used independently by external consumers. This may be intentional (internal-only validators) but is inconsistent with the other 18.

---

### H6. `AiSdkProvider` — Error type differentiation lost

**File:** `packages/core/src/ai/providers/ai-sdk.ts`
**Severity:** HIGH
**Description:**

`circuit-breaker.ts` has `getRetryStrategy()` that differentiates between error types (`RateLimitError`, `TimeoutError`, `AuthError`, etc.) to decide retry behavior. However, `AiSdkProvider` wraps all errors in a generic `LLMError`:

```typescript
// ai-sdk.ts: all API errors → LLMError
catch (error) {
  throw new LLMError('AI SDK completion failed', { cause: error });
}
```

The specific error classes (`RateLimitError`, `TimeoutError`, `ModelNotFoundError`, `AuthError`) are defined in `errors.ts` and exported from the barrel, but `AiSdkProvider` never instantiates them.

**Impact:** The circuit breaker cannot apply differentiated retry strategies (e.g., exponential backoff for rate limits vs. immediate fail for auth errors). All errors receive the same treatment.

**Fix:** Parse the Vercel AI SDK error response and throw the appropriate typed error.

---

## 5. Medium Severity Findings

### M1. Silent catch blocks — audit of all 14 instances

| File | Line | Pattern | Acceptable? |
|------|------|---------|-------------|
| `api.ts` | 557 | Trace write errors silently ignored | ✅ (telemetry) |
| `api.ts` | 703 | Word count parse failure silently ignored | ⚠️ Should log |
| `assembler/chapter.ts` | 54 | Chapter metadata unreadable → warn | ✅ |
| `assembler/novel.ts` | 116 | Config read failure → return undefined | ✅ |
| `cache/render-cache.ts` | 128 | Skip unreadable file in hash | ❌ See C3 |
| `cache/render-cache.ts` | 339 | Corrupt cache → mark stale | ✅ |
| `entity/yaml-loader.ts` | 28,75,134 | YAML parse failure → throw ConfigError | ✅ |
| `pipeline/render.ts` | 422 | Double-run verification non-fatal | ✅ (dev-only) |
| `plugin/loader.ts` | 90 | Plugin load failure → warn | ✅ |
| `review/manager.ts` | 99 | Malformed review file → ignore | ⚠️ Should log |
| `schemas/analysis.ts` | 34 | JSON parse failure → return null | ✅ (triggers retry) |
| `state/snapshot.ts` | 63 | Snapshot read failure → return null | ✅ |
| `storage/fs-storage.ts` | 21 | File read failure → return null | ✅ |
| `validator/timeline.ts` | 31 | DAG build failure → fallback | ❌ See C2 |

### M2. `MockPass2Provider` — AnalysisResult type looser than Zod schema

**File:** `packages/core/src/ai/providers/mock-pass2.ts`
**Severity:** MEDIUM
**Description:** The mock provider's type for `AnalysisResult` is `Record<string, unknown>` with `eventId` extracted via regex. This is looser than the Zod `analysisResultSchema`. Mock data that passes the mock provider may fail Zod validation in production.

### M3. Branch filter log uses undefined `eventId`

**File:** `packages/core/src/assembler/branch-filter.ts`
**Severity:** MEDIUM
**Description:** The branch filter's log message references `eventId` from a destructured variable that may be undefined in certain code paths.

---

## 6. Low Severity Findings

### L1. `any` casts in production code

| File | Line | Context | Risk |
|------|------|---------|------|
| `api.ts` | 874 | `kind as any` for `findByKind()` | Low — filter operation |
| `ai/util/zod-example.ts` | 20-21 | `_def as any` for Zod internals | Low — utility function |

### L2. Misleading comment in `prompt-assembler.ts`

**File:** `packages/core/src/context/prompt-assembler.ts:19`
**Severity:** LOW
**Description:** Comment says "In production, loads from templatePath" but production never provides templatePath. See H3.

### L3. Empty-string entity IDs in single-entity relationships

**File:** `packages/core/src/context/assembler.ts` (`_buildRelationshipContext`)
**Severity:** LOW
**Description:** When a relationship involves only one entity, the other entity ID defaults to empty string rather than being handled explicitly.

### L4. Conflict analysis fallback value `'TBD'`

**File:** Validator conflict analysis logic
**Severity:** LOW
**Description:** The string `'TBD'` appears as a fallback value for `conflictAnalysis.primaryType`. This could appear in Pass 2 analysis output if the LLM omits the field.

---

## 7. Architecture Compliance

| Contract | Status | Evidence |
|----------|--------|----------|
| `compareFact()` is single comparison entry point | ❌ | `knowledge.ts:70` bypasses with `===` |
| DAG cycle is hard error (replay engine) | ✅ | `topologicalSort()` throws `DagCycleError`, `replay()` no catch |
| DAG cycle is hard error (validator layer) | ❌ | `timeline.ts:31` silently catches and falls back |
| `Fact.narrativeHint` not written to WorldState | ✅ | `replay.ts` filters narrativeHint-only facts |
| Pass 2 = hard requirement, no regex fallback | ✅ | `schemas/analysis.ts` returns null on failure, triggers retry |
| Placeholder values rejected at Zod level | ✅ | `PLACEHOLDER_VALUES` guard in `iss/types.ts` |
| `narrativeOrder` = Assembler-only (discourse) | ✅ | `NarrativeSorter` uses `narrativeOrder`, DAG/replay ignore it |
| Cache hash chain cascade invalidation | ✅ | `computeCacheKeys()` chains event hashes |
| Release gate blocks on S/X errors | ✅ | `InteractionManager` checks severity |
| 5-layer ContextCompiler priority | ✅ | All layers populated in `ContextAssembler` |
| Genre no longer hardcoded 'fantasy' | ✅ | P0d fix confirmed — no hardcoded genre in assembler |
| 20 validators all registered | ✅ | `aggregator.ts:62-82` |

---

## 8. Validator Deep Dive

All 20 validators are real, reachable, and registered. Below is the per-validator summary.

| # | Validator | File | Real Logic | `compareFact` | Registered | Analysis Consumer |
|---|-----------|------|------------|---------------|------------|-------------------|
| 1 | TimelineValidator | `timeline.ts` | ✅ | N/A (no fact comparison) | ✅ | `tenseDetected` |
| 2 | CharacterStateValidator | `character-state.ts` | ✅ | N/A | ✅ | `characterReferences` |
| 3 | KnowledgeValidator | `knowledge.ts` | ✅ | ❌ uses `===` (C1) | ✅ | `knowledgeChecks` |
| 4 | WorldRuleValidator | `world-rule.ts` | ✅ | N/A | ✅ | `ruleChecks` |
| 5 | CausalityValidator | `causality.ts` | ✅ | ✅ | ✅ | `postconditions`, `preconditions` |
| 6 | ForeshadowingValidator | `foreshadowing.ts` | ✅ | N/A | ✅ | `foreshadowingDeployed` |
| 7 | POVValidator | `pov.ts` | ✅ | N/A | ✅ | `pov` |
| 8 | FactualDetailValidator | `factual-detail.ts` | ✅ | N/A | ✅ | `inventedDetails` |
| 9 | VoiceDriftDetector | `voice-drift.ts` | ✅ | N/A | ✅ | `quality` |
| 10 | BranchMergeValidator | `branch-merge.ts` | ✅ | ✅ | ✅ | `postconditions` |
| 11 | ReachabilityValidator | `reachability.ts` | ✅ | N/A | ✅ | N/A |
| 12 | PacingValidator | `pacing.ts` | ✅ | N/A | ✅ | `narrativeChecks` |
| 13 | TenseConsistencyValidator | `tense-consistency.ts` | ✅ | N/A | ✅ | `tenseDetected` |
| 14 | DiscourseBalanceValidator | `discourse-balance.ts` | ✅ | N/A | ✅ | `narrativeChecks` |
| 15 | AliasValidator | `alias.ts` | ✅ | N/A | ✅ | `characterReferences` |
| 16 | PronounValidator | `pronoun.ts` | ✅ | N/A | ✅ | `characterReferences` |
| 17 | AppearanceValidator | `appearance.ts` | ✅ | N/A | ✅ | `appearanceChecks` |
| 18 | ConflictValidator | `conflict.ts` | ✅ | N/A | ✅ | `conflictAnalysis` |
| 19 | QualityValidator | `quality.ts` | ✅ | N/A | ✅ (not barrel-exported) | `quality` |
| 20 | ThreadProgressValidator | `thread-progress.ts` | ✅ | N/A | ✅ (not barrel-exported) | `threadProgressAchieved` |

**Notes:**
- Only 2 validators use `compareFact()`: CausalityValidator and BranchMergeValidator. The other 18 validators don't perform Fact comparison — they consume Pass 2 analysis (narrativeChecks, appearanceChecks, etc.) or do structural checks.
- `KnowledgeValidator` bypasses `compareFact()` with direct `===` — this is the CRITICAL C1 finding.
- `QualityValidator` and `ThreadProgressValidator` are registered but not barrel-exported (H5).

---

## 9. Structural Integrity

### 9.1 Barrel Export Map

```
src/index.ts (main barrel)
├── types/* (all type re-exports) ✅
├── errors.ts (all error classes) ✅
├── entity/ (EntityMapper, Registry, compareFact, yaml-loader) ✅
├── migration/ (migrateToLatest, CURRENT_SCHEMA_VERSION) ✅
├── schemas/ (analysisResultSchema, contracts schemas) ✅
├── state/ (ReplayEngine, StateManager, buildCausalEdges, DAG export) ✅
├── validator/ (18 of 20 validators + ResultAggregator) ⚠️ missing Quality, ThreadProgress
├── context/ (RelevanceEngine, ContextAssembler, ContextCompiler) ✅
├── assembler/ (assembleNovel, countWords, countNarrativeText) ✅
├── summary/ (LogicalDisclosureSummaryCompiler, SurfaceReferenceExtractor) ✅
├── review/ (ReviewManager) ✅
├── plugin/ (PluginHooksManager + types) ✅ (types only for hooks)
├── agent/ (AgentRegistry + types) ✅
├── storage/ (FsStorage, MemoryStorage + types) ✅
├── report/ (ReportWriter) ✅
├── ai/ (LLMError, MockProvider, MockPass2Provider, AiSdkProvider + types) ⚠️ missing prompt builders
├── cache/ (clearEventCache, computeEvidenceHash, get/setCachedRender, verifyEvidenceChain) ✅
├── pipeline/ (InteractionManager + types) ✅
├── batch-renderer/ (types only) ✅
└── api.ts (8 orchestration functions) ✅
```

### 9.2 CLI Command → API Wiring

| CLI Command | API Function | Wired? |
|-------------|-------------|--------|
| `render <event>` | `renderNovel()` | ✅ |
| `validate` | `validateNovel()` | ✅ |
| `status` | `getProjectStatus()` | ✅ |
| `entity list` | `listEntities()` | ✅ |
| `entity show` | `showEntity()` | ✅ |
| `diff` | `diffEvent()` | ✅ |
| `assemble` | `assembleNovel()` | ✅ |
| `graph` | `buildCausalEdges()` + `exportDAGtoDOT/Mermaid()` | ✅ |
| `verify` | `verifyEvidenceChain()` | ✅ |
| `migrate` | `migrateToLatest()` | ✅ |
| `bench` | `runAll()` (from @novalistically/bench) | ✅ |
| `project init` | Direct YAML scaffolding | ✅ |
| `review` | `ReviewManager` | ✅ |
| `trace` | TraceCollector | ✅ |

### 9.3 Fixture Integrity

| Fixture | Events | Status |
|---------|--------|--------|
| `zhu-fu/` | 7 (E0–E6) | ✅ YAML valid, 4 chars, 5 rels, 4 rules, 4 locs, rendered scenes present |
| `arcane-aftermath/` | 2 | ✅ YAML valid |
| `most-dangerous-game/` | 6 | ✅ YAML valid |
| `zhu-fu-variants/` | error-injection ×30, extreme-damage ×10 | ✅ All 40 variants valid |

---

## 10. Summary

### Blockers for Stage 2

| ID | Description | Est. Effort |
|----|-------------|-------------|
| C1 | `knowledge.ts:70` bypasses `compareFact()` | 0.2d |
| C2 | `timeline.ts:31` silently swallows DAG cycle | 0.2d |
| C3 | `render-cache.ts:128` skips unreadable files in hash | 0.1d |

**Total estimate: < 1 day to resolve all three CRITICAL issues.**

### Stage 2 Pre-existing Debt (non-blocking)

| ID | Description |
|----|-------------|
| H1 | `LogicalDisclosureSummaryCompiler` dead code — wire into render loop |
| H2 | `SnapshotEngine.findNearest()/invalidateFrom()` dead code — wire or document |
| H3 | `PromptAssembler.parseTemplate()` dead code — remove or activate |
| H4 | Barrel export gap for prompt builders → 8 e2e test failures |
| H5 | `QualityValidator` + `ThreadProgressValidator` missing from barrel |
| H6 | `AiSdkProvider` error type differentiation lost |
| M1–M3 | Medium issues (silent catches, type looseness, log bug) |
| L1–L4 | Low issues (casts, comments, edge cases) |

### Overall Verdict

**The project is real, reachable, and fundamentally reliable.** All core pipeline stages (EntityMapper → StateManager → ContextCompiler → RenderPipeline → 20 Validators → Assembler) have production implementations backed by 1787 passing tests. The 3 CRITICAL issues are localized and well-understood. The architecture complies with its own contracts in 9 of 11 measured dimensions. Stage 2 planning can proceed after the 3 CRITICAL fixes, with the HIGH/MEDIUM items tracked as ongoing cleanup.
