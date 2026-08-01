# Epistemic NovelIR 最小变更实施计划

## Context

目标是一次 fixture-first 的破坏式切换：项目源码先编译为唯一的内部 NovelIR，再进入图、状态边界、discourse 与渲染；确定性状态只保存作者声明和纯确定性推导；Pass 2 文学判断保存为带协议、证据和不确定性的外部 measurement observation，绝不伪装成故事角色的知识 claim；验证结果明确区分编译器不变量、证据不匹配、解释性评估和测量不确定性；实体 ontology 只在真实 fixture 校准、显式编目并人工确认 policy 后启用。

### Research basis（依据，不直接决定代码形状）

- Genette 的 story/discourse 区分支持继续让 story graph、discourse graph 和渲染顺序保持独立，不把叙述判断写回 story state。
- NarrativeTime 一类标注工作支持把时间/话语现象保存为带来源的 annotation，而不是未标来源的客观事实。
- Mikhalkova 等叙事标注研究以及 Piper/So/Bamman 的计算文学研究共同说明：文学判断存在解释分歧，模型输出应保留证据、策略和不确定性，不能因 JSON 通过 schema 就称为“已验证事实”；LLM-as-a-judge 的偏差研究进一步要求把模型输出视为需要校准的 measurement，而不是知识事实。
- story-world knowledge 与外部 validation measurement 是两个 ontology：前者继续由 `Claim`/`PropositionCatalog`/`EpistemicLedger` 表达，后者只存在于 `AnalysisResult`，二者没有隐式转换。

### Repository-grounded decisions（工程选择）

- 保留现有公开 `initializeProject()` 作为薄封装；不新增公开 `ProjectNovelIR`/`compileProjectNovelIR()` API。新增的规范编译内核只在 core 内部模块间导入，repo 内调用方一次性切换到当前形状，不承诺旧调用方兼容。这是用户确认的最小变更方案。
- 保留 `sceneBrief` 作为简短场景目标，不做无收益的 `sceneGoal` 重命名；新增有序 `beats`，使它不再独自承载全部场景语义。
- 保留现有动态 `analysis` payload；新增一个平行的、按 top-level analysis field 索引的轻量 `observations` map，不给每个 block 再包一层泛型，也不改现有 block schema。finding 用 JSON Pointer 指向实际消费的原子 payload，避免为每个数组项再建一套对象图。
- 保留现有 knowledge-domain `Claim`、`ClaimAssessment`、`ClaimEvidenceRecord`、`PropositionCatalog` 和 `EpistemicLedger` 原形；Pass 2 只复用 `ValidationKey` 和 release gate。YAML/Zod 跨边界只新增 source catalog 类型；不新建通用 epistemic framework。
- event-local `introduces` 明确定义为“实体进入可写 live runtime state 的 activation boundary”，不是 compile-time declaration，也不是 discourse 首次提及；它编译为同 story coordinate、位于 authored event 之前的 non-renderable introduction transition。复用现有 game-choice synthetic event pattern，避免给 replay 增加第二套“pre-event 写入”机制。

## Approach

### 1. 直接破坏更新 authored contract

- 删除 `schemas/project.ts::schemaVersion`、`schemas/event.ts::formatVersion` 及对应 `ProjectConfig`/`EventFile` 字段；`nova.yaml`、event YAML、Pass 2 result 均不携带版本判别字段。`loadProjectConfig()` 与 event loader 直接按当前 schema 严格解析，不做版本协商、双读或自动迁移。删除仅服务 project/event schema version 的 `migrateProjectFile()`、migration registry、root exports 和未使用测试；旧 shape 不能通过当前 schema 时直接 `ConfigError`。
- 在 `EventFile`、`NarrativeEvent` 和 `SceneSpecification` 增加必填非空 tuple：
  ```ts
  beats: [string, ...string[]];
  ```
  `sceneBrief` 保留并明确为“一句话场景目标”；`beats` 只表达按顺序发生的动作/转折。POV、时序、冲突、解决、checklist、style、thread、foreshadowing、relationship/rule effects 和 facts 继续使用现有字段，不复制到新结构。
- 用一次性脚本直接更新所有 `fixtures/**/nova.yaml`、authored event YAML、测试内存项目、CLI `project init` 模板、bench adapter 输出和 synthetic event 构造器；该脚本是本次仓库改写工具，不是 runtime migration API，交付后删除。脚本移除已有 `schemaVersion`/`formatVersion`，可按原 brief 的句界生成保持原文和顺序的 `beats` 候选，但句子不自动等同于动作/转折；fixture owner 必须逐项确认或改写候选后才能提交当前 contract。脚本只把 definition `initialState` 移入已经 authored 的唯一 `introduces`，不依据“最早引用”自动创建或移动 introduction；空 brief、未确认 beats、较早 live reference、无法唯一归属的 introduction 或冲突 initial state 都是迁移错误，不设置 fallback。
- 先单独修复校准扫描发现的 schema-invalid legacy fixture（包括 `most-dangerous-game` 的旧 style/relationship/narrative 字段），再进入后续步骤；不要让 loader 静默丢字段。
- `EntityMapper.mapToNarrativeEvent()` 原样传递 `sceneBrief`/`beats`。`ContextAssembler._buildSceneSpec()`、Pass 1 prompt 和 `buildAnalysisPrompt()` 输出目标后紧跟编号 beats。`analyzeProjectImpact()` 将任一字段变化保持为当前 scene-semantic 的 yellow impact。
- 使用 `zhu-fu/chapters/chapter_01/E0_encounter.yaml` 作为丰富 golden；断言 prompt 同时含 goal 和有序 beats。更新后对 source/test/fixture/CLI/bench 搜索，所有 authored event 都有 beats，所有 author-facing project/event 文件均无版本判别字段，`sceneBrief` 仍只出现在目标字段及其合法消费者中。

