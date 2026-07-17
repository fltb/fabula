# Novalistically Bench 重写 — 系统设计总纲

**状态：设计锁定。技术决策全部内嵌。**

> 本文档是 Novalistically bench 重写项目的唯一权威设计来源。涵盖架构修正、验证模型、类型系统、打分标准、实现阶段。所有技术决策的取舍过程和依据已内嵌在各节中。

---

## 第一部分：架构修正 — 时间线 DAG 模型落地

### 1.1 原始设计 vs 当前实现

**PROJECT.md 定义（line 187）：**
> Story：真正发生的事情，按时间顺序排列 → **一棵 DAG（有向无环图）**

**当前实现：**
- 全部按 `narrativeOrder` 线性排序（replay.ts, mapper.ts, sorter.ts, event-store.ts, snapshot.ts, 所有 validator）
- `storyTime` 只是元数据标签，不参与排序
- 不存在任何 DAG 结构

**偏离程度：严重。** 原始设计的核心架构概念（时间 DAG）完全没有落地。

### 1.2 narrativeOrder 的正确定位

narrativeOrder 是**文本拼装顺序**（Discourse），不是**故事模型**的一部分。
- Assembler 用它排序场景输出 → 正确
- StateManager 用它重放状态 → **错误**，应该用 storyTime DAG
- Validator 用它找 prevEvent → **错误**，应该遍历 DAG 的因果边

**修正：** narrativeOrder 只保留在 Assembler 层。StateManager 和 Validator 不再依赖它做时间推理。

### 1.3 DAG 的隐式边（不需要显式 edge 对象）

PROJECT.md 的设计中，DAG 的边有三种来源：

| 边类型 | 来源 | 用途 |
|---|---|---|
| **因果边** | `eventA.postconditions[n] → eventB.preconditions[m]`（entity + attribute 匹配） | 原因必须在结果之前，StateManager 重放顺序 |
| **分支边** | `BranchPoint.triggerEvent → BranchPoint.branches[].targetEvent` | 分支决策 → 下一个事件 |
| **线程边** | `event.threadProgress[].thread → 下一个推进同一 thread 的事件` | 线程追踪、foreshadowing 验证 |

这三种边构成 Story DAG。当前系统**零处理**。

### 1.4 需要做什么（P0 修正）

| 修正项 | 文件 | 内容 |
|---|---|---|
| 因果边计算 | entity/mapper.ts 或 新建 state/dag.ts | 扫描所有事件的 preconditions/postconditions，构建 entity+attribute 匹配的因果边 |
| StateManager 重放改 DAG 拓扑排序 | state/replay.ts | `replay()` 改为拓扑排序执行（按因果边），而非 `narrativeOrder` 线性 |
| Validator 改 DAG 遍历 | validator/timeline.ts, validator/reachability.ts 等 | 线性 prevEvent 查找改为 DAG 因果边查找 |
| TimelineValidator 接收 timeAnchors | validator/timeline.ts | 修复空 Map bug |

---

## 第二部分：场景定义锁定（P0）

### 2.1 精确定义

```
Scene = 最小渲染单元 = 一个 NarrativeEvent

输入不变式（结构定义，与字数无关）:
  1. 连续时间 — 场景内时间不跳跃
  2. 单一地点 — 场景内不换地点  
  3. 固定角色群 — 进场角色在场景内不变
  4. 一个戏剧单元 — 2-3 个规划 beat 合并成一个场景动作

tense（每个场景一个时态，闪回是独立场景）:
  - project 级默认 tense（如 'past'），per-scene 可覆盖
  - flashback 场景是独立场景（sceneType: 'flashback'），tense 自动继承 project 默认
  - 一个场景 = 一个时态。场景内包含闪回段落 = 应拆为两个场景

字数（渲染参数，非结构定义）:
  - 系统默认: 400 words（render pipeline config）
  - 项目覆盖: nova.yaml 的 default_target_words
  - 场景覆盖: event YAML 的 target_words（个别场景需要更短/更长）
  - maxTokens: 10000（不动 — 模型需要思考空间，不按字数×4计算，不构成矛盾）

narrativeOrder:
  - 只用于 Assembler 按章节→场景顺序拼装输出
  - 不属于故事时间模型
```

