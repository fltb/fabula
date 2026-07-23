# Public API TSDoc Audit

**Date:** 2026-07-22
**Version:** 1.0
**Scope:** `packages/core/src/index.ts` — all named exports

## Summary

| Category | Exports | With TSDoc | Missing | Coverage |
|----------|---------|------------|---------|----------|
| Errors | 18 | 0 | 18 | 0% |
| Entity | 7 | 2 | 5 | 29% |
| Migration | 5 | 2 | 3 | 40% |
| Schemas | 5 | 0 | 5 | 0% |
| Observability | 6 | 2 | 4 | 33% |
| State | 7 | 2 | 5 | 29% |
| Validators | 20 | 20 | 0 | 100% |
| Context | 4 | 2 | 2 | 50% |
| Assembler | 6 | 3 | 3 | 50% |
| Summary | 4 | 2 | 2 | 50% |
| Review | 1 | 0 | 1 | 0% |
| Plugin | 7 | 3 | 4 | 43% |
| Agent | 4 | 2 | 2 | 50% |
| Storage | 5 | 3 | 2 | 60% |
| Report | 3 | 2 | 1 | 33% |
| Reporter | 2 | 0 | 2 | 0% |
| AI | 14 | 8 | 6 | 57% |
| Cache | 6 | 3 | 3 | 50% |
| Pipeline | 5 | 2 | 3 | 40% |
| Batch | 4 | 0 | 4 | 0% |
| API | 8 | 5 | 3 | 63% |
| **Total** | **~141** | **63** | **78** | **45%** |

Note: `export type * from './types/index.js'` re-exports ~300+ additional types from the types barrel. These are not individually audited here — they are covered by the types barrel's own export list.

## 100% Coverage (No Gaps)

- **Validators** (20/20): All 20 validator classes have TSDoc class-level comments with descriptions

## Critical Gaps (0% Coverage)

These categories have zero TSDoc coverage and are high-priority for documentation:

### Errors (18 exports)
- `NovalisticallyError`, `ConfigError`, `StorageError`, `DagProviderError`, `DagCycleError`
- `PreconditionMismatchError`, `ReferenceFormatError`, `CacheCorruptionError`, `ValidationError`, `PipelineError`
- `AuthError`, `RateLimitError`, `TimeoutError`, `ModelNotFoundError`, `AssemblyIncompleteError`
- `NetworkDeniedError`, `RuleConstraintViolationError`, `sanitizeError`
- Source: `packages/core/src/errors.js`
- TSDoc: 0/18 — each error class needs a one-line description of when it's thrown

### Schemas (5 exports)
- `analysisResultSchema`, `expectedOutcomeManifestSchema`, `provenanceManifestSchema`, `responseReferenceSchema`, `liveSmokeRecordSchema`
- TSDoc: 0/5 — each schema needs a description of what it validates

### Reporter (2 exports)
- `writeValidationReport`, `ValidationReport`
- TSDoc: 0/2

### Batch (4 exports)
- `BatchConfig`, `BatchProgressEvent`, `BatchResult`, `BatchStats`
- TSDoc: 0/4

## High-Priority Missing TSDoc

These are the most externally-facing exports without documentation:

| Export | Source File | Priority |
|--------|-------------|----------|
| `compareFact` | `entity/compare.ts` | HIGH — core API, sole comparison entry point |
| `ReplayEngine` | `state/replay.ts` | HIGH — core state engine |
| `StateManager` | `state/manager.ts` | HIGH — public state management |
| `ContextCompiler` | `context/compiler.ts` | HIGH — context compilation for rendering |
| `ContextAssembler` | `context/assembler.ts` | HIGH — assembles context packages |
| `ResultAggregator` | `validator/aggregator.ts` | HIGH — validates all results |
| `InteractionManager` | `pipeline/interaction-gate.ts` | MEDIUM — only export with @example |
| `ReportWriter` | `report/writer.ts` | MEDIUM — report generation |
| `AgentRegistry` | `agent/registry.ts` | MEDIUM — agent system entry |
| `AiSdkProvider` | `ai/providers/ai-sdk.ts` | MEDIUM — default LLM provider |
| `initializeProject` | `api.ts` | HIGH — CLI entry point |
| `renderNovel` | `api.ts` | HIGH — main rendering function |
| `validateNovel` | `api.ts` | HIGH — validation entry |

## Exports With @example Tags

Only 1 export has an `@example` tag:
- `InteractionManager` in `pipeline/interaction-gate.ts`

## Recommendations

1. **Errors first**: Add one-line TSDoc to all 18 error classes — these are the first thing users see when things break
2. **API functions**: All 8 `api.ts` exports need TSDoc with `@example` usage — these are the main entry points
3. **Core types**: The `export type *` wildcard masks ~300 types. Consider selective re-export with TSDoc for the top 30 most-used types
4. **Validator pattern**: Validator classes are well-documented (100%). Use the same pattern for other class exports
5. **@example tags**: Add `@example` blocks to the top 10 most-used API functions (initializeProject, renderNovel, validateNovel, etc.)

## Verification

Run to verify coverage: `npx typedoc --json docs/reference/typedoc.json packages/core/src/index.ts`

---

*This audit covers all named exports from `packages/core/src/index.ts`. The `export type *` wildcard re-exports are not individually enumerated but represent ~300 additional types.*
