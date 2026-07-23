# Scalability Baseline — 3 Standard Change Tasks

| # | Task | File | LOC |
|---|------|------|-----|
| 1 | New Validator (`CountingValidator`) | `packages/core/src/validator/counting.ts` | 41 |
| 2 | New Provider (`NoOpProvider`) | `packages/core/src/ai/providers/noop.ts` | 28 |
| 3 | New Definition Type (`MoodDefinition`) | `packages/core/src/schemas/mood.ts` | 31 |
|   | **Total** | **3 new files, 0 existing modified** | **100** |

## Files Modified

None — all three tasks are self-contained new files that do **not** touch the barrel
(`index.ts`) or any existing module.

## Template for Future Extension Tasks

When adding a new extension artifact, record the following in a copy of this table:

| Field | Value |
|-------|-------|
| **Artifact name** | e.g. `MyValidator` |
| **File path** | `packages/core/src/validator/my.ts` |
| **Implements** | Interface/type implemented |
| **Net new LOC** | Count of non-comment, non-blank lines |
| **Existing files modified** | List any touched files (or "none") |
| **Imports from core** | Dependencies on existing internal modules |

## Measurement Notes

- LOC counted with `wc -l` on each new file (full file, including header comment and imports).
- None of the new files are added to any barrel (`index.ts`) — they are kept
  isolated to measure pure extensibility cost.
- Build verification: `npm run typecheck` on `packages/core` passes with all three files present.
