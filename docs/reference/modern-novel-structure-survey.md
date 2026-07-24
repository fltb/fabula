# 现代小说结构建模层（S3）— 理论 survey 与字段集提案

> **项目：** Fabula
> **撰写日期：** 2026-07-24
> **状态：** 系统推导中，S3 字段集锁定前置

---

## 概述

本文档完成 S3（现代小说结构建模层）的三层 survey 中的第 2–3 层，并对当前 provisional 6 字段做完整重分类。核心结论：

1. **Genette 已从 S3 移至 base schema**（见 `narratology-dimension-audit.md`），因此 S3-research 第 1 层（叙事学 survey）不再是 S3 专属任务。
2. **当前 6 字段中有 1 个属 base narratology**（`uncloseableThread`），3 个需重命名或重新定位，2 个保留但需补充同层反向字段。
3. **多作品 survey 揭示 4 个新字段**，均不在当前 6 字段中。

> **分层约定：** A 类 = 结构元数据，deterministic check；B 类 = 语义效果，Pass 2 对照作者透传 prompt 检查。

---

## 第 2 层：现代主义 / 后现代批评 survey

### 2.1 Eco《开放的作品》— 开放 vs 封闭作品

| 维度 | 说明 |
|------|------|
| **核心概念** | 开放作品（`open work`）刻意设计"空白"，让读者参与意义完成。封闭作品（`closed work`）意义由作者决定，读者被动接收。 |
| **现代性判断** | 开放结构本身就是现代主义特征——传统小说追求意义确定性，现代小说以"未完成性"为美学目的。 |
| **对字段的启示** | `suspension` 和 `absenceProfile` 都隐含"开放"的某一面，但 Eco 强调的是**读者参与的必然性**，不是值的不可判定。Eco 的开放是结构性开放——作品要求读者做出选择。 |
| **与 Derrida 的区分** | Eco 认为开放最终仍可闭合（读者选择一种解读）；Derrida 认为 deferral 是终态，无法闭合。这是程度差异。 |

### 2.2 Iser《隐含的读者》— 空白 / Leerstellen

| 维度 | 说明 |
|------|------|
| **核心概念** | 文本中的空白（`gaps/Leerstellen`）是意义的生成器，不是缺陷。读者必须填充这些空白才能产生意义。 |
| **现代性判断** | 所有文本都有空白——但现代小说将空白**主题化**：空白不是"还没写"而是"必须由读者写"。 |
| **对字段的启示** | Iser 的空白概念与 `suspension` 不同——空白是意义生成的积极条件，不是值的不可判定。传统小说也有空白（如《红楼梦》的留白），但现代小说将空白提升为结构性原则。这进一步说明 `suspension` 作为"不可判定"不等于"空白"。 |
| **与传统小说的边界** | 传统小说空白可复原（读者可推断出单一合理填充）；现代小说空白不可复原（多个合法填充互斥）。这指向 Borges 的 `multiplicity`。 |

### 2.3 Barthes S/Z — 可读文本 vs 可写文本

| 维度 | 说明 |
|------|------|
| **核心概念** | 可读文本（`readerly/lisible`）——读者是消费者，意义固定。可写文本（`writerly/scriptible`）——读者是生产者，意义不固定。S/Z 用 5 种代码（阐释性、能愿性、行动性、象征性、文化性）分析 Balzac 的中篇小说。 |
| **现代性判断** | 巴特认为真正的现代文本应该是 writerly——迫使读者**生产**意义而非消费。文本的多义性不是歧义而是"意义星群"。 |
| **对字段的启示** | `suspension` 和 `multiplicity` 都是 writerly 文本的表现。Barthes 的分析表明：现代文本不是"模糊"而是"多义系统的结构性共存"。这支持 `multiplicity` 字段（多个合法值同时存在）的存在权。 |
| **对 voiceDissonance 的批评** | Barthes 的"可写性"不包含 tone/content 裂隙——那是不同概念。 |

### 2.4 Derrida "Before the Law" — différance 作为结构

