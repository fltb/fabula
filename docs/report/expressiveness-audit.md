# 表达性审计报告 — 建模路径、透传兜底与剩余缺口

> **时间**: 2026-07-26 23:32 CST
> **前置**: `docs/report/ir-completeness-and-fullchain-verification.md`（死类型鉴定）、`docs/report/full-chain-wiring-acceptance.md`（九条缺口闭合 + S6 validator 接线）。历史发现来源 `agent://PromptSurfaceScout`（PromptSurfaceScout 是早期无状态 scout，其输出已全部被后续 wave1/wave2 的实际接线覆盖）。本报告以当前仓库文件（`packages/core/src/types/event.ts`、`packages/core/src/entity/mapper.ts`、`packages/core/src/context/assembler.ts`、`packages/core/src/context/prompt-assembler.ts`、`packages/core/src/pipeline/render.ts`、`packages/core/src/validator/*.ts`、`packages/core/src/api.ts`、`packages/core/src/schemas/project.ts` 等）为唯一事实依据。
> **方法**: 逐字段追踪 EventFile/NarrativeEvent/ProjectConfig 从 YAML → EntityMapper → ContextCompiler → PromptAssembler → Pass 1 prompt / buildAnalysisPrompt → Pass 2 → validators → 最终输出的每条代码路径；对 25 种叙事技巧逐一分类为"建模优先"或"透传兜底"或混合路径。

---

## 一、范围与方法

### 1.1 审计范围

- **EventFile**（`types/event.ts:174-298`）全部 authorable 字段 → `NarrativeEvent` → 各消费端
- **ProjectConfig**（`types/chapter.ts:41-71` + `schemas/project.ts:9-62`）全部 authorable 字段 → 渲染管线消费
- 25 种具体叙事技巧的表达路径
- 九条已修复缺口、一条残留纯粹透传 path、以及 JSON 去重 / 空字段清理 / World Rules 三个交叉关注点

### 1.2 判断标准

每字段/技巧标记为以下类别之一：

| 类别 | 含义 |
|------|------|
| **IR→State/validator** | 字段被状态管理器或 prereder validator 消费（确定性校验，非 LLM 评判） |
| **IR→Context→Pass 1** | 字段经 ContextPackage → PromptAssembler 渲染为 Pass 1 prompt 自然语言指令 |
| **IR→Pass 2** | 字段经 `buildAnalysisPrompt` 传递给 Pass 2 的 JSON scene spec + 被 validator validatePost 消费 |
| **pure authorNotes passthrough** | 字段只到达 Pass 1 的 `## Author Notes` 区块，无结构性校验或建模 |

"建模优先，透传兜底"：先评估体系内有无该技巧的结构性字段 + validator 组合；如果有，该技巧的主体路径走建模；如果体系没有显式字段承载，则作者必须靠 `authorNotes`/`sceneBrief`/`styleGuidance`/`narrativeChecklist` 等自由文本区块向 LLM 传递意图。

### 1.3 交叉关注点

- **JSON markdown 去重**：`packages/core/src/schemas/analysis.ts:72` 的 `fenceMatch` 正则会在解析前剥离 ` ```json ` 围栏，防止嵌套 markdown 污染。
- **空字段清理**：`packages/core/src/context/prompt-assembler.ts:166` 在序列化 ContextPackage JSON 时通过 `({ markdown: _omitted, ...contextForPrompt })` 排除包内的 markdown 字段，避免与已渲染的 markdown 区块重复。
- **World Rules**：`prompt-assembler.ts:154-161` 在 Pass 1 prompt 中渲染 `## World Rules` 区块 + `Prose must not contradict these rules.` 约束指令；同时在 Pass 2 中 `buildAnalysisPrompt` 的 `## Active World Rules` JSON 块也被传递给 LLM 进行一致性检查。

---

## 二、Field→Terminal Fate 矩阵

### 2.1 EventFile 字段

来源：`types/event.ts:174-298`（EventFile）→ `mapper.ts:218-281`（mapToNarrativeEvent）→ 消费端。