#### 预期的 `nova.yaml`

```yaml
project: zhu-fu
title: "祝福"
author: "鲁迅"
defaultModel: mock
defaultLanguage: zh
genre: literary
tense: past
snapshotInterval: 3
defaultSceneTextTarget: 1200
```

其余现有 project 配置（`synopsis`、`ideaIR`、validator overrides、style/render 配置等）原形保留；不增加版本 header。`definitions/state_initial.yaml` 的 `timeAnchors`、`threads`、`worldFacts` 形状不变。

#### 预期的 authored event YAML

```yaml
event: E2
narrativeOrder: 3
title: "初到鲁镇"
storyTime: winter_five_years_ago
narrationTime: new_year_eve
sceneType: flashback
tense: past
pov:
  character: narrator
  type: first_person

# 简短目标仍保留；不改名为 sceneGoal
sceneBrief: "祥林嫂逃到鲁镇做工，短暂获得安稳。"

# 新增的必填有序结构；至少一项，每项必须非空
beats:
  - "卫老婆子把祥林嫂带到鲁四老爷家。"
  - "四婶试用她做工，发现她安分耐劳。"
  - "祥林嫂从惶恐逐渐转为短暂的满足。"

# 该实体的 declaration 已存在；它在本事件之前的 internal transition 中进入 live runtime state
introduces:
  - type: character
    id: xianglins_wife
    initialState:
      location: weijia_shan
      status: alive
      emotionalState: fearful_but_determined

preconditions:
  - entity: xianglins_wife
    attribute: location
    value: weijia_shan

expectedPostconditions:
  - entity: xianglins_wife
    attribute: location
    value: fourth_master_lu_house
    confidence: 1.0
  - entity: xianglins_wife
    attribute: status
    value: employed_maid
    confidence: 1.0

styleGuidance:
  tone: "克制、冷静"
  targetWordCount: 1200
```

`introduces.initialState` 不允许显式写 `lifecycle`；compiler 自动生成 `lifecycle=active`。同一实体只能在一个 event 中 `introduces`。在 target event 上，introduction transition 先执行，因此 precondition 可读取该 initial state；target event 的 postcondition 可继续修改同一 attribute。

这里的 `introduces` 只表示 runtime activation：definition 在编译期已经声明实体身份；activation 之前实体不能被普通 event 作为 live participant/precondition/write target，较早 live reference 是 `ConfigError`；discourse 中的首次提及由 narrative/discourse order 决定，不由该字段表示。迁移器不得根据引用位置移动 activation boundary。

实体定义文件仍按当前 kind 分文件。将 character/location/item/faction 的 `initialState` schema/type 改为 optional（不能使用 `.default({})`，因为 compiler 必须区分“省略”与“空 baseline state”）。若实体由 event `introduces`，definition 只写身份/描述等 metadata，并省略 `initialState`：

```yaml
# definitions/characters/xianglins_wife.yaml
id: xianglins_wife
name: "祥林嫂"
type: tragic_protagonist
role: supporting
description: "……"
aliases:
  - "祥林嫂"
gender: "女"
traits:
  - hardworking
  - traumatized
# 无 initialState；状态只在唯一的 introduces.initialState 中声明
```

没有 event activation 的 baseline entity 继续在 definition 中写 `initialState`；允许显式 `{}`。规范编译器执行唯一 exclusivity 规则：存在 authored event `introduces` 时 definition `initialState` 必须省略；没有 event activation 时 definition `initialState` 缺失按空 baseline state 处理。旧 definition state 只有在已经存在唯一 authored introduction、所有 key/value 相容且此前没有 live reference 时才可由一次性脚本移入；其他情况报错并要求作者决定，不做覆盖优先级或自动改写 story boundary。

### 2. 以 fixture 校准 authored entity catalog，但暂不执法

- 在测试侧增加只读校准 helper 和 `packages/core/tests/entity/catalog-calibration.test.ts`；扫描范围固定为 `nova.yaml`、`definitions/**/*.yaml`、`chapters/**/E*.yaml`，排除 `scenes/`、`.nova/`、`reference/data/` 和 render-request 产物。
- 校准结果按 entity kind/type 列出：baseline/introduces/pre/postcondition 中的 attribute、值形状、set/unset 次数、首次写入位置、重复 introduction、未声明引用和 source path。测试失败信息生成确定性的结构 proposal 与 policy evidence report；不把 proposal 生成器放进生产包，也不提交另一份手工 snapshot。
- 在 `types/entity-catalog.ts` 增加最小 serializable source 形状；author-facing source 不暴露 runtime `EntityTypeRef.schemaVersion` 或 catalog `version`：
  ```ts
  type AttributeValueType =
    | 'string'
    | 'number'
    | 'boolean'
    | 'string_list'
    | 'string_map';

  interface AttributeDefinitionSource
    extends Omit<AttributeDefinition, 'valueSchema'> {
    valueType: AttributeValueType;
  }

  interface EntityTypeDefinitionSource
    extends Omit<EntityTypeDefinition, 'typeRef' | 'attributes'> {
    typeId: string;
    attributes: Record<string, AttributeDefinitionSource>;
  }

  interface EntityTypeCatalogSource {
    types: Record<string, EntityTypeDefinitionSource>;
  }
  ```
  source 只表达当前可编译结构，不增加递归 DSL、union、nullable、`any` 逃生口或版本协商字段。
