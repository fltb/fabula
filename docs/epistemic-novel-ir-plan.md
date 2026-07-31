# Epistemic NovelIR 最小变更实施计划

## Context

目标是一次 fixture-first 的破坏式切换：项目源码先编译为唯一的内部 NovelIR，再进入图、状态边界、discourse 与渲染；确定性状态只保存作者声明和纯确定性推导；Pass 2 文学判断保存为带协议、证据和不确定性的 claim；验证结果明确区分编译器不变量、证据不匹配和解释性评估；实体 ontology 只在真实 fixture 校准并显式编目后启用。

### Research basis（依据，不直接决定代码形状）

- Genette 的 story/discourse 区分支持继续让 story graph、discourse graph 和渲染顺序保持独立，不把叙述判断写回 story state。
- NarrativeTime 一类标注工作支持把时间/话语现象保存为带来源的 annotation，而不是未标来源的客观事实。
- Mikhalkova 等叙事标注研究以及 Piper/So/Bamman 的计算文学研究共同说明：文学判断存在解释分歧，模型输出应保留证据、策略和不确定性，不能因 JSON 通过 schema 就称为“已验证事实”。

### Repository-grounded decisions（工程选择）

- 保留现有公开 `initializeProject()`；不新增公开 `ProjectNovelIR`/`compileProjectNovelIR()` API。新增的规范编译内核只在 core 内部模块间导入，`initializeProject()` 作为兼容薄封装委托给它。这是用户确认的最小变更方案。
- 保留 `sceneBrief` 作为简短场景目标，不做无收益的 `sceneGoal` 重命名；新增有序 `beats`，使它不再独自承载全部场景语义。
- 保留现有动态 `analysis` payload；新增平行的 claim map，不给每个 block 再包一层 `AnalysisObservation<T>`。
- 复用现有 `Claim`、`ClaimAssessment`、`ClaimEvidenceRecord`、`ValidationKey`、`EvidenceClass`、`EntityTypeCatalog` 和 release gate；只有 YAML/Zod 跨边界必须新增 source catalog 类型。
- event-local `introduces` 编译为同 story coordinate、位于 authored event 之前的 non-renderable introduction transition；复用现有 game-choice synthetic event pattern，避免给 replay 增加第二套“pre-event 写入”机制。

## Approach

### 1. 先冻结并迁移 v2 authored contract

- 将 `schemas/project.ts::schemaVersion` 和 `schemas/event.ts::formatVersion` 改为必填 literal `2`，同步 `ProjectConfig`/`EventFile` 类型。旧版、缺失版本和混合版本直接 `ConfigError`；没有 runtime 兼容读取器。
- 在 `EventFile`、`NarrativeEvent` 和 `SceneSpecification` 增加必填非空 tuple：
  ```ts
  beats: [string, ...string[]];
  ```
  `sceneBrief` 保留并明确为“一句话场景目标”；`beats` 只表达按顺序发生的动作/转折。POV、时序、冲突、解决、checklist、style、thread、foreshadowing、relationship/rule effects 和 facts 继续使用现有字段，不复制到新结构。
- 用一次性迁移脚本更新所有 `fixtures/**/nova.yaml`、authored event YAML、测试内存项目、CLI `project init` 模板、bench adapter 输出和 synthetic event 构造器。脚本仅按原 brief 的句界拆分 `beats`，保持原文和顺序，不做改写；同时按 Step 3 的唯一规则归并/移动 `introduces`。空 brief、无法唯一归属的 introduction 或冲突 initial state 都是迁移错误，不设置 fallback。
- 先单独修复校准扫描发现的 schema-invalid legacy fixture（包括 `most-dangerous-game` 的旧 style/relationship/narrative 字段），再进入后续步骤；不要让 loader 静默丢字段。
- `EntityMapper.mapToNarrativeEvent()` 原样传递 `sceneBrief`/`beats`。`ContextAssembler._buildSceneSpec()`、Pass 1 prompt 和 `buildAnalysisPrompt()` 输出目标后紧跟编号 beats。`analyzeProjectImpact()` 将任一字段变化保持为当前 scene-semantic 的 yellow impact。
- 使用 `zhu-fu/chapters/chapter_01/E0_encounter.yaml` 作为丰富 golden；断言 prompt 同时含 goal 和有序 beats。迁移后对 source/test/fixture/CLI/bench 搜索，所有 authored event 都有 v2 和 beats，`sceneBrief` 仍只出现在目标字段及其合法消费者中。

