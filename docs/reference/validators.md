# 验证器

**源文件：** `packages/core/src/validator/*.ts`（20 个验证器文件）  
**聚合器：** `packages/core/src/validator/aggregator.ts` (ResultAggregator)  
**基础辅助函数：** `packages/core/src/validator/base.ts` (buildContext、makeIssue)  
**类型：** `packages/core/src/types/validator.ts` (Validator、PreRenderInput、PostRenderInput、AnalysisBlockRequirement、ValidationResult)

Novalistically 运行 20 个验证器，在两个层面检查叙事完整性：**L1（渲染前）**检查事件定义和世界状态一致性，**L2（渲染后）**检查 LLM 生成的散文是否符合规范以及 Pass 2 结构化分析。所有验证器都符合 `Validator` 接口。

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
| **CausalityValidator** | `causality` | 通过 `compareFact()` 检查前提条件在当前世界状态中是否满足；后置条件与状态转换是否一致 |
| **ReachabilityValidator** | `reachability` | 线程完成度追踪、伏笔回收截止日期、前提条件死锁检测（前提条件从未被建立）、散文中已死角色的行为检查 |
| **BranchMergeValidator** | `branch_merge` | 分支合并点前提条件一致性——检查进入的分支路径是否无状态冲突地汇合 |

### 时间与节奏

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **TimelineValidator** | `timeline` | 绝对时间矛盾（storyTime 顺序 vs sceneType）、DAG 因果边优先级、闪回 narrationTime 要求、通过 Pass 2 `narrativeChecks` 检查一天中时间的一致性 |
| **PacingValidator** | `pacing` | 弧段位置推进的连贯性（高潮在 60-85% 处、早期事件为 "opening"）、弧段回归检测、通过 Pass 2 `narrativeChecks` 获取的叙事节奏信号 |

### 角色

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **CharacterStateValidator** | `character_state` | 生死状态一致性——已死角色不能参与，前提条件必须匹配当前状态 |
| **VoiceDriftDetector** | `voice_drift` | 通过 Pass 2 `narrativeChecks` 匹配 `voice_*` 属性来检查角色声音一致性——标记缺失或矛盾的声音信号 |
| **AppearanceValidator** | `appearance` | 消费 Pass 2 `appearanceChecks`——缺失的外貌细节为警告，矛盾的外貌细节为错误 |
| **AliasValidator** | `alias` | 消费 Pass 2 `characterReferences`——散文中使用的所有名称必须匹配 `CharacterDefinition.aliases[]` 中的已知别名 |
| **PronounValidator** | `pronoun` | 性别代词一致性——基于正则表达式的代词计数（英文 + 中文），范围限于叙事散文中排除对话的部分；也消费 Pass 2 `narrativeChecks` 以获取代词信号 |

### 世界

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **WorldRuleValidator** | `world_rule` | 消费 Pass 2 `ruleChecks`——根据 LLM 自身的分析标记世界规则违反情况，按严重性错误/警告路由 |
| **KnowledgeValidator** | `knowledge` | 知识边界执行——POV 角色不应知道来自未来事件的事实，Pass 2 `knowledgeChecks` 泄露检测 |

### 叙事

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **POVValidator** | `pov` | POV 角色在注册表中的存在性、场景参与要求、散文中第一人称代词的存在、Pass 2 `pov` 块的泄露检测和一致性 |
| **TenseConsistencyValidator** | `tense_consistency` | Pass 2 `tenseDetected` 与场景级别时态覆盖的匹配、通过静态注册表的跨场景时态变化追踪 |
| **DiscourseBalanceValidator** | `discourse_balance` | `discourseMode` 值在场景间的分布（单一模式不超过 80%）、Pass 2 `narrativeChecks` 中的话语平衡信号 |
| **ConflictValidator** | `conflict` | 消费 Pass 2 `conflictAnalysis`——声明了解决类型但未实现为错误、冲突类型不匹配为信息、未预期的解决方式为信息 |
| **ForeshadowingValidator** | `foreshadowing` | 伏笔揭示截止日期——检查 `targetRevealChapter` 是否已过但无对应的揭示事件 |

### 输出质量

| 验证器 | 名称 | 检查内容 |
|---|---|---|
| **FactualDetailValidator** | `factual_detail` | 占位符值拒绝（如 `"changed"`、`"resolved"`、`"updated"` 等值）、来自 Pass 2 `inventedDetails` 的重大发明细节标记、特质级别前提条件确认 |
| **QualityValidator** | `quality` | 消费 Pass 2 `quality` 块——标记低散文分数并列出弱点列表 |
| **ThreadProgressValidator** | `thread_progress` | Pass 2 `threadProgressAchieved` 与声明的 `threadProgress` 的对比——当声明的线程未在散文中实现时发出警告 |

## L1 与 L2：validatePre 与 validatePost

从旧的单一 `validate()` 方法迁移到 `validatePre`/`validatePost`，使得验证器可以同时参与渲染前和渲染后的检查。`ResultAggregator` 使用：

- **`validate()`** — 在所有验证器上运行 `validatePre()`（新路径），如果未实现则回退到旧的 `validate()`
- **`validateRender()`** — 在所有验证器上运行 `validatePost()`（新路径），如果未实现则回退到旧的 `validateRender()`

这种分离使得像 `PacingValidator` 这样的验证器可以在渲染前检查弧段推进，并在渲染后消费叙事节奏信号。

## ResultAggregator 中的属性冲突检测

`getAnalysisRequirements()` 按字段合并所有验证器的 `AnalysisBlockRequirement` 对象。如果两个验证器在同一字段上声明了相同的属性（例如 `TimelineValidator` 和 `PacingValidator` 都在 `narrativeChecks` 上声明了 `time_period`），则在运行时抛出错误——每个分析属性在每个字段上必须是唯一的，以防止产生歧义的 LLM 指令。