| 字段 | 类别 | 精确代码路径 |
|------|------|-------------|
| `event` | IR→State/validator | 事件标识，`mapper.ts:219` → state key |
| `formatVersion` | schema 级别 | `schemas/event.ts:26` default(1)，运行时零消费 |
| `narrativeOrder` | IR→validator + Context | `mapper.ts:221` → `compiler.ts:68` 话语重放位置钳制；`timeline.ts` validator |
| `title` | IR→Pass 2 | `render-analysis.ts:119` → Pass 2 scene spec JSON |
| `storyTime` | IR→State/validator | `mapper.ts:206/223` → TimelineValidator 消费 |
| `narrationTime` | IR→State | `mapper.ts:224` → NarrativeEvent 可选字段，无 validator 专门校验 |
| `sceneType` | IR→Context→Pass 1 + Pass 2 | `render-analysis.ts:120` Pass 2 spec；context JSON 包体 |
| `discourseMode` | IR→Pass 2 + validator | `render-analysis.ts:127` Pass 2 spec；`discourse-balance.ts` DiscourseBalanceValidator |
| `arcPosition` | IR→Pass 2 | `render-analysis.ts:128` Pass 2 spec |
| `emotionalValence` | IR→Context→Pass 1 | `assembler.ts:148` → `SceneSpecification.emotionalValence` → `prompt-assembler.ts:89-91` `- Emotional keynote:` |
| `conflictType` | IR→Pass 2 + validator | `render-analysis.ts:125` Pass 2 spec；`conflict.ts` ConflictValidator |
| `resolutionType` | IR→Pass 2 + validator | `render-analysis.ts:126` Pass 2 spec；`conflict.ts` ConflictValidator |
| `tense` | IR→Pass 2 + validator | `render-analysis.ts:124` Pass 2 spec；`tense-consistency.ts` TenseConsistencyValidator |
| `pov` | IR→State/validator + Context + Pass 2 | `render-analysis.ts:122` Pass 2；`pov.ts` POVValidator；`assembler.ts` context povCharacter |
| `sceneBrief` | IR→Context→Pass 1 + Pass 2 | Context markdown → Pass 1 prose；`render-analysis.ts:123` Pass 2 spec |
| `preconditions` | IR→State/validator | `mapper.ts:174` → Fact[] → CausalityValidator/KnowledgeValidator 预校验 |
| `expectedPostconditions` | IR→State/validator | `mapper.ts:190` → Fact[] → CausalityValidator 后校验 |
| `styleGuidance` | IR→Context→Pass 1 | `render.ts:297` → `prompt-assembler.ts:77-87` 子字段逐一渲染 |
| `styleGuidance.tone` | 同上 | `prompt-assembler.ts:79` `- Tone: ...` |
| `styleGuidance.characterVoice` | 同上 | `render.ts:298-300` → `prompt-assembler.ts:95-97` `- Character voice: ...` |
| `styleGuidance.avoid` | 同上 | `prompt-assembler.ts:87` `- Avoid: ...` |
| `styleGuidance.scenePacing` | 同上 | `prompt-assembler.ts:80` `- Pacing: ...` |
| `styleGuidance.atmosphere` | 同上 | `prompt-assembler.ts:81` `- Atmosphere: ...` |
| `styleGuidance.targetWordCount` | 同上 | `prompt-assembler.ts:82-86` 字数目标 |
| `threadProgress` | IR→State/validator + Context + Pass 2 | `assembler.ts` → ThreadStatus[]；`thread-progress.ts` validator；`render-analysis.ts:141` Pass 2 spec |
| `greyLines` | IR→validator | `grey-line.ts` GreyLineValidator 检查 motif 一致性 |
| `foreshadowing` | IR→validator + Pass 2 | `foreshadowing.ts` ForeshadowingValidator；`render-analysis.ts:142-145` Pass 2 spec |
| `relationshipEffects` | IR→State/validator | `mapper.ts:251` → RelationshipTransaction → 状态演进 + validator 间接检查 |
| `ruleEffects` | IR→validator + Pass 2 | `world-rule.ts` WorldRuleValidator；`render-analysis.ts:147` Pass 2 spec |
| `introduces` | IR→State（registry） | `api.ts:241-252` 在 load 时自动注册到 EntityRegistry（`registry.register()`） |
| `targetAudience` | IR→Context→Pass 1 | `assembler.ts` → `SystemContext.targetAudience` → `prompt-assembler.ts:118-121` |
| `cast.onScreen` | IR→Context | `assembler.ts:78-82` L3a merge on-screen 角色到 CharacterSnapshot 列表中 |
| `cast.affected` | **pure passthrough** | `mapper.ts:267` 复制到 NarrativeEvent，但无 validator/assembler 读取（`grep "cast\.affected\|\.affected" packages/core/src` → 0 命中） |
| `narrativeChecklist` | IR→Context→Pass 1 + Pass 2 + validator | `render.ts:307` → PromptAssembler `## Narrative Coverage Requirements`；`checklist.ts` ChecklistValidator 消费 Pass 2 的 `checklistResults` |
| `sourceContext` | IR→Context→Pass 1 | `render.ts:308-311` 过滤 `STYLE` 分类 → PromptAssembler `## Source Style Anchors` |
| `duration` | IR→validator + Pass 2 始终询问 | `duration-consistency.ts` validatePre (ellipsis) + validatePost (declared type vs detected)；Pass 2 始终生成 `durationDetected` |
| `frequency` | 同上 | `frequency-consistency.ts` + Pass 2 `frequencyDetected` |
| `voice` | 同上 | `voice-consistency.ts` + Pass 2 `voiceDetected` |
| `anachrony` | 同上 | `anachrony-consistency.ts` + Pass 2 `anachronyDetected` |
| `narratorProfileRef` | IR→Context + validator | `compiler.ts:60-61` narrator 解析；`discourse.ts` DiscourseValidator 查 profileRef 存在性 + discourse 回放完整性 |
| `focalization` | IR→validator + Pass 2 始终询问 | `focalization-consistency.ts` + Pass 2 `focalizationDetected` |
| `modernNovel` | schema 级别 | B 类字段（`types/modern-novel.ts`），Zod validates but 运行时无消费者（计划内） |
| `authorNotes` | **pure authorNotes passthrough** | `mapper.ts:280` → `assembler.ts:149` → `prompt-assembler.ts:146-152` → `## Author Notes` 逐行输出。零结构性校验 |

