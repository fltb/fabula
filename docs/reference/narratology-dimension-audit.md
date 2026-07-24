# Genette 叙事维度审计报告

> **项目**: Fabula (前 Novalistically)  
> **用途**: 对照 Genette《叙事话语》(Narrative Discourse) 五维度审计当前 schema 覆盖状态  
> **核心论点**: Genette 的五维度是基础叙事学（任何小说都使用），不是现代小说扩展。它们属于 base schema 审计项，不应置于 S3（现代小说建模层）内。

---

## 维度一：Order（时序）—— 倒叙 / 预叙

### 1. Genette 定义

Genette 研究"叙事的时间顺序"——故事（fabula）的自然顺序与叙事（syuzhet）的呈现顺序之间的不一致。他将这种不一致称为 **anachrony（错时）**，分为两类：**analepsis（倒叙）**——回溯此前事件，和 **prolepsis（预叙）**——预述未来事件。关键参数是 **distance（距离）**——从现在到被回溯事件的跨度，以及 **amplitude（幅度）**——覆盖的时间范围。错时又分 internal（在第一时间层内）/ external（在第一时间层外）/ mixed。

### 2. 系统现有内容

| 要素 | 文件 | 状态 |
|------|------|------|
| `sceneType` 枚举（linear/flashback/flashforward/dream/parallel） | `packages/core/src/types/event.ts:20` | 类型 + 架构存在 |
| `EventFile.sceneType`（同上枚举） | `packages/core/src/types/event.ts:150` | 架构存在 |
| `narrationTime`（讲故事的时间点，与 storyTime 对比指示错时） | `packages/core/src/types/event.ts:19`（NarrativeEvent），`event.ts:148`（EventFile） | 类型 + 架构存在 |
| `SceneTransition`（flashback/time_jump 等） | `packages/core/src/types/render-surface.ts:94-101` | 类型存在 |
| zhu-fu 系列 fixture 使用 `sceneType: flashback` + `narrationTime` | `fixtures/zhu-fu/` | **已接线** |
| dream-of-red-chamber fixture 仅用 `sceneType: linear` | `fixtures/dream-of-red-chamber/` | 正交（线性叙事也合法） |
| four-generations fixture 仅用 `sceneType: linear` | `fixtures/four-generations/` | 正交 |

### 3. 缺失内容

- **无 temporal distance 类型**——没有字段记录倒叙/预叙的时间跨度（"距当前多少年"）
- **无 analepsis/prolepsis 区分**——`sceneType: flashback` 合并了 internal/external/external+mixed 三种错时
- **无 anachrony 的一等公民类型**——错时被降级为场景级 metadata，无法在 discourse 层独立跟踪
- **无 completing/repeating 倒叙区分**——不知倒叙是填补空白还是重述已知事件
- **无 anachrony 嵌套模型**——不能在错时中再嵌错时（如《百年孤独》的嵌套时间结构）

### 4. 红楼梦反例（证明 Order 不是现代小说特有）

红楼梦在第一回就建立了多层错时结构：

- **外部倒叙 (external analepsis)**：女娲补天遗石——这是故事"之前"的事件，发生在第一时间层之外。石头被茫茫大士、渺渺真人携入红尘是外部预叙(external prolepsis)——讲述了石头整个红尘经历的"预先摘要"。
- **内部倒叙 (internal analepsis)**：贾宝玉梦游太虚幻境中看到的判词（第五回）是内部预叙——在故事时间线内部预述人物未来命运。
- **嵌入错时**：甄士隐的故事线（第一回）是整部小说的微型倒叙嵌入——先在石头叙事层面讲甄士隐的遭遇，才转入贾府主线。
- **距离/幅度可计算**：从甄士隐元宵失女（故事第二年）到后文香菱（即英莲）入薛家再到贾府，跨度约 8-10 年——完全是 Genette 的 temporal distance 和 amplitude 分析对象。

红楼梦用倒叙、预叙实现"草蛇灰线，伏脉千里"，这不是 Kafka 或现代主义才需要的结构，是任何复杂叙事的基座。

### 5. 建议 schema 扩展

