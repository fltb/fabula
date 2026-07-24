# narrative-checklist: Self-checking outline system + coverage benchmark

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S1 | [ ] | — | `docs/TODO.md` lines 205-211 |
| C1 | [ ] | S1 | `docs/TODO.md` lines 317-321 |

## Group-level dependencies
None for S1. C1 depends on S1 (needs ChecklistValidator + checklistResults).

## Scope
S1: A per-event narrative checklist system — each event declares which narrative dimensions must be covered (poetry, dialogue personality, ironic distance, foreshadowing threads, etc.). Pass 1 receives these as style constraints; Pass 2 evaluates per-dimension coverage; a new `ChecklistValidator` checks required items. C1: Use the S1 system to measure coverage on 12 existing + 8 new dream-of-red-chamber events, reporting per-dimension coverage rate and information loss rate.

## Sub-plan

### S1: narrativeChecklist — self-checking outline system

**Scope**: Full pipeline: types → schemas → EventFile extension → Pass 2 analysis block → validator → context compiler integration.

**New files**:
- `packages/core/src/types/narrative-checklist.ts` — `NarrativeChecklistItem`, `NarrativeChecklist` types
- `packages/core/src/schemas/narrative-checklist.ts` — Zod schemas
- `packages/core/src/validator/checklist.ts` — `ChecklistValidator`
- `packages/core/tests/validator/checklist.test.ts` — test suite

**Modified files**:
- `packages/core/src/types/analysis.ts` — add `ChecklistResult` type + `checklistResults` field to `AnalysisResult`
- `packages/core/src/schemas/analysis.ts` — add `checklistResults` Zod schema
- `packages/core/src/types/event.ts` — add `narrativeChecklist?: NarrativeChecklist` to `EventFile`
- `packages/core/src/schemas/event.ts` — add `narrativeChecklist` to `eventFileSchema`
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export
- `packages/core/src/validator/index.ts` — register `ChecklistValidator`
- Context compiler (unverified exact path — `packages/core/src/render/context-compiler.ts` or equivalent; confirm during execution): include `narrativeChecklist.items` in Pass 1 scene context as style constraints

**Binding constraints**:
1. Types:
   ```typescript
   export interface NarrativeChecklistItem {
     dimension: string;       // e.g. "诗词", "对话个性", "反讽距离", "草蛇灰线"
     description: string;     // what to cover in this scene
     required: boolean;       // true = must, false = should
   }
   export interface NarrativeChecklist {
     items: NarrativeChecklistItem[];
   }
   ```
2. AnalysisResult extension:
   ```typescript
   export interface ChecklistResult {
     dimension: string;
     covered: boolean;
     evidence?: string;       // quote from prose
   }
   // Add to AnalysisResult: checklistResults: ChecklistResult[]
   ```
3. Validator logic: for every `required: true` item in `narrativeChecklist`, find matching `checklistResults` entry with `covered: true`. Missing result → warning; `covered: false` → warning with evidence.
4. Context compiler: include `narrativeChecklist.items` in Pass 1 prompt as style constraints — Pass 1 receives the dimensions as "must cover" signals
5. Backward compatible: `narrativeChecklist` is optional; events without it are skipped by ChecklistValidator
6. No new Validator registrations break existing suite

**Acceptance**: `npx vitest run packages/core/tests/validator/checklist.test.ts` passes. At least one zhu-fu or dream-of-red-chamber event uses `narrativeChecklist` in its YAML fixture, produces `checklistResults` in Pass 2 output, and passes ChecklistValidator.

### C1: 红楼梦 20-event coverage benchmark

**Scope**: Measurement task using the S1 system. No code beyond what S1 produces. Re-evaluate 12 existing dream-of-red-chamber events with narrativeChecklist annotations, extend to 20 events, report per-dimension coverage rate and information loss rate.

**New files**:
- `output/checklist-coverage.md` — final report
- Fixture YAML updates for 8 new events in `fixtures/dream-of-red-chamber/`

**Binding constraints**:
1. All 20 events must carry `narrativeChecklist` with per-event dimension declarations
2. Pass 2 must produce `checklistResults` for all 20 events
3. Report metrics: per-dimension coverage rate (`covered: true` / total), information loss rate (`covered: false` or missing / total)
4. Report includes per-dimension breakdown table + aggregate statistics
5. C1 depends on S1 completion (needs ChecklistValidator + checklistResults pipeline)

**Acceptance**: `output/checklist-coverage.md` exists with per-dimension coverage table for 20 events. All 20 events pass `ChecklistValidator` with measurable coverage rates.

## Evidence
—