### 2.2 ProjectConfig 字段（relevant subset）

来源：`schemas/project.ts:9-62` → `api.ts:394-400` SystemContext + 配置推断。

| 字段 | 类别 | 精确代码路径 |
|------|------|-------------|
| `genre` | IR→Context→Pass 1 | `api.ts:395` → `SystemContext.genre` → ContextPackage JSON → Pass 1 |
| `synopsis` | IR→Context→Pass 1 | `api.ts:399` → `SystemContext.synopsis` → `prompt-assembler.ts:123-127` `## Work Synopsis` |
| `ideaIR.thematicIntent` | IR→Context→Pass 1 | `api.ts:398` → `SystemContext.thematicIntent` → `prompt-assembler.ts:129-136` `## Thematic Intent`（主主题 + 子主题） |
| `ideaIR.emotionalArc.emotionalBeats` | IR→Context→Pass 1 | `api.ts:487-489` 按 event.id 或 arcPosition 匹配 → `compiler.ts:56-57` `pkg.sceneSpec.emotionalBeat` → `prompt-assembler.ts:92-94` `- Emotional beat:` |
| `styleProfile` → toStyleNotes | IR→Context→Pass 1 | `render.ts:286-288` → `prompt-assembler.ts:98-99` `- ${profileStyleNotes}` |
| `tense` | IR→validator | TenseConsistencyValidator（全局默认） |
| `defaultModel` | IR→api.ts | `api.ts:431` CLI/model 选择，无 LLM prompt 层影响 |
| `plugins` | IR→PluginLoader | `plugin/loader.ts` → hooks 注册，无 prompt 层消费 |

---