```typescript
// 在 types/discourse.ts 新增
export type AnachronyType = 'analepsis' | 'prolepsis';
export type AnachronyScope = 'internal' | 'external' | 'mixed';
export type AnachronyFunction = 'completing' | 'repeating';

export interface Anachrony {
  type: AnachronyType;          // 倒叙/预叙
  scope: AnachronyScope;        // 内部/外部/混合
  function: AnachronyFunction;  // 填补/重述
  distance: string;             // "距离当前 x 年/月/日"
  amplitude?: string;           // 时间跨度
  anchorEventId?: string;       // 锚定事件
}

// NarrativeEvent 增加
anachrony?: Anachrony;
```

---

## 维度二：Duration（时距）—— 场景 / 概要 / 省略 / 停顿 / 拉伸

### 1. Genette 定义

Duration 研究故事时间跨度与叙事文本长度之间的关系。Genette 定义四种标准关系（加一个变体）：

- **Scene（场景）**：故事时间 ≈ 叙事时间（对话、实时场景）
- **Summary（概要）**：叙事时间 < 故事时间（几句话概括几年）
- **Ellipsis（省略）**：叙事时间 = 0，故事时间 > 0（直接跳过一段时间）
- **Pause（停顿）**：叙事时间 > 0，故事时间 = 0（描写、评论——故事未推进）
- **Stretch（拉伸）**：叙事时间 >> 故事时间（慢动作——罕见，意识流常用）

### 2. 系统现有内容

| 要素 | 文件 | 状态 |
|------|------|------|
| 任何 Duration 类型 | — | **完全不存在** |
| `NarrativeEllipsis`（corpus 中非渲染的叙事间隙） | `packages/core/src/types/corpus.ts:33-66` | 是**语料诊断类型**（非渲染节点），与 Genette 的省略完全不同 |
| 约 400 词默认场景长度 | 各处 | 纯工程默认值，无叙事学模型 |

**Distinction（关键区分）**：`NarrativeEllipsis` 表示"没有 prose 渲染的时段"——它跳过了渲染，是语料层面的占位符。Genette 的 ellipsis 恰恰是被**渲染**的——文本存在，但它告诉你时间过去了。`NarrativeEllipsis` 不进入 prose 生成流程，永远不可能成为 Duration 模型。

### 3. 缺失内容

- **无 `durationType` 枚举**（scene/summary/ellipsis/pause/stretch）——完全空白
- **无 ellipsis duration 字段**——不仅跳过时间，还要记录跨度和类型（明确省略/暗示省略）
- **无 pause 模型**——描写、作者介入、哲学思考是一种有意的叙事策略，不是默认场景填充
- **无 stretch 模型**——意识流、关键时刻放大，完全没有建模可能性
- **无场景级时间膨胀/压缩系数**——目前仅有 storyTime/narrationTime 两对时间戳，但没有任何"这段用了____叙事时间讲____故事时间"的关系定义
- **Zod schema 等全部空白**

### 4. 红楼梦反例（证明 Duration 不是现代小说特有）

红楼梦极其精巧地使用了全部五种 Duration 变体：

- **Scene（场景）**：凤姐协理宁国府（第十三回）——近整回的实时对话和行动，故事时间约一天，叙事时间覆盖整回。
- **Summary（概要）**："宝玉自进园来，心满意足，再无别项可生贪求之心。每日只和姊妹丫鬟们一处，或读书，或写字，或弹琴下棋，作画吟诗……"——几句话概括了大观园入住后数月的日常生活。
- **Ellipsis（省略）**：从黛玉丧父（第十六回）到元春省亲（第十八回）之间——故事时间可能数月，但文本直接跳过了。
- **Pause（停顿）**：太虚幻境的判词和《红楼梦》曲子（第五回）——故事时间完全停止（宝玉在梦境中），叙事时间大量用于歌词和预言。同样，书中大量诗词插入也是 pause——故事不动，文本流动。
- **Stretch（拉伸）**：黛玉焚稿（第九十七回）——最后的诀别时刻，叙事时间远超可能的"实时"，心理时间被放大。

这些不是现代主义实验，是 18 世纪中国古典小说的常规技法。

### 5. 建议 schema 扩展

