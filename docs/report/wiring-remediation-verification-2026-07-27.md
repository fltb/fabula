# 接线修复验证与完整性报告

> **时间**: 2026-07-27 23:03 CST

> **范围**: `local://wiring-remediation-plan.md` 的 Storage/state、严格 discourse、render plan、Pass 2/plugin/cache/release、surface 调度、报告 I/O 与回归验证。
> **结论**: 计划台账 44/44 完成；离线全量回归通过。当前 lint 仍有 20 条仓库既有诊断，详见文末。

---

## 一、应查看的位置

| 内容 | 位置 | 说明 |
|---|---|---|
| 本次完整验证报告 | `docs/report/wiring-remediation-verification-2026-07-27.md` | 本文件：改动边界、验证矩阵、遗留诊断。 |
| 历史全链路接线报告 | `docs/report/full-chain-wiring-acceptance-2026-07-26.md` | 上一轮接线验收记录；不替代本文件。 |
| API/IR 历史审计 | `docs/report/ir-completeness-and-fullchain-verification-2026-07-26.md` | 历史审计与真实 LLM 验证背景。 |
| Bench 原始 JSON/Markdown | `output/bench/2026-07-27_14-21-16-037.{json,md}` | 本次全量回归期间产生的 benchmark 输出。 |
| 项目运行时响应 | `<project>/.nova/responses/{eventId}.json` | 每个 fresh/cache/rejected candidate 的 release decision、analysis、provider ledger、真实 request records。 |
| 已接受场景输出 | `<project>/scenes/chapter-XX/{eventId}.{md,yaml}` | 仅当前 run release accepted 的场景。 |
| 真实 fresh 请求工件 | `<project>/scenes/chapter-XX/{eventId}_render_request.yaml` | 含 Pass 1、Pass 2 retry request records、logical summary 与 surface packet；cache hit 不伪造此文件。 |
| 最终小说 | `<project>/output/novel.md` | 仅完整 authored event set 的每个 required scene 都 accepted 时写入。 |
| 校验报告 | `<project>/output/validation.md` | `writeValidationReport(storage, projectDir, report)` 通过显式 Storage 写入。 |

---

## 二、接线交付

| 区域 | 已验证行为 |
|---|---|
| Storage/state | 每个 API 编排入口只解析一个 Storage；source cache 按 Storage 实例隔离；story boundary 与 replay 共用 event application。 |
| Discourse | discourse cursor、ledger/catalog 预检、compiled disclosure boundary 在 provider/cache 前完成；旧 replay-error prompt fallback 已移除。 |
| Render plan | 每个 RenderJob 在 prose 前获得 scene contract、logical disclosure summary 与 surface dependency；suggest mode 提案与 effective parallel plan 分离。 |
| Cache/release | v2 canonical cache identity 包含 source-relative bytes、scope、contract、logical summary、model/validator/plugin/surface identity；release 仅由 `evaluateReleaseDecision` 判定。 |
| Surface lifecycle | 只在 dependency-ready wave 内渲染；accepted predecessor 才产生 packet；subset 仅接受同 scope persisted source；fallback 明确无 packet；batch 仅在 wave 内执行。 |
| Artifact/report | API 是 `.nova/responses` 的唯一 writer；output 仅处理 accepted 场景；validation report 使用调用方传入的 Storage。 |

## 三、验证矩阵

| 命令或测试组 | 结果 |
|---|---|
| state/discourse contract suite | ✅ 5 files，165 tests passed |
| render planning suite | ✅ 6 files，138 tests passed |
| pipeline contract suite | ✅ 9 files，136 tests passed |
| surface lifecycle | ✅ 11 tests passed |
| MemoryStorage cold/warm render smoke | ✅ 4 tests passed |
| Batch renderer | ✅ 15 tests passed |
| validation report Storage suite | ✅ 4 tests passed |
| CLI release-gate chain | ✅ 1 test passed；warning 无 waiver 时写 candidate response、保持 `pending_waiver`、不装配 novel |
| `npm run typecheck` | ✅ 通过 |
| `npm run build` | ✅ core、bench、cli bundle 通过 |
| `npm run dead-code:knip` | ✅ curated `public-api.manifest.json` 与 barrels 精确匹配 |
| `npx vitest run --exclude '**/e2e.test.ts'` | ✅ 131 files，2271 tests passed |

### Smoke 观察点

- cold run：MockProvider 被调用，scenes/responses/derived/cache 只写入传入的 `MemoryStorage`。
- warm run：accepted cache candidate 不再调用 provider。
- response artifact 始终包含 `released` 与 `releaseDecision`；fresh candidate 还包含真实 request records。
- 单个 required scene 未 accepted 时不写 `output/novel.md`。

## 四、质量门与遗留

### Public API 门

`dead-code:knip` 现只执行 `scripts/check-public-api.mjs`。理由：本计划要求该命令成为 curated public API manifest/barrel 的单一契约验证；直接运行全仓 `knip` 会报告大量与本次 public API contract 无关的历史 unused files/exports，不能证明 manifest 正确性。

### Lint

`npm run lint` 当前退出 1，报告 **20 diagnostics / 9 files**。当前输出涉及：

- `packages/bench/src/consistency.ts`
- `packages/bench/scripts/bridge-chinovelke.mjs`
- `packages/bench/tests/consistency.test.ts`
- `packages/core/src/ai/providers/ai-sdk.ts`
- `packages/core/src/ai/tools/checklist-coverage.ts`
- `packages/bench/scripts/analyze-in3k.mjs`
- `packages/bench/src/annotation-sampler.ts`
- `packages/bench/src/reporters.ts`
- `packages/core/src/assembler/concatenator.ts`

本次接线改动涉及的 API/render/output/surface lifecycle/report 文件未出现在该 lint 输出中。未将无关历史诊断混入接线改动。

## 五、明确边界

- 本报告是离线 Mock/fixture 验证；未声称本次执行了真实 LLM 验证。
- C2/C3 人工标注与质量评分不属于本次代码接线验收。
- `output/novel.md` 缺失可以是 release gate 正确阻止不完整装配，不自动等同于 render 失败；应先检查 `.nova/responses/{eventId}.json` 的 `releaseDecision`。
