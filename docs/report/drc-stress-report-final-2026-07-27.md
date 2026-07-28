# Stress Report — Dream of Red Chamber

> **时间**: 2026-07-27 14:19 CST
> **时间**: 2026-07-27 14:15 CST
> **状态**: Event Metrics 为 post-fix 完整装配（36 scene-backed release）；下方 Stability 小节明确为 pre-fix cache-isolated snapshots，保留作模型波动基线，不表示 post-fix 复测。


## Event Metrics

| ID | Chapter | Render Han | Original Han | Containment | Released | Attempts | Source | Excerpt
|----|---------|-----------|-------------|-------------|----------|----------|--------|---------
| E01 | 1 | 1,510 | 1,240 | 25.8% | true | 1 | scene | ✅ OK
| E02 | 1 | 1,640 | 1,193 | 4.0% | true | 0 | scene | ✅ OK
| E03 | 1 | 2,207 | 1,247 | 3.5% | true | 0 | scene | ✅ OK
| E04 | 1 | 1,378 | 1,162 | 3.7% | true | 0 | scene | ✅ OK
| E05 | 1 | 1,239 | 890 | 18.2% | true | 0 | scene | ✅ OK
| E06 | 1 | 2,101 | 1,233 | 5.7% | true | 0 | scene | ✅ OK
| E07 | 1 | 1,643 | 1,986 | 4.6% | true | 0 | scene | ✅ OK
| E08 | 1 | 2,101 | 1,973 | 3.3% | true | 0 | scene | ✅ OK
| E09 | 1 | 1,758 | 1,984 | 5.3% | true | 0 | scene | ✅ OK
| E10 | 2 | 2,150 | 1,162 | 4.1% | true | 0 | scene | ✅ OK
| E11 | 2 | 2,097 | 1,184 | 3.0% | true | 0 | scene | ✅ OK
| E12 | 2 | 1,798 | 1,994 | 7.4% | true | 0 | scene | ✅ OK
| E13 | 2 | 1,781 | 1,994 | 3.7% | true | 0 | scene | ✅ OK
| E14 | 2 | 1,491 | 1,975 | 4.6% | true | 0 | scene | ✅ OK
| E15 | 2 | 2,558 | 1,243 | 2.7% | true | 0 | scene | ✅ OK
| E16 | 2 | 2,103 | 1,238 | 2.1% | true | 0 | scene | ✅ OK
| E17 | 2 | 1,495 | 1,222 | 4.6% | true | 0 | scene | ✅ OK
| E18 | 2 | 2,404 | 1,608 | 3.5% | true | 0 | scene | ✅ OK
| E19 | 3 | 2,452 | 1,984 | 4.5% | true | 0 | scene | ✅ OK
| E20 | 3 | 1,301 | 1,225 | 2.9% | true | 0 | scene | ✅ OK
| E21 | 3 | 2,468 | 1,242 | 2.0% | true | 0 | scene | ✅ OK
| E22 | 3 | 1,415 | 1,995 | 5.3% | true | 0 | scene | ✅ OK
| E23 | 3 | 2,226 | 1,992 | 6.7% | true | 0 | scene | ✅ OK
| E24 | 3 | 1,278 | 1,587 | 6.5% | true | 0 | scene | ✅ OK
| E25 | 3 | 1,148 | 1,998 | 3.9% | true | 0 | scene | ✅ OK
| E26 | 3 | 1,348 | 1,991 | 3.8% | true | 0 | scene | ✅ OK
| E27 | 3 | 1,863 | 1,990 | 12.7% | true | 0 | scene | ✅ OK
| E28 | 4 | 1,129 | 1,984 | 6.5% | true | 0 | scene | ✅ OK
| E29 | 4 | 1,825 | 1,990 | 5.3% | true | 0 | scene | ✅ OK
| E30 | 4 | 2,419 | 1,995 | 3.7% | true | 0 | scene | ✅ OK
| E31 | 4 | 2,796 | 1,972 | 5.3% | true | 0 | scene | ✅ OK
| E32 | 4 | 1,756 | 1,992 | 2.5% | true | 0 | scene | ✅ OK
| E33 | 4 | 1,262 | 1,984 | 6.1% | true | 0 | scene | ✅ OK
| E34 | 4 | 2,111 | 1,998 | 2.7% | true | 0 | scene | ✅ OK
| E35 | 4 | 2,522 | 1,994 | 3.7% | true | 0 | scene | ✅ OK
| E36 | 4 | 1,499 | 1,996 | 5.3% | true | 0 | scene | ✅ OK

## Aggregate

- **Events**: 36
- **With render (scene)**: 36
- **With response fallback**: 0
- **With prose (total)**: 36
- **Released**: 36
- **With reference**: 36
- **Mean containment**: 5.5%
- **Min containment**: 2.0%
- **Drift count (< 0.15)**: 34
- **EXCERPT_INVALID count**: 0

## Stability (Run Comparison)
> **说明**: 以下 9 个 pairwise measurements 来自 ConflictValidator `setup`/`ongoing` 分类修复前的 E05/E21/E25 ×3 cache-isolated snapshots；其 37.7% 仅是 pre-fix 模型波动基线。post-fix 完整批次装配状态以上方 Event Metrics 为准。


| Event | Pair | Containment |
|-------|------|-------------|
| E05 | run1 ↔ run2 | 35.5% |
| E05 | run1 ↔ run3 | 70.3% |
| E05 | run2 ↔ run3 | 37.5% |
| E21 | run1 ↔ run2 | 34.1% |
| E21 | run1 ↔ run3 | 37.9% |
| E21 | run2 ↔ run3 | 43.5% |
| E25 | run1 ↔ run2 | 26.5% |
| E25 | run1 ↔ run3 | 26.4% |
| E25 | run2 ↔ run3 | 27.1% |

- **Pairwise comparisons**: 9
- **Mean pairwise containment**: 37.7%