## 三、九条已修复缺口 + JSON 去重 + 空字段清理 + World Rules

以下九条是 wave2 闭合报告（`full-chain-wiring-acceptance.md`）中确认修复的缺口，本报告用当前代码精确验证：

| 缺口 | 修复证据 |
|------|---------|
| **characterVoice** | `render.ts:298-300` 从 `styleGuidance.characterVoice` 构建 `{id}: {note}` 字符串 → `prompt-assembler.ts:95-97` `- Character voice:` 区块。schema 层面 `primitives.ts:144` `z.record(z.string(), z.string())` 验证 |
| **avoid** | `prompt-assembler.ts:87` `if (sg.avoid) parts.push(...)`。项目级 `styleProfile.avoid` 经 `toStyleNotes` → `profileStyleNotes` 同路径送达 |
| **emotionalValence** | `assembler.ts:148` → `SceneSpecification.emotionalValence` → `prompt-assembler.ts:89-91` `- Emotional keynote:` |
| **synopsis** | `schemas/project.ts:17` → `api.ts:399` → `SystemContext.synopsis` → `prompt-assembler.ts:123-127` `## Work Synopsis` 区块 |
| **emotionalArc beat** | `api.ts:487-489` 按 `position` 匹配 `ideaIR.emotionalArc.emotionalBeats[]` → `compiler.ts:56-57` 写入 `sceneSpec.emotionalBeat` → `prompt-assembler.ts:92-94` |
| **threadProgress advancement** | `mapper.ts:239-244` → `render-analysis.ts:141` Pass 2 场景 spec → ThreadProgressValidator 消费 `threadProgressAchieved` 块；`assembler.ts` L4 构建 `ThreadStatus[]` |
| **cast.onScreen** | `assembler.ts:78-82` L3a merge 将 onScreen 角色加入 CharacterSnapshots（通过 registry.resolve 实体化） |
| **introduces registry** | `api.ts:241-252` 加载事件时对每个 `introduces` 条目调用 `registry.register()` → 后续事件可 resolve 该实体 |
| **authorNotes** | `mapper.ts:280` → `assembler.ts:149` → `prompt-assembler.ts:146-152` `## Author Notes` 纯透传 |
| **JSON markdown dedup** | `analysis.ts:72` `fenceMatch` 正则在 JSON 解析前剥离 LLM 输出的 ` ```json` 围栏 |
| **空字段清理** | `prompt-assembler.ts:166` 序列化 ContextPackage JSON 时 `({ markdown: _omitted, ... })` 避免 markdown 区块重复暴露 |
| **World Rules** | `prompt-assembler.ts:154-161` 渲染 `## World Rules` + 约束；`render-analysis.ts:164-173` 同样传递给 Pass 2 做规则一致性检查 |

---

## 四、Technique→Expression-Path 矩阵

每行标注"建模优先，透传兜底"：建模路径 = 字段→IR→validator 确定性校验的组合；透传路径 = `authorNotes`/`sceneBrief`/`styleGuidance`/`narrativeChecklist` 中自由文本向 LLM 传递意图的手段。