```typescript
// 在 types/discourse.ts 新增——完全新类型
export type DurationType = 'scene' | 'summary' | 'ellipsis' | 'pause' | 'stretch';

export interface DurationProfile {
  type: DurationType;
  /** 故事时间跨度（秒/分钟/小时/天/月/年） */
  storyDuration?: string;
  /** 叙事时间长度（词数或字节数） */
  narrativeLength?: number;
  /** 如果 type === 'ellipsis': 省略的明确性 */
  ellipsisClarity?: 'explicit' | 'implicit' | 'hypothetical';
  /** 故事时间压缩比（summary 时特别有意义） */
  compressionRatio?: number;
}

// NarrativeEvent 增加
duration?: DurationProfile;
```

---

## 维度三：Frequency（频率）—— 单叙 / 复叙 / 迭代叙

### 1. Genette 定义

Frequency 研究一个事件发生在故事中的次数与它在叙事中被讲述的次数之间的关系。三种关系：

- **Singulative（单叙）**：发生一次，讲一次（最普通的形式："我今天早上起晚了"）
- **Repeating（复叙）**：发生一次，讲多次（多个视角讲同一个事件："我起晚了" / "他起晚了" / "我们老板很不高兴"）
- **Iterative（迭代叙）**：发生多次，讲一次（用一次叙述概括反复发生的事件："每天早上我都起晚"）

### 2. 系统现有内容

| 要素 | 文件 | 状态 |
|------|------|------|
| 任何 Frequency 类型 | — | **完全不存在** |
| TODO.md 提及 Frequency 作为"已知缺口" | `docs/TODO.md:193` | 但放在 S3-research 下，视为 Kafka/Beckett 需求 |

### 3. 缺失内容

- **无 `frequencyType` 枚举**——完全空白
- **无 singulative/repeating/iterative 类型**——无法标记叙事与事件的关系
- **无 iterative scope 标记**——一次叙述覆盖了多少次实际发生
- **无 repeating 锚定**——多次叙述同一事件时，无法关联同一事件的多个 discourse 出现
- **Zod schema 等全部空白**

### 4. 红楼梦反例（证明 Frequency 不是现代小说特有）

- **Singulative（单叙）**：元春省亲（第十八回）——一生一次的事件，讲述一次。典型单叙。
- **Iterative（迭代叙）**：日常生活的重复描写——"贾母等每日在园中游玩，或下棋，或抹牌，或观花看景"——一次叙述覆盖了数月的日常。
- **Repeating（复叙）**：同一个事件被多次讲述——金钏投井一事，王夫人说一次、宝钗说一次、袭人说一次、贾环在贾政面前又说一次；宝玉挨打的"因"在不同人物口中呈现不同版本。这是 Genette 经典的 repeating narrative 分析对象。
- **混合 frequency**：刘姥姥三进荣国府，每次都是不同年份的类似事件——既是 singulative（每次独立），也可视为 iterative pattern（穷亲戚反复访亲靠友）。

### 5. 建议 schema 扩展

```typescript
// 在 types/discourse.ts 新增
export type FrequencyType = 'singulative' | 'repeating' | 'iterative';

export interface FrequencyProfile {
  type: FrequencyType;
  /** Repeating: 这个叙述对应故事中的哪次事件 */
  sourceEventCount?: number;   // 1 (singulative) | N (repeating when >1)
  /** Iterative: 一次叙述覆盖了多少次实际发生 */
  occurrenceCount?: number;
  /** Iterative: 时间范围 */
  iterationScope?: { start: string; end: string };
  /** Repeating: 关联的重复叙述的 event ids */
  otherOccurrences?: string[];
}

// NarrativeEvent 增加
frequency?: FrequencyProfile;
```

---

## 维度四：Mood（语态——叙事聚焦）—— 零聚焦 / 内聚焦 / 外聚焦

### 1. Genette 定义

Mood 回答"谁在看（感知）？"——即叙事的聚焦方式。Genette 分类三种：

- **Zero focalization（零聚焦）**：全知叙事，叙述者知道的比任何角色都多（"上帝视角"）
- **Internal focalization（内聚焦）**：通过某个角色的视角讲述，叙述者只知该角色所知——固定式（一个角色贯穿全文）/ 不定式（切换角色）/ 多重式（同一事件通过多个角色视角各讲一次）
- **External focalization（外聚焦）**：叙述者知道的比角色还少——只描述可见外部行为，不进入内心。如海明威《白象似的群山》——纯对话，无内心。