| 维度 | 说明 |
|------|------|
| **核心概念** | Derrida 读 Kafka《在法的门前》：法的本质是 deferral（延缓/defer）+ difference（差异/differ）。农民在法的门前等待一生——不是"法不在场"而是"等待 IS 与法的关系"。Différance 不是临时状态而是存在结构。 |
| **现代性判断** | **极端现代（后现代）**——结构本身建立在延缓之上，没有终极意义。传统小说的延缓是叙事策略（悬念→解决），现代小说的延缓是本体论状态。 |
| **对字段的启示** | § `suspension` 完全误用概念——暗示"暂时悬置，稍后解决"。Derrida 证明 différance 是**终态结构**。 |
| **命名修正** | → **`irresolvableIndeterminacy`**（不可解决的不确定性）：值不是"待决定"而是"本质上不可决定"。 |
| **验证路径** | 不是"是否 unresolved"而是"unresolved 是否为结构性终端"——即系统没有提供解决潜势。 |

### 2.5 Deleuze & Guattari《卡夫卡》— 生产装置 vs 缺席实体

| 维度 | 说明 |
|------|------|
| **核心概念** | D&G 反对传统解读（法庭是缺席的超越性力量）。法庭是**生产装置**（`agencement`/assemblage）——它不审判而是**制造法律、制造罪感、制造官僚机器**。K 不是被审判的角色而是**机器的零件**。 |
| **现代性判断** | 极端现代。传统小说中缺席实体（如 Godot、城堡）可被追问"它存在吗？在哪里？"——D&G 认为这是错误问题。问题是"机器如何运作？" |
| **对字段的启示** | § `absenceProfile` 完全误读《审判》。它把法庭建模为"缺席实体"（entity defined by absence），D&G 证明法庭是**过度的在场**——它不断生产文档、程序、官僚行为。两个根本不同的结构概念。 |
| **正确建模** | 需要区分：**
- **缺席实体**（`absentEntity`）：Godot 不到场，但不妨碍它作为引力点——这近似 `absenceProfile` 的原意。
- **生产装置**（`agencement`）：法庭没有"本质"只有"运作"——这不是缺失而是**机器化的过度**。 |
| **命名修正** | → **`absentApparatus`**（缺席装置）或保留 `absenceProfile` 但重新定义为"实体通过缺席产生结构性效果"。D&G 视角要求新增 `agencement` 字段。 |

---

## 第 3 层：多作品 survey

### 3.1 Beckett《等待 Godot》— 重复 + 无反果

| 维度 | 说明 |
|------|------|
| **作品特征** | 两幕几乎相同：Estragon 和 Vladimir 等待 Godot，对话重复，来人但不解决问题，第二天同一时间同一地点重新开始。 |
| **所需结构属性** | 1. `frequency: repeating`（Genette 基础层）——同一模式反复出现<br>2. `antiCausalEdge`——每个事件都不产生后续后果<br>3. `duration: pause/stretch`（Genette 基础层）——时间在等待中变形 |
| **与当前字段的关系** | 当前只有 `antiCausalEdge`。缺少 `frequency: repeating` 组合——Beckett 的静止不是"单一因果断裂"而是"反复无后果的节奏"。 |
| **依赖新字段** | `antiCausalEdge` 保留 S3；`frequency` 已是 base schema（Genette 层）。 |

### 3.2 Borges《小径分岔的花园》— 多重共时

| 维度 | 说明 |
|------|------|
| **作品特征** | 时间不是单一线性而是"分岔的花园"——所有可能性同时存在并都真实。小说选择其中一条，但其他分支并不消失。 |
| **所需结构属性** | `multiplicity`——多个有效值同时合法。 |
| **与当前字段的关系** | § 当前 `suspension`（单一值不可决定）**不适用**。Borges 的不是"不确定取哪个"而是"都取，都真"。 |
| **验证路径** | B 类——对照作者透传 prompt，确认分支间无"唯一正确"选择。 |
| **命名建议** | `multiplicity`（A 类？B 类？见提案） |

### 3.3 Robbe-Grillet《嫉妒》— 表面叙事 / 深度拒绝

