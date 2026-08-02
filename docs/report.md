# Stage 3 Implementation Report

**Date**: 2026-07-24
**Source Plan**: `docs/TODO.md` Stage 3 (lines 203-355)
**Sub-plans**: `docs/todos/stage-3-2026-07-27.md` + 9 group files

**历史状态**: 本报告是阶段 3 的实现与验收记录；所有测试数字为 2026-07-24 wave 提交时点测量，S1/S2/S3/S5/C1 状态经 2026-07-31 修订。**当前事实（2026-08-02 源码核验）以 [`docs/current-state.md`](./current-state.md) 为准**：`npm test` = 根 Vitest 2,881 + Workbench Host 367 + Workbench Client 36；lint 0 errors / 630 warnings / 236 infos；28 个 built-in validators 注册默认集（GreyLine opt-in）；AnalysisResult envelope 为 `eventId`/`protocol`/`observations`/`analysis`。下文各节标注了相应校正。

---

## Executive Summary

Stage 3 introduces deterministically-validated narrative capabilities (S-items), measured benchmarks (C-items), and supporting infrastructure across 8 implementation groups. S1-S7 are implemented, with **S8 (planner) removed** — its types were deleted on 2026-07-24 as design-incompatible with the Novel IR direction (see note below). **注意**：S1/S2/S3 的实现存在未对齐/未集成缺口（见 Detailed Status：checklist 与 narrative-technique 验证器的 envelope 读取、GreyLine 未注册默认集），S5 为未接线的独立工具；C1 为历史快照且报告仍 Pre-run。Human annotation tasks (C2, C3) 的 scaffold 不完整（仅 README，引用的目录/文件缺失）。

> **2026-08-02 校正**: 下述 "S1/S2/S3 集成缺口未闭合" 中，S1（checklist）与 S3（narrative-technique）的 envelope 读取缺口已修复（见 Detailed Status 对应节），两者均已注册进 28 个默认 built-in validators；S2（GreyLine）仍为 opt-in、S5 仍为未接线独立工具——这两项维持未变。本表测试数字为 2026-07-24 时点快照。

| Category | Items | Status |
|----------|-------|--------|
| S (Deterministic) | S1-S7 | ⚠️ Implemented，S1/S2/S3 集成缺口未闭合、S5 未接线（S8 removed） |
| C (Measured) | C1-C3 | ⚠️ C1 为历史快照（仍 Pre-run）；C2/C3 scaffold 不完整 |
| Validator bugs | VB-1/2/3 | ✅ Fixed |

---

## Implementation Waves

### Wave 0 — Validator Bug Fixes (3 bugs, ~15 lines)

Three Pass 2 integration migration leftovers fixed:

| Bug | File | Fix |
|-----|------|-----|
| VB-1 | `validator/thread-progress.ts:49` | Split `threadProgressAchieved` entries on `:`/`：` before Set lookup |
| VB-2 | `validator/alias.ts:122` | Removed "pronoun" from `getAnalysisRequirements` instruction; routes to PronounValidator |
| VB-3 | `validator/pov.ts:81-93` | Deleted English-only `/\b(?:I\|my\|me)\b/i` regex fallback; now fully Pass 2-dependent |

**Commit**: `349dd44`
**Test delta**: 1839→1839 (no new tests; bug fixes on existing paths)

### Wave 1 — Core Types, Schemas, and Validators (5 groups, ~40 new files)

| Group | Items | New Files | Key Deliverables |
|-------|-------|-----------|------------------|
| **narrative-checklist** | S1 | 4 | `NarrativeChecklist` type, `ChecklistValidator`, `checklistResults` in `AnalysisResult` |
| **thread-tracking** | S2 | 3 | `GreyLine` type (replaces `Foreshadowing` binary model), `GreyLineValidator` |
| **base-narratology** | S6a-S6e | 6 | Genette 5 dimensions: `DurationProfile`, `FrequencyProfile`, `Anachrony`, `VoiceProfile`, narrator wiring |
| **generation-pipeline** | S4, S5 | 4 | `SourceContext` type, `SourceClassifier` LLM path, `generateWithSchemaRetry()` |
| **upper-ir** | S7a, S7b | 6 | `IdeaIR` (Aristotelian Mythos), `StoryIR` (Propp 31 + Greimas actants) |

