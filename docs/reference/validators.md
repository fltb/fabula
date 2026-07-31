# 验证器

**源文件：** `packages/core/src/validator/*.ts`（28 个默认验证器文件）
**聚合器：** `packages/core/src/validator/aggregator.ts` (ResultAggregator)
**基础辅助函数：** `packages/core/src/validator/base.ts` (buildContext、makeIssue)
**类型：** `packages/core/src/types/validator.ts` (Validator、PreRenderInput、PostRenderInput、AnalysisBlockRequirement、ValidationResult)

Novalistically 默认运行 28 个验证器（`ResultAggregator` 构造时的内置列表），在两个层面检查叙事完整性：**L1（渲染前）**检查事件定义和世界状态一致性，**L2（渲染后）**检查 LLM 生成的散文是否符合规范以及 Pass 2 结构化分析。所有验证器都符合 `Validator` 接口。

## 验证器架构

每个验证器实现以下一个或多个方法：
- **`validatePre(input: PreRenderInput)`** — 渲染前的 L1 检查：事件定义、状态查询、注册表查找、DAG 因果边。
- **`validatePost(input: PostRenderInput)`** — 渲染后的 L2 检查：散文分析、Pass 2 分析消费、确定性事实比较。
- **`getAnalysisRequirements()`** — 声明此验证器需要哪些 Pass 2 块，驱动动态提示构建。

`ResultAggregator` 按顺序运行验证器，应用严重性覆盖，并将问题收集到 `ValidationResult { passed, errors, warnings, infos }` 中。

## 验证器分类

### 因果与结构

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **CausalityValidator** | `causality` | L1：通过 `compareFact()` 检查前提条件在当前世界状态中是否满足（不满足为错误）；后置条件与前提完全相同（场景无因果效应）为警告——该无效应检查只比较 `entityId.attribute` 键集合与数组长度，不比较值，因此同键改值或两组空列表同样会触发警告。L2：位置类前提在散文中未被提及为警告；Pass 2 `postconditions` 块——被丢弃的后置条件为警告、超过半数被丢弃为错误；Pass 2 `preconditions.violated` 为错误 |
| **ReachabilityValidator** | `reachability` | 线程目标完成度追踪（落后且章节较晚时为警告）、前提条件死锁检测（前提条件从未被任何后置条件建立时为警告）。不消费 Pass 2 |
| **BranchMergeValidator** | `branch_merge` | 合并点前提条件一致性——只检查是否存在任何更早的非 `all` 事件（存在即视为合并点），然后对单个当前 `queryState` 逐条比较事件前提（不满足为警告）；它不识别具体入边，也不按每个分支路径计算状态；L2：分支事件（`paths`）散文应含条件语言（否则警告）、过度绝对化措辞为信息；规范事件（`all`）不应有条件措辞（警告）；同段散文内的位置矛盾为错误；消费 Pass 2 `narrativeChecks` 解析仅含 narrativeHint 的前提（`resolveDeferredFacts`） |

### 时间与节奏

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **TimelineValidator** | `timeline` | 线性场景在相同时钟下坐标回退（同 clock 的 point 坐标）为错误；无效 `sceneType` 枚举为错误；非线性场景缺少 `narrationTime` 为警告；消费 Pass 2 `narrativeChecks` 中 `time_period` 属性（absent/contradicted 为警告） |
| **PacingValidator** | `pacing` | 弧段位置推进的连贯性——高潮事件应位于总事件的 60–85% 处（否则警告）、前两个事件通常应为 `opening`（否则信息）；消费 Pass 2 `narrativeChecks` 中 pacing/pace 属性（absent/contradicted 为警告） |