#### 预期的 `nova.yaml`

```yaml
project: zhu-fu
schemaVersion: 2
title: "祝福"
author: "鲁迅"
defaultModel: mock
defaultLanguage: zh
genre: literary
tense: past
snapshotInterval: 3
defaultSceneTextTarget: 1200
```

其余现有 project 配置（`synopsis`、`ideaIR`、validator overrides、style/render 配置等）原形保留；唯一 breaking header 是必填 `schemaVersion: 2`。`definitions/state_initial.yaml` 的 `timeAnchors`、`threads`、`worldFacts` 形状不变。

#### 预期的 authored event YAML

```yaml
event: E2
formatVersion: 2
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

# 该实体在本事件之前的 internal introduction transition 中进入 state
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

没有 event introduction 的 baseline entity 继续在 definition 中写 `initialState`；允许显式 `{}`。规范编译器执行唯一 exclusivity 规则：存在 event introduction 时 definition `initialState` 必须省略；没有 event introduction 时 definition `initialState` 缺失按空 baseline state 处理。两处同时写在 v2 中是错误，不做覆盖优先级。

### 2. 以 fixture 校准 authored entity catalog，但暂不执法

- 在测试侧增加只读校准 helper 和 `packages/core/tests/entity/catalog-calibration.test.ts`；扫描范围固定为 `nova.yaml`、`definitions/**/*.yaml`、`chapters/**/E*.yaml`，排除 `scenes/`、`.nova/`、`reference/data/` 和 render-request 产物。
- 校准结果按 entity kind/type 列出：baseline/introduces/pre/postcondition 中的 attribute、值形状、set/unset 次数、首次写入位置、重复 introduction、未声明引用和 source path。测试失败信息生成确定性 catalog proposal；不把 proposal 生成器放进生产包，也不提交另一份手工 snapshot。
- 在 `types/entity-catalog.ts` 增加最小 serializable source 形状，除 `valueSchema` 外与现有 runtime catalog 一一对应：
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
  ```
  `EntityTypeDefinitionSource`/`EntityTypeCatalogSource` 只把 attributes 换为 source 版本；不增加递归 DSL、union、nullable 或 `any` 逃生口。