### 2.2 五个矛盾修复

| ID | 矛盾 | 修复 |
|---|---|---|
| C1 | sceneType vs scene_type | 统一为 camelCase sceneType |
| C2 | 目标字数 500/800/1200 三处不一致 | 统一为 400 |
| C3 | one dramatic unit vs merge 2-3 beats | 场景 = 2-3 beat 合成的戏剧单元 |
| C4 | sceneType schema optional vs interface required | 统一 optional, 默认 linear |
| **不再是矛盾** | maxTokens 10000 vs target 字数 | maxTokens 不为输出字数服务 — 模型需要思考空间。保留 10000。 |

### 2.3 验证架构：Pass 2 LLM 自检 vs Validator 自扫散文

**当前架构问题：** Pass 2 AnalysisResult 只含 postconditions/POV/inventedDetails/quality。不含角色引用、物理描述、代词、名称、时态、冲突分析。导致 9/11 个验证器自己用 regex 扫散文——这是脆弱的、CJK 文本上尤其不准确的做法。

### 2.4 成品：AnalysisResult 完整定义

整合现有 7 个块 + 新增 5 个块（来自本轮设计讨论）。完整 TypeScript 接口定义和 Zod schema 见 deepwork 源文件。核心设计要点：

- Pass 2 是自检层，不是数据提取层。LLM 自己比较，validator 读结果。
- 确定性事实 → validator 用 compareFact() 自己比
- 语义事实 → LLM 在 Pass 2 里比，validator 消费检查结果
- 新增 5 个块：narrativeChecks（matchLevel 四级枚举）、appearanceChecks（同）、characterReferences（namesUsed 不含计数）、tenseDetected（past/present/mixed）、conflictAnalysis（primaryType + resolutionAchieved）
- 删除了 pronounCount/dialogueLines（LLM 不会数数）、physicalDescriptions（改为 LLM 自检模式 appearanceChecks）

### 2.5 Pass 2 技术决策（参考业界标准）

| 决策 | 处置 |
|---|---|
| **temperature** | 保持 0.3（Anthropic RAG 推荐 0.2-0.5，LLM-as-Judge 论文证实低 temp 更高一致性） |
| **seed** | `seed: 42`（提高跨运行一致性） |
| **重试策略** | 改为 retry-with-feedback（Instructor 模式：Zod 验证错误回传给 LLM → 首重试成功率 70-80%） |
| **maxTokens** | 从 4000 增至 6000 |
| **三级输出模式** | L1 json_schema（OpenAI/Anthropic）→ L2 json_object（DeepSeek）→ L3 prompt only |
| **重复输出验证** | 仅 bench/dev 模式，生产关闭。temp 0.3 + seed 42 跑两次比较 JSON |

### 2.6 Fact 双表示模型规格（P0i）

```typescript
interface Fact {
  value?: unknown;           // 确定性比较（boolean, enum, 简单 string）
  narrativeHint?: string;    // 叙事属性 — 输入 Pass 2
}
// value 和 narrativeHint 互斥

function compareFact(fact: Fact, stateValue: unknown): CompareOutcome {
  if (fact.value !== undefined) return stateValue === fact.value ? 'match' : 'mismatch';
  if (fact.narrativeHint !== undefined) return 'deferred';
}
```

narrativeHint 事实不写入 WorldState（replay.ts 跳过）。7 个 validator 统一用 `compareFact()` → match/mismatch/deferred 三路分支 → deferred 走 Pass 2 narrativeChecks。

### 2.7 narrationTime 设计规格（P0c）

- 类型: StoryTimestamp（与 storyTime 相同）
- Schema: EventFile 加 `narrationTime?: string`
- Mapper: parseStoryTimestamp 解析
- DAG: narrationTime 不参与因果边，只用于 Assembler 可选排序

---

## 第三部分：类型系统扩充

从 4 个业界数据集的丢弃字段反推通用模型缺口。13 个新增 computational 字段：tense, discourseMode, arcPosition, conflictType, resolutionType, appearance, aliases[], ruleClass, gender, synopsis, age, emotionalValence, profession。2 个激活现有字段（genre 修复 bug, role→importance）。2 个纯元数据（tags, status）。1 个不新增（alignment）。