### 角色

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **CharacterStateValidator** | `character_state` | 生死状态一致性——已死角色出现在场景前提中为错误；L2：世界状态中已死角色在散文中执行动作（说话/行走/思考等，闪回/回忆语境除外）为错误；消费 Pass 2 `narrativeChecks` 中 `character_state`/lifecycle 属性（absent/contradicted 为警告） |
| **VoiceDriftDetector** | `voice_drift` | 通过 Pass 2 `narrativeChecks` 匹配 `voice_*` 属性检查角色声音一致性——矛盾（contradicted）为警告、缺失（absent）为信息 |
| **AppearanceValidator** | `appearance` | L1：事件内所有 appearance 语义后置条件被收集进同一数组并比较全体不同值（出现 >1 个不同值即错误）——不按实体或特征分组，因此同一角色的不同发色/瞳色或分属两个角色的外貌值都可能触发；L2：消费 Pass 2 `appearanceChecks`——缺失的外貌细节为警告，矛盾的外貌细节为错误，引用未知实体为警告 |
| **AliasValidator** | `alias` | 消费 Pass 2 `characterReferences`——散文中使用的名称必须匹配实体 ID、`CharacterDefinition.aliases[]`（来自世界状态或注册表）以及实体 ID 的分段；未知名称为警告 |
| **PronounValidator** | `pronoun` | 性别代词一致性——纯 Pass 2 驱动：消费 `narrativeChecks` 中 `pronoun`/`pronoun_consistency` 属性（contradicted 为错误、absent 为警告）；不做正则代词扫描 |

### 世界

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **WorldRuleValidator** | `world_rule` | L1：nullify 规则效果与当前规则运行状态不一致为错误；写后置条件违反不可变属性（registry 写策略 immutable）为错误；L2：消费 Pass 2 `ruleChecks`——violated 且 severity 为 major 为错误、minor 为警告 |
| **KnowledgeValidator** | `knowledge` | 知识边界执行——重复获取已知命题为信息；POV 角色在事实建立之前（更晚的事件中才建立）就“知道”该事实为错误；Pass 2 `knowledgeChecks` 中 contradicted 为警告 |

### 叙事

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **POVValidator** | `pov` | L1：POV 角色在实体注册表中的存在性（缺失为错误）、第三人称限知/第一人称的参与者要求（警告）、全知视角的信息提示；L2：Pass 2 `pov` 块的泄露（warning）与不一致（warning） |
| **TenseConsistencyValidator** | `tense_consistency` | L1：通过事件列表（validatePre）检测与更早场景的跨场景时态变化（error）；L2：Pass 2 `tenseDetected` 与场景级时态声明不匹配或检测到混合时态为警告 |
| **DiscourseBalanceValidator** | `discourse_balance` | `discourseMode` 值在场景间的分布（单一模式不超过 80%，否则警告；缺少 discourseMode 为信息）；消费 Pass 2 `narrativeChecks` 中的 discourse_balance/discourseMode 信号（信息） |
| **ConflictValidator** | `conflict` | L1：声明 `unresolved` 但存在冲突类型为警告；L2：消费 Pass 2 `conflictAnalysis`——声明了解决类型但未实现为错误、检测到的冲突类型与声明不匹配为信息、分析显示已解决但未声明 resolutionType 为信息 |
| **ForeshadowingValidator** | `foreshadowing` | 伏笔揭示截止日期——`targetRevealChapter` 已过为警告、当前章节超过 `targetRevealChapter + FORESHADOW_THRESHOLD_CHAPTERS`（2）为错误；该判定只看声明中的目标章节与当前章节，没有揭示状态查询，因此即使伏笔已在别处揭示也会被标记；L2：声明伏笔在散文（Pass 2 `foreshadowingDeployed`）中未检测到为警告 |

