# C3: Dual-Round Annotation Reliability Study

**Status**: Pending human annotation  
**Target**: Cohen's kappa ≥ 0.60, Spearman rho reported  
**Source**: `docs/TODO.md` lines 329-333  
**Guidelines**: `docs/reference/annotation-guidelines.zh-CN.md` v1.0 (frozen 2026-07-22)

## Protocol

1. **Round 1**: Annotate ≥120 question-level + ≥50 scene-level validations
2. **Gap**: 7-14 days between rounds
3. **Round 2**: Blind re-annotation (annotator must not see Round 1 results)
4. **Language**: Chinese-language samples only

## Annotation Dimensions

Per `annotation-guidelines.zh-CN.md`:
- **Severity**: blocker (4) / high (3) / medium (2) / low (1)
- **Fix Priority**: independent judgment, recorded separately

## Format

Each annotation entry:
```json
{
  "id": "ANN-001",
  "eventId": "E1",
  "validator": "alias",
  "issue": "Unknown name used for character",
  "severity": 2,
  "fixPriority": 1,
  "notes": "..."
}
```

## Outputs

- `round-1/question-level.json` — ≥120 entries
- `round-1/scene-level.json` — ≥50 entries
- `round-2/question-level.json` — blind re-annotation
- `round-2/scene-level.json` — blind re-annotation
- `reliability-report.md` — Cohen's kappa + Spearman rho