- 在每个 fixture/project 新增 `definitions/entity-types.yaml`。`EntityMapper.loadProject()` 必须解析它并保存为 `ProjectData.entityTypeCatalogSource`；缓存中只保存该 serializable source，绝不保存 live Zod object。
- `compileEntityTypeCatalog(source)` 每次编译 fresh runtime catalog：五个 literal 分别映射到 `z.string()`、finite `z.number()`、`z.boolean()`、`z.array(z.string())`、`z.record(z.string(), z.string())`。现有 runtime 类型若仍要求 `EntityTypeRef.schemaVersion`/catalog `version`，compiler 只填充 implementation-local 常量；它们不出现在 authored YAML、不选择 migration，也不构成兼容保证。`typedInvariants` 在本计划中必须为空，因为当前 description 不是可执行规则。
- calibration 只能推导结构事实：observed `valueType`、出现位置和 set/unset 频率；同一 attribute 出现不兼容 value shape 时直接报错。已存在于 `defaultEntityTypeCatalog` 的 attribute 可逐项复制其 policy。新 attribute 不从“样本中未发生写入/删除”推导 `immutable`、`write_once`、`requiredAt` 或 `unsetAllowed`；proposal 对这些字段输出 `POLICY_REQUIRED` 及观测证据，fixture owner 必须从现有有限枚举中显式选择后，`entity-types.yaml` 才是有效输入。
- 这一阶段只要求 catalog 覆盖扫描到的值形状，并要求每个 policy 都是显式 authored/approved 值；coverage 通过只证明当前 fixture 与 catalog 一致，不证明 policy 普遍有效。`defaultEntityTypeCatalog` 仍供现有 validator 使用，ReplayEngine 仍不因新 catalog 改变行为。Step 6 只有在 coverage、显式 policy review 与各 policy 的 negative contract tests 全部通过后才能启用执法。`definitions/entity-types.yaml` 的预期形状如下；每个实际使用的 type/attribute 都按同一结构显式列出：

  ```yaml
  types:
    character:
      typeId: character
      kind: character
      attributes:
        lifecycle:
          attributeId: lifecycle
          valueType: string
          requiredAt: introduction
          writePolicy: lifecycle_managed
          allowedLifecycleStates: [active, inactive, retired]
          unsetAllowed: false
          semanticRole: lifecycle
        location:
          attributeId: location
          valueType: string
          requiredAt: never
          writePolicy: mutable
          unsetAllowed: true
          semanticRole: location
          typedReferenceConstraint:
            targetKind: location
        status:
          attributeId: status
          valueType: string
          requiredAt: never
          writePolicy: mutable
          unsetAllowed: true
          semanticRole: lifecycle
        aliases:
          attributeId: aliases
          valueType: string_list
          requiredAt: never
          writePolicy: mutable
          unsetAllowed: true
          semanticRole: identity
      lifecyclePolicy:
        allowedTransitions:
          - [active, inactive]
          - [active, retired]
          - [inactive, active]
          - [inactive, retired]
      referenceCapabilities:
        defaultEligibility: live
      typedInvariants: []

    location:
      typeId: location
      kind: location
      attributes:
        lifecycle:
          attributeId: lifecycle
          valueType: string
          requiredAt: introduction
          writePolicy: lifecycle_managed
          allowedLifecycleStates: [active, inactive, retired]
          unsetAllowed: false
          semanticRole: lifecycle
        status:
          attributeId: status
          valueType: string
          requiredAt: never
          writePolicy: mutable
          unsetAllowed: false
          semanticRole: lifecycle
      lifecyclePolicy:
        allowedTransitions:
          - [active, inactive]
          - [active, retired]
          - [inactive, active]
          - [inactive, retired]
      referenceCapabilities:
        defaultEligibility: live
      typedInvariants: []
  ```

  author-facing catalog 不含 `version`/`schemaVersion`；attribute key 必须与 authored fact 中的 attribute 完全一致，不能使用 wildcard。

### 3. 建立唯一的内部 project compilation kernel

- 新增 `packages/core/src/entity/project-runtime.ts`，但不从 `entity/index.ts`、core root 或 `public-api.manifest.json` 导出。内部契约固定为：
  ```ts
  interface CanonicalProjectIR {
    readonly sourceHash: string;
    readonly data: ProjectData;
    readonly authoredEvents: readonly NarrativeEvent[];
    readonly runtimeEvents: readonly NarrativeEvent[];
    readonly initialFacts: readonly Fact[];
    readonly initialThreads: readonly { id: string }[];
    readonly registry: InMemoryEntityRegistry;
    readonly entityDeclarations: EntityDeclarationCatalog;
    readonly entityTypes: EntityTypeCatalog;
    readonly gameDialogueTree: CompiledGameDialogueTree | null;
    readonly chapterByEventId: Readonly<Record<string, number>>;
  }

  function loadCanonicalProject(projectDir: string, storage: Storage): CanonicalProjectIR;
  function compileCanonicalRuntime(
    ir: CanonicalProjectIR,
    options?: { branchPath?: BranchPath; discourseBranch?: string },
  ): CompiledNarrativeRuntime;
  ```
  这些是 package-private module exports，只供 core 内部文件复用。