### 2. 系统现有内容

| 要素 | 文件 | 状态 |
|------|------|------|
| `NarratorProfile` 4 种类型（focalizer_bound/retrospective_entity/explicit_ledger/omniscient） | `packages/core/src/types/discourse.ts:79-83` | **类型存在** |
| `FocalizerBoundProfile`（接口） | `discourse.ts:109-112` | **类型存在**，建模了内聚焦（access=focalizer_only） |
| `NarratorAccess`（full/focalizer_only/limited） | `discourse.ts:90` | 类型存在 |
| `NarratorFidelity`（reliable/unreliable/ambiguous） | `discourse.ts:93` | 类型存在 |
| `NarratorProfile` Zod schema | `packages/core/src/schemas/discourse.ts:48-93` | **架构存在** |
| 工厂函数（createFocalizerBoundProfile 等 4 个） | `packages/core/src/state/discourse-replay.ts:75-130` | **实现存在** |
| `DiscourseState.narratorProfiles` | `discourse.ts:392` | 在 DiscourseState 中有占位 |
| `pov.type`（first_person/third_person_limited/omniscient） | `packages/core/src/types/event.ts:27-30` | 类型存在，**fixture 中使用** |
| `pov.character`（EntityId） | `event.ts:28` | fixture 中使用 |

**关键判断**：`NarratorProfile` 的类型、模式、实现全部存在，但 **没有任何一个 fixture YAML 使用它们**。所有 fixture 只用了 `pov.type` + `pov.character`。`NarratorProfile` 是 **dead types**——已实现但未接线。

### 3. 缺失内容

- **NarratorProfile YAML 输入路径不存在**——没有从 YAML 加载 narrator profile 的映射代码
- **pov.type 只有 3 种**——`first_person` / `third_person_limited` / `omniscient`——缺少 `external`（外聚焦——摄像机式只观察不进入内心）。Genette 的 external focalization 在现代小说之前就有了（海明威、部分 19 世纪场景）
- **没有不定式/多重式内聚焦的类型化支持**——目前 pov 是单值，不能表达"第 1–3 场黛眼看，第 4–6 场宝眼看，第 7 场多视角拼同一事件"
- **没有 focalization 持续时间或切换模式**——何时切换视角、切换类型（突然/过渡）

### 4. 红楼梦反例（证明 Mood 不是现代小说特有）

- **零聚焦（Omniscient/Zero focalization）**：红楼梦的主叙事——叙述者知道每个人的心思。如第三十回，叙述者同时知道宝玉在黛玉门外的愧疚、王夫人的懊悔、宝钗的尴尬、凤姐的观望——这是经典的 zero focalization。
- **内聚焦（Internal focalization）——不定式**：叙述频繁切换视角——从宝玉看黛玉（"两弯似蹙非蹙罥烟眉"）、从黛玉看宝玉（"面若中秋之月"）、从刘姥姥看贾府（第六回入府，以村妪之眼展示贾府气派）、从尤三姐看贾琏等。这是 internal focalization（variable）。
- **外聚焦（External focalization）局部应用**："这一日，尤氏来至荣府，见了贾珍，说道：'明日是老爷寿辰，那边珍大哥问可请什么客。'"——某些过渡段落只记录对话和行为，不进入内心。
- **聚焦切换（Focalization shift）**：第二回"冷子兴演说荣国府"——通过冷子兴的有限视角（兼外人之口）介绍贾府族谱，然后无缝切换回全知叙述。这种聚焦边界跨越是多层次叙事聚焦的经典案例。

### 5. 建议 schema 扩展

```typescript
// **紧急度最高**——NarratorProfile 需要从 dead type 转为 wired type。
// 第一步：在 EventFile 接口中增加 narratorProfile 引用路径，
// 允许 YAML 指向一个外部定义的 NarratorProfile，而非退化为 pov.type。

// 新增：EventFile 扩展
narratorProfileRef?: string;      // 指向 NarratorProfile id
focalization?: {
  type: 'zero' | 'internal' | 'external';
  variation?: 'fixed' | 'variable' | 'multiple'; // 内聚焦子类型
  characterSequence?: { character: EntityId; scope: string }[]; // 不定式
};
```