| 维度 | 说明 |
|------|------|
| **作品特征** | 全书只有物象的精确描写：百叶窗的角度、香蕉园的列序、桌布上的污渍。拒绝任何心理深度——不说人物感受，只写可见的。 |
| **所需结构属性** | `depthRefusal` / `surfaceMode`——结构性拒绝心理深度。不是"voice 与 content 冲突"而是**voice 主动选择表面**。 |
| **与当前字段的关系** | § 当前 `voiceDissonance`（语气与内容裂隙）**不适用**。Robbe-Grillet 没有裂隙——叙事者的语调与内容完全一致（冷漠的语调描述冷漠的世界）。没有 dissonance，只有 refusal。 |
| **验证路径** | A 类——scene-level metadata 标注 `surfaceMode: true`，检验是否存在内部视角/心理活动。 |
| **命名建议** | `surfaceMode`（A 类） |

### 3.4 Pynchon《拍卖第 49 批》— 因果过载

| 维度 | 说明 |
|------|------|
| **作品特征** | Oedipa Maas 执行遗嘱 executor 职责，发现每一个细节都可能是更大阴谋的线索。邮戳、酒吧标志、雅号剧院——所有事物似乎都连接到 Trystero 秘密系统。**因果链不是断裂而是爆炸**。 |
| **所需结构属性** | `causalOverload`——因果过载：事件可能产生太多后果，每个细节都可能是另一个线索系统的入口。 |
| **与当前字段的关系** | § 当前 `antiCausalEdge`（无后果）是**相反方向**。Pynchon 需要的是因果过载——不是"no consequence"而是"every detail is connected in too many ways"。 |
| **验证路径** | A 类——thread 的 branching factor 异常高；或 B 类——pass 2 检查因果密度。 |
| **命名建议** | `causalOverload`（A 类/B 类）——与 `antiCausalEdge` 成对：前者是因果断裂，后者是因果过剩。 |

### 3.5 Calvino《如果在冬夜，一个旅人》— 元叙事自指

| 维度 | 说明 |
|------|------|
| **作品特征** | 小说讲述"你"（读者）阅读一本叫《如果在冬夜，一个旅人》的小说的过程。每一章都是不同的小说的开头。叙事不断被打断、自指、暴露建构过程。 |
| **所需结构属性** | `selfReflexivity` / `metanarrativeLevel`——叙事的自我指涉：叙事内容是关于叙事本身。 |
| **与当前字段的关系** | § 当前 `voiceDissonance`（语气与内容裂隙）**不适用**。Calvino 的 tone 和 content 完全一致（元小说语调叙述元小说内容）。 |
| **验证路径** | A 类——`narrativeLevel: metadiegetic`（已属 Genette base 层）；B 类——pass 2 确认自我指涉不是偶发而是结构性原则。 |
| **与 Genette 的关系** | `narrativeLevel`（extradiegetic/intradiegetic/metadiegetic）已在 base schema（Genette 层）中。但"自指作为结构性原则"超越 Genette 的描述性分类——它是现代小说特有的**元叙事立场**。 |
| **命名建议** | `metanarrativeLevel`（B 类）——比 `selfReflexivity` 更结构化。 |

---

## 重分类：当前 6 字段逐一判定

### `uncloseableThread`（A 类）

| 维度 | 判定 |
|------|------|
| **原始定义** | 线程不收敛。验证：该线程在最终 WorldState 里未达 `resolved`/`concluded` |
| **理论出处** | Kafka《审判》（K 的诉讼未结束，线程永不闭合） |
| **是否 base** | **✅ 是**。传统小说同样可以有未闭合线程。红楼梦有多条伏笔（如甄士隐的结局线索）至今令红学家无法定论。张爱玲《半生缘》结尾的不完全和解。**非现代小说专属。** |
| **推荐处理** | **移入 base schema**。建议重命名（保留）为 `unresolvedThread`（更接近验证语义）。Genette 层无此概念——它是 fabula-level 结构特征，与因果链完整性相关，建议归入"叙事完整性"维度。 |
| **最终分类** | **→ base** |

### `antiCausalEdge`（A 类）