**Integration**: 9 new fields added to `EventFile` and `NarrativeEvent`, ~40 type exports and ~35 schema exports added to barrels, 2 validators registered, `checklistResults` added to `analysisContentSchema`, NarratorProfile YAML loading wired in `EntityMapper`.

**Commit**: `23f121b`
**Test delta**: 1839→1931 (+92)

### Wave 2 — Dependent Groups (S3 + C1)

| Group | Items | Key Deliverables |
|-------|-------|------------------|
| **narrative-technique** | S3 | 8 种图解析叙事技巧合同（`types/narrative-techniques.ts`），1 个 `NarrativeTechniqueValidator`，`resolveNarrativeTechniques()` 在 `compileStoryRuntimeGraph()` 中解析 |
| **coverage** | C1 | 8 new Dream of Red Chamber events, `narrativeChecklist` on all 20 events, coverage report |

**Commit**: `18ce1ae`
**Test delta**: 1931→1948 (+17)

---

## Detailed Status by Item

### S1 — narrativeChecklist ✅（envelope 已对齐；历史缺口见下）

Self-checking outline system. Each event declares narrative dimensions to cover; Pass 2 evaluates per-dimension coverage; `ChecklistValidator` checks required items.

- **Types**: `NarrativeChecklistItem`, `NarrativeChecklist`, `ChecklistResult`
- **Validator**: `packages/core/src/validator/checklist.ts`
- **Analysis**: `checklistResults` field declared on `AnalysisResult` and inside `analysisContentSchema`
- **Tests**: `packages/core/tests/validator/checklist.test.ts` (6 tests)

**历史缺口（2026-07-24 记录，已修复）**：当时 `analysisResultSchema` 把 `checklistResults` 放在内容块内（`analysis.analysis.checklistResults`），但 `ChecklistValidator.validatePost()` 读取顶层 `analysis.checklistResults`，其单测也构造顶层形状——真实解析输出下该字段恒为空，每个必填项都会产生“未被评估”告警。**2026-08-02 校正**：读取路径已对齐为 `analysis.analysis.checklistResults`（`packages/core/src/validator/checklist.ts`），且 `ChecklistValidator` 已注册进 28 个默认 built-in validators（`validator/builtins.ts`）；AnalysisResult envelope 现为 `eventId`/`protocol`/`observations`/`analysis`。S1 按已验证状态标记。

### S2 — greyLines ⚠️（opt-in，未注册默认集）

Replaces `foreshadowing` binary model with multi-point motif tracking. Same imagery appears across events, accumulating different semantic meaning. Node list grows indefinitely; closure not required.

- **Types**: `GreyLineNode`, `GreyLine`
- **Validator**: `packages/core/src/validator/grey-line.ts` (uses `narrativeChecks` for imagery detection; `validatePost()` 正确读取 `analysis.analysis.narrativeChecks`)
- **Tests**: `packages/core/tests/validator/grey-line.test.ts` (7 tests)
- **Note**: `ForeshadowingValidator` 仍在默认验证器集中保留（未标记 deprecated）。

**未集成的原因**：`ResultAggregator` 的默认注册列表不包含 `GreyLineValidator`，且其 `getAnalysisRequirements()` 返回空列表——默认管线既不请求 grey-line 证据也不运行其检查。目前只能作为自定义/插件验证器 opt-in 注册，不是已实现的默认行为。**2026-08-02 核验**：此状态维持——`GreyLineValidator` 已导出但不在 `validator/builtins.ts` 默认注册集中，属 opt-in 能力（见 [`docs/current-state.md`](./current-state.md)），S2 不按已完成默认行为宣称。

### S3 — Narrative Technique Contracts ✅（envelope 已对齐；历史缺口见下）

8 kinds from `NARRATIVE_TECHNIQUE_KINDS` (`packages/core/src/types/narrative-techniques.ts`)，取代早期 modern-novel 字段设计：

