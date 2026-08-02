> **历史记录（dated snapshot）**：本页记录 2026-07（stage-2 阶段）的扩展成本测量快照——三个标准扩展任务的净新增 LOC 与“不触碰 barrel”的隔离成本。这是**有日期的历史测量**，不是当前架构承诺；新增代码的净成本会随模块边界演进而变化。2026-08-02 源码核验：`counting.ts`（39 行）、`noop.ts`（24 行）、`mood.ts`（31 行）三个文件仍存在且未被加入任何 barrel，本页事实与当前源码一致。当前系统状态以 [`docs/current-state.md`](../current-state.md) 为准（五包边界：Core 纯叙事语义、Node Host 适配器、Bench/CLI/Workbench 各自按 manifest 依赖）。

# Scalability Baseline — 3 Standard Change Tasks

| # | Task | File | LOC |
|---|------|------|-----|
| 1 | New Validator (`CountingValidator`) | `packages/core/src/validator/counting.ts` | 39 |
| 2 | New Provider (`NoOpProvider`) | `packages/core/src/ai/providers/noop.ts` | 24 |
| 3 | New Definition Type (`MoodDefinition`) | `packages/core/src/schemas/mood.ts` | 31 |
|   | **Total** | **3 new files, 0 existing modified** | **94** |

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