| 维度 | 判定 |
|------|------|
| **原始定义** | 事件不产生后果。验证：该事件 postconditions 不被任何后续事件 preconditions 引用 |
| **理论出处** | Kafka《审判》——K 的每个行动都不改变诉讼状态 |
| **是否 base** | **❌ 不是（但有前提）**。Aristotle 要求因果必然性——事件应当产生后果。传统小说中偶尔出现无后果事件（如《战争与和平》中 Pierre 的某个沉思），但作为**结构性原则**（大量事件系统性地无后果）是现代小说专属的。 |
| **区分基准** | 传统小说中偶尔一个无后果事件是 **craft flaw** 或 **rhythm variation**；现代小说中系统性的无反果是 **structural statement**（"世界无意义"或"因果链失效"）。 |
| **验证问题** | 如何区分"偶发无后果"和"系统无反果"？A 类 deterministic check 只能检测单一事件——量化阈值（连续 N 个 antiCausal events / 比例超过 P%）可解决。 |
| **推荐处理** | **保留 S3**。但附加阈值条件：只有达到系统级规模（如>50%的事件为 antiCausal）才标注，单一个是 base schema 可管理的 craft issue。 |
| **最终分类** | **→ S3（要求阈值量化）** |

### `chapterOrder: contested`（A 类）

| 维度 | 判定 |
|------|------|
| **原始定义** | 章节顺序不可决定。验证：metadata 标注存在，Assembler 按 chosen rendering 排序 |
| **理论出处** | Kafka《审判》——章节排序的作者意图无法确定（Brod 出版的顺序 vs Kafka 原稿的碎片化顺序） |
| **是否 base** | **❌ 否**。传统小说章节顺序总是确定的。虽然 Laurence Sterne《项狄传》有嬉戏（第 6 卷后接第 9 卷），但那是例外，不是结构性主张。现代小说将 order 的不可决定性**主题化**。 |
| **验证路径** | A 类——metadata field `renderingOptions: { orderContested: true }` + 多个 `chosenRendering` 变体。Assembler 按用户/渲染配置选择排序。 |
| **推荐处理** | **保留 S3**。名称精确无歧义。与 Genette Order（base）的关系：当 base 层允许多个 order 时，contested 标记哪个是"无作者意图的"。 |
| **最终分类** | **→ S3（不变）** |

### `suspension`（B 类）

| 维度 | 判定 |
|------|------|
| **原始定义** | Fact value 不可决定。验证：Pass 2 对照 narrativeChecklist 透传 prompt |
| **理论出处** | Kafka《审判》——K 有罪/无罪不可决定 |
| **问题** | **命名误导。**`suspension` 暗示"临时悬置，可能解决"。Derrida 的 différance 证明现代文本的不可决定是**终态结构**，不是等待决定。 |
| **概念混淆** | 传统小说也有"悬置"（悬念——读者等待解答）。现代小说的"不可决定"不是悬念而是**结构性去决定**。 |
| **推荐处理** | **更名。** 提案：`irresolvableIndeterminacy`（不可解决的不确定性）。验证路径仍为 B 类（Pass 2 对照检查），但含义明确为"不可解决的"（与 Eco/Iser 的可填充不同）。 |
| **与 multiplicity 的边界** | `irresolvableIndeterminacy` = 一个值不可决定（Derrida 的 deferral as terminal state）。`multiplicity`（Borges）= 多个值同时合法（分岔叙事）。两者的共同点：都不要求选择单一值。不同点：不确定性是"选不出"；多重性是"不选"。 |
| **最终分类** | **→ S3（更名）** |

### `absenceProfile`（B 类）