- `causalDiscontinuity` — 因果断裂：前驱/后继边的呈现代价（取代旧 `antiCausalEdge`/`chapterOrder: contested` 思路）
- `surfaceMode` — 拒绝心理深度的表面模式（Robbe-Grillet）
- `causalMultiplicity` — 出边分支 ≥ 阈值的多重因果（Pynchon；取代旧 `causalOverload`）
- `irresolvableIndeterminacy` — 断言/话语引用合同：`assertionIds` 必须存在于运行时断言目录且被选中的 `DiscourseGraph.outputs` 引用（Derrida；不判定 Fact 值）
- `absentApparatus` — 通过缺席产生结构效果的实体（D&G）
- `voiceDissonance` — 叙述者语气与内容冲突（Kafka 模式）
- `multiplicity` — 断言/话语引用合同：多个 `assertionIds` 存在且被话语输出引用（Borges；不证明“多个有效值同时成立”的 Fact 语义）
- `metanarrativeLevel` — 叙事以自身建构为内容（Calvino）

每个 kind 是携带 `kind` + `instruction` + `requiredEvidence` 的**解析后合同**（`ResolvedNarrativeTechniqueContract`）；`resolveNarrativeTechniques()`（`packages/core/src/state/technique-resolver.ts`）在 `compileStoryRuntimeGraph()` 中对故事图/话语图解析合同，Pass 1 只见解析后的合同字段。

- **Validator**: `packages/core/src/validator/narrative-technique.ts` — `NarrativeTechniqueValidator`（校验 wiring：事件有原始技巧字段但 context 无解析合同 → 错误；每个合同要求恰好一个 `narrativeCheck` 且 matchLevel 为 exact/similar）。**历史缺口（2026-07-24 记录，已修复）**：当时 `validatePost()` 读取顶层 `analysis.narrativeChecks`，而解析器把检查放在 `analysis.analysis.narrativeChecks`——真实 Pass 2 输出下 `allChecks` 恒为空，每个已解析合同都会被报“缺少 narrativeCheck”。**2026-08-02 校正**：读取路径已对齐为 `analysis.analysis.narrativeChecks`（当前源码 `validator/narrative-technique.ts`），且 `NarrativeTechniqueValidator` 已注册进 28 个默认 built-in validators；envelope 现为 `eventId`/`protocol`/`observations`/`analysis`，缺口已关闭。
- **Tests**: `packages/core/tests/narrative-techniques-pipeline.test.ts`、`packages/core/tests/state/technique-resolver.test.ts`

### S4 — sourceContext ✅

Per-event style anchors from original source text, classified as STYLE/FACT/MIXED by the LLM classifier. Only STYLE-classified parts enter Pass 1 as style references.

- **Types**: `SourceContextEntry`, `SourceContext`
- **Classifier**: `packages/core/src/ai/preprocessors/source-classifier.ts` — `classifySourceExcerpt()` 有真实 LLM 路径（provider 不可用/失败时回退为单条 MIXED 条目）
- **Context compiler integration**: 已接通——`PromptAssembler.assemble()` 的 `sourceContextStyleNotes` 选项注入 STYLE 风格锚点到 Pass 1 prompt（`pipeline/render.ts` 过滤 `classification === 'STYLE'` 后传入）

### S5 — Schema-Aware Generation ✅（独立工具，未接线）

`YAML.parse → schema.validate → Zod error feedback → LLM retry loop`（默认 `maxRetries=3`，即**最多三次总尝试**：首次 + 最多两次重试；Instructor pattern）。

- **Module**: `packages/core/src/ai/generators/schema-aware-gen.ts`
- **Function**: `generateWithSchemaRetry<T>(prompt, schema, generator, maxRetries?)`
- **Tests**: `packages/core/tests/ai/schema-aware-gen.test.ts` (8 tests)
- **注意**：该函数无生产调用方、不在公共 barrel 导出，仅被自身单测引用——是未接线的独立工具，不是已完成的 LLM 集成

### S6 — Base Narratology (Genette 5 Dimensions) ✅

| Sub-item | Dimension | Status | Key Types |
|----------|-----------|--------|-----------|
| S6a | Duration | ✅ | `DurationType`, `DurationProfile` (scene/summary/ellipsis/pause/stretch) |
| S6b | Frequency | ✅ | `FrequencyType`, `FrequencyProfile` (singulative/repeating/iterative) |
| S6c | Mood wiring | ✅ | `NarratorProfile` YAML load path, `external` focalization type |
| S6d | Voice | ✅ | `NarrativeLevel`, `DiegeticRelation`, `VoiceProfile` |
| S6e | Order | ✅ | `AnachronyType`, `AnachronyScope`, `AnachronyFunction`, `Anachrony` |

