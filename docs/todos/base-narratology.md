# base-narratology: Genette five dimensions (base schema audit)

## Group Status: [x] complete — wired 2026-07-26 22:07 CST（full-chain wiring session）: 5 个 consistency validator（duration/frequency/voice/anachrony/focalization）+ Pass 2 `{dimension}Detected` 分析块 + narratorProfileRef→NarratorProfile 解析进 ContextPackage/Pass 1 prompt。根因补修：`mapToNarrativeEvent` 此前静默丢弃全部 S6 字段（types/schemas 齐全但运行时零传递），现已转发（`mapper.ts:268-277`）。见 `docs/report/full-chain-wiring-acceptance.md`。

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| S6a | [x] | — | Duration — `DurationConsistencyValidator`（`validator/duration-consistency.ts`）: pre 检查 ellipsisClarity，post 对比 Pass 2 `durationDetected`；zhu-fu E1 fixture 已声明 `duration: summary` |
| S6b | [x] | — | Frequency — `FrequencyConsistencyValidator`: pre 检查 iterationScope，post 对比 `frequencyDetected`；zhu-fu E1 已声明 `frequency: singulative` |
| S6c | [x] | — | Mood/Voice wiring — `narratorProfileRef` 经 mapper→`ContextCompiler.compile()` 解析为 `ContextPackage.narratorProfile`，渲染进 Pass 1 `## Narrator` 区块；`FocalizationConsistencyValidator` 消费 `focalizationDetected`；zhu-fu E0 已用 `narratorProfileRef: narrator_wo` |
| S6d | [x] | — | Voice — `VoiceConsistencyValidator`: 对比 `voiceDetected.level/.relation`（逐子字段报 issue）；zhu-fu E1 已声明 `voice: extradiegetic/homodiegetic` |
| S6e | [x] | — | Order/Anachrony — `AnachronyConsistencyValidator`: pre 检查 distance，post 对比 `anachronyDetected`（含 `'none'` 字面量，validatePost 在 event.anachrony 未声明时提前返回）；zhu-fu E1 已声明 `anachrony: analepsis` |

## Group-level dependencies
None — all five sub-items are independent within this group. They all extend `NarrativeEvent`/`EventFile` but do not conflict.

## Scope
Complete Genette's five narrative dimensions as base schema. All five dimensions describe any narrative (not modern-novel-specific) and must be in the base schema. Current status: Order partially covered, Duration/Frequency completely absent, Mood/Voice are dead types (NarratorProfile types exist but zero fixture wiring).

## Sub-plan

### S6a: Duration — DurationProfile

**Scope**: New `DurationProfile` type + schema. The largest blind spot — the entire system has zero Duration concepts. Critical distinction: `NarrativeEllipsis` in `corpus.ts` is a corpus diagnostic type (non-rendering node), NOT Genette ellipsis (which IS rendered — the text exists but tells you time passed).

**New files**:
- `packages/core/src/types/duration.ts` — `DurationType`, `DurationProfile`
- `packages/core/src/schemas/duration.ts` — Zod schemas
- `packages/core/tests/validator/duration.test.ts` — test suite (at minimum: schema validation)

**Modified files**:
- `packages/core/src/types/event.ts` — add `duration?: DurationProfile` to `NarrativeEvent` + `EventFile`
- `packages/core/src/schemas/event.ts` — add `duration` to schemas
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export

**Binding constraints**:
1. Types (from `docs/reference/stage-3/narratology-dimension-audit.md` lines 114-131):
   ```typescript
   export type DurationType = 'scene' | 'summary' | 'ellipsis' | 'pause' | 'stretch';
   export interface DurationProfile {
     type: DurationType;
     storyDuration?: string;       // story time span (seconds/minutes/hours/days/months/years)
     narrativeLength?: number;     // narrative time length (word count or byte count)
     ellipsisClarity?: 'explicit' | 'implicit' | 'hypothetical';  // if type === 'ellipsis'
     compressionRatio?: number;    // story time compression ratio (meaningful for summary)
   }
   ```
2. MUST NOT conflate with `NarrativeEllipsis` (corpus diagnostic type). `DurationProfile.type === 'ellipsis'` is a Genette discourse-level property — the text exists, it just tells you time passed. `NarrativeEllipsis` is a non-rendering gap.
3. Add to BOTH `NarrativeEvent` and `EventFile` for consistency with other discourse fields
4. At least one zhu-fu or dream-of-red-chamber event YAML fixture must use `duration` with a non-default value