| 维度 | 判定 |
|------|------|
| **原始定义** | 实体通过缺失定义。验证：Pass 2 对照 narrativeChecklist 透传 prompt |
| **理论出处** | 传统解读：法庭是缺席的超越性力量。Godot 是永不来的等待目标。 |
| **问题** | **误读《审判》。** D&G 证明法庭不是缺席实体而是**生产装置**（过度在场，不断制造法律效果）。"通过缺失定义"错误地将结构性运作（官僚机器）建模为"不存在对象"。 |
| **两个不同概念** | 1. **absentEntity**（缺席实体）：Godot、Pinter 的沉默人物、某些鬼魂叙事——特征是"对象不在场但作为引力中心存在"。这个确实需要建模。<br>2. **agencement**（生产装置）：法庭没有本质只有运作。这不是缺失而是过度。 |
| **推荐处理** | **拆分 + 更名。** `
- `absenceProfile` → **`absentApparatus`**（缺席装置）——保留原意的修正版：实体通过缺席产生结构性效果。
- 新增 **`agencement` / `machineMode`**（B 类）——实体不通过本质定义而通过运作定义。 |
| **最终分类** | **→ S3（重构 + 重命名）** |

### `voiceDissonance`（B 类）

| 维度 | 判定 |
|------|------|
| **原始定义** | 语气与内容裂隙。验证：Pass 2 对照 narrativeChecklist 透传 prompt |
| **理论出处** | Kafka《审判》——冷漠的叙事语调叙述荒谬的诉讼体验 |
| **问题** | **过度聚合。** 多作品 survey 显示该字段聚合了多个不同概念：|
| **拆分解构** | - **Robbe-Grillet**：不需要 dissonance——他的语调与内容**完全一致**（冷漠描写冷漠）。需要的是 `surfaceMode`（结构性拒绝心理深度），不是 dissonance。<br>- **Calvino**：不需要 dissonance——元叙事语调与内容一致（元小说叙述元结构）。需要的是 `metanarrativeLevel`（元叙事自指），不是 dissonance。<br>- **Beckett**：voice 与 content 之间有 dissonance（滑稽语调叙述绝望），但这是 Beckett 的，不是普遍模式。 |
| **保留空间** | Kafka 确实有 voiceDissonance（法庭书记员用日常语调宣读荒谬指控）。但这个概念太窄——只适用于特定的"叙述态度与叙述内容之间的张力"。 |
| **推荐处理** | **保留但缩窄定义**。`voiceDissonance` 限定为"叙事者语气与所叙内容之间的结构性裂隙"（narrator's tone structurally conflicts with the content being narrated）。不作为涵盖 Robbe-Grillet 和 Calvino 的通用字段。Robbe-Grillet 和 Calvino 的各用对应字段。 |
| **最终分类** | **→ S3（缩窄定义，保留原名）** |

---

## 新字段提案（来自多作品 survey）

### `multiplicity`——多重共时

| 维度 | 说明 |
|------|------|
| **理论出处** | Borges《小径分岔的花园》；Barthes S/Z（多义系统的结构性共存） |
| **定义** | 一个 narrative slot 有多个有效值同时合法，系统不要求选择单一值 |
| **与 `irresolvableIndeterminacy` 的区别** | 不确定性 = 一个值不可决定；多重性 = 多个值同时存在且都真 |
| **验证路径** | A 类（争议性）——如果有多个 WorldState 分支同时被"叙事承认"，可 deterministic 检查；或 B 类（保守）——Pass 2 对照。初始建议 **B 类**，因为"同时合法"需要语义判断。 |

### `surfaceMode`——表面叙事 / 深度拒绝

| 维度 | 说明 |
|------|------|
| **理论出处** | Robbe-Grillet《嫉妒》；nouveau roman 拒绝心理深度 |
| **定义** | 结构性拒绝心理深度——叙事者只描述可见/可观察的表面，不进入人物内心 |
| **与 `voiceDissonance` 的区别** | 无 dissonance——tone 与 content 一致。但主动选择 surface。 |
| **验证路径** | A 类——scene-level metadata `surfaceMode: true`。检验：场景内是否有任何内部视角/心理活动标注。若存在内部视角但 metadata 标记 surfaceMode，报 warning。 |

### `causalOverload`——因果过载

| 维度 | 说明 |
|------|------|
| **理论出处** | Pynchon《拍卖第 49 批》 |
| **定义** | 事件产生过多可能的后果/连接——因果链的 branching factor 异常高，产生"everything is connected"效应 |
| **与 `antiCausalEdge` 的关系** | 对立面。antiCausalEdge = event has NO consequence；causalOverload = event has TOO MANY possible consequences。两者同属"因果异常"维度。 |
| **验证路径** | A 类——检查 thread branching factor。单线程的 fork 数超过阈值（如>5）即触发；或 B 类——pass 2 确认"过多连接"是结构性（不是随机细节）。初始建议 **A 类**（阈值化）。 |

### `metanarrativeLevel`——元叙事自指

| 维度 | 说明 |
|------|------|
| **理论出处** | Calvino《如果在冬夜，一个旅人》；结合 Genette narrative level 扩展 |
| **定义** | 叙事将自身作为内容——自指不是偶发技法而是结构性原则 |
| **与 Genette 的关系** | Genette 有 `narrativeLevel`（extradiegetic/intradiegetic/metadiegetic）作为分类描述。`metanarrativeLevel` 是 Genette 分类的**现代扩展**：不是"叙述者位于第几层"而是"叙事以自身建构为对象"。 |
| **验证路径** | B 类——pass 2 确认自指是结构性的（不是 meta-comment 的偶发使用）。场景级 metadata 可标注 `narrativeLevel: metadiegetic`（base），但结构性自指需要额外 B 类确认。 |

---

## 修正后 S3 字段集提案

### 保留字段（3 个）

| 字段名 | 类 | 说明 |
|--------|-----|------|
| `antiCausalEdge` | A | 保留原名。附加阈值条件：系统级规模（如 >50% events antiCausal）才标注为 S3。单次无后果 event 由 base schema 管理。 |
| `chapterOrder: contested` | A | 保留原名。与 Genette Order（base）的关系：base 允许多个 order 时，contested 标记"无作者意图"。 |
| `voiceDissonance` | B | 保留原名但**缩窄定义**：限定为"叙事者语气与所叙内容之间的结构性裂隙"（Kafka 模式）。不覆盖 Robbe-Grillet/Calvino/Beckett。Beckett 的 voice dissonance 是派生用法，不是字段的核心语义。 |

### 重命名字段（2 个）

| 原字段 | 新字段 | 类 | 说明 |
|--------|--------|-----|------|
| `suspension` | **`irresolvableIndeterminacy`** | B | Derrida 的 différance 表明 deferral 是终态结构。不再暗示"临时悬置"。 |
| `absenceProfile` | **`absentApparatus`** | B | D&G 纠偏：实体通过缺席产生结构性效果。原字段的"通过缺失定义"保留但修正为"缺席装置"——实体不在场但作为结构性引力中心存在。 |

### 移入 base schema（1 个）

| 字段名 | 类 | 目标层 |
|--------|-----|--------|
| `uncloseableThread` → `unresolvedThread` | A | base schema，归入"叙事完整性"维度（或 thread 层） |

> `uncloseableThread` 与 `unresolvedThread` 的区别：uncloseable 暗示"技术上不能"（Kafka 语境），unresolved 描述"实际状态"。base schema 应使用更通用的 unresolved。

### 新增字段（4 个）

| 字段名 | 类 | 理论出处 | 作品验证 |
|--------|-----|---------|----------|
| `multiplicity` | B | Borges; Barthes S/Z | Borges《小径分岔的花园》 |
| `surfaceMode` | A | Robbe-Grillet; nouveau roman | Robbe-Grillet《嫉妒》 |
| `causalOverload` | A | Pynchon | Pynchon《拍卖第 49 批》 |
| `metanarrativeLevel` | B | Calvino; Genette narrative level 扩展 | Calvino《如果在冬夜，一个旅人》 |

### 可选后续扩展

| 字段名 | 类 | 理论出处 | 说明 |
|--------|-----|---------|------|
| `agencement` / `machineMode` | B | Deleuze & Guattari | 实体不通过本质定义而通过运作定义（D&G 的生产装置）。从 `absenceProfile` 拆分出的第二个概念。需要更多作品验证才能锁定。 |

---

### 修正后总表

| # | 字段名 | 类 | 路径 | 理论出处 | 作品 |
|---|--------|-----|------|---------|------|
| 1 | `antiCausalEdge` | A | S3（保留） | Aristotle→Kafka 的断裂 | Kafka, Beckett |
| 2 | `chapterOrder: contested` | A | S3（保留） | Genette Order→不可决定 | Kafka |
| 3 | `voiceDissonance`（缩窄） | B | S3（保留,缩窄） | Genette Voice→裂隙 | Kafka |
| 4 | `irresolvableIndeterminacy` | B | S3（改名） | Derrida différance | Kafka |
| 5 | `absentApparatus` | B | S3（改名） | D&G production apparatus | Kafka, Beckett |
| 6 | `multiplicity` | B | S3（新增） | Borges, Barthes S/Z | Borges |
| 7 | `surfaceMode` | A | S3（新增） | Robbe-Grillet | Robbe-Grillet |
| 8 | `causalOverload` | A | S3（新增） | Pynchon | Pynchon |
| 9 | `metanarrativeLevel` | B | S3（新增） | Calvino, Genette 扩展 | Calvino |
| — | `unresolvedThread` | A | **→ base** | 任何小说的常规特征 | 红楼梦 等 |

---

## S3-research 重定范围

### 原设计（不适用）

```
S3-research:
  第 1 层——叙事学 survey （Genette, Chatman, Bal, Rimmon-Kenan）
  第 2 层——现代主义/后现代批评 survey
  第 3 层——多作品 survey