### S7 — Upper IR Layers ✅

| Sub-item | Layer | Status | Key Types |
|----------|-------|--------|-----------|
| S7a | Idea IR | ✅ | `ThematicIntent`, `EmotionalArcDefinition`, `IdeaIR` |
| S7b | Story IR | ✅ | `StructuralFunction` (Propp 31, 枚举子集可扩展), `ActantModel` (Greimas), `StoryArchetype` |

**Note**: `ThreadTypeDefinition` extended with `structuralFunction` and `actantModel` (threads are natural starting point for Story IR).

### S8 — Planner（已移除）❌

原计划的前向事件生成层（`NarrativePlannerMode`/`NarrativeGoal`/`ActionDefinition`）**未实现**——其类型于 2026-07-24 删除（`packages/core/src/types/index.ts` 中注明 "S8 removed (design incompatible with Novel IR)"，正确方向是独立的 YAML 编辑模块而非前向 planner）。本报告不声称该组件完成。（**2026-08-02 核验**：Planner 不是当前能力，见 [`docs/current-state.md`](./current-state.md) 已知限制表。）

### C1 — Coverage Benchmark ⚠️（历史快照，仍为 Pre-run）

**历史状态（2026-07-24 提交时）**：20 个 Dream of Red Chamber 事件带 `narrativeChecklist` 注解（12 existing + 8 new：E03、E06、E08、E10、E14、E15、E19、E20），60 items / 40 required，报告 `output/checklist-coverage.md`。

**当前状态（2026-07-31）**：
- 夹具已扩展为 E01–E36、四个 chapter（每章 9 个事件），全部带 `narrativeChecklist`
- `output/checklist-coverage.md` 仍是 20 事件的旧快照且标为 **Pre-run**（actual coverage requires running the pipeline with LLM Pass 2）；当时的 `checklist-coverage.ts::CHAPTER_DIR` 只扫描 `chapter_01`（现为 9 个事件）——旧数字无法由当前源码重新生成（该脚本此后已从源码移除，见下）
- **全量验证状态未定**：需实际跑一次 LLM Pass 2 + `ChecklistValidator` 后才能得出 Covered Items（S1 envelope 对齐已修复，见 S1 节校正）

- **Script（已不存在）**: 原 `packages/core/src/ai/tools/checklist-coverage.ts` 已不在当前源码中（`packages/core/src/ai/tools/` 目录已移除）；`output/checklist-coverage.md`/`.json` 仅保留为历史快照。**2026-08-02 核验**：当前仓库无 checklist-coverage 脚本，旧数字无法由当前源码重新生成

### C2 — Human Annotation (Precondition/Postcondition) — 未完成 scaffold ⏳

**Target**: F1 ≥ 0.70 vs LLM-generated facts
**Status**: 只有 `output/annotation-c2/README.md` 存在；README 引用的产物/目录均缺失。Requires human annotator.

- `output/annotation-c2/README.md` — detailed instructions
- **缺失前置**：README 仍指向旧夹具的 E1–E18 风格事件 ID 与标题（当前夹具为 E01–E36、四 chapter），并承诺 `events/<eventId>.json`、`ground-truth.json`、`llm-comparison.json`、`f1-report.md`——`events/` 目录尚不存在。需先用当前夹具同步 README 并创建 `events/` 骨架，才可开始标注

### C3 — Human Annotation (Dual-Round Reliability) — 未完成 scaffold ⏳

**Target**: Cohen's kappa ≥ 0.60
**Status**: 只有 `output/annotation-c3/README.md` 存在；README 引用的指南与产物均缺失。Requires 2 annotators with 7-14 day gap.

- `output/annotation-c3/README.md` — protocol and format
- **缺失前置**：README 引用 `docs/reference/annotation-guidelines.zh-CN.md` v1.0（2026-07-22 frozen）——该文件不存在；承诺的 `round-1/`、`round-2/` 输出目录也尚未创建。需补齐指南与目录骨架后才能开始两轮标注

---

## Test Summary

| Phase | Test Files | Tests | Delta |
|-------|-----------|-------|-------|
| Pre-Stage-3 baseline | 102 | 1839 | — |
| Wave 0 (validator bugs) | 102 | 1839 | +0 |
| Wave 1 (6 groups) | 110 | 1931 | +92 |
| Wave 2 (S3 + C1) | 111 | 1948 | +17 |
| **Total** | **111** | **1948** | **+109** |