完整字段分析（含管线消费点、缺失后果、MVI）见 deepwork 源文件 §3.3。

---

## 第四部分：测试体系设计

### 4.1 测试层次

```
回归测试（祝福）→ 变种测试（分支 + 错误注入 + 极端破坏）→ 外部数据集基准（ChiNovelKE + Novel Agent SFT + 中文互动小说 3K）
```

### 4.2 打分标准（7 个核心指标）

| # | 指标 | 对标 | 状态 |
|---|---|---|---|
| 1 | N-CED | ConStory-Bench [CB] ACL 2026 | ✅ 直接采纳 |
| 2 | S-CED | 综合 INSTRUCTSCORE + WebNovelBench | ⚠️ 初始值，待 PCA + logistic regression 校准 |
| 3 | Pipeline F1 | ConStory-Checker F1=0.678 | ✅ 标准 ML 指标 |
| 4 | ECDF 百分位排名 | WebNovelBench [WB] EACL 2026 | ✅ 替代固定 grade |
| 5 | Per-Validator N-CED | — | 调试用 |
| 6 | Severity-Level N-CED | — | 透明度 |
| 7 | HANNA 兼容 Spearman ρ | HANNA [HANNA] COLING 2022 | 🎯 最终验证目标 |

**HANNA 验证目标：** 72 个 NLP 指标故事级最高 ρ < 0.4。我们的事件溯源 state 提供完全不同的信息维度。目标 ρ > 0.4（击败全部现有方法），≥ 0.5 为前所未有的结果。

详细算法、校准计划、学术引用见 deepwork 源文件 §4.5。

---

## 第五部分：实现阶段（按依赖排序）

### 依赖图

```
P0f 类型字段 → P0i Fact 模型 → P0b DAG + P0g Pass 2
                                    ↓
                                  P5 验证器
                                    ↓
                    P1 祝福夹具 → P2 Bench → P3 适配器 → P4 一致性
```

### 10 个阶段概要

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0-tier1 | 类型基础：13 字段 + scene 修复 + genre bug + 占位符 | 无 |
| P0-tier2 | 核心模型：Fact 双表示 + narrationTime + role 激活 | P0-tier1 |
| P0-tier3 | 计算 + Pass 2：DAG 因果边 + Pass 2 扩展 | P0-tier2 |
| P5 | 7 新验证器（全消费 Pass 2） | P0-tier3 |
| P1 | 祝福夹具 + 变种 | P0-tier1 |
| P2 | Bench 重构 | P1 + P5 |
| P3 | 外部适配器 | P2 |
| P4 | 一致性基准 + 最终验证 | P3 |
| P6 | 管线增强（Circuit breaker + 反向验证 + cast + 原文对比） | P0-tier3 + P5 |
| P7 | 管线完整实现（audience + status + 全功能反向验证 + DAG 可视化） | P6 |

完整任务表（含每项代码量估计）见 deepwork 源文件 §5。

### 后续迭代（本轮不做）

- 交互式 DAG 可视化（需前端）
- 全自动 LLM-as-Judge 多故事评估（研究型，MVI 已覆盖）

---

## 第六部分：测试组织 + Git 管理

**进入仓库：** `fixtures/zhu-fu/`、`fixtures/zhu-fu-variants/`、`packages/bench/src/`、`packages/bench/tests/`

**不进入仓库：** 外部数据集下载产物、adapter 生成的 YAML、bench 运行结果、外部数据缓存

---

## 附录：外部来源参考

完整学术引用（9 篇，含 ACL/COLING/EMNLP/TACL/EACL 论文 + GitHub 仓库）见 deepwork 源文件 §4.5 参考文献表。

---

> 本文档的完整详细版本位于 `bench-rewrite-full.md`（~1300 行），包含完整 TypeScript 接口定义、Zod schema、算法实现伪代码、所有字段的管线消费点分析、7 个打分指标的完整计算代码。
> 本文档为精简版（~200 行），适合快速索引和决策回顾。