- 首先改 `EntityMapper.loadAllEvents()`：接收已加载的 `ProjectData`（不是 chapters 片段），并禁止内部再次调用 `loadProject()`。同样将 `InMemoryEntityRegistry.load(projectPath, storage)` 改为 `load(data, deferredIntroductionIds)`，消除第二个 mapper/load；所有 callsite 同步迁移。
- source hash/cache 逻辑从 `api.ts` 下沉到该模块。一次调用只执行一次 `loadProject()`；cache key 仍按 `Storage` identity + project path + authored YAML hash 隔离。cache 只含 structured-clone-safe source/mapped data；每次调用重新创建 registry、compiled Zod catalog、declaration catalog、arrays 和 runtime，避免跨调用污染。
- 删除 `EntityMapper.createGenesisEvent()` 和 `system:genesis`。`initialFacts` 只从采用 initial activation 的 definition/registry state 与 `state_initial.yaml` 概念实体生成，并为这些 baseline entities 添加纯推导的 `lifecycle=active`；同一 `entity.attribute` 重复且值相同去重，值冲突时报 `ConfigError`。不再同时生成 `world.<factId>` 和 `<factId>.value` 两套表示。
- `EntityDeclaration` 增加必填 `introduction: { type: 'initial' } | { type: 'event'; eventId: string }`，其中 `introduction` 只描述 live-state activation source；所有 declaration 在 story compile 前均已存在。一个实体若没有 authored `introduces`，保持 initial activation；若有则必须唯一，且任何较早 live participant/precondition/write reference 都是迁移错误。把 definition 的旧 `initialState` 移入已经 authored 的 introduction 只允许相同 key/value 去重，值冲突或较早 live reference 时报错；不得把 introduction 自动移动到最早引用。target event 中引用这些值的 preconditions 保留并必须与 merged initial state 一致。
- 对每个 event activation 生成 `system:introduction:<targetEventId>:<entityId>`：story coordinate/branch scope 与 target 相同，postconditions 为 `lifecycle=active` 加 merged initial state，并添加到 target 的 author-origin predecessor；复用 game-choice transition 的 internal event 构造/过滤方式。它参加 story graph、boundary 和 replay，但不参加 discourse order、scene catalog、Pass 1/2、validator denominator 或 assembly。target `stateBefore` 已包含 activation state，target 的 authored postconditions 可以再修改同一 attribute。
- 复用现有 game-dialogue compiler 生成 scope 与 transition events：`authoredEvents` 只含可渲染 event-file events，`runtimeEvents` 为 authored + introduction transitions + choice transitions。`compileCanonicalRuntime()` 统一解析 branch/discourse route，再且仅调用一次 `compileNarrativeRuntime()`。
- 保留公开 `initializeProject()`，实现改为薄封装：调用内部 load/compile kernel，返回当前仓库需要的 `mapper/data/events/registry/stateManager/state/runtime`；第三参数为内联的可选 branch/discourse options。返回的 `events` 明确为 authored events；`StateManager` 用 catalog context 和 `runtimeEvents` 初始化。repo 内调用方一次性迁移，不承诺旧返回形状兼容，也不再借返回的 mapper 重建项目。
- `initializeProject()` 继续是 CLI/bench 的现有公开入口；core 内的 API/editorial/assembler/SourceWorkspace 直接导入 package-private kernel，避免 `api.ts` 循环依赖。不得新增第二个公开 project compiler。
- 增加 one-load spy、Storage cache isolation、fresh mutable objects、无 genesis、introduction 时序、branch/discourse route 和 hash stability 测试。

### 4. 用轻量 companion observation 记录 Pass 2 measurement

- **knowledge domain 零改动。** `Claim`、`ClaimAssessment`、`ClaimEvidenceRecord`、`PropositionCatalog`、`EpistemicLedger`、`claimKey()`、knowledge schemas、knowledge replay 和 reference index 均保持原形；本步骤不增加 `EpistemicStatus`/`ClaimKind`，不迁移任何 claim literal，也不让模型成为 `EntityId`。Pass 2 observation 永不进入 WorldState、DiscourseState、ledger、catalog 或 reference index。
- `NarratorAssertion` 仍是 authored discourse source record，但使用自己命名的有限类型：
  ```ts
  type NarratorAssertionStatus = 'asserted' | 'unknown' | 'contested';
  ```
  它替换 `truthBoundary`，不与 Pass 2 disposition 共享 type alias。只有 `status: 'asserted'` 的 `authoritative_reveal` 可执行 reveal；`unknown`/`contested` 只能走 claim/conjecture/implication。它不投影进 `EpistemicLedger` 或 `AnalysisResult.observations`，现有 assertion evidence/confidence 保持 authored discourse 语义。
- narrator assertion YAML 只删除 `truthBoundary`、新增 `status`。确定性 reveal 使用 `status: asserted`；不确定命题使用 `unknown` 或 `contested`，且不能标成 `authoritative_reveal`：
  ```yaml
  # definitions/assertions/xianglin_death.yaml
  id: assertion_xianglin_death
  narrator: narrator_wo
  proposition: "祥林嫂死于祝福前夜"
  polarity: affirmative
  type: authoritative_reveal
  status: asserted
  narrationBoundary:
    narratorId: narrator_wo
  ```
  ```yaml
  id: assertion_afterlife_uncertain
  narrator: narrator_wo
  proposition: "人死后是否有灵魂"
  polarity: affirmative
  type: conjecture
  status: contested
  narrationBoundary:
    narratorId: narrator_wo
  evidence:
    type: testimony
    source: "祥林嫂的三次追问"
    confidence: speculative
  ```
- 将 integration `BoundaryReference.truthValues: Record<string, boolean>` 改为 `evaluations: Record<string, EvaluationResult>`；`true|false|indeterminate` 是确定性计算结果，不映射成 narrator status 或 Pass 2 disposition。
- 只在 `types/analysis.ts` 增加一个局部、非泛型的 companion union；map key 本身就是 active top-level analysis field，不再复制 `target`、`subject`、`propositionId`、`policyId` 或 evaluator。模型只返回 exact quote，parser 做 substring 校验；不要求模型计算容易出错的字符 offset：
  ```ts
  interface AnalysisAlternative {
    summary: string;
    evidence: [string, ...string[]]; // exact prose quotes
  }

  type AnalysisObservation =
    | {
        disposition: 'produced';
        evidence: [string, ...string[]];
      }
    | {
        disposition: 'abstained';
        reason: string;
        evidence: string[];
      }
    | {
        disposition: 'ambiguous';
        alternatives: [AnalysisAlternative, AnalysisAlternative, ...AnalysisAlternative[]];
        evidence: string[];
      };
  ```
  `produced` 只表示“该 field 的 measurement payload 已产生并通过原 block schema”，不声明其中每个判断为真；`abstained` 是无法测量；`ambiguous` 是单次评估发现至少两种有文本证据的合理解释，不冒充多评估者 consensus，也不使用 `contested`。