**Acceptance**: Type exports from `types/index.ts`. Schema validates. At least one fixture event uses `duration` in YAML. `npx vitest run packages/core/tests/validator/duration.test.ts` passes (even if only schema validation tests initially).

### S6b: Frequency — FrequencyProfile

**Scope**: New `FrequencyProfile` type + schema. Completely absent — no singulative/repeating/iterative concepts anywhere.

**New files**:
- `packages/core/src/types/frequency.ts` — `FrequencyType`, `FrequencyProfile`
- `packages/core/src/schemas/frequency.ts` — Zod schemas
- `packages/core/tests/validator/frequency.test.ts` — test suite

**Modified files**:
- `packages/core/src/types/event.ts` — add `frequency?: FrequencyProfile` to `NarrativeEvent` + `EventFile`
- `packages/core/src/schemas/event.ts` — add `frequency` to schemas
- `packages/core/src/types/index.ts` — barrel export
- `packages/core/src/schemas/index.ts` — barrel export

**Binding constraints**:
1. Types (from `docs/reference/stage-3/narratology-dimension-audit.md` lines 170-188):
   ```typescript
   export type FrequencyType = 'singulative' | 'repeating' | 'iterative';
   export interface FrequencyProfile {
     type: FrequencyType;
     sourceEventCount?: number;    // Repeating: which occurrence in story this narrative covers (1 for singulative, N when >1)
     occurrenceCount?: number;     // Iterative: how many actual occurrences one narrative covers
     iterationScope?: { start: string; end: string };  // Iterative: time range
     otherOccurrences?: string[];  // Repeating: related repeating narrative event IDs
   }
   ```
2. Add to BOTH `NarrativeEvent` and `EventFile`
3. At least one zhu-fu or dream-of-red-chamber event YAML fixture must use `frequency`

**Acceptance**: Type exports. Schema validates. At least one fixture event uses `frequency` in YAML. `npx vitest run packages/core/tests/validator/frequency.test.ts` passes.

### S6c: Mood wiring — NarratorProfile YAML load path + external focalization

**Scope**: Wire existing `NarratorProfile` types (focalizer_bound/retrospective_entity/explicit_ledger/omniscient) to YAML loading in `entity/mapper.ts`. Add `external` focalization type. Currently all fixtures use crude `pov.type` (first_person/third_person_limited/omniscient) — NarratorProfile types are dead.

**New files**:
- None (types already exist in `types/discourse.ts:79-144`)

**Modified files**:
- `packages/core/src/types/event.ts` — add `narratorProfileRef?: string` + `focalization?: { type: 'zero' | 'internal' | 'external'; variation?: 'fixed' | 'variable' | 'multiple'; characterSequence?: { character: EntityId; scope: string }[] }` to `EventFile`
- `packages/core/src/schemas/event.ts` — add `narratorProfileRef` + `focalization` to schemas
- `packages/core/src/entity/mapper.ts` — add NarratorProfile YAML load path: when `narratorProfileRef` is set, resolve the referenced `NarratorProfile` from project YAML instead of degrading to `pov.type`
- `packages/core/src/types/discourse.ts` — add `external` focalization type (currently only 3 pov types exist)

**Binding constraints**:
1. EventFile extension (from `docs/reference/stage-3/narratology-dimension-audit.md` lines 234-246):
   ```typescript
   narratorProfileRef?: string;      // reference to NarratorProfile id
   focalization?: {
     type: 'zero' | 'internal' | 'external';
     variation?: 'fixed' | 'variable' | 'multiple'; // internal focalization subtypes
     characterSequence?: { character: EntityId; scope: string }[]; // variable focalization
   };
   ```
2. Mapper: when YAML has `narratorProfileRef`, load the referenced `NarratorProfile` from project-level `narratorProfiles` map (in DiscourseState). Fall through to `pov.type` only when `narratorProfileRef` is absent (backward compat)
3. Add `external` focalization type: `pov.type` only has `first_person`/`third_person_limited`/`omniscient`. Add `external` (camera-like, no internal access). Genette external focalization predates modernism (Hemingway, some 19th-century scenes)
4. At least one fixture event must use `narratorProfileRef` to reference a defined NarratorProfile

**Acceptance**: Mapper resolves `narratorProfileRef` → `NarratorProfile`. At least one fixture uses the new path. `pov.type` backward compat maintained (events without `narratorProfileRef` still work). `external` focalization type available in enum.

### S6d: Voice — NarrativeLevel + DiegeticRelation