| # | 技巧 | 建模路径 | 透传路径 | 分类 |
|---|------|---------|---------|------|
| 1 | **Genette Duration** | `event.duration` → `DurationConsistencyValidator` (Pre: ellipsisClarity, Post: 声明的 type vs Pass 2 `durationDetected`) + Pass 2 始终询问 | — | 建模优先 |
| 2 | **Genette Frequency** | `event.frequency` → `FrequencyConsistencyValidator` (repeating/iterative 必须带 iterationScope) + Pass 2 `frequencyDetected` | — | 建模优先 |
| 3 | **Genette Voice** | `event.voice` → `VoiceConsistencyValidator` (level/relation 逐字段检查) + Pass 2 `voiceDetected` | — | 建模优先 |
| 4 | **Genette Anachrony** | `event.anachrony` → `AnachronyConsistencyValidator` (analepsis/prolepsis 必须带 distance) + Pass 2 `anachronyDetected`（含 `none` 字面量） | — | 建模优先 |
| 5 | **Genette Focalization** | `event.focalization` → `FocalizationConsistencyValidator` (internal+multiple 必须 characterSequence≥2) + Pass 2 `focalizationDetected` | — | 建模优先 |
| 6 | **Stream of Consciousness** | — | `authorNotes` 逐条写入 Pass 1；`styleGuidance.diction/characterVoice` 调控 prose 风格；`narrativeChecklist` `"心理流向":"意识流的非逻辑跳跃"` | 透传兜底 |
| 7 | **Unreliable Narration** | `narratorProfile.sincerity<100` → `DiscourseValidator` 发 warning（仅确定性检查，true performance 靠 LLM 实现） | `authorNotes` 说明不可靠机制；`styleGuidance.characterVoice` 调控叙述者口吻 | 两者皆有 |
| 8 | **Multiple POV** | 多个事件各自声明 `pov:{character,type}` → `POVValidator` 检查相邻事件间切换一致性 | `styleGuidance.tone` 区分不同视角声调 | 建模优先 |
| 9 | **Epistolary** | — | `authorNotes`/`sceneBrief` 说明书信体；`styleGuidance` 调整格式提示（LLM 可输出信件体，但无结构性封套） | 透传兜底 |
| 10 | **Poetry Insertion** | — | `authorNotes` 逐行写诗词内容；`narrativeChecklist` 要求"诗行插入" | 透传兜底 |
| 11 | **Metafiction** | — | `authorNotes` 说明元小说设置；`narrativeChecklist` `"叙述自反性":"暴露叙述行为"` | 透传兜底 |
| 12 | **Nonlinear Narrative** | `narrativeOrder` 定义排列顺序；`sceneType: flashback/flashforward`；`anachrony` 精确建模倒叙/预叙的类型和距离 | `sceneBrief` 描述时间跳转 | 建模优先 |
| 13 | **Omission/Ellipsis** | `duration.type:'ellipsis'` → `DurationConsistencyValidator` 要求 `ellipsisClarity` | `authorNotes` 说明省略内容 | 建模优先 + 透传兜底 |
| 14 | **Ironic Distance** | — | `narrativeChecklist` `"反讽距离"` 项目要求覆盖；`sourceContext` STYLE entries 提供原文反讽样本；`authorNotes` 补充指令 | 透传兜底 |
| 15 | **Foreshadowing** | `event.foreshadowing[]` → `render-analysis.ts:142-145` Pass 2 spec → `ForeshadowingValidator` 校验需被覆盖 | — | 建模优先 |
| 16 | **Frame Narrative** | — | `sceneBrief` 描述框架故事结构；`authorNotes` 说明内层故事起止；`narrativeChecklist` 要求框架呼应 | 透传兜底 |
| 17 | **Second Person** | — | `authorNotes` 直接写"本场景用第二人称"；`styleGuidance.tone` 辅助（type 联合中无 `second_person`，纯透传） | 透传兜底 |
| 18 | **Interior Monologue** | — | `discourseMode:'reflection'` 信号；`styleGuidance.characterVoice` 说明独白风格；`authorNotes` 具体内容 | 透传兜底 |
| 19 | **Ensemble Cast** | `cast.onScreen` → `assembler.ts:78-82` L3a 合并角色；多个 `pov: {character}` 声明 | `sceneBrief` 描述群戏安排 | 建模优先 |
| 20 | **Dialect/Idiolect** | `styleGuidance.characterVoice` 按角色记录个性化语言特征 → Pass 1 prompt `- Character voice:`；`VoiceDriftDetector` 检查一致性 | — | 建模优先 |
| 21 | **Omniscient Commentary** | `pov.type:'omniscient'` → `POVValidator` 检查一致性 | `authorNotes` 写入全知评论的具体内容（LLM 据此在 prose 中插入叙述者评论） | 建模优先 + 透传兜底 |
| 22 | **Prophetic Verse** | — | `authorNotes` 直接输出预言诗句内容 | 透传兜底 |
| 23 | **Time Loop** | — | `authorNotes` 说明循环规则；`narrativeChecklist` 项目要求重复场景；`sceneBrief` 描述循环逻辑 | 透传兜底 |
| 24 | **Open Ending** | — | `sceneBrief` 描述未解决的结局；`authorNotes` 说明留白意图；`narrativeChecklist` 要求"开放式结尾" | 透传兜底 |
| 25 | **Montage** | — | `styleGuidance.scenePacing` 提示剪辑节奏；`discourseMode:'description'/'transition'` 信号；`authorNotes` 说明蒙太奇序列 | 透传兜底 |
| 26 | **Play-Within-Play** | — | `authorNotes` 写入戏中戏内容格式；`narrativeChecklist` 要求"嵌套结构" | 透传兜底 |
| 27 | **Diary Novel** | — | `authorNotes` 说明日记格式；`styleGuidance.tone` 调日记口吻 | 透传兜底 |
| 28 | **Annotated Novel** | — | `authorNotes` 说明脚注/批注系统；需要 LLM 理解后在 prose 中生成注释格式 | 透传兜底 |
| 29 | **Imagery System** | `event.greyLines[]` → `GreyLineValidator` 追踪意象链的语义累积和再现 | `styleGuidance.atmosphere` 调控意象氛围 | 建模优先 |