- `AnalysisResult` 升为：
  ```ts
  interface AnalysisResult {
    eventId: string;
    protocol: ValidationKey;
    observations: Record<string, AnalysisObservation>;
    analysis: Record<string, unknown>; // 现有 domain payload 原形
  }
  ```
  不增加 `AnalysisObservation<T>`，不修改每个 block 的内部 schema。删除 `AnalysisResult.checklistResults` 的旧 top-level 可选字段；`ChecklistValidator` 与其他 validator 一样只读 `analysis.checklistResults`。
- `AnalysisBlockRequirement` 保持现有形状，不增加 `claimKind`/`observationKind` 映射。`ResultAggregator.getAnalysisContract()` 仍从现有 validator requirements 构造 active fields；同一 top-level field 的 nested requirement（例如 `pov.leaks`）共享一个 `observations.pov` execution record，原子判断仍留在原 payload 中。
- top-level response contract 要求每个 active field 恰有一个 observation：`produced` 时 `analysis[field]` 必须存在并通过原 schema；`abstained`/`ambiguous` 时 canonical payload 必须缺失，前者要求非空 reason，后者在 observation 内保留至少两个 alternatives 及各自 evidence。plugin optional block 未返回时 observation/payload 均缺失；一旦返回其中任一，必须满足同一配对规则。
- 每条 evidence 必须是 `protocol.proseHash` 对应 prose 的非空 exact substring；不匹配即为 protocol parse error。具体 prose span 需要展示时由 parser 用现有字符串查找确定，不增加持久 offset 类型。模型运行的 request ID/attempt 保存在现有 raw-response/revision debug envelope，不写入 story timestamp，也不进入 semantic cache identity。
- 扩展现有 `ValidationKey`，不新增第二套 protocol：
  ```ts
  interface ValidationKey {
    proseHash: string;
    analysisSchema: string;
    model: string;
    provider: string;
    analysisPromptHash: string;
    samplingConfigHash: string;
    validatorPolicy: string;
    referencePolicy: string;
  }
  ```
  `analysisPromptHash` 覆盖 canonical、non-self-referential Pass 2 prompt preimage（先以固定 sentinel 构造完整 prompt material 并哈希，再把真实 hash 写回最终 prompt；sentinel 永不发送给 provider）；`samplingConfigHash` 覆盖 temperature、seed、response format 等影响 measurement 的调用参数。给 `RenderPipelineOptions` 增加必填 `validatorPolicyId`；editorial 传现有 `plan.planSummary.validationIdentity`，direct tests/CLI 明确传 contract/policy hash。
- prompt 给出 exact protocol、active field 和 observation template；`parseAnalysisJSON*()` 接收 `expectedProtocol` 并比较全部字段、field 配对与 exact quotes。protocol/配对/evidence 错误走现有四次 Zod-feedback 子尝试；合法 `abstained`/`ambiguous` 首次解析成功，不触发 retry。
- cache 继续使用现有 logical/surface/attempt 分层；`buildValidationKeyMaterial()` 由同一个 protocol 构造，不新增平行 cache key。current-shape response fixture、mock provider、cache reparse、double-run comparison、revision/debug persistence 全量保存 protocol/observations/analysis；先前缓存因 schema/prompt/sampling/policy hash 改变自然 miss，不加旧 response reader。现有 render-cache `formatVersion` 只用于内部缓存安全失效，不是 author-facing 或 API 兼容承诺。
- 加入硬隔离测试：NarratorAssertion 的 `unknown|contested` 只影响 disclosure rules；Pass 2 的 `abstained|ambiguous` 只影响 validation/release；两种 persisted schema 交叉反序列化必须失败。任何 Pass 2 解析前后，knowledge ledger、PropositionCatalog、reference index、WorldState 和 DiscourseState 必须 byte-equivalent。

### 5. 将 validation finding 的语义与 release severity 分开

- 给 `ValidationIssue` 及 strict persisted schema 增加最小引用，不复制整个 observation：
  ```ts
  kind:
    | 'compiler_invariant'
    | 'evidence_mismatch'
    | 'interpretive_assessment'
    | 'analysis_uncertainty';
  observationRef?: {
    field: string;
    analysisPointer?: string; // RFC 6901 pointer into AnalysisResult.analysis
  };
  ```
  severity 继续是独立的 `error|warning|info`；`ValidationResult.passed` 仍只表示无 error，不表示文学判断为客观真。