### 叙事（Genette 维度、话语与清单）

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **DurationConsistencyValidator** | `duration_consistency` | ellipsis 时长缺少 `ellipsisClarity` 为警告；消费 Pass 2 `durationDetected`（S6a，`scene` \| `summary` \| `ellipsis` \| `pause` \| `stretch`）——与声明的 `duration.type` 不一致为警告 |
| **FrequencyConsistencyValidator** | `frequency_consistency` | `repeating`/`iterative` 频率缺少 `iterationScope` 为警告；消费 Pass 2 `frequencyDetected`（S6b，`singulative` \| `repeating` \| `iterative`）——与声明的 `frequency.type` 不一致为警告 |
| **FocalizationConsistencyValidator** | `focalization_consistency` | `internal` + `multiple` 聚焦要求 `characterSequence` 至少 2 项（否则警告）；消费 Pass 2 `focalizationDetected`（S6c，`zero` \| `internal` \| `external`）——与声明的类型不一致为警告 |
| **VoiceConsistencyValidator** | `voice_consistency` | 消费 Pass 2 `voiceDetected`（S6d，level + relation）——与声明的 `voice.level`/`voice.relation` 任一不一致为警告 |
| **AnachronyConsistencyValidator** | `anachrony_consistency` | `analepsis`/`prolepsis` 倒错缺少 `distance` 为警告；消费 Pass 2 `anachronyDetected`（S6e，`analepsis` \| `prolepsis` \| `none`）——与声明的类型不一致为警告 |
| **DiscourseValidator** | `discourse` | `narratorProfileRef` 未解析到已加载的 `NarratorProfile`（PostRenderInput.context 中缺失）为错误。纯确定性，不消费 Pass 2 |
| **ChecklistValidator** | `checklist` | 每个必需的叙事清单条目（`narrativeChecklist.items` 中 required）必须在 Pass 2 `checklistResults` 中有 `covered: true` 的对应项——未评估或未覆盖为警告；无清单的事件跳过。注意：解析后的 Pass 2 数据把该块存在 `analysis.analysis.checklistResults`，而 `validatePost()` 读的是外层包装上的 `analysis.checklistResults`，正常解析路径从不产生该顶层字段——因此当前所有必需条目实际都被视为未评估 |
| **NarrativeTechniqueValidator** | `narrative_technique` | 原始技巧字段存在但解析后的 context 契约为空为接线错误（error）；每个已解析技巧契约要求恰好一个匹配的 `narrativeCheck`（entityId=事件 ID、attribute=技巧 kind）——缺失、重复、absent 或 contradicted 均为错误，exact/similar 通过。同样受嵌套读取缺陷影响：解析后的检查在 `analysis.analysis.narrativeChecks`，而 `validatePost()` 读 `analysis.narrativeChecks`，因此当前该路径看到空数组，每个已解析契约都会被报告为缺失 |

### 输出质量

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **FactualDetailValidator** | `factual_detail` | 消费 Pass 2 `inventedDetails`——重大（major）发明细节（不在规范中的情节/角色变化）为警告 |
| **QualityValidator** | `quality` | 消费 Pass 2 `quality` 块——`proseScore < 4` 时标记低散文质量并列出弱点列表（警告）；`estimatedWordCount < 100` 时提示短场景（信息） |
| **ThreadProgressValidator** | `thread_progress` | L1：`threadProgress` 引用世界状态中不存在的线程为警告；L2：Pass 2 `threadProgressAchieved` 与声明的 `threadProgress` 对比——当声明的线程未在散文中实现时发出警告 |

## L1 与 L2：validatePre 与 validatePost

从旧的单一 `validate()` 方法迁移到 `validatePre`/`validatePost`，使得验证器可以同时参与渲染前和渲染后的检查。`ResultAggregator` 使用：

- **`validate()`** — 在所有验证器上运行 `validatePre()`（新路径），如果未实现则回退到旧的 `validate()`
- **`validateRender()`** — 在所有验证器上运行 `validatePost()`（新路径），如果未实现则回退到旧的 `validateRender()`

这种分离使得像 `PacingValidator` 这样的验证器可以在渲染前检查弧段推进，并在渲染后消费叙事节奏信号。

## ResultAggregator 中的属性/字段冲突检测

`getAnalysisRequirements()` 按字段合并所有验证器的 `AnalysisBlockRequirement` 对象，`getAnalysisContract()` 在此基础上构建确定性契约（合并需求、组合 schema 与 SHA-256 指纹）。冲突检测规则：

- **同一字段上相同属性只能由一个验证器声明**——例如 `TimelineValidator` 声明 `narrativeChecks[time_period]`、`PacingValidator` 声明 `narrativeChecks[pacing/pace]`、`VoiceDriftDetector` 声明 `narrativeChecks[voice_*]`；若两个验证器在同一字段声明同一属性（如都声明 `time_period`），则运行时抛出 `ConfigError`——每个分析属性在每个字段上必须是唯一的，以防止产生歧义的 LLM 指令。
- **同一字段上不兼容的 schema**（不同验证器对同一字段贡献冲突的 Zod schema）同样抛出 `ConfigError`。