### 4.1 矩阵解读

**建模优先的 11 项**（1-5, 8, 12, 13, 15, 19, 20, 21, 29）：结构、视角、时序、叙事时间、重复、预示、群演、方言、全知评论、意象系统——这些都是要么有明确的 validator 交叉校验，要么有 IR 层的结构性字段，能够在渲染前/渲染后进行确定性验证。

**纯透传的 13 项**（6, 9, 10, 11, 14, 16, 17, 18, 22, 23, 24, 26, 27, 28）：意识流、书信体、诗歌插入、元小说、反讽距离、框架叙事、第二人称、内心独白、预言诗、时间循环、开放式结尾、蒙太奇、戏中戏、日记体、注释体——这些依赖于作者的文学判断在 `authorNotes`/`narrativeChecklist` 中注入指令，由 LLM 在 Pass 1 中落实。系统不做结构性验证——因为对这些技巧的"正确性"做出评判需要文学批评级理解，超出了确定性校验的范围。

**混合的 2 项**（7, 21）：不可靠叙述和全知评论有结构性签名（`narratorProfile.sincerity`/`pov.type`），但具体的不可靠行为或评论内容只能靠透传指导。

**关于 `second_person`**：`pov.type` 的联合类型只有 `'first_person' | 'third_person_limited' | 'omniscient'`，第二人称纯靠透传。这是有意的设计限制：第二人称在文学中极为罕见且用法高度不统一，不值得为一个几乎用不到的 `pov` 变体修改 schema/validator。

---

## 五、决策保留：Pass 2 始终询问 S6 维度检测

### 5.1 现状

六个 S6 validator（Duration/Frequency/Voice/Anachrony/Focalization + NarratorDiscourse）全部通过 `getAnalysisRequirements()` 注册了对应的分析块。Pass 2 的 `buildDynamicJsonTemplate()` 总是生成包含全部 6 块的 JSON schema 模板，无论当前事件是否声明了对应字段。

### 5.2 替代方案考量

考虑过的替代方案：在 `buildDynamicJsonTemplate()` 中检查当前事件——仅当 `event.duration` 存在时才加入 `durationDetected` requirement，以此类推。这需要将整个 `NarrativeEvent` 传入模板构建函数或在 `render.ts` 层面预处理 requirements 列表。

### 5.3 决定保留"始终询问"的根因