- pre-render/deterministic validator 的 issue 标记 `compiler_invariant` 且禁止 `observationRef`。hard schema/graph/replay/ontology 错误继续使用现有 typed error channel，并在 provider/cache/prompt 前 fail closed；UI 转换为 diagnostic 时才显示该 kind。
- `produced` verification payload 的不匹配标记 `evidence_mismatch`；assessment/quality payload 的 findings 标记 `interpretive_assessment`。field 级 observation 只证明该 measurement 的执行与 provenance；具体 finding 必须用 `analysisPointer` 指向其实际消费的原子 payload，不能把整个 field 的 observation 当作所有数组项的真值证明。
- aggregator 只增加一个统一 preflight：validator 所需 field 为 `abstained`/`ambiguous` 时，不把缺失 payload 交给 validator，而是按 validator+field 生成稳定的 `analysis_uncertainty` finding，并附 `observationRef.field`。默认 severity 为 warning，但现有 validator override/policy 可显式提升或降低；severity 不从 disposition 自动推导。多个 field 分别生成 finding。
- 对 `produced` payload，单对象 field 可由 aggregator 自动填充 field reference；消费数组项或多个字段的 validator 必须在现有 issue 构造点提供 exact RFC 6901 pointer。aggregator 必须拒绝不存在的 pointer，以及首段与 `observationRef.field` 不一致的 pointer。只新增一个 `makeObservationRef(field, pointer?)` helper，不增加 observation repository、facade 或新的 validator base class。
- `resolveDeferredFacts()` 只对 `produced` 的现有 verification payload 执行 exact/similar/absent/contradicted 逻辑；`abstained`/`ambiguous` 不伪造 match level。
- `evaluateReleaseDecision()` 仍是唯一 release gate：protocol/compile/missing/error 为 blocked；warning（包括默认 analysis uncertainty）为 pending_waiver；无阻断 finding 为 accepted。request 中的现有 waivers 初始化到同一个 `InteractionManager`，并传给 editorial 两个 release-decision callsite；waiver 只改 release disposition/waiverId，不改 observation。
- CLI/editorial/API/reporter/manifest 持久化并显示 kind、observation field/pointer、disposition、protocol 和 evidence。`AnalysisResult` 只保存一份 observation map，issue 只保存引用，避免重复 payload。保留 `VerifiedHeadData`、approved human reference、accepted head 等程序性术语；不得用 “verified” 描述 Pass 2 measurement。

### 6. 校准测试全绿后再启用 ontology enforcement

- 只有 Step 2 的 fixture value-shape coverage、逐项显式 policy review 和每种启用 policy 的 negative contract tests 全绿后，才把 compiled type/declaration catalogs 接入 runtime；“当前 fixture 没有反例”本身不是 gate。定义一个小型共享 `EntityCatalogContext { entityDeclarationCatalog; entityTypeCatalog }`，不再增加其他 catalog facade。
- 新增纯函数 `validateCatalogWrite(state, fact, phaseContext, catalogs)`；source preflight 和 replay 都调用它，确保只有一套规则。`validateProjectOntology(ir)` 先做全事件的 declaration/value/reference 静态检查，再按现有 game-tree leaf 枚举把每条 reachable branch replay 到临时 scratch state，以同一 applicator 检查时序型 write policy；它不修改 IR、registry 或任何持久状态。
- 将 catalog context 设为 `CompileNarrativeRuntimeInput`、story-boundary application、`ReplayEngine` 和 `StateManager` 的必填依赖。`StateManager` 按现有位置参数做一次明确签名切换，不保留 optional catalog fallback；synthetic tests/bench 显式构造最小 catalog。
- 初始 fact 只能激活 declaration catalog 中 `introduction.type === 'initial'` 的实体；只有匹配 declaration/event 的 `system:introduction:*` transition 可以激活 event-introduced entity；普通 authored event 对尚未 activation 的实体执行 live read/write 报错。introduction writes 完成后再检查 required fields，target event 的 participants/preconditions 读取已激活状态。删除两处隐式 auto-create；declaration 始终在 compile 前存在，不把 activation 描述成实体身份的创建。
- source 与 replay 同步执法：unknown entity/type/attribute；`valueSchema.safeParse`；typed reference kind/type；`requiredAt` introduction/activation；`immutable`、`write_once`、`mutable`、`lifecycle_managed`；allowed lifecycle states/transitions；unset allowed/existing；同坐标 lifecycle 冲突。`typedInvariants` 仍为空且不执行。
- `SourceWorkspace.compileOverlay()` 和 reconcile 的 external-working-copy 检查均使用 overlay storage 调内部 canonical kernel + ontology preflight；失败保留 `ConfigError` phase/path/eventId，并映射现有 `INVALID_SOURCE_CHANGE`。
- validator catalog helpers 改为从 `PreRenderInput`/`PostRenderInput` 接收本项目 compiled catalog，不再 import default。
- source-overlay/replay 等价测试通过后删除 `defaultEntityTypeCatalog`、其 lookup helpers、registry import、所有 auto-create fallback 及对应 permissive tests。缺少 `definitions/entity-types.yaml` 是 current-contract `ConfigError`。

### 7. 将所有 repo 内 project entrypoint 委托到同一内核

- `api.ts`：`validateNovel()`、`getProjectStatus()`、`diffEvent()`、`listEntities()`、`showEntity()`、`analyzeProjectImpact()` 全部使用内部 IR/runtime；删除各函数重复的 initialFacts、threads、discourse 和 graph reconstruction。公开 `initializeProject()` 仅保留当前形状的薄封装，不承担旧调用方兼容。
- `editorial/render-service.ts`：`loadProjectData()` 改为接收内部 IR，只补 editorial 独有的 source contents、accepted revisions、catalog metadata；`buildBoundariesAndJobs()` 接收 compiled runtime，删除 registry flatten、genesis lookup、`initialThreads: []`、game-tree rescope 和直接 `compileNarrativeRuntime()`。preview 复用同一 helper；tree render 一次 load IR、每个 leaf 只 compile route。
- assembler/release assembly：使用 `authoredEvents`、compiled game tree 和 runtime discourse sequence；不再直接 mapper/graph compile。
- CLI：保留导入现有公开 `initializeProject()`，用其 authored `events`/`runtime` 完成 game-leaf 检查、event list、evidence hash、commit preflight 和 graph export；删除 CLI 中的 `EntityMapper`/`compileStoryRuntimeGraph` 项目路径。
- bench `reference.ts`、`regression.ts`、`variants.ts` 使用 `initializeProject()` 返回的 canonical events/registry/runtime boundaries；删掉 genesis 合并、手写 incremental replay 和独立 project graph compilation。`performance.ts` 的纯 synthetic benchmark 继续调用 lower-level graph/replay，但必须提供显式 synthetic catalog；它不是 project entrypoint。
- SourceWorkspace、MCP 和 assembly 的 repo 内 direct project mapper call 同步移除。最终搜索 project-level `loadProject`/`loadAllEvents`/`compileNarrativeRuntime`/`compileStoryRuntimeGraph`：生产路径只允许出现在 `entity/project-runtime.ts` 和 lower-level state modules；测试/benchmark 只保留明确 synthetic case。
- 不从 root 增加新 compiler export，不删除 `initializeProject`，不修改 public manifest 的该条目；新增内部类型不可出现在生成的 package public declarations 中。

