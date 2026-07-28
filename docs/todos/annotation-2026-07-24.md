# annotation: Human annotation — ground truth + reliability

> **时间**: 2026-07-24 13:57 CST
## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| C2 | [ ] | — | `docs/TODO.md` lines 323-327 |
| C3 | [ ] | — | `docs/TODO.md` lines 329-333; `docs/reference/stage-3/annotation-guidelines.zh-CN.md` |

## Group-level dependencies
None — these are measurement tasks (human annotation), not code. Both are independent of S-items and of each other.

## Scope
C2: Human annotation of exact preconditions/postconditions for 12 existing dream-of-red-chamber events. Compare with LLM-generated facts. Compute F1. Used as `compareFact()` ground truth. C3: Dual-round annotation per the frozen `docs/reference/stage-3/annotation-guidelines.zh-CN.md` — ≥120 question-level + ≥50 scene-level annotations, 7-14 day gap, blind re-annotation. Compute Cohen's kappa + Spearman rho.

## Sub-plan

### C2: 12-event precondition/postcondition annotation

**Scope**: Human annotation task. Annotate exact preconditions and postconditions for 12 existing dream-of-red-chamber events. Compare with LLM-generated facts. Compute F1 score. Used as ground truth for `compareFact()` evaluation.

**New files**:
- `output/annotation-c2/` — annotation dataset directory
  - `events/` — per-event annotation JSON/YAML files
  - `ground-truth.json` — consolidated ground truth facts
  - `llm-comparison.json` — LLM-generated facts for same events
  - `f1-report.md` — F1 analysis report

**Binding constraints**:
1. Annotate exact preconditions and postconditions for all 12 existing events
2. Each fact must be atomically stated — one claim per fact entry
3. Use existing `Fact` type structure: `{ entity, attribute, value, narrativeHint? }`
4. Annotations are source-grounded: each fact must cite the specific chapter/paragraph from《红楼梦》
5. Compare against LLM-generated facts (produced by running the existing pipeline on the same 12 events)
6. Compute F1: precision = (correct LLM facts) / (total LLM facts), recall = (correct LLM facts) / (total human facts)
7. Target: F1 ≥ 0.70 (per `docs/TODO.md` line 354)
8. No code — produces data files only. Does not change the pipeline

**Acceptance**: `output/annotation-c2/f1-report.md` exists with F1 ≥ 0.70. Ground truth dataset is complete for all 12 events. Comparison methodology documented in report.

### C3: Dual-round annotation — reliability study

**Scope**: Human annotation task per frozen `docs/reference/stage-3/annotation-guidelines.zh-CN.md`. Two independent annotation rounds with 7-14 day gap, blind re-annotation. Compute inter-rater reliability metrics.

**New files**:
- `output/annotation-c3/` — annotation dataset directory
  - `round-1/` — first-round annotations (≥120 question-level + ≥50 scene-level)
  - `round-2/` — second-round annotations (blind re-annotation)
  - `reliability-report.md` — Cohen's kappa + Spearman rho report

**Binding constraints**:
1. Annotation dimensions: severity (blocker/high/medium/low) and fix priority (independent judgment)
2. Volume: ≥120 question-level + ≥50 scene-level annotations per round
3. Gap: 7-14 days between round 1 and round 2
4. Blind: round 2 annotator must not see round 1 results
5. Metrics: Cohen's kappa (inter-rater agreement on categorical — severity, fix priority), Spearman rho (rank correlation on ordinal — severity ranking)
6. Target: Cohen's kappa ≥ 0.60 (per `docs/TODO.md` line 354)
7. Guidelines frozen at `docs/reference/stage-3/annotation-guidelines.zh-CN.md` v1.0 (2026-07-22). No changes during annotation
8. Chinese-language samples only (per TODO line annotation scope)
9. No code — produces data files only

**Acceptance**: `output/annotation-c3/reliability-report.md` exists with Cohen's kappa ≥ 0.60 and Spearman rho reported. Both rounds complete with full counts. Methodology documented in report.

## Evidence
—