1. **验证器已快速返回**：`DurationConsistencyValidator.validatePost` 首行即 `if (!event.duration || !analysis?.analysis) return issues;`。即便 Pass 2 检测了 duration，无声明事件也零开销——检测结果是免费情报。
2. **模板构建复杂度**：事件感知的 requirement 过滤增加 ~50 行代码（传递 event 对象 + 逐 requirement 匹配字段名 + 处理 field 可能跨多 validator 共享的场景），而每个未声明事件节省的 tokens 约 30-50（`durationDetected` 的 instruction 文本 + schema 占位）。以 zhu-fu 7 事件 × 5 维 × 50tok ≈ 1750 tok 全程节省，与重构复杂度不成比例。
3. **免费分析数据**：即使事件未声明 duration，Pass 2 检测到的 `durationDetected` 数据可被非校验用途消费（如质量报告、风格分析）。"始终检测"模式为未来的分析工具保留了数据基础而不增加当前开发负担。
4. **Narrator/discourse 同样始终检查**：`compiler.ts:60-72` 对每个事件都尝试解析 narratorProfileRef + 回放 discourse ledger（用 `Math.min(narrativeOrder, ledger.length)` 钳制），不影响无声明事件。

**结论**：坚持"Pass 2 始终询问 S6 维度检测，validator 静默跳过无声明事件"的设计，不引入事件感知的动态过滤。

---

## 六、结论：否定两个负面命题

### 6.1 负面命题一："写不进去"

**问**：是否存在因系统缺乏字段导致作者意图"写不进去"的情况？

**答：不存在。`authorNotes` 纯透传通道（`mapper.ts:280` → `assembler.ts:149` → `prompt-assembler.ts:146-152` → Pass 1 render）是无限的"安全阀"。** 任何未被结构性字段建模的文学意图——调性、姿势、参考、特殊格式、不可靠叙事的具体操作方式——都可以不经任何结构性限制写入 `authorNotes: ["..."]`，原样出现在 Pass 1 prompt 的 `## Author Notes` 区块中。

例外核实：
- `ProjectConfig` 层面的自由文本安全阀：`synopsis`（已建模）、`styleProfile`（已建模）、`ideaIR.thematicIntent`（已建模）。剩余的 `reviewExpiry`/`concurrency`/`cacheEnabled` 等属基础设施配置，不属于"写不进"的文学意图。
- 事件层面的安全阀：`authorNotes`、`sceneBrief`（已建模）、`styleGuidance`（子字段全部已建模）、`narrativeChecklist`（已建模）、`sourceContext`（已建模）。

### 6.2 负面命题二：清单残留

**问**：哪些字段/技巧在此次工作后仍然是**纯透传**（无结构性字段、无 validator 消费者）？

**答：经过 Wave1/Wave2 接线后，仅剩下两项是"纯透传"：**

1. **`cast.affected`** — `NarrativeEvent.cast.affected`（`types/event.ts:59`）。`cast.onScreen` 已被 `assembler.ts:78` 用于 L3a 角色合并，但 `affected`（"受事件影响但不在场"的角色列表）没有一个阅读它的 validator 或 context builder。**这与 design intent 一致**：受事件影响但不在场的角色无 prose 约束（他们不在 scene 中，原则上 LLM 不该写他们），故不需要校验。如果某个作者希望在 prose 中提及但提醒 LLM 在场外影响，仍用 `authorNotes` 或 `narrativeChecklist` 透传。
2. **纯透传叙事技巧**（13 项）：意识流、书信体、诗歌插入、元小说、反讽距离、框架叙事、第二人称、内心独白、预言诗、时间循环、开放式结尾、蒙太奇、戏中戏、日记体、注释体——均为有透传兜底、无结构性建模。没有 validator 宣称"这个意识流做得不对"——也永远不应该有，因为那是文学批评家的领域。

### 6.3 最终断言

经过 Waves 1-2 对九个缺口的逐一修复，`authorNotes` 覆盖"剩余"。没有一条经过本系统的用户输入路径是无去处的：

- 有结构性字段 + validator → 建模优先，确定校验
- 有结构性字段但无校验 → 该无校验是有意设计（`cast.affected`、`modernNovel` B 类）
- 无结构性字段 → `authorNotes`/`narrativeChecklist`/`sceneBrief`/`styleGuidance` 透传
- ProjectConfig 配置字段（`cacheEnabled`/`concurrency` 等）→ 运行时消费，非表达层面

**结论**：表达性审计通过。零"写不进去"缺口，零非预期的纯透传字段。