---

## 维度五：Voice（叙事声音——叙述者层级）—— 外叙事 / 内叙事 / 元叙事

### 1. Genette 定义

Voice 回答"谁在说话？"以及"在哪个叙事层面？"。叙述者相对于他所讲述的故事所处的层级：

- **Extradiegetic（外叙事层）**：第一层叙述者——叙述者在故事之外讲述故事。通常是"作者叙述者"（"我写到这，想起多年前……"）
- **Intradiegetic（内叙事层）**：故事内的角色讲述另一个故事。如《奥德赛》中奥德修斯在宴会上讲述自己的经历——他是故事内角色，也是次级故事的叙述者。
- **Metadiegetic（元叙事层）**：第二层叙事中的第二层叙事——故事中的故事中的故事。
- **Heterodiegetic（异故事）**：叙述者不在自己讲述的故事中（"上帝视角"）
- **Homodiegetic（同故事）**：叙述者是自己讲述的故事中的角色（"我"）

### 2. 系统现有内容

| 要素 | 文件 | 状态 |
|------|------|------|
| `NarratorProfile` 4 种类型 | `discourse.ts:79-83` | **类型存在**，但建模的是 narrator capabilities（访问/可信度/真实性），**不是叙事层级** |
| `RetrospectiveEntityProfile` | `discourse.ts:118-122` | 部分相关——建模了"事后回溯的叙述者"，涉及叙事层的时间方面 |
| `pov.type: first_person` | `event.ts:29` | fixture 使用（David Copperfield）——但混杂了 Mood 和 Voice（first_person 既是聚焦也是叙事层级信号） |
| **NarrativeLevel 类型（extradiegetic/intradiegetic/metadiegetic）** | — | **完全不存在** |
| **Homodiegetic/Heterodiegetic 类型** | — | **完全不存在** |
| David Copperfield fixture 使用 `first_person` + `character: narrator` | `fixtures/david-copperfield/` | 使用 crude 类型，无明确叙事层建模 |

### 3. 缺失内容

- **无 NarrativeLevel 枚举**——无法表达"故事中的故事"或"讲故事的角色"
- **无嵌套叙事层模型**——无法表达"外层叙述者→内层角色叙述者→元层故事"
- **NarratorProfile 4 种类型与叙事层正交**——`omniscient` 既可以是 extradiegetic（传统的上帝叙述者），也可以是 intradiegetic（故事内全知者如《天方夜谭》的山鲁佐德）。当前类型系统混合了能力（access 等）和层级，但层级部分缺失
- **无 homodiegetic/heterodiegetic 区分**——无法区分"我在说我的故事"和"我在说别人的故事"
- **无叙事层跨越事件**——如外叙层直接进入内叙层（导演式介入）

### 4. 红楼梦反例（证明 Voice 不是现代小说特有）

红楼梦拥有多层嵌套叙事，是 Genette Voice 分析的经典对象：

- **Extradiegetic（外叙事层）**：第一回"作者自云曾历过一番梦幻之后，故将真事隐去……"——这是外叙事层的作者叙述者。空空道人、石头、曹雪芹的命名游戏是 extradiegetic 层次的复杂化。
- **Intradiegetic（内叙事层）**：石头是通灵宝玉——它是故事内物体，却拥有叙述者身份；甄士隐在故事内讲述梦境（第一回）也是一个内层叙事。
- **Metadiegetic（元叙事层）**：石头上的偈子讲述了自己的来历（元叙事）；贾母在王夫人处讲"石头记"的故事（嵌套的笑话也是元叙事）；刘姥姥讲"雪地里抽柴火"的乡野传闻。
- **Homodiegetic 混杂**：第一人称段落（如宝玉自述梦境）与第三人称全知叙事并置——叙事者的自我定位在同一部小说中不断滑动。
- **嵌套层级边界模糊（Genette 的 metalepsis——叙事越界）**：最后用"史笔"直呼读者是更高层级的跨层叙事——"听曲文宝玉悟禅机"中戏文与人生互相映射。

### 5. 建议 schema 扩展