**Scope**: Add `VoiceProfile` with `NarrativeLevel` and `DiegeticRelation` to `types/discourse.ts`. Extend `NarratorProfileBase` with optional `voice` field. Currently NarratorProfile models narrator capabilities (access/fidelity/truthfulness) but NOT narrative level — these are orthogonal dimensions.

**New files**:
- None (extend existing `types/discourse.ts`)

**Modified files**:
- `packages/core/src/types/discourse.ts` — add `NarrativeLevel`, `DiegeticRelation`, `VoiceProfile` types; add optional `voice?: VoiceProfile` to `NarratorProfileBase`
- `packages/core/src/schemas/discourse.ts` — add Zod schemas for new types
- `packages/core/src/types/event.ts` — add `voice?: VoiceProfile` to `EventFile`
- `packages/core/src/schemas/event.ts` — add `voice` to schemas

**Binding constraints**:
1. Types (from `docs/reference/stage-3/narratology-dimension-audit.md` lines 293-316):
   ```typescript
   export type NarrativeLevel = 'extradiegetic' | 'intradiegetic' | 'metadiegetic' | 'hypodiegetic';
   export type DiegeticRelation = 'heterodiegetic' | 'homodiegetic';
   export interface VoiceProfile {
     level: NarrativeLevel;
     relation: DiegeticRelation;
     nestingDepth?: number;
     embeddedStory?: {
       narratingCharacter: EntityId;
       audienceCharacter?: EntityId;
     };
   }
   ```
2. Extend `NarratorProfileBase` with optional `voice?: VoiceProfile`. Narrator capabilities (access, fidelity) and narrative level are orthogonal — omniscient can be extradiegetic (traditional omniscient narrator) or intradiegetic (Scheherazade in 1001 Nights)
3. `voice` on EventFile allows per-event override of narrator level (e.g., an embedded story within a chapter)
4. At least one fixture event must use `voice` with a non-default `NarrativeLevel`

**Acceptance**: Types exported. Schema validates. At least one fixture event uses `voice`. `NarratorProfile` with `voice` wired through mapper.

### S6e: Order refinement — Anachrony type

**Scope**: Add `Anachrony` interface to refine the existing `sceneType: flashback/flashforward` with Genette classification (type, scope, function, distance, amplitude).

**New files**:
- None (extend existing `types/discourse.ts`)

**Modified files**:
- `packages/core/src/types/discourse.ts` — add `AnachronyType`, `AnachronyScope`, `AnachronyFunction`, `Anachrony` types
- `packages/core/src/schemas/discourse.ts` — add Zod schemas
- `packages/core/src/types/event.ts` — add `anachrony?: Anachrony` to `NarrativeEvent` + `EventFile`
- `packages/core/src/schemas/event.ts` — add `anachrony` to schemas

**Binding constraints**:
1. Types (from `docs/reference/stage-3/narratology-dimension-audit.md` lines 48-64):
   ```typescript
   export type AnachronyType = 'analepsis' | 'prolepsis';
   export type AnachronyScope = 'internal' | 'external' | 'mixed';
   export type AnachronyFunction = 'completing' | 'repeating';
   export interface Anachrony {
     type: AnachronyType;
     scope: AnachronyScope;
     function: AnachronyFunction;
     distance: string;             // "N years/months/days from current"
     amplitude?: string;           // time span covered
     anchorEventId?: string;       // anchor event
   }
   ```
2. `Anachrony` refines but does NOT replace `sceneType` (backward compat). `flashback` with `anachrony.type = 'analepsis'` provides richer classification
3. At least one zhu-fu fixture event (which already uses `sceneType: flashback` + `narrationTime`) must also use `anachrony`

**Acceptance**: Types exported. Schema validates. At least one zhu-fu fixture event uses `anachrony`. Existing `sceneType: flashback` events still work.

## Evidence
- 5 个 validator 注册于 `aggregator.ts`（validator 总数 20→26）、`validator/index.ts` barrel + `analysisContentSchema`（5 个新块 `.optional()`——既有 mock reference data 早于这些字段，required 会破坏全部 mock 测试面）、core barrel。
- 每 validator 独立测试（match/mismatch/analysis-null 三段式）+ `schema-unification`/`dynamic-schema`/`validator.test` 契约断言同步更新。全量非 e2e 回归与既有基线逐字一致（15 failed / 3 files，全部为过期硬编码路径）。
- 真实 LLM 全链路（DeepSeek `render E0 --all`）: 7/7 事件 committed，S6 字段经 Pass 2 往返无 validator 异常。报告：`docs/report/full-chain-wiring-acceptance.md`。
