# generation-pipeline: Source context style passthrough + schema-aware generation

> **时间**: 2026-07-26 20:42 CST
## Group Status: [x] complete — S4 wiring gap closed 2026-07-26 (this session), S5 confirmed

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S4 | [x] | — | `SourceContext`/`SourceContextEntry` types exist; `RenderPipeline.renderScene()` now passes STYLE-filtered `sourceContextStyleNotes` into `PromptAssembler.assemble()` (`pipeline/render.ts:295-299`, fixed this session — was previously dead-wired; proven via new test + live-LLM zhu-fu runs) |
| S5 | [x] | — | Zod-error-feedback retry loop confirmed directly in `pipeline/render.ts` Pass 2 handling (`feedbackErrors`, `zodErrors.issues.map(...)`, up to 4 attempts) |

## Group-level dependencies
None — S4 and S5 are independent within this group.

## Scope
S4: Per-event `sourceContext` — style anchors extracted from original source text, classified as STYLE/FACT/MIXED by an LLM preprocessor, with only STYLE-classified parts entering Pass 1 as style references. FACT parts are filtered out (already in preconditions/postconditions). S5: Schema-aware YAML generation — `YAML.parse → schema.validate → Zod error feedback → LLM retry` loop (max 3 retries, Instructor pattern).

## Sub-plan

### S4: sourceContext — style passthrough

**Scope**: Types → schema → EventFile extension → LLM preprocessor → context compiler integration.

**New files**:
- `packages/core/src/types/source-context.ts` — `SourceContextEntry`, `SourceContext` types
- `packages/core/src/schemas/source-context.ts` — Zod schemas
- `packages/core/src/ai/preprocessors/source-classifier.ts` — LLM-based STYLE/FACT/MIXED classifier

**Modified files**:
- `packages/core/src/types/event.ts` — add `sourceContext?: SourceContext` to `EventFile`
- `packages/core/src/schemas/event.ts` — add `sourceContext` to `eventFileSchema`
- `packages/core/src/types/index.ts` — barrel export
- Context compiler (unverified exact path — confirm during execution): include `sourceContext.entries` (STYLE only) in Pass 1 prompt as style anchors

**Binding constraints**:
1. Types:
   ```typescript
   export interface SourceContextEntry {
     excerpt: string;           // text from source
     classification: 'STYLE' | 'FACT' | 'MIXED';
     styleNote?: string;        // for STYLE/MIXED: what style element to reference
   }
   export interface SourceContext {
     entries: SourceContextEntry[];
   }
   ```
2. Preprocessor: LLM-based classification (rule-based classification of literary style is unreliable). Prompt: given a source excerpt, classify each segment as STYLE (pure style — atmosphere/syntax/poetry), FACT (plot fact — enters WorldState), or MIXED (both — split)
3. Only STYLE-classified parts enter Pass 1 as style reference. FACT parts are filtered out (they're already in preconditions/postconditions)
4. Does NOT enter Fact comparison; does NOT conflict with validators
5. Context compiler: include `sourceContext.entries` (STYLE only) in Pass 1 prompt as style anchors — they guide prose style without adding facts

**Acceptance**: At least one zhu-fu or dream-of-red-chamber event uses `sourceContext` in its YAML fixture. SourceClassifier produces correct STYLE/FACT/MIXED classifications for a known excerpt. Pass 1 prompt includes STYLE entries as style anchors.

### S5: schema-aware generation pipeline

**Scope**: Zod-aware retry loop for YAML generation. No new types — uses existing Zod schemas.

**New files**:
- `packages/core/src/ai/generators/schema-aware-gen.ts` — `YAML.parse → schema.validate → retry` loop

**Modified files**:
- Existing YAML generation pipeline (confirm exact entry point during execution) — wrap generation with schema-aware retry

**Binding constraints**:
1. Pipeline: `YAML.parse(text) → schema.validate(parsed) → on Zod failure: collect error messages → feed back to LLM with error context → retry (max 3)`
2. This is the Instructor pattern, not blind retry — each retry carries the specific Zod error messages
3. First-pass rate target: from ~25% to >80%
4. Maximum 3 retries; after 3 failures, return the last result with accumulated errors
5. No new types — uses existing Zod schemas for validation
6. Works with any Zod schema (event, project, thread, etc.), not hardcoded to one type

**Acceptance**: `npx vitest run packages/core/tests/ai/schema-aware-gen.test.ts` passes. Demonstration: generate a YAML event, observe retry on first failure, observe valid output on success. First-pass success rate measurable against a batch of known-valid YAML inputs.

## Evidence
—
