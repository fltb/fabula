# api-core-validator: API initialization/caching, core API boundary, and validator schema cohesion

## Group Status: [x] completed

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| AGG-1 | [x] | — | `docs/TODO.md` lines 122-202 |
| API-1 | [x] | — | `docs/TODO.md` lines 1082-1105 |
| API-2 | [x] | API-1 | `docs/TODO.md` lines 1107-1132 |
| API-3 | [x] | API-1 | `docs/TODO.md` lines 1134-1147 |
| API-4 | [x] | API-1 | `docs/TODO.md` lines 1149-1161 |
| API-5 | [x] | API-1 | `docs/TODO.md` lines 1163-1179 |
| CORE-API-1 | [x] | — | `docs/TODO.md` lines 1308-1354 |

## Group-level dependencies
None — this is a Wave 1 group.

## Evidence

### AGG-1: ALREADY IMPLEMENTED (no code change)
- `AnalysisBlockRequirement` has `schema: import('zod').ZodTypeAny` field at `packages/core/src/types/validator.ts:35` (spec named it `zodSchema`, code uses `schema` — kept established name)
- All 20 validators return zod fragments from `getAnalysisRequirements()` (confirmed 16 return non-empty arrays)
- `ResultAggregator.getCombinedValidationSchema()` at `aggregator.ts:329-344` merges fragments, includes plugin validators
- `render.ts:317` calls `parseAnalysisJSONWithErrors(analysisRaw, this.aggregator?.getCombinedValidationSchema())` — dynamic schema passed
- Spec step 5 (delete `analysisContentSchema` and `parseAnalysisJSON*` from `schemas/analysis.ts`) NOT applied: `analysisContentSchema` is imported by `schemas/analysis.ts:11` as the building block for `analysisResultSchema`, which is consumed by `contracts.ts:2`, `index.ts:42`, and `render.ts:23`. The file is retained as integration glue. The spec's intent (per-validator fragments, aggregator merge, render uses dynamic schema) is fully met.

### API-1: Module-level cache added
- `packages/core/src/api.ts`: Added `projectCache` (module-level `Map<string, ProjectCacheEntry>`) and `computeProjectHash()` at lines 46-89
- `initializeProject()` (line 159) now computes `hash = computeProjectHash(projectDir, events)` and checks cache before rebuilding
- Hash composed of: content of all YAML files in `definitions/`, content of `nova.yaml`, content of all event YAML files in `events/`, plus `projectDir` — per orchestration pragmatism
- On cache hit with matching hash, returns cached `{mapper, data, events, registry, stateManager, state}`

### API-2: ALREADY IMPLEMENTED (no code change)
- `renderNovel` dryRun (line 276) and full render both use `boundaries.stateBeforeByEventId.get(ev.id)` — NOT `getStateAt(ev.narrativeOrder - 1)`
- Confirmed at `packages/core/src/api.ts:277` (dryRun) and `api.ts:340` (full render)

### API-3: Optional validationResults parameter
- `getProjectStatus()` signature at `api.ts:553-556` now accepts `validationResults?: Map<string, ValidationResult>`
- When provided, skips internal `aggregator.validateAll()` call (lines 596-601)
- Backward-compatible: existing callers (`cli/src/index.ts:266`, `cli/src/mcp-server.ts:31,153,175`) pass no second argument and continue to work

### API-4: ALREADY IMPLEMENTED (no code change)
- `initializeProject()` (api.ts:167-202) returns `state: WorldState = {entities:{}, relationships:{}, ...}` — no commit loop
- `renderNovel` uses boundaries for state, not the returned empty state
- Root cause (O(n²) commit loop) removed before this task

### API-5: Implemented via API-1 cache
- Same module-level project cache at `packages/core/src/api.ts:60` (`projectCache`)
- Cache key is content-hash based, not mtime-only, per spec requirement
- Cached result verified by matching hash before returning

### CORE-API-1: Exports trimmed per consumer audit
- Kept all exports consumed by `packages/cli/src/` and `packages/bench/src/` and their tests
- Kept all spec-mandated keep-list items (renderNovel, validateNovel, getProjectStatus, diffEvent, listEntities, showEntity, assembleNovel, AiSdkProvider, MockProvider, MockPass2Provider, Storage, FsStorage, MemoryStorage, compareFact, countWords, readYamlFile, all types)
- Symbols REMOVED from `packages/core/src/index.ts` (zero repo-internal consumers):
  1. `compareTimestamp` (from entity)
  2. `parseStoryTimestamp` (from entity)
  3. `resolveTimestampToDay` (from entity)
  4. `readYamlFilesInDir` (from entity)
  5. `JsonlLogTransport`, `Logger`, `logger`, `MemoryLogTransport` (from observability)
  6. `TraceCollector` (from observability)
  7. `createEmptyBranchPath`, `includesPath`, `evaluateCondition`, `branchPathsEqual`, `branchPathToString`, `isLinearNarrative`, `createBranchPoint`, `getAvailableChoices` (all branch utils)
  8. `EventStore`, `SnapshotEngine`, `topologicalSort` (from state)
  9. `PromptAssembler` (from context — `RelevanceEngine` and `ContextAssembler` KEPT due to core test consumers)
  10. `SceneCollector`, `NarrativeSorter`, `ProseConcatenator` (from assembler)
  11. `NARRATIVE_TEXT_COUNT_VERSION` (from assembler)
  12. `detectAntiPatterns`, `validateStrict` (from ISS)
  13. `PluginLoader`, `ValidatorRegistry` (from plugin — type `PluginValidator` kept)
  14. `buildSceneRenderPrompt`, `buildThreadStatusPrompt`, `buildProsePrompt`, `buildAnalysisPrompt` (from AI)
  15. `RenderPipeline`, `buildAndWriteOutputs` (from pipeline — types kept)
  16. `BatchRenderPipeline` (from batch renderer — types kept)
- All type exports preserved as specified
- Build: `npm run build` exits 0 (tsc -b + esbuild for core/cli/bench, all bundles produced)
- Tests: `npx vitest run --exclude '**/e2e.test.ts'` → 783 passed, 1 failed. The 1 failure (`packages/core/tests/ai/ai-sdk-structured-output.test.ts:191` — `deepseek-v4-flash` vs `deepseek-v4-pro` model name) is PRE-EXISTING: verified by `git stash` + re-run on clean tree (same failure). Unrelated to Wave 1 changes.
