# Stage 1.5 Audit Findings

**Date:** 2026-07-22
**Auditor:** Acceptance report verification
**Scope:** Stage 1.5 deliverables, TODO.md integrity, group file consistency

---

## Finding 1: Duplicate INTEGRATION-2 heading in TODO.md (CRITICAL, fixed)

**Location:** `docs/TODO.md:942-948` (now deleted)
**Description:** `TodoSyncWave3` subagent inserted a second `#### [ ] INTEGRATION-2: ReferenceEligibility 与 lifecycle closure 规范` with expanded spec body under it. The real INTEGRATION-2 at line 934 was already `[x]` with completion note.
**Root cause:** Subagent did not check for existing [x] heading before inserting.
**Fix:** Deleted lines 942-948. Verified real INTEGRATION-2 (line 934) retains `[x]` and spec body.
**Status:** RESOLVED (commit `fa02d0d`)

---

## Finding 2: Duplicate INTEGRATION-1 heading in TODO.md (CRITICAL, fixed)

**Location:** `docs/TODO.md:1033-1040` (now deleted)
**Description:** `TodoSyncWave3` inserted fake `#### [x] INTEGRATION-1` with RENDER-SURFACE-1 body content under it. Real INTEGRATION-1 at line 1042 was `[ ]`.
**Root cause:** Subagent wrote completion note under wrong heading.
**Fix:** Deleted fake heading + misplaced body, flipped real INTEGRATION-1 to `[x]` with correct completion note.
**Status:** RESOLVED (commit `37f27b4`)

---

## Finding 3: cli-storage group status out of sync (LOW, fixed)

**Location:** `docs/todos/cli-storage.md:3`
**Description:** Group Status still said `[-] in progress` while all 4 items (CLI-3, CLI-4, CLI-5, STORAGE-2) were `[x]`. The row-level items were updated by subagents but the group header was not.
**Fix:** Flipped to `[x] complete — all 4 items done. Build+test green (1400/1400).`
**Status:** RESOLVED

---

## Finding 4: CORPUS-1 tree diagram corruption (LOW, fixed)

**Location:** `docs/TODO.md:1072`
**Description:** CORPUS-1 [x] edit replaced `└── NarrativeEllipsis    # 显式叙事省略段...` with the `#### [x]` heading, breaking the ASCII tree diagram. Caused duplicate `#### [ ] CORPUS-1` heading at line 1079.
**Fix:** Restored tree diagram line, removed duplicate heading, placed `#### [x] CORPUS-1` after diagram block.
**Status:** RESOLVED (commit `fa02d0d`)

---

## Finding 5: Bench regression L2 failure (PRE-EXISTING, not stage 1.5)

**Location:** `packages/bench/tests/regression.test.ts`
**Description:** `Run post-render validators (L2)` fails: `Reference load failed: Event E0 not found in generation-record call.perEvent`. This is Stage 1 known issue — mock data `call.perEvent: []` is design-intentional for test fixtures.
**Impact:** 7/8 regression tests pass; L2 failure is expected for mock-backed bench.
**Recommendation:** Fix in Stage 2 (CORPUS) when real external fixtures replace mock data.
**Status:** ACKNOWLEDGED (not new, not regressed)

---

## Finding 6: Subagent scope violations (CORRECTED inline)

| Subagent | Violation | Fix |
|----------|-----------|-----|
| DAG-4 | Created `ProjectData` type instead of editing existing | Corrected to direct edits on 3 call sites |
| CLI-4 | Missing `export` on `initializeProject` | Added `export` keyword |
| DAG-5a | Syntax error in `snapshot.ts` (missing closing brace) | Restored syntax |
| RENDER-SURFACE-1 | Used `Map` instead of `Record` for Zod | Converted to `Record` type |
| CORPUS-1 | None — clean execution | — |

All scope violations were caught and corrected by the orchestrator before commit.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL (TODO.md corruption) | 2 | RESOLVED |
| LOW (header out of sync) | 2 | RESOLVED |
| PRE-EXISTING | 1 | ACKNOWLEDGED |
| SUBAGENT SCOPE | 4 | CORRECTED INLINE |

**Conclusion: Stage 1.5 deliverable quality is acceptable. All CRITICAL and LOW findings resolved. The pre-existing bench L2 failure is a Stage 1 artifact not introduced by Stage 1.5.**