```typescript
// 在 types/discourse.ts 新增
export type NarrativeLevel = 'extradiegetic' | 'intradiegetic' | 'metadiegetic' | 'hypodiegetic';
export type DiegeticRelation = 'heterodiegetic' | 'homodiegetic';

export interface VoiceProfile {
  level: NarrativeLevel;                // 叙述者所在层级
  relation: DiegeticRelation;           // 叙述者是否在自己讲的故事中
  nestingDepth?: number;                // 嵌套深度（0=最外层）
  embeddedStory?: {                      // 如果有嵌入故事
    narratingCharacter: EntityId;       // 叙事者角色
    audienceCharacter?: EntityId;       // 受述者角色
  };
}

// 对现有 NarratorProfileBase 的扩展
export interface NarratorProfileBase {
  // ...现有字段
  voice?: VoiceProfile;
}

// EventFile 扩展
voice?: VoiceProfile;
```

---

## 汇总表

| 维度 | Genette 核心概念 | 系统状态 | 缺口严重性 | 归属层级 |
|------|-----------------|---------|-----------|---------|
| **Order（时序）** | analepsis/prolepsis, distance, amplitude | **已建**：`sceneType`（flashback/flashforward）+ `narrationTime`；**已接线**：zhu-fu fixture 使用 | 中等——功能够基本使用，缺 temporal distance 和 anachrony 分类 | **Base** |
| **Duration（时距）** | scene/summary/ellipsis/pause/stretch | **完全缺失**——`NarrativeEllipsis` 是语料类型，不是 Genette 省略 | **严重**——这是最大的盲区，整个系统中无任何 Duration 概念 | **Base** |
| **Frequency（频率）** | singulative/repeating/iterative | **完全缺失**——TODO 误认为这是 Kafka 需求 | **严重**——所有叙事都使用多种频率关系 | **Base** |
| **Mood（聚焦）** | zero/internal/external focalization | **Dead types**：`NarratorProfile`（focalizer_bound 等 4 类）类型 + 架构 + 工厂函数全存在，但**无 YAML 接线**，fixture 用 `pov.type` 替代 | 高——功能实现未接入管线，且缺少 external focalization 类型 | **Base** |
| **Voice（叙事声音）** | extradiegetic/intradiegetic/metadiegetic, homodiegetic/heterodiegetic | **部分已建**（NarratorProfile 建模了 narrator capabilities 但不是层级）；**类型缺失**（NarrativeLevel 枚举不存在）；**Dead types**（NarratorProfile 无接线） | 高——NarratorProfile 实现一半（能力），另一半（层级）完全缺；现有接口未接入 | **Base** |

### 分类说明

- **Base（基座）**：属于所有叙事，无论时代/文体/流派。红楼梦中全部使用。**应进入基础 schema audit，不应在 S3 中。**
- **S3（现代小说扩展）**：仅现代/后现代小说特有的结构（如 Kafka 的 `suspension`、`voiceDissonance`、`absenceProfile`）。

**核心结论**：Genette 的五维度全部应标注为 Base。S3-research 中的"第 1 层——叙事学 survey"（`docs/TODO.md:191-193`）当前把 Frequency 和 Narrative Level 放在 Kafka/Beckett 语境下看待，这是**误分类**。Genette 描述任何叙事的基础结构——红楼梦（18 世纪古典小说）同时使用全部五维度。S3 应该只保留 S3-research 中"第 2 层（现代主义/后现代批评 survey）"和"第 3 层（多作品 survey）"的内容。

---

## 建议优先级

### 立即（Stage 2 基础）
1. **Duration**：新增 `DurationProfile` 类型 + schema（从头建模）
2. **Frequency**：新增 `FrequencyProfile` 类型 + schema（从头建模）

### 中等（Stage 2）
3. **Mood — Wire NarratorProfile**：打通 YAML 加载路径，使 fixture 可引用 NarratorProfile 而非退化到 `pov.type`
4. **Voice — 新增 NarrativeLevel**：为现存 NarratorProfile 补充层级字段

### 增强
5. **Order**：新增 `Anachrony` 接口按 Genette 分类细化错时类型
6. **Voice — 嵌套模型**：支持故事中故事的叙事层级建模