## Critical files & anchors

- `packages/core/src/entity/project-runtime.ts` — 唯一 storage-backed YAML → internal NovelIR → runtime 内核，package-private。
- `packages/core/src/entity/mapper.ts::loadAllEvents()` — one-load 修复、无 genesis、introduction transition 编译。
- `packages/core/src/api.ts::initializeProject()` — 保留的公开薄封装；不得再拥有独立 cache/compile 逻辑。
- `packages/core/src/state/narrative-runtime.ts::compileNarrativeRuntime()` — 保持纯 graphs → boundaries → discourse 顺序，只新增 catalog input。
- `packages/core/src/types/analysis.ts::{AnalysisResult,AnalysisObservation}` — Pass 2 measurement 的唯一 companion record；不得依赖 knowledge types。
- `packages/core/src/types/knowledge.ts::{Claim,ClaimAssessment,ClaimEvidenceRecord}` — story-world knowledge 边界；本计划对其类型、schema、replay、ledger 和 index 零改动。
- `packages/core/src/types/discourse.ts::{NarratorAssertionStatus,ValidationKey}` — authored narrator status 与 Pass 2 protocol；两个概念只同文件共存，不共享 status type。
- `packages/core/src/validator/aggregator.ts::getAnalysisContract()` — observation/payload 配对、uncertainty preflight 和 field attribution 的唯一汇合点。
- `packages/core/src/state/event-application.ts::{applyNarrativeEvent,applyInitialFacts}` — ontology/write policy 执法与 auto-create 删除点。

## Verification

### Focused proofs

1. **current source contract + calibration**
   ```bash
   npx vitest run packages/core/tests/entity/catalog-calibration.test.ts packages/core/tests/entity/yaml-loader.test.ts packages/core/tests/zhu-fu-fixture.test.ts packages/core/tests/impact-analysis.test.ts
   ```
   证明所有 authored fixture 直接满足当前 project/event schema、没有 `schemaVersion`/`formatVersion`、beats 非空有序且候选已人工确认、legacy schema error 为零、所有 observed attribute/value shape 被 authored catalog 覆盖、每个 write policy 均是显式值而非扫描推导，sceneBrief/beats 任一变化均产生 yellow impact。

2. **canonical kernel parity**
   ```bash
   npx vitest run packages/core/tests/entity/project-runtime.test.ts packages/core/tests/canonical-project-paths.test.ts packages/core/tests/api-storage-isolation.test.ts packages/core/tests/graph-render-assembly-order.test.ts packages/core/tests/discourse-branch-render.test.ts
   ```
   用 counting `MemoryStorage` 证明一次初始化仅一次 `loadProject()`；无 `system:genesis`；initial facts/threads、activation/choice transitions、branch/discourse graph 与 boundaries 在 API/editorial/CLI projection/bench/SourceWorkspace 一致；event-activated entity 的 declaration 始终存在、activation 前不可 live read/write、target `stateBefore` 已含 activation state并可被 target precondition 读取；重复 compile 无共享可变对象。

3. **Pass 2 observation + validation isolation**

   新增且只新增一个 Pass 2 contract 测试文件 `packages/core/tests/pipeline/analysis-observation.test.ts`；其余均复用现有测试：
   ```bash
   npx vitest run packages/core/tests/state/discourse-replay.test.ts packages/core/tests/validator/analysis-parse.test.ts packages/core/tests/pipeline/dynamic-schema.test.ts packages/core/tests/pipeline/analysis-observation.test.ts packages/core/tests/validator/deferred-resolver.test.ts packages/core/tests/interaction-gate.test.ts
   ```
   同 prose/protocol 下覆盖三种 disposition：`produced` 必有 schema-valid payload 与可回指 exact quote；`abstained` 无 payload且有 reason；`ambiguous` 无 canonical payload且保留至少两个带 evidence 的 alternatives。后两者首次解析成功、各生成 `analysis_uncertainty` finding，默认 release pending waiver；exact waiver 可 accepted 且 observation 不变。field/payload pairing、prompt/provider/sampling/policy/protocol 或 evidence quote 任一不匹配走现有四次 feedback 后 blocked。

   同一测试对 Pass 2 前后 WorldState、DiscourseState、EpistemicLedger、PropositionCatalog 和 reference index 做 byte-equivalence；断言不存在 `model:<model>` knowledge subject、analysis proposition 或 `ClaimKind`。NarratorAssertion schema 与 AnalysisObservation schema 交叉解析必须失败，`unknown|contested` 只影响 disclosure，`abstained|ambiguous` 只影响 validation/release。

4. **ontology source/replay equivalence**
   ```bash
   npx vitest run packages/core/tests/entity/entity-type-catalog.test.ts packages/core/tests/entity/registry-catalog-load.test.ts packages/core/tests/state/entity-lifecycle.test.ts packages/core/tests/validator/catalog-driven-checks.test.ts packages/core/tests/editorial/source-workspace.test.ts
   ```
   同一个 invalid write 在 SourceWorkspace 与 ReplayEngine 返回同一规则消息并保留不同 phase；覆盖 unknown、domain、immutable、write_once、unset、requiredAt、typed reference、activation timing、lifecycle 和 missing catalog；每个 policy 有至少一个会失败的负例，任何路径都不能观察到 implicit entity creation/activation。

