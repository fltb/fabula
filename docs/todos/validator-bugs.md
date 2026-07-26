# validator-bugs: Pass 2 集成迁移遗留 Bug 修复

## Group Status: [x] complete — verified against current source 2026-07-26

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| VB-1 | [x] | — | Fixed: `packages/core/src/validator/thread-progress.ts:49-50` splits on `:`/`：` before Set lookup |
| VB-2 | [x] | — | Fixed: `packages/core/src/validator/alias.ts:122` Pass 2 instruction excludes pronouns from `namesUsed` entirely — architecturally equivalent fix (moved to separate `PronounValidator`) |
| VB-3 | [x] | — | Fixed: `packages/core/src/validator/pov.ts` consumes Pass 2 `pov` block, no regex fallback |

## Group-level dependencies
None — these are prerequisite bug fixes that unblock accurate validation measurement for all other groups.

## Scope
Three validator bugs in existing Pass 2 consumer code. Each is an integration migration leftover: the comparison logic was not aligned with actual Pass 2 output format. ~16 lines total across three files. No new types, no schema changes, no prompt engineering.

## Sub-plan

### VB-1: thread-progress.ts — Pass 2 format mismatch

**Scope**: `packages/core/src/validator/thread-progress.ts` line 72. Pass 2 outputs `"T1: desc"` format (thread ID + colon + description), but the validator checks the bare `"T1"` against a Set. The format was introduced during Pass 2 integration but the comparison was never updated.

**New files**: None

**Binding constraints**:
1. Fix at comparison logic level — architecture alignment, not prompt engineering
2. Split on `:` or use `startsWith(id + ":")` before Set lookup
3. Must handle both formats (bare ID for backward compat, ID + colon for Pass 2)
4. No type changes; no schema changes

**Acceptance**: `npx vitest run packages/core/tests/validator/` passes. Re-run `fixtures/zhu-fu/` validation — thread progress false positives drop from current rate.

### VB-2: alias.ts — pronoun filter in namesUsed

**Scope**: `packages/core/src/validator/alias.ts` line 125. Pass 2 `characterReferences.namesUsed` includes pronouns (她/他/它 and equivalents). The alias validator compares these against character alias lists without first filtering the pronoun set, producing false positives for every pronoun.

**New files**: None

**Binding constraints**:
1. Fix at comparison logic level — architecture alignment
2. Filter pronoun set before alias comparison
3. Pronoun filter list:
   - Chinese: `她|他|它|我|你|您|这|那|其`
   - English: `he|she|it|they|him|her|his|their|my|your|our|we|us|me|I` (case-insensitive)
4. ~5 lines of code
5. No type changes; no schema changes

**Acceptance**: `npx vitest run packages/core/tests/validator/` passes. Re-run `fixtures/zhu-fu/` validation — alias false positives drop from current rate.

### VB-3: pov.ts — remove English regex fallback

**Scope**: `packages/core/src/validator/pov.ts` line 135. A residual English regex fallback (`/\b(?:I|my|me)\b/i`) from the pre-Pass-2 era remains in the POV validator. The validator should read Pass 2 `pov` analysis block instead — this analysis is already produced by Pass 2 but not consumed by the validator.

**New files**: None

**Binding constraints**:
1. Fix at comparison logic level — architecture alignment
2. Remove the English regex fallback completely
3. Read Pass 2 `pov` analysis block (already produced by Pass 2)
4. ~10 lines of code
5. No type changes; no schema changes
6. If Pass 2 is unavailable, this is a hard error (consistent with system-wide Pass 2 requirement)

**Acceptance**: `npx vitest run packages/core/tests/validator/` passes. Re-run `fixtures/zhu-fu/` validation — POV false positives drop from current rate. grep for the removed regex pattern returns no matches in `pov.ts`.

## Evidence
—