```

### 变更原因

| 原理由 | 变更 |
|--------|------|
| Genette 描述的是 ANY 叙事，不是现代小说特有。红楼梦、战争与和平、俄狄浦斯王都使用 5 个维度。 | Genette → base schema（narratology-dimension-audit） |
| 因此 Genette 的 gap-分析（哪些维度已建模、哪些缺失）不是 S3 的任务 | 第 1 层（叙事学 survey）从 S3-research 移除 |
| S3 应只保留"真正现代主义/后现代特有的"结构属性 | 第 2–3 层保留 |

### 新设计

```
S3-research（重定范围）:
  ❌ 第 1 层——叙事学 survey
     → 已移至 base schema audit（见 narratology-dimension-audit.md）

  ✅ 第 2 层——现代主义/后现代批评 survey
     Eco《开放的作品》
     Iser《隐含的读者》
     Barthes S/Z
     Derrida "Before the Law"
     Deleuze & Guattari《卡夫卡》
     （可扩展：Foucault、Lyotard、Jameson）
     → 已完成（本文档 §2）

  ✅ 第 3 层——多作品 survey
     Kafka《审判》（已完成，S3 fields derived from here）
     Beckett《等待 Godot》
     Borges《小径分岔的花园》
     Robbe-Grillet《嫉妒》
     Pynchon《拍卖第 49 批》
     Calvino《如果在冬夜，一个旅人》
     → 已完成（本文档 §3）