以上数字为各 wave 提交时点的测量值（2026-07-24）。当前测试布局已随 S3 演进：`modern-novel.test.ts` 与 `narrative-planner.test.ts` 不再存在，叙事技巧覆盖由 `narrative-techniques-pipeline.test.ts` 与 `state/technique-resolver.test.ts` 提供。All 3 commits form a bisectable chain.

**2026-08-02 核验基线**（[`docs/current-state.md`](./current-state.md)）：`npm test` 现为根 Vitest 2,881 tests + Workbench Host 367 tests + Workbench Client 36 tests；lint 0 errors / 630 warnings / 236 infos。上表 1,839→1,948 仅是阶段 3 wave 提交时点的历史测量，不代表当前测试布局。

---

## Stage 3 Acceptance Criteria

From `docs/TODO.md` lines 353-355:

| Criterion | Status |
|-----------|--------|
| S1-S7 implemented + tests pass | ⚠️ 实现存在；S1/S3 envelope 缺口已于 2026-08-02 核验修复（见 Detailed Status），S2 仍 opt-in、S5 仍未接线 |
| S3 narrative-technique contracts completion marked | ✅ envelope 读取已对齐（2026-08-02 核验：`analysis.analysis.narrativeChecks`，默认 built-ins 内） |
| S6 Genette 5 dimensions sub-item completion marked | ✅ |
| S7 sub-item completion marked | ✅ |
| S8 (planner) — removed, not implemented | ✅ types deleted 2026-07-24 (design incompatible with Novel IR) |
| C1 coverage report complete | ⚠️ 报告为历史快照且仍 Pre-run，生成脚本已不在当前源码，无法由当前源码重新生成 |
| C2 F1 ≥ 0.70 | ⏳ Pending human annotation（scaffold 不完整：README 指向旧事件 ID，`events/` 目录缺失） |
| C3 Cohen's kappa ≥ 0.60 | ⏳ Pending human annotation（scaffold 不完整：指南文件与 `round-1/`/`round-2/` 目录缺失） |
| fixtures/dream-of-red-chamber/ 20 events pass full validation | ⏳ 未验证：夹具已扩至 E01–E36（四 chapter），20 事件数字为旧快照；需 LLM Pass 2 实跑（S1 envelope 已修复） |

---

## Commit History

```
18ce1ae feat(wave2): S3 modern-novel fields + C1 coverage benchmark  (59 files, +33877 -1)
23f121b feat(wave1): types, schemas, and validators for 6 stage-3 groups  (43 files, +3407 -15)
349dd44 fix(wave0): validator Pass 2 integration alignment  (3 files, +5 -15)
```

---

## Remaining Work

1. **C2**: Human annotation of 12-event preconditions/postconditions → compute F1
2. **C3**: Dual-round annotation (≥120 question + ≥50 scene) → compute Cohen's kappa
3. **Context compiler wiring — 已完成**：S1（`narrativeChecklistItems`）与 S4（`sourceContextStyleNotes`）已注入 `PromptAssembler.assemble()` 的 Pass 1 prompt
4. **S5 — 未接线（独立工具）**：`generateWithSchemaRetry()`（`packages/core/src/ai/generators/schema-aware-gen.ts`）无生产调用方、不在公共 barrel 导出、仅被自身单测引用；默认 `maxRetries=3` 表示**最多三次总尝试**（首次 + 最多两次重试）。`SourceClassifier` 的 LLM 路径属于 S4，不是 S5
5. **Fixture wiring — 已完成**：zhu-fu 事件已带 `narratorProfileRef`、`duration`、`frequency`、`voice`、`anachrony` 字段
6. S8 auto mode：不适用——S8（planner）已移除

---

*Report generated 2026-07-24；S8 移除与 S3 演进后于 2026-07-31 更新以反映实际实现状态，并修正 S1/S2/S3 validator envelope 与注册缺口、S5 未接线、C1 历史快照、C2/C3 scaffold 缺失等表述。2026-08-02 校正：S1/S3 envelope 缺口已修复（见对应节），C1 生成脚本已从源码移除，当前基线见 [`docs/current-state.md`](./current-state.md)。C2/C3 await human annotation.*
