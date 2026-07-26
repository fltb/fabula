# Stage 3 — TODO Index

> **Generated**: 2026-07-24
> **Source**: `docs/TODO.md` 阶段 3 S/C items (lines 203-336)
> **Acceptance**: S1-S8 all implemented + tests pass. C1 coverage report complete. C2 F1 ≥ 0.70. C3 Cohen's kappa ≥ 0.60. `fixtures/dream-of-red-chamber/` 20 events pass full validation.

## Group table

| Group | Status | Deps | Sub-plan | Items | Count |
|-------|--------|------|----------|-------|-------|
| validator-bugs | [x] | — | [validator-bugs.md](validator-bugs.md) | VB-1, VB-2, VB-3 | 3 |
| narrative-checklist | [x] S1 / [ ] C1 | — | [narrative-checklist.md](narrative-checklist.md) | S1, C1 | 2 |
| thread-tracking | [x] | — | [thread-tracking.md](thread-tracking.md) | S2 | 1 |
| base-narratology | [ ] type-only, zero consumers | — | [base-narratology.md](base-narratology.md) | S6a, S6b, S6c, S6d, S6e | 5 |
| generation-pipeline | [x] | — | [generation-pipeline.md](generation-pipeline.md) | S4, S5 | 2 |
| upper-ir | [x] | — | [upper-ir.md](upper-ir.md) | S7a, S7b | 2 |
| planner | [x] (removed by design, see file) | — | [planner.md](planner.md) | S8 | 1 |
| modern-novel | [x] | narrative-checklist, base-narratology | [modern-novel.md](modern-novel.md) | S3 | 1 |
| annotation | [ ] blocked on human review | — | [annotation.md](annotation.md) | C2, C3 | 2 |

**Total**: 9 groups, 19 items (11 S-items + 3 validator bugs + 3 C-items + 2 deferred sub-items)

**Verified 2026-07-26**: 6/9 groups fully complete, 1 partial (narrative-checklist: S1 done, C1 blocked), 1 genuinely incomplete despite prior audit claiming otherwise (base-narratology — types exist, zero runtime consumers), 1 blocked on human annotation (out of agent-executable scope). See individual sub-plan files for source citations; do not trust `docs/report/stage-3-audit.md`'s S6 row without re-verifying source.

## Execution waves

### Wave 0: Prerequisite bug fixes
**validator-bugs** — unblocks accurate validation measurement for all other groups.
- VB-1: thread-progress.ts Pass 2 format mismatch (~1 line)
- VB-2: alias.ts pronoun filter (~5 lines)
- VB-3: pov.ts remove English regex fallback (~10 lines)

### Wave 1: Independent groups (no group-level deps)
All six groups can execute in parallel once Wave 0 is complete:

| Group | Items | New types | New validators | Key risk |
|-------|-------|-----------|----------------|----------|
| **narrative-checklist** (S1 part) | S1 | NarrativeChecklist, ChecklistResult | ChecklistValidator | Context compiler path unverified |
| **thread-tracking** | S2 | GreyLine, GreyLineNode | GreyLineValidator | Foreshadowing backward compat |
| **base-narratology** | S6a-S6e | DurationProfile, FrequencyProfile, VoiceProfile, Anachrony | None (pure types + schemas) | Duration conflated with NarrativeEllipsis |
| **generation-pipeline** | S4, S5 | SourceContext | None (preprocessor + retry) | LLM dependency in SourceClassifier |
| **upper-ir** | S7a, S7b | IdeaIR, StructuralFunction, ActantModel | None (pure types + schemas) | Thread system extension compatibility |
| **planner** | S8 | NarrativeGoal, ActionDefinition | None (planner pipeline) | Surface PlannerMode conflation |

### Wave 2: Dependent groups
Execute only after Wave 1 dependencies are `[x]`:

| Group | Items | Depends on | Reason |
|-------|-------|------------|--------|
| **narrative-checklist** (C1 part) | C1 | S1 (from Wave 1) | Needs ChecklistValidator + checklistResults pipeline |
| **modern-novel** | S3 | S1, S6 | B-class fields need Pass 2 checklist channel; Genette dimensions extracted to base |

## Sub-plan file template

Each `docs/todos/<slug>.md` follows this shape (from `docs/todos/corpus.md` exemplar):

```
# <slug>: <title>
## Group Status: [ ] unstarted
## Items in this group
| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
## Group-level dependencies
## Scope
## Sub-plan
### <Item ID>: <title>
**Scope**: ...
**New files**: ...
**Binding constraints**: ...
**Acceptance**: ...
## Evidence
```

## Code conventions

- New types → `packages/core/src/types/<name>.ts`, exported from `types/index.ts` barrel
- New schemas → `packages/core/src/schemas/<name>.ts`, exported from `schemas/index.ts` barrel
- Tests → `packages/core/tests/<area>/<name>.test.ts`
- Build order: core → cli → bench
- Rebuild `packages/core/dist/` before running CLI

## Acceptance criteria (from `docs/TODO.md` lines 353-355)

- **S capability**: S1-S8 all implemented + tests pass. S3-research is already complete (9-field set locked). S3 must mark A-class (deterministic validator) and B-class (depends on S1 Pass 2 channel) completion status separately. S6 (base-narratology Genette five dimensions) must mark Duration/Frequency/Mood-wiring/Voice/Order sub-item completion status. S7 (Idea IR + Story IR) + S8 (Planner) must mark sub-item completion status.
- **C capability**: C1 coverage report complete + C2 F1 ≥ 0.70 + C3 Cohen's kappa ≥ 0.60
- **Project**: `fixtures/dream-of-red-chamber/` 20 events pass full validation (including ChecklistValidator + GreyLineValidator + S6 Genette dimension validators)

## Stage 3 is complete when

Every group row in the table above is `[x]` and the acceptance criteria above are met.

---
*Based on `docs/TODO.md` stage 3 restructuring (2026-07-24). Design decisions locked in reference docs + sub-plan files. Zero design work remaining — all sub-plans are decision-complete.*
