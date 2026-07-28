# modern-novel: Modern novel structural modeling layer

> **时间**: 2026-07-26 20:42 CST
## Group Status: [x] complete — verified against current source 2026-07-26

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S3 | [x] | — | `modernNovel?: ModernNovelConfig` on `NarrativeEvent` (`types/event.ts:82`) with real sub-configs (`antiCausalEdge`, `chapterOrder`, `surfaceMode`); genuinely consumed by `ChapterOrderValidator`, `AntiCausalEdgeValidator`, `SurfaceModeValidator`, `CausalOverloadValidator` (all registered in `validator/index.ts`) |

## Group-level dependencies
- **narrative-checklist**: S1 must be `[x]` before S3 B-class fields (they depend on Pass 2 checklist channel)
- **base-narratology**: S6 must be `[x]` before S3 (Genette dimensions extracted to base — S3 only has modern-specific fields)

## Scope
A unified schema extension for modern/postmodern novel structural fields. Schema is designed for the most general case (modern novel); traditional novels are a constrained subset (these fields are simply not filled). S3 fields are first-class citizens, not optional extensions. No `novelType` branch — traditional novels just happen to not use these fields.

**Field set** (9 fields, from survey corrected table): 4 A-class structural metadata (deterministic validators), 5 B-class semantic effects (Pass 2 against narrativeChecklist passthrough prompt). `unresolvedThread` moved to base (not in this sub-plan).

## Sub-plan

### S3: Modern novel structural fields

**Scope**: Types → schemas → A-class validators → B-class Pass 2 blocks → EventFile extension.

**New files**:
- `packages/core/src/types/modern-novel.ts` — all 9 field types
- `packages/core/src/schemas/modern-novel.ts` — Zod schemas
- `packages/core/src/validator/anti-causal.ts` — `AntiCausalEdgeValidator` (A-class)
- `packages/core/src/validator/chapter-order.ts` — `ChapterOrderValidator` (A-class)
- `packages/core/src/validator/surface-mode.ts` — `SurfaceModeValidator` (A-class)
- `packages/core/src/validator/causal-overload.ts` — `CausalOverloadValidator` (A-class)
- `packages/core/tests/validator/modern-novel.test.ts` — test suite

**Modified files**:
- `packages/core/src/types/event.ts` — add all 9 fields (A-class + B-class) to `EventFile`
- `packages/core/src/schemas/event.ts` — add to schemas
- `packages/core/src/types/analysis.ts` — add B-class analysis result fields (5 new blocks or reuse narrativeChecks)
- `packages/core/src/schemas/analysis.ts` — add to AnalysisResult schema
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export
- `packages/core/src/validator/index.ts` — register 4 A-class validators

**Binding constraints**:

A-class fields (deterministic validators):
1. **`antiCausalEdge`** — event postconditions not referenced by any later preconditions. Threshold: >50% of events antiCausal → S3 structural signal. Single event = base craft issue. Validator counts causal edges from event; flags system-level anti-causal pattern when >50% threshold crossed
2. **`chapterOrder: contested`** — metadata `renderingOptions: { orderContested: true }` + multiple `chosenRendering` variants. Assembler picks per render config. Validator: when `orderContested` is set, requires at least 2 rendering variants
3. **`surfaceMode`** — scene metadata `surfaceMode: true`. Validator: if marked, check no internal POV/psychological activity in scene (Robbe-Grillet — structural refusal of psychological depth, narrative describes only surface)
4. **`causalOverload`** — thread branching factor > threshold (e.g. >5). Validator: count causal edges from event; flag when branching factor exceeds threshold (Pynchon — event produces too many possible consequences; opposite of antiCausalEdge)

B-class fields (Pass 2 against narrativeChecklist passthrough):
5. **`irresolvableIndeterminacy`** — Fact value structurally undecidable (Derrida différance — deferral is terminal, not temporary). Renamed from `suspension`
6. **`absentApparatus`** — entity produces structural effect through absence (D&G correction of `absenceProfile` — the absence IS a production apparatus, not a deficit)
7. **`voiceDissonance`** — narrator tone structurally conflicts with content narrated (narrowed — Kafka mode only; does NOT cover Robbe-Grillet/Calvino)
8. **`multiplicity`** — multiple valid values simultaneously legitimate, system does not require choosing one (Borges + Barthes S/Z)
9. **`metanarrativeLevel`** — narrative takes its own construction as content (Calvino; extends Genette narrative level but structural self-reference is modern-specific)

B-class execution mechanism:
- Each B-class field adds an entry to `narrativeChecklist` with `required: false` (these are presence checks, not must-include constraints)
- Pass 2 prompt includes B-class definitions as passthrough — "check if the scene exhibits any of these structural patterns"
- Pass 2 results populate B-class analysis blocks
- `ChecklistValidator` (from S1) checks B-class coverage as part of its normal checklist evaluation
- This reuses the S1 pipeline without creating a separate Pass 2 channel

**Non-goals**:
- `unresolvedThread` (formerly `uncloseableThread`) — moved to base schema (thread layer). Not in this sub-plan. Traditional novels also have unresolved threads
- Genette five dimensions — moved to S6 (base-narratology). Not in this sub-plan

**Acceptance**: `npx vitest run packages/core/tests/validator/modern-novel.test.ts` passes. At least one fixture event (preferably dream-of-red-chamber with modern-novel annotations or a new Kafka-inspired test fixture) exercises all 4 A-class validators. B-class fields appear in `checklistResults` in Pass 2 output. All 9 fields are first-class on `EventFile` (not wrapped in a sub-object that would hide them).

## Evidence
—