5. **measurement calibration（bench-only，不增加 core runtime 抽象）**
   ```bash
   npx vitest run packages/bench/tests/consistency.test.ts packages/bench/tests/reference.test.ts
   ```
   在 bench reference data 中保存少量双人独立标注与 adjudication，复用 `packages/bench/src/annotation-stats.ts`/`consistency.ts` 报告 per-field agreement、precision/recall、abstention rate、重复调用稳定性以及顺序/长度扰动敏感度。报告和阈值属于 bench evidence artifact，不进入 `AnalysisObservation`、validator API 或 release gate 类型。

   `quality` 若由生成模型自评，必须标记为 self-assessment heuristic；在 blind judge 或 human reference 校准通过前只能产生 info/warning，不能单独升级为 blocking error。schema、protocol、cache 测试通过只证明 measurement 可追溯，不得写成文学判断有效性已经得到证明。

### End-to-end gates

1. 构建后运行真实 CLI/editorial offline smoke：
   ```bash
   npm run build
   npx vitest run packages/cli/tests/render-full-chain.test.ts packages/cli/tests/editorial-flow.test.ts packages/cli/tests/render-tree.test.ts packages/cli/tests/bundle-boundary.test.ts
   ```
   当前形状的 `zhu-fu` 和 game-tree fixture 必须经内部 canonical kernel 生成 observation-bearing analysis，并保持 branch/discourse 顺序与 release disposition；manifest/report 只保存 observation 一份，finding 只保存 field/pointer reference。

2. 运行 project-based bench callers：
   ```bash
   npm run bench
   ```
   reference/regression/variants 必须使用 canonical runtime；synthetic performance 保持 lower-level 且显式 catalog；measurement calibration 只产出 bench evidence，不反向写入 core state。

3. 完整离线与静态门：
   ```bash
   npx vitest run --exclude '**/e2e.test.ts'
   npm run typecheck
   npm run lint
   npm run bundle-check
   npm run typecheck:dead-code
   npm run dead-code:knip
   ```
   全部 exit 0；public manifest 仍含当前 `initializeProject` 且无新 public compiler；对 production source 与 persisted fixtures 的 dead-code/search 不得发现 project/event `schemaVersion`/`formatVersion`、project migration registry/exports、genesis、project-path duplicate compiler、default catalog、implicit auto-create、旧 `truthBoundary`、Pass 2 `ClaimKind`/`EpistemicStatus`、claim map、`model:*` knowledge subject 或 protocol-less Pass 2 fixture。内部 cache/capability identity 字段不属于 author/API version contract；文档中的禁止性示例不计入该 source search。

## Assumptions & contingencies

- knowledge-domain `Claim`/ledger/catalog/replay/index 保持原形；Pass 2 没有 claim、proposition、epistemic subject 或 story timestamp。
- authored narrator 只使用独立的 `NarratorAssertionStatus = asserted|unknown|contested`；generated Pass 2 只使用 `AnalysisObservation.disposition = produced|abstained|ambiguous`。两个 persisted schema 不共享 alias、转换 helper 或 fallback。
- **复杂度护栏（不是新增需求，也不删除任何现有同名模块）：** Observation 只是 `AnalysisResult` 的伴随数据。本次新增面固定为一个 `AnalysisObservation` union、`AnalysisResult.observations` 一个 map、`ValidationIssue.observationRef` 一个可选引用，以及 aggregator 一个 preflight/helper；其余全部复用现有解析、持久化、report、protocol 和 cache 路径。
  - 不建 observation repository：不为它增加独立存储、CRUD 或查询服务，随 `AnalysisResult` 使用现有持久化路径保存。
  - 不建 observation ledger 或 event replay：不记录第二套状态历史，不按故事时间重放，也不进入 WorldState、DiscourseState、EpistemicLedger 或 EventStore。
  - 不建 observation facade 或新 base class：不增加包装服务或 validator 继承体系，现有 aggregator 直接读取 map，validator 只保存 field/pointer 引用。
  - 不建第二套 protocol/cache：只扩展现有 `ValidationKey`，继续使用现有 Pass 2/render cache 与失效路径。
- author-facing YAML、event file 和 Pass 2 result 直接破坏切换到当前 shape，不携带版本 header，不做版本协商、自动 migration、alias、fallback 或双读；一次性仓库改写脚本交付前删除。在正式版本政策制定前，旧 source/result/API shape 一律不受兼容保证。现有 cache/capability/runtime identity 中仅用于内部安全校验的数字不构成产品 version 承诺。
- `sceneBrief` 有意保留为 goal；beats 候选可以机械生成，但只有 fixture owner 确认后才成为 authored 有序动作/转折，不增加 runtime provenance 字段。
- `introduces` 只表示 live runtime activation；definition declaration 和 discourse first mention 与它分离。迁移器不根据引用位置自动移动 activation boundary。
- `initializeProject` 保留为公开薄封装并委托 package-private canonical kernel；不新增公开 project compiler。
- source/runtime catalog 双层仅解决 YAML 与 live Zod 的必要边界；不扩展为通用 schema language。fixture 扫描只推导 value shape 和 policy evidence，不推导规范性 write policy。
- `abstained|ambiguous` 默认产生 `analysis_uncertainty` warning + pending waiver，但现有 validator policy 可显式调整 severity；waiver 只改变 release，不改变 observation。
- Pass 2 的经验有效性由 bench calibration evidence 管理，不向 core 增加校准状态或运行时抽象；没有 calibration evidence 时，interpretive/quality measurement 不得宣称为客观 verified fact。
- approved references、accepted heads、capability evidence 等程序性“verified”术语不在本次改名范围。