- 在每个 fixture/project 新增 `definitions/entity-types.yaml`。`EntityMapper.loadProject()` 必须解析它并保存为 `ProjectData.entityTypeCatalogSource`；缓存中只保存该 serializable source，绝不保存 live Zod object。
- `compileEntityTypeCatalog(source)` 每次编译 fresh runtime catalog：五个 literal 分别映射到 `z.string()`、finite `z.number()`、`z.boolean()`、`z.array(z.string())`、`z.record(z.string(), z.string())`。`typedInvariants` 在这一版本必须为空，因为当前 description 不是可执行规则。
- proposal 的 policy 规则固定，避免人为漂移：已存在于 `defaultEntityTypeCatalog` 的 attribute 逐项复制其 `requiredAt`、`writePolicy`、`unsetAllowed`、lifecycle states、semantic role 和 typed reference；只有新发现的 attribute 才按扫描推导——`lifecycle` 为 `lifecycle_managed`；baseline 已存在且无后续写入为 `immutable`，只要有后续写入即为 `mutable`；首次在 introduction/普通 event 出现且总共只 set 一次为 `write_once`；多次 set 或出现 unset 为 `mutable`；`unsetAllowed` 仅在 authored unset 存在时为 true；`requiredAt: introduction` 仅在同 type 每次 introduction 都提供时启用，否则 `never`。
- 这一阶段只要求 catalog 覆盖扫描到的值和 policy proposal；`defaultEntityTypeCatalog` 仍供现有 validator 使用，ReplayEngine 仍不因新 catalog 改变行为。该隔离是 Step 6 启用执法的硬 gate。`definitions/entity-types.yaml` 的预期形状如下；每个实际使用的 type/attribute 都按同一结构显式列出：

  ```yaml
  version: 1
  types:
    character:
      typeRef:
        typeId: character
        schemaVersion: 1
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
      typeRef:
        typeId: location
        schemaVersion: 1
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

  catalog `version` 独立于 project `schemaVersion`；本次固定为 `1`。attribute key 必须与 authored fact 中的 attribute 完全一致，不能使用 wildcard。

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
- 删除 `EntityMapper.createGenesisEvent()` 和 `system:genesis`。`initialFacts` 只从没有 event introduction 的 definition/registry state 与 `state_initial.yaml` 概念实体生成，并为这些 baseline entities 添加纯推导的 `lifecycle=active`；同一 `entity.attribute` 重复且值相同去重，值冲突时报 `ConfigError`。不再同时生成 `world.<factId>` 和 `<factId>.value` 两套表示。
- `EntityDeclaration` 增加必填 `introduction: { type: 'initial' } | { type: 'event'; eventId: string }`。迁移时，一个实体若没有 authored `introduces`，保持 initial declaration；若有 introduction，则必须唯一，并移动到 story graph 中最早引用该实体的 authored event。把 definition 的旧 `initialState` 与该 event 的 `introduces.initialState` 合并到后者：相同 key/value 去重，不同值报迁移错误；随后从 definition 删除 `initialState`。target event 中引用这些值的 preconditions 保留并必须与 merged initial state 一致。
- 对每个 event introduction 生成 `system:introduction:<targetEventId>:<entityId>`：story coordinate/branch scope 与 target 相同，postconditions 为 `lifecycle=active` 加 merged initial state，并添加到 target 的 author-origin predecessor；复用 game-choice transition 的 internal event 构造/过滤方式。它参加 story graph、boundary 和 replay，但不参加 discourse order、scene catalog、Pass 1/2、validator denominator 或 assembly。target `stateBefore` 已包含 introduction state，target 的 authored postconditions 可以再修改同一 attribute。
- 复用现有 game-dialogue compiler 生成 scope 与 transition events：`authoredEvents` 只含可渲染 event-file events，`runtimeEvents` 为 authored + choice transitions。`compileCanonicalRuntime()` 统一解析 branch/discourse route，再且仅调用一次 `compileNarrativeRuntime()`。
- 保留公开 `initializeProject()`，实现改为薄封装：调用内部 load/compile kernel，保持现有 `mapper/data/events/registry/stateManager/state` 字段，并新增已编译的 `runtime`；第三参数为内联的可选 branch/discourse options。返回的 `events` 明确为 authored events；兼容 `StateManager` 用 catalog context 和 `runtimeEvents` 初始化。repo 内不再借返回的 mapper 重建项目。
- `initializeProject()` 继续是 CLI/bench 的现有公开入口；core 内的 API/editorial/assembler/SourceWorkspace 直接导入 package-private kernel，避免 `api.ts` 循环依赖。不得新增第二个公开 project compiler。
- 增加 one-load spy、Storage cache isolation、fresh mutable objects、无 genesis、introduction 时序、branch/discourse route 和 hash stability 测试。

### 4. 用 companion claim map 扩展 Pass 2，而不重包 domain payload

- 在现有 knowledge 类型上增加：
  ```ts
  type EpistemicStatus = 'asserted' | 'derived' | 'inferred' | 'unknown' | 'contested';
  type ClaimKind = 'verification' | 'assessment' | 'quality';

  interface Claim {
    subject: EntityId;
    propositionId: PropositionId;
    status: EpistemicStatus;
    claimKind: ClaimKind;
    assessment: ClaimAssessment;
    evidence: ClaimEvidenceRecord[];
    policyId?: string;
  }
  ```
  `ClaimAssessment` 保持独立轴；不从它反推 status。`ClaimEvidenceRecord` 新增必填 `evidenceClass: EvidenceClass`，`EvidenceClass` 增加 `validation_measurement`。knowledge replay 从 authored information act 计算出的 claim 一律为 `derived`；只有源码直接声明的 claim 为 `asserted`。它们分别使用 `state_replay`/`discourse_replay`；不改 `InformationAct`，因为 act 不是新的 claim carrier。
- `applyClaimTransaction()` 改为接收完整 `Claim`，继续复用 `claimKey()` 和现有 ledger indexes；一次性迁移现有 claim literals/schema/tests，不保留旧 overload。
- 将 `NarratorAssertion.truthBoundary` 替换为 authored-only `status: 'asserted' | 'unknown' | 'contested'`。只有 `asserted` 的 `authoritative_reveal` 可执行 reveal；`unknown`/`contested` 只能走 claim/conjecture/implication。NarratorAssertion 保持独立的 discourse source record，不投影进 `EpistemicLedger` 或 Pass 2 `claims`，因此现有 assertion evidence/confidence 不需要伪装成 `ClaimEvidenceRecord`。
- 将 integration `BoundaryReference.truthValues: Record<string, boolean>` 改为 `evaluations: Record<string, EvaluationResult>`；`true|false|indeterminate` 是确定性计算结果，不映射成 epistemic status。

  narrator assertion YAML 只改一个字段：删除 `truthBoundary`，新增 `status`。确定性 reveal：

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

  不确定判断使用 `unknown` 或 `contested`，且不能标成 `authoritative_reveal`：

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

  Pass 2 的 protocol/claims/analysis 是生成的 JSON，不写入 authored YAML。
- `AnalysisBlockRequirement` 新增必填 `claimKind`。同一 top-level field 的多个 requirement 必须 kind 一致，否则 aggregator 在编译 contract 时 `ConfigError`。映射固定为：`postconditions`、`preconditions`、`pov`、`inventedDetails`、`threadProgressAchieved`、`foreshadowingDeployed`、`appearanceChecks`、`characterReferences`、`knowledgeChecks`、`ruleChecks`、`checklistResults` 为 `verification`；`narrativeChecks`、`tenseDetected`、`conflictAnalysis`、`durationDetected`、`frequencyDetected`、`voiceDetected`、`anachronyDetected`、`focalizationDetected` 为 `assessment`；`quality` 为 `quality`。plugin 必须显式声明；新增字段必须在同一映射处登记。
- `AnalysisResult` 升为：
  ```ts
  interface AnalysisResult {
    schemaVersion: 2;
    eventId: string;
    protocol: ValidationKey;
    claims: Record<string, Claim>;   // key = active top-level analysis field
    analysis: Record<string, unknown>; // 保留现有 domain payload 原形
  }
  ```
  不增加 `AnalysisObservation<T>`，不修改每个 block 的内部 schema。
- `ResultAggregator.getAnalysisContract()` 生成一个 top-level response schema：每个 active field 必须恰有一个 claim；`inferred` 要求对应 `analysis[field]` 存在并通过原 schema；`unknown`/`contested` 要求该 payload 缺失。plugin optional block 仅在其 validator 无 post consumer 时保持 optional，但一旦返回 payload 也必须有 claim。
- companion claim key 一律取 requirement path 的第一个 segment；因此 `pov.leaks` 规范化为 key `pov`，proposition 为 `<eventId>.analysis.pov`，validator lookup 也只能用 `pov`。同一 top-level field 的 nested requirements 共享一个 claim。
- 删除 `AnalysisResult.checklistResults` 的旧 top-level 可选字段；`ChecklistValidator` 与其他 validator 一样只读 `analysis.analysis.checklistResults`，不保留双位置。
- Pass 2 claim 只允许 `inferred|unknown|contested`：`inferred` 使用 settled assessment；`unknown` 使用 suspended；`contested` 使用 conflicted 且双方计数均大于零。subject 固定为 `model:<protocol.model>`，proposition 固定为 `<eventId>.analysis.<field>`，`policyId` 必须等于 `protocol.validatorPolicy`；evidence 必须为 `validation_measurement`，provider 为模型，provenance 同时含 event ID 与 prose hash，`acquiredAt` 使用该 event 的 story timestamp。模型不能返回 `asserted`/`derived`。
- 在发起 Pass 2 前构造现有五字段 `ValidationKey`：`proseHash`、analysis contract hash、model、调用方传入的 validator policy identity、scene contract 的 assertion/reference catalog hash（缺失时用 canonical null hash）。给 `RenderPipelineOptions` 增加一个必填 `validatorPolicyId`；editorial 传现有 `plan.planSummary.validationIdentity`，direct tests/CLI 明确传其 contract/policy hash。
- prompt 给出 exact protocol 和 claims template；`parseAnalysisJSON*()` 接收 `expectedProtocol` 并比较全部五字段及上述 claim cross-field invariants。增加 `protocol` rejection category，走现有四次 Zod-feedback 子尝试。`unknown`/`contested` 是一次解析成功的合法 abstention，不触发 retry，也不改 WorldState、DiscourseState 或任何 source catalog。
- cache 继续使用现有 logical/surface/attempt 分层；`buildValidationKeyMaterial()` 由同一个 protocol 构造，不新增平行 cache key。schema-v2 response fixture、mock provider、cache reparse、double-run comparison、revision/debug persistence 全量保存 protocol/claims/analysis；旧 cache 因 schema/policy hash 改变自然 miss，不加 migration reader。

### 5. 将 validation finding 的语义与 release severity 分开

- 给 `ValidationIssue` 及 strict persisted schema 增加必填：
  ```ts
  kind: 'compiler_invariant' | 'evidence_mismatch' | 'interpretive_assessment';
  claim?: Claim;
  ```
  severity 继续是独立的 `error|warning|info`；`ValidationResult.passed` 仍只表示无 error，不表示文学判断为客观真。
- pre-render/deterministic validator 的 issue 标记 `compiler_invariant` 且禁止 claim。hard schema/graph/replay/ontology 错误继续使用现有 typed error channel，并在 provider/cache/prompt 前 fail closed；UI 转换为 diagnostic 时才显示该 kind。
- post-render verification block 的不匹配标记 `evidence_mismatch`；assessment/quality block 的 findings 标记 `interpretive_assessment`。每个 issue 只能附其实际消费的一个 companion claim；不得附 claim 数组或聚合不相关 evidence。
- 在 aggregator 做统一 abstention preflight：某 validator 需要的 field 为 `unknown`/`contested` 时，不让该 validator读取缺失 payload，而是按 field 生成一个带 exact claim 的稳定 `interpretive_assessment` warning。若同一 validator 有多个 abstention，拆成多个 finding。
- 对 inferred payload，单字段 validator 的 issue 由 aggregator 自动附该字段 claim；多字段 validator 必须在现有 issue 构造点用 `getAnalysisClaim(result, field)` 指定触发字段。aggregator 拒绝 claimKind、policy 或 field 不匹配，避免错误归因。
- `resolveDeferredFacts()` 只对 inferred verification claim 执行现有 exact/similar/absent/contradicted 逻辑；unknown/contested 不伪造 match level。
- `evaluateReleaseDecision()` 仍是唯一 release gate：protocol/compile/missing/error 为 blocked；warning（包括合法 abstention）为 pending_waiver；无阻断 finding 为 accepted。把 request 里的现有 waivers 初始化到同一个 `InteractionManager`，并传给 editorial 两个 release-decision callsite；waiver 只改 disposition/waiverId，不改 claim。
- CLI/editorial/API/reporter/manifest 持久化并显示 kind、status、policy、evidence。保留 `VerifiedHeadData`、approved human reference、accepted head 等程序性术语；只禁止用 “verified” 描述 Pass 2 epistemic status。

### 6. 校准测试全绿后再启用 ontology enforcement

- 只有 Step 2 的 fixture catalog coverage/policy 测试全绿后，才把 compiled type/declaration catalogs 接入 runtime。定义一个小型共享 `EntityCatalogContext { entityDeclarationCatalog; entityTypeCatalog }`，不再增加其他 catalog facade。
- 新增纯函数 `validateCatalogWrite(state, fact, phaseContext, catalogs)`；source preflight 和 replay 都调用它，确保只有一套规则。`validateProjectOntology(ir)` 先做全事件的 declaration/value/reference 静态检查，再按现有 game-tree leaf 枚举把每条 reachable branch replay 到临时 scratch state，以同一 applicator 检查时序型 write policy；它不修改 IR、registry 或任何持久状态。
- 将 catalog context 设为 `CompileNarrativeRuntimeInput`、story-boundary application、`ReplayEngine` 和 `StateManager` 的必填依赖。`StateManager` 按现有位置参数做一次明确签名切换，不保留 optional catalog fallback；synthetic tests/bench 显式构造最小 catalog。
- 初始 fact 只能创建 declaration catalog 中 `introduction.type === 'initial'` 的实体；只有匹配 declaration/event 的 `system:introduction:*` transition 可以创建 event-introduced entity；普通 authored event 对不存在实体写入时报错。introduction writes 完成后再检查 required fields，target event 的 participants/preconditions 读取已引入状态。删除两处隐式 auto-create。
- source 与 replay 同步执法：unknown entity/type/attribute；`valueSchema.safeParse`；typed reference kind/type；`requiredAt` introduction/activation；`immutable`、`write_once`、`mutable`、`lifecycle_managed`；allowed lifecycle states/transitions；unset allowed/existing；同坐标 lifecycle 冲突。`typedInvariants` 仍为空且不执行。
- `SourceWorkspace.compileOverlay()` 和 reconcile 的 external-working-copy 检查均使用 overlay storage 调内部 canonical kernel + ontology preflight；失败保留 `ConfigError` phase/path/eventId，并映射现有 `INVALID_SOURCE_CHANGE`。
- validator catalog helpers 改为从 `PreRenderInput`/`PostRenderInput` 接收本项目 compiled catalog，不再 import default。
- source-overlay/replay 等价测试通过后删除 `defaultEntityTypeCatalog`、其 lookup helpers、registry import、所有 auto-create fallback 及对应 permissive tests。缺少 `definitions/entity-types.yaml` 是 v2 config error。

### 7. 将所有 repo 内 project entrypoint 委托到同一内核

- `api.ts`：`validateNovel()`、`getProjectStatus()`、`diffEvent()`、`listEntities()`、`showEntity()`、`analyzeProjectImpact()` 全部使用内部 IR/runtime；删除各函数重复的 initialFacts、threads、discourse 和 graph reconstruction。公开 `initializeProject()` 仅保留薄封装与兼容字段。
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
- `packages/core/src/types/knowledge.ts::{Claim, ClaimAssessment, ClaimEvidenceRecord}` — 五种 status 的唯一 claim 模型。
- `packages/core/src/validator/aggregator.ts::getAnalysisContract()` — companion claim contract、abstention 和 field attribution 的唯一汇合点。
- `packages/core/src/state/event-application.ts::{applyNarrativeEvent,applyInitialFacts}` — ontology/write policy 执法与 auto-create 删除点。

## Verification

### Focused proofs

1. **v2 source + calibration**
   ```bash
   npx vitest run packages/core/tests/entity/catalog-calibration.test.ts packages/core/tests/entity/yaml-loader.test.ts packages/core/tests/zhu-fu-fixture.test.ts packages/core/tests/impact-analysis.test.ts
   ```
   证明所有 authored fixture 为 project/event v2、beats 非空有序、legacy schema error 为零、所有 observed attribute/value shape 被 authored catalog 覆盖，sceneBrief/beats 任一变化均产生 yellow impact。

2. **canonical kernel parity**
   ```bash
   npx vitest run packages/core/tests/entity/project-runtime.test.ts packages/core/tests/canonical-project-paths.test.ts packages/core/tests/api-storage-isolation.test.ts packages/core/tests/graph-render-assembly-order.test.ts packages/core/tests/discourse-branch-render.test.ts
   ```
   用 counting `MemoryStorage` 证明一次初始化仅一次 `loadProject()`；无 `system:genesis`；initial facts/threads、introduction/game transitions、branch/discourse graph 与 boundaries 在 API/editorial/CLI projection/bench/SourceWorkspace 一致；event-introduced entity 不在 baseline，却已出现在 target `stateBefore`，并可被 target precondition 读取；重复 compile 无共享可变对象。

3. **epistemic Pass 2 + validation**
   ```bash
   npx vitest run packages/core/tests/state/epistemic-ledger.test.ts packages/core/tests/validator/analysis-parse.test.ts packages/core/tests/pipeline/dynamic-schema.test.ts packages/core/tests/pipeline/epistemic-pass2.test.ts packages/core/tests/validator/deferred-resolver.test.ts packages/core/tests/interaction-gate.test.ts
   ```
   同 prose/policy 下覆盖 inferred、unknown、contested：inferred payload+claim 正常验证；unknown/contested 首次解析成功、无 payload、各生成一个 interpretive warning、state byte-equivalent、release pending waiver；exact waiver 可 accepted 且 claim 不变。伪造 asserted status、field/policy/protocol/provenance 任一不匹配走四次 protocol feedback 后 blocked。

4. **ontology source/replay equivalence**
   ```bash
   npx vitest run packages/core/tests/entity/entity-type-catalog.test.ts packages/core/tests/entity/registry-catalog-load.test.ts packages/core/tests/state/entity-lifecycle.test.ts packages/core/tests/validator/catalog-driven-checks.test.ts packages/core/tests/editorial/source-workspace.test.ts
   ```
   同一个 invalid write 在 SourceWorkspace 与 ReplayEngine 返回同一规则消息并保留不同 phase；覆盖 unknown、domain、immutable、write_once、unset、requiredAt、typed reference、introduction timing、lifecycle 和 missing catalog；任何路径都不能观察到 implicit entity creation。

### End-to-end gates

1. 构建后运行真实 CLI/editorial offline smoke：
   ```bash
   npm run build
   npx vitest run packages/cli/tests/render-full-chain.test.ts packages/cli/tests/editorial-flow.test.ts packages/cli/tests/render-tree.test.ts packages/cli/tests/bundle-boundary.test.ts
   ```
   v2 `zhu-fu` 和 game-tree fixture 必须经内部 canonical kernel 生成 schema-v2 claim-bearing analysis，并保持 branch/discourse 顺序与 release disposition。

2. 运行 project-based bench callers：
   ```bash
   npm run bench
   ```
   reference/regression/variants 必须使用 canonical runtime；synthetic performance 保持 lower-level 且显式 catalog。

3. 完整离线与静态门：
   ```bash
   npx vitest run --exclude '**/e2e.test.ts'
   npm run typecheck
   npm run lint
   npm run bundle-check
   npm run typecheck:dead-code
   npm run dead-code:knip
   ```
   全部 exit 0；public manifest 仍含 `initializeProject` 且无新 public compiler；dead-code/search 不得发现 genesis、project-path duplicate compiler、default catalog、implicit auto-create、旧 truthBoundary 或 protocol-less Pass 2 fixture。

## Assumptions & contingencies

- 持久 epistemic status 固定为 `asserted|derived|inferred|unknown|contested`；`verified` 不是 Pass 2 status。
- YAML v2 是破坏式切换；只保留实施期一次性迁移脚本，交付物没有 alias、fallback 或双读。
- `sceneBrief` 有意保留为 goal；新增 beats 是满足结构化场景语义的最小等价实现，不做字段重命名。
- `initializeProject` 保留为公开薄封装并委托 package-private canonical kernel；不新增公开 project compiler。
- source/runtime catalog 双层仅解决 YAML 与 live Zod 的必要边界；不扩展为通用 schema language。
- unknown/contested 默认 warning + pending waiver；waiver 只改变 release，不改变 epistemic record。
- approved references、accepted heads、capability evidence 等程序性“verified”术语不在本次改名范围。
