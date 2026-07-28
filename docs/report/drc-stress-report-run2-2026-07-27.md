# Stress Report — Dream of Red Chamber

> **时间**: 2026-07-27 14:19 CST

> **状态**: 历史 pre-fix 压测快照。E01 当时因 `ConflictValidator` 将 `resolutionType: setup` 误判为须完成收束而被错误拒绝；不可作为最终 release 状态。修复后的完整装配见 `docs/report/drc-stress-report-final-2026-07-27.md`。


## Event Metrics

| ID | Chapter | Render Han | Original Han | Containment | Released | Attempts | Source | Excerpt
|----|---------|-----------|-------------|-------------|----------|----------|--------|---------
| E01 | 1 | 1,088 | 1,240 | 25.3% | false | 6 | response | ✅ OK
| E02 | 1 | 1,640 | 1,193 | 4.0% | true | 0 | response | ✅ OK
| E03 | 1 | 2,207 | 1,247 | 3.5% | true | 0 | response | ✅ OK
| E04 | 1 | 1,378 | 1,162 | 3.7% | true | 0 | response | ✅ OK
| E05 | 1 | 1,350 | 890 | 11.5% | true | 0 | response | ✅ OK
| E06 | 1 | 2,101 | 1,233 | 5.7% | true | 0 | response | ✅ OK
| E07 | 1 | 1,643 | 1,986 | 4.6% | true | 0 | response | ✅ OK
| E08 | 1 | 2,101 | 1,973 | 3.3% | true | 0 | response | ✅ OK
| E09 | 1 | 1,758 | 1,984 | 5.3% | true | 0 | response | ✅ OK
| E10 | 2 | 2,150 | 1,162 | 4.1% | true | 0 | response | ✅ OK
| E11 | 2 | 2,097 | 1,184 | 3.0% | true | 0 | response | ✅ OK
| E12 | 2 | 1,798 | 1,994 | 7.4% | true | 0 | response | ✅ OK
| E13 | 2 | 1,781 | 1,994 | 3.7% | true | 0 | response | ✅ OK
| E14 | 2 | 1,491 | 1,975 | 4.6% | true | 0 | response | ✅ OK
| E15 | 2 | 2,558 | 1,243 | 2.7% | true | 0 | response | ✅ OK
| E16 | 2 | 2,103 | 1,238 | 2.1% | true | 0 | response | ✅ OK
| E17 | 2 | 1,495 | 1,222 | 4.6% | true | 0 | response | ✅ OK
| E18 | 2 | 2,404 | 1,608 | 3.5% | true | 0 | response | ✅ OK
| E19 | 3 | 2,452 | 1,984 | 4.5% | true | 0 | response | ✅ OK
| E20 | 3 | 1,301 | 1,225 | 2.9% | true | 0 | response | ✅ OK
| E21 | 3 | 1,541 | 1,242 | 2.1% | true | 0 | response | ✅ OK
| E22 | 3 | 1,415 | 1,995 | 5.3% | true | 0 | response | ✅ OK
| E23 | 3 | 2,226 | 1,992 | 6.7% | true | 0 | response | ✅ OK
| E24 | 3 | 1,278 | 1,587 | 6.5% | true | 0 | response | ✅ OK
| E25 | 3 | 1,148 | 1,998 | 3.9% | true | 0 | response | ✅ OK
| E26 | 3 | 1,348 | 1,991 | 3.8% | true | 0 | response | ✅ OK
| E27 | 3 | 1,863 | 1,990 | 12.7% | true | 0 | response | ✅ OK
| E28 | 4 | 1,129 | 1,984 | 6.5% | true | 0 | response | ✅ OK
| E29 | 4 | 1,825 | 1,990 | 5.3% | true | 0 | response | ✅ OK
| E30 | 4 | 2,419 | 1,995 | 3.7% | true | 0 | response | ✅ OK
| E31 | 4 | 2,796 | 1,972 | 5.3% | true | 0 | response | ✅ OK
| E32 | 4 | 1,756 | 1,992 | 2.5% | true | 0 | response | ✅ OK
| E33 | 4 | 1,262 | 1,984 | 6.1% | true | 0 | response | ✅ OK
| E34 | 4 | 2,111 | 1,998 | 2.7% | true | 0 | response | ✅ OK
| E35 | 4 | 2,522 | 1,994 | 3.7% | true | 0 | response | ✅ OK
| E36 | 4 | 1,499 | 1,996 | 5.3% | true | 0 | response | ✅ OK

## Aggregate

- **Events**: 36
- **With render (scene)**: 0
- **With response fallback**: 36
- **With prose (total)**: 36
- **Released**: 35
- **With reference**: 36
- **Mean containment**: 5.3%
- **Min containment**: 2.1%
- **Drift count (< 0.15)**: 35
- **EXCERPT_INVALID count**: 0