```

### 产出更新

- **原产出路径：** `docs/reference/modern-narrative-structure-survey.md`
- **新产出路径：** ✅ **`docs/reference/modern-novel-structure-survey.md`**（本文档）

原因：与 `narratology-dimension-audit.md` 区分（后者覆盖 base 层的 all-narrative 维度）。本文档专门覆盖现代小说特有结构。

### TODO.md 更新建议

TODO.md L191-L195（第 1 层）应标记为移至 base schema audit，S3-research 范围缩至第 2–3 层。本文档完成第 2–3 层 survey，产出最终字段集提案。

---

## 附录 A：理论-字段对照矩阵

| 理论/批评家 | 对应字段 | 对字段的影响 |
|-------------|---------|-------------|
| Eco 开放作品 | `multiplicity`, `irresolvableIndeterminacy` | 确定"开放"的两种形式 |
| Iser 空白 | `irresolvableIndeterminacy` (对立面) | 空白≠不可决定，空白可填充 |
| Barthes S/Z | `multiplicity` | 多义系统的结构性共存 |
| Derrida différance | `irresolvableIndeterminacy` | 提供命名和本体论基础 |
| D&G 生产装置 | `absentApparatus`, `agencement`（扩展） | 纠偏 absenceProfile 误读 |

## 附录 B：作品-字段对照矩阵

| 作品 | 核心字段 | 次要字段 | 不适用字段 |
|------|---------|---------|-----------|
| Kafka《审判》 | `irresolvableIndeterminacy`, `absentApparatus`, `antiCausalEdge`, `voiceDissonance`, `chapterOrder: contested` | — | — |
| Beckett《等待 Godot》 | `antiCausalEdge` | frequency: repeating (base), `absentApparatus` | `voiceDissonance`（需要用但非核心） |
| Borges《小径分岔的花园》 | `multiplicity` | — | `suspension`（原判）；`irresolvableIndeterminacy`（不适用） |
| Robbe-Grillet《嫉妒》 | `surfaceMode` | — | `voiceDissonance`（原判） |
| Pynchon《拍卖第 49 批》 | `causalOverload` | `multiplicity`（可能的扩展） | `antiCausalEdge`（对立） |
| Calvino《如果在冬夜》 | `metanarrativeLevel` | — | `voiceDissonance`（原判） |
