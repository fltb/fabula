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

**当前架构问题：** Pass 2 AnalysisResult 只含 postconditions/POV/inventedDetails/quality。**不含角色引用、物理描述、代词、名称、时态、冲突分析**。导致 9/11 个验证器自己用 regex 扫散文——这是脆弱的、CJK 文本上尤其不准确的做法。

### 2.4 成品：AnalysisResult 完整定义

整合现有 7 个块 + 新增 5 个块（来自本轮设计讨论）：

```typescript
// ============================================================================
// AnalysisResult — Pass 2 LLM 自检 JSON（成品定义）
// ============================================================================
// 原则：
//   - Pass 2 是自检层，不是数据提取层。LLM 自己比较，validator 读结果。
//   - 确定性事实 → validator 用 compareFact() 自己比
//   - 语义事实 → LLM 在 Pass 2 里比，validator 消费检查结果
//   - 提取型块（characterReferences）LLM 只需列出"文中有啥"
//   - 所有 block 在 Zod schema 里都是 optional — 一个 block 失败不影响其余

// ── 现有块（保留） ──

interface PostconditionAnalysis {
  covered: string[];      // "entityId.attribute" — 散文中覆盖了的后置条件
  dropped: string[];       // "entityId.attribute" — 散文中没提到的后置条件
}

interface ViolatedPrecondition {
  entityId: string;
  attribute: string;
  expectedValue: string;
  issue: string;
}

interface PreconditionAnalysis {
  violated: ViolatedPrecondition[];
}

interface POVAnalysis {
  consistent: boolean;
  leaks: string[];        // 侵入了其他角色内心思想的短语
}

interface InventedDetail {
  detail: string;
  severity: 'minor' | 'major';
}

interface QualityAnalysis {
  proseScore: number;     // 0-10
  maxScore: number;       // 固定 10
  strengths: string[];
  weaknesses: string[];
  estimatedWordCount: number;
}

// ── 新增块：LLM 自检（LLM 自己比较，validator 读 matchLevel） ──

type MatchLevel = 'exact' | 'similar' | 'absent' | 'contradicted';

interface NarrativeCheck {
  entityId: string;
  attribute: string;          // e.g. "emotionalState"
  hint: string;               // 来自 YAML narrativeHint — LLM 的语义锚点
  evidence: string;           // ★ 散文中的证据句子（必须引用原文）
  matchLevel: MatchLevel;     // LLM 自己的比较结论
}

interface AppearanceCheck {
  entityId: string;
  feature: string;            // e.g. "face", "build", "eyes", "hair", "clothing"
  declared: string;           // 来自角色定义 appearance — 声明的外貌
  evidence: string;           // ★ 散文证据
  matchLevel: MatchLevel;     // LLM 自己的比较结论
}

// ── 新增块：LLM 提取（LLM 列出"文中有啥"） ──

interface CharacterReference {
  entityId: string;
  namesUsed: string[];     // 散文里用来指代此角色的所有名称/代词/短语
                           // 不含 pronounCount, dialogueLines — LLM 不会数数
}

// ── 新增块：单一判断 ──

type TenseDetected = 'past' | 'present' | 'mixed';

interface ConflictAnalysis {
  primaryType: string;          // e.g. "person_vs_society"
  resolutionAchieved: boolean;  // 场景结束时冲突是否解决了
}

// ── 顶层 ──

interface AnalysisContent {
  // —— 现有 ——
  postconditions: PostconditionAnalysis;
  preconditions: PreconditionAnalysis;
  pov: POVAnalysis;
  inventedDetails: InventedDetail[];
  quality: QualityAnalysis;
  threadProgressAchieved: string[];    // thread IDs
  foreshadowingDeployed: string[];     // foreshadowing IDs

  // —— 新增：LLM 自检 ——
  narrativeChecks?: NarrativeCheck[];      // narrativeHint 事实的 Pass 2 检查结果
  appearanceChecks?: AppearanceCheck[];    // 角色外貌的 Pass 2 检查结果

  // —— 新增：LLM 提取 ——
  characterReferences?: CharacterReference[];  // 散文中的角色指代
  tenseDetected?: TenseDetected;              // 散文实际时态
  conflictAnalysis?: ConflictAnalysis;        // 冲突分析
}

interface AnalysisResult {
  eventId: string;
  analysis: AnalysisContent;
}
```

**验证器消费映射：**

| 验证器 | 消费 Pass 2 块 | 消费方式 |
|---|---|---|
| Causality | `postconditions.covered/dropped` | 现有 |
| POV | `pov.consistent/leaks` | 现有 |
| FactualDetail | `inventedDetails` | 现有 |
| VoiceDrift | — | 确定性 + characterReferences 辅助 |
| Knowledge | — | 确定性 |
| Timeline | `tenseDetected` | 读单一值 vs 声明 tense |
| WorldRule | — | 确定性 |
| Foreshadowing | `foreshadowingDeployed` | 现有 |
| BranchMerge | — | 确定性 |
| CharacterState | — | 确定性（compareFact） |
| Reachability | `narrativeChecks[].matchLevel` | absent/contradicted → error |
| AliasValidator | `characterReferences[].namesUsed` ⊆ aliases ∪ {id} | absent alias → warn |
| AppearanceValidator | `appearanceChecks[].matchLevel` | absent/contradicted → error |
| PronounValidator | — | 确定性（他/她 vs gender） |
| TenseConsistencyValidator | `tenseDetected` | 现有 |
| ConflictValidator | `conflictAnalysis` | 读值 vs 声明 conflictType/resolutionType |

**5 个新块的 Zod schema（全部 required — 一个失败 = 整个 analysis 无效 = 修 prompt）：**

```typescript
const matchLevelSchema = z.enum(['exact', 'similar', 'absent', 'contradicted']);

const narrativeCheckSchema = z.object({
  entityId: z.string(),
  attribute: z.string(),
  hint: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});

const appearanceCheckSchema = z.object({
  entityId: z.string(),
  feature: z.string(),
  declared: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});

const characterReferenceSchema = z.object({
  entityId: z.string(),
  namesUsed: z.array(z.string()),
});

const tenseDetectedSchema = z.enum(['past', 'present', 'mixed']);

const conflictAnalysisSchema = z.object({
  primaryType: z.string(),
  resolutionAchieved: z.boolean(),
});
```

**Pass 2 重复输出验证（仅 bench/dev 模式，生产环境关闭——API 成本翻倍）：**

流水线中 Pass 2 跑两次（temp 0.3, seed 42），比较两次 JSON：
- 完全一致 → 通过，使用该 JSON
- 不一致 → 标记 `pass2_unstable: true`，记录差异字段。作为 prompt/schema 缺陷信号
- 目标：稳定 prompt 下两次输出 100% 一致

```typescript
// render.ts — 开发期检查
const result1 = await runPass2(input);  // temp 0.3, seed 42
const result2 = await runPass2(input);  // temp 0.3, seed 42

if (JSON.stringify(result1) !== JSON.stringify(result2)) {
  diffFields = findDiffFields(result1, result2);
  // 进入 review，标记哪些字段 LLM 输出不稳定
  // 长期目标：diffFields.length === 0
}
```

### 2.5 Pass 2 技术决策（参考业界标准）

| 决策 | 研究结论 | 处置 |
|---|---|---|
| **temperature** | **保持 0.3**。Anthropic RAG/summarization 推荐 0.2–0.5；ConStory-Checker 验证 pipeline 用 0.7 生成但 judge 用低温；LLM-as-Judge 论文（2603.28304）1M+ runs 证明低 temp = 更高一致性、更低错误率。0.1 对纯提取合适，但我们有 judgment 块（matchLevel）。 | 保持 0.3 |
| **seed** | OpenAI/Anthropic 都支持固定 seed。不保证 bit-identical（GPU 浮点非结合性）但显著提高跨运行一致性。 | `seed: 42` |
| **重试策略** | Instructor 库的 retry-with-feedback 模式：把 Zod 验证错误回传给 LLM → 首重试成功率 70-80%。当前盲重试（不告诉 LLM 错在哪）远低于此。 | 改为 retry-with-feedback |
| **maxTokens** | ConStory-Checker 报告 ~2K tokens。5 新块 + 现有 → ~3K。 | 从 4000 增至 6000 |
| **结构强制** | Provider 原生 structured output（OpenAI `response_format`, Anthropic `output_config.format`）消除 8-15% 畸形 JSON。xgrammar 对本地模型零开销。 | P1 升级，P0 保持 prompt+parse+Zod+retry |
| **prompt 拆分** | ConStory-Checker 用 5 个专用 prompt（每类别一个），比单一 prompt 效果更好但成本 5x。 | P0 保持单一 prompt，P2 考虑拆 2-3 个 |

**Pass 2 双模式输出策略 → 三种模式：**

Pass 2 根据 provider 能力自动选择输出模式，按强度三级降级：

| 级别 | 能力 | Provider 示例 | 机制 |
|---|---|---|---|
| **L1: json_schema** | 原生 schema 强制 | OpenAI `response_format`, Anthropic `output_config.format` | token 级约束解码，保证合法 JSON 且符合 schema |
| **L2: json_object** | 原生 JSON 模式（无 schema 强制） | DeepSeek `response_format: {type:'json_object'}` | 模型知道要输出 JSON，schema 由 prompt 中的示例指导。**要求 prompt 必须含 "json" 字样和 JSON 格式样例** — 我们的 prompt 已满足（`render-analysis.ts:74-121` 有完整示例） |
| **L3: prompt only** | 无原生支持 | Mock provider, 旧模型 | 纯 prompt engineering — 嵌入 schema 示例 + "Output ONLY valid JSON" + Zod 验证 + retry-with-feedback |

```
render.ts 逻辑:

const mode = detectOutputMode(provider);
// mode = 'json_schema' | 'json_object' | 'prompt'

switch (mode) {
  case 'json_schema':
    // L1 — schema 传 provider，token 级约束
    params.responseFormat = { type: 'json_schema', schema };
    break;

  case 'json_object':
    // L2 — 传 json_object 标志 + 允许额外推理开销
    params.responseFormat = { type: 'json_object' };
    params.maxTokens += 1000;  // DeepSeek 已知：偶尔返空，给更多 token 缓冲区
    // prompt 中已含 "json" 字样 + 完整 JSON 示例 ✓（render-analysis.ts:74-121）
    break;

  case 'prompt':
    // L3 — 纯 prompt，已有 schema 示例
    break;
}

raw = await provider.complete(params);
// 三种模式都过 Zod + retry-with-feedback
result = parseAnalysisJSON(raw);
```

**注意事项：**
- DeepSeek `json_object` 有概率返回空 content — 已知问题。`maxTokens` 多给 1000 缓冲区 + retry 兜底。
- L2 的 schema 约束靠 prompt 示例，不是 token 级。如果 LLM 产出的 JSON 结构不对，Zod 验证失败 → retry-with-feedback。

**与现有文件的关系：** `types/analysis.ts`、`schemas/analysis.ts`、`render-analysis.ts`、`render.ts` 四个文件改动。全部 new block required，现有 block 保持 required。项目开发阶段直接改。

### 2.6 Fact 双表示模型规格（P0i）

```typescript
// ── Fact 类型变更（entity.ts：value → optional，新增 narrativeHint） ──

interface Fact {
  id: string;
  entityId: string;
  attribute: string;
  value?: unknown;           // 确定性比较（boolean, enum, 简单 string）
  narrativeHint?: string;    // 叙事属性 — 输入 Pass 2，不做确定性比较
  confidence?: number;
  validity: FactValidity;
}
// value 和 narrativeHint 互斥 — Zod .refine() 强制

// ── 统一比较函数（entity/compare.ts — 新文件） ──

type CompareOutcome = 'match' | 'mismatch' | 'deferred';

function compareFact(fact: Fact, stateValue: unknown): CompareOutcome {
  if (fact.value !== undefined) {
    return stateValue === fact.value ? 'match' : 'mismatch';
  }
  if (fact.narrativeHint !== undefined) {
    return 'deferred';
  }
  throw new Error('Fact must have value or narrativeHint');
}

// ── 7 个 validator 统一消费模式 ──

for (const fact of event.postconditions) {
  const outcome = compareFact(fact, state.get(fact));
  switch (outcome) {
    case 'match':    continue;
    case 'mismatch': return error();
    case 'deferred':
      const check = pass2?.narrativeChecks?.find(
        c => c.entityId === fact.entityId && c.attribute === fact.attribute
      );
      if (!check || check.matchLevel === 'absent'
                || check.matchLevel === 'contradicted') return error();
  }
}
```
**约束：** narrativeHint 事实不写入 WorldState（`replay.ts` 跳过 `fact.value === undefined`）。

### 2.7 narrationTime 设计规格（P0c）

```
类型: StoryTimestamp（与 storyTime 相同，三变体 union）
Schema: EventFile 加 `narrationTime?: string`（YAML 自由文本）
Mapper: parseStoryTimestamp(narrationTime, timeAnchorsMap)
TimelineValidator: sceneType ≠ linear 时必须同时有 narrationTime 和 storyTime
DAG: narrationTime 不参与因果边。只用于 Assembler 可选排序。
```

---

## 第三部分：分批渲染系统（BatchRenderPipeline）

### 3.1 问题

`RenderPipeline.renderAll()` 一次性提交全部事件到 `ConcurrencyPool`（默认 5 并发）。对 6-20 个事件的单项目工作良好，但 bench 场景涉及：

- ChiNovelKE 150+ 角色、互动小说 100K 章节 → 全部结果 hold 在内存
- 无进度可见性 → bench 跑外部数据集时不知道进度
- 无流式输出 → 输出文件在全部渲染完成后一次性写入
- 无批次间状态优化入口

### 3.2 方案：滑动窗口分批渲染

新增 `BatchRenderPipeline` 编排层类，位于 `packages/core/src/batch-renderer.ts`。

**核心架构：**

```
BatchRenderPipeline（编排层 — batch-renderer.ts）
  │  组合（非继承）
  └─ RenderPipeline（渲染机制 — pipeline/render.ts，不变）
       └─ ConcurrencyPool（pool.ts，不变）
```

**关键设计决策：**

| 决策 | 选择 | 依据 |
|---|---|---|
| 放置层次 | `core/src/batch-renderer.ts`（编排层） | 分批调度是编排逻辑，不是渲染机制。与 api.ts 同级 |
| 组合方式 | 组合 RenderPipeline | 不继承，保持 RenderPipeline 纯渲染语义 |
| 调度模型 | 滑动窗口 | 2 批次在飞 → 完成一批补一批。AsyncIterator 对 bench 场景过度设计 |
| 批次大小 | 固定（可配，默认 10） | 2× pool concurrency = 池子满但不堆积 |
| 窗口大小 | 固定（可配，默认 2） | p-queue 标准，20 事件在飞，平衡吞吐和 API 压力 |

### 3.3 API

```typescript
// packages/core/src/batch-renderer.ts

export interface BatchConfig {
  batchSize: number;          // 默认 10
  windowSize: number;         // 默认 2
  failFast?: boolean;         // 默认 true（false → 单批失败继续下一批）
  onProgress?: (event: BatchProgressEvent) => void;
  onBeforeBatch?: (batch: RenderJob[], index: number) => Promise<void>;
  onAfterBatch?: (results: RenderSceneResult[], index: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface BatchProgressEvent {
  batchIndex: number;
  totalBatches: number;
  completedInBatch: number;
  totalCompleted: number;
  totalJobs: number;
  elapsedMs: number;
  batchResults: RenderSceneResult[];
}

export interface BatchResult {
  results: RenderSceneResult[];
  completed: boolean;     // false = 提前终止
  stats: BatchStats;
}

export interface BatchStats {
  totalJobs: number;
  totalBatches: number;
  completedBatches: number;
  cacheHits: number;
  cacheMisses: number;
  totalErrors: number;
  totalAttempts: number;
  elapsedMs: number;
  aborted: boolean;
}

export class BatchRenderPipeline {
  constructor(pipeline: RenderPipeline);
  async renderBatched(jobs: RenderJob[], config: BatchConfig): Promise<BatchResult>;
  abort(): void;
}
```

### 3.4 滑动窗口算法

```
输入: jobs[], batchSize, windowSize
输出: BatchResult

1. batches = chunk(jobs, batchSize)          // 拆批
2. inFlight = 0, nextToSubmit = 0, completedBatches = 0
3. for i in 0..min(windowSize, batches.length):
     submitBatch(batches[nextToSubmit++])    // 初始填充窗口
4. while completedBatches < batches.length:
     result = await Promise.race(inFlightPromises)
     inFlight--
     onAfterBatch(result) → 写盘 → 释放内存
     onProgress(...)
     if signal.aborted: break
     completedBatches++
     if nextToSubmit < batches.length:
       submitBatch(batches[nextToSubmit++])
```

批次内部仍使用 `ConcurrencyPool.all(batchJobs, renderScene)` → 享受现有有界并行。

### 3.5 错误处理

| 场景 | failFast=true | failFast=false |
|---|---|---|
| 单场景 Pass 1 失败（3 次 retry 后） | 该批标记失败 → 终止全部 | 该场景 error → 该批继续其他场景 → 跳下一批 |
| 单场景 Pass 2 parse 失败 | analysis=null，不影响 | 同左 |
| 单批全部场景失败 | 终止全部 | 跳过该批，继续 |
| abort() | 飞行批次完成后停止，completed=false | 同左 |

### 3.6 api.ts 集成

```typescript
// api.ts — renderNovel 新增可选参数
export async function renderNovel(
  projectDir: string,
  options?: {
    // ... 现有参数 ...
    batch?: BatchConfig;   // ★ 新增
  },
): Promise<{ results: MappedResult[]; errors: string[] }> {
  const pipeline = new RenderPipeline({ ... });

  if (options?.batch) {
    const batchRenderer = new BatchRenderPipeline(pipeline);
    const { results } = await batchRenderer.renderBatched(jobs, options.batch);
    // onAfterBatch 中已流式写盘
    return mapResults(results);
  }

  // 原模式不变
  const results = await pipeline.renderAll(jobs);
  buildAndWriteOutputs(storage, projectDir, jobs, results);
  return mapResults(results);
}
```

### 3.7 在 bench-rewrite 中的位置

属于 **P2（Bench 重构）的前置基础设施**。依赖链：

```
P0-tier3 (RenderPipeline 稳定)
  └── P0x BatchRenderPipeline (新增，不修改上游)
        └── P2 Bench 重构 (P2a regression.ts / variants.ts 调用)
```

工作量：

| 文件 | 行数 |
|---|---|
| `core/src/batch-renderer.ts` | ~250 |
| `core/src/api.ts`（+batch 分支） | ~30 |
| `core/src/index.ts`（导出） | ~5 |
| `core/tests/batch-renderer.test.ts` | ~200 |
| **合计** | **~485** |

不修改：`RenderPipeline`、`ConcurrencyPool`、`render-analysis.ts`、`cache/`、bench 包（P2 阶段接线）。

完整规格见 `docs/2026-07-17-batch-render-pipeline-design.md`。

---

## 第四部分：类型系统扩充 — 从数据集丢弃字段反推通用模型缺口

### 3.1 方法论

从 4 个业界数据集（ChiNovelKE、中国互动小说3K、Novel Agent SFT、STORAL）的丢弃字段出发，对照 PROJECT.md 的五层模型，分析每一层的缺失字段。目标：让系统能无损接收业界标准数据集的全部标注信息。

### 3.2 字段分类方法论

每个字段必须回答四个问题才能列入计划：

1. **它进入管线的哪一层？** Schema → Mapper → StateManager → ContextCompiler → PromptAssembler → Validator
2. **它驱动什么计算？** 对 prose 生成/验证/状态管理有什么具体影响？
3. **如果缺失会怎样？** LLM 幻觉？验证器盲区？上下文浪费？
4. **MVI（最小可行实现）是什么？** 最小代价让它产生价值

**三类字段：**
- **COMPUTATIONAL** — 被管线消费，影响 prose 生成或验证
- **PURELY METADATA** — 只存储，不参与计算（CLI/MCP 用）
- **REDUNDANT** — 系统已有等价字段，不需要新增

### 3.3 字段分析：COMPUTATIONAL（全部必做，无优先级差）

#### genre — 修复现有 bug（非新增字段）

- **管线层**: ProjectConfig → SystemContext(L1) → PromptAssembler → VoiceDriftDetector
- **计算**: SystemContext 的 `genre` 字段当前硬编码为 `'fantasy'`（`assembler.ts:62`）— **所有项目都拿到"幻想"题材的系统提示**。题材驱动 LLM 的词汇选择、世界观构建、VoiceDriftDetector 的时代词汇检查。
- **缺失后果**: 武侠项目被 LLM 当幻想写。VoiceDriftDetector 的古语/现代词检查无视题材上下文。
- **MVI**: 从 ProjectConfig 读取 `genre`，移除硬编码。SystemContext 正确注入。5 分钟修复。
- **分类**: REDUNDANT — 字段已存在，需要激活。

#### tense — 防止最常见的 prose 不一致

- **管线层**: ProjectConfig → PromptAssembler 指令 → 新建 TenseConsistencyValidator
- **计算**: PromptAssembler 当前不指定时态。LLM 默认过去时，但有些项目需要现在时（文学小说趋势）或混合时态（闪回在过去时叙事中用现在时）。时态混用是最常见的 LLM 散文错误。
- **缺失后果**: 现在时项目被 LLM 写过去时。闪回场景时态混乱。没有验证器检查。
- **MVI**: `tense?: 'past' | 'present'` 加到 ProjectConfig（项目级默认）+ NarrativeEvent（场景级覆盖）。PromptAssembler 注入 "Write in [tense] tense"。10 分钟。
- **全实现**: TenseConsistencyValidator — 扫描 prose 的时态一致。闪回场景自动切时态。

#### 3. discourseMode — 解决"LLM 每个场景都一个调"

- **管线层**: NarrativeEvent → PromptAssembler 指令分支 → VoiceDriftDetector
- **计算**: 当前 LLM 收到 `sceneBrief`（描述发生什么）但没有指示这个场景的**主要写作模式**。80% 对话场景 vs 80% 动作场景需要完全不同的散文构建方式。这是 prose 质量最关键的单一控制字段。
- **缺失后果**: "每个场景读起来都一样"——最常见的 LLM 小说失败模式。动作场景太多内心独白，描述场景太多对话。
- **MVI**: `discourseMode?: 'action' | 'dialogue' | 'description' | 'exposition' | 'reflection' | 'transition'`。PromptAssembler 按 mode 分支出不同提示指令。无验证器。
- **全实现**: DiscourseBalanceValidator 检查 prose 构成是否匹配声明模式（对话场景应有 >40% 对话行）。StyleGuidance 自动填充。

#### 4. arcPosition — 解决"高潮在第 20% 处"

- **管线层**: NarrativeEvent → PromptAssembler SceneSpecification → 新建 PacingValidator
- **计算**: `narrativeOrder` 给序列位置但没有戏剧功能。"高潮"场景需要峰值强度，"落幕"需要舒缓，但目前 LLM 每个场景都收到相同的提示。
- **缺失后果**: 高潮写得太早或太晚。上升动作和落幕没有强度差异。节奏控制失败——最常见的 LLM 长篇失败。
- **MVI**: `arcPosition?: 'opening' | 'rising' | 'climax' | 'falling' | 'denouement'`。PromptAssembler 注入 SceneSpecification。无验证器。
- **全实现**: PacingValidator — 高潮应在 60-85% 事件位置，开场应为事件 1-2。ISS 增加节奏维度。ContextAssembler 按 arcPosition 调整目标字数。

#### 5. importance / role — 激活现有字段（非新增）

- **管线层**: CharacterDefinition.role → RelevanceEngine 新增 importanceBonus 维度 → ContextAssembler
- **计算**: RelevanceEngine 当前 8 维度评分中**没有叙事重要性维度**。一个高空间邻近度的背景角色可能比不在场的反派得分更高。`role` 字段（`'minor' | 'supporting' | 'antagonist' | 'background'`）存在但未被 RelevanceEngine 消费。
- **缺失后果**: 上下文包被背景角色泛滥，重要角色在 token 预算竞争中输掉。
- **MVI**: RelevanceEngine 新增 `importanceBonus` 维度：protagonist=+0.3, major=+0.2, antagonist=+0.25（反派即使不在场也需要上下文）。不新增字段。
- **分类**: REDUNDANT — 字段已存在，需要激活。

#### 6. appearance — 修复 #1 LLM 幻觉类别（物理描述不一致）

- **管线层**: CharacterDefinition → ContextAssembler CharacterSnapshot → FactualDetailValidator
- **计算**: 系统当前**没有外貌字段**。`description` 是通用描述。LLM 需要明确的物理属性来维持视觉一致性。外貌矛盾是最常见的 LLM 散文错误。
- **缺失后果**: 角色第 1 章"蓝眼睛"，第 3 章"棕色眼睛"。系统无法检测。
- **MVI**: `appearance?: string`（自由文本）。ContextAssembler 注入 CharacterSnapshot。无验证器。
- **全实现**: 结构化 `{feature, value}[]`。FactualDetailValidator 做 feature 级散文匹配。Pass 2 分析提取散文中的物理描述比对。

#### 7. aliases[] — 修复 #2 幻觉类别（名字不一致）

- **管线层**: CharacterDefinition → EntityRegistry 反向查找 → RelevanceEngine → KnowledgeValidator
- **计算**: Entity 注册为 `magistrate`，但散文中出现"知县大人"。KnowledgeValidator 的散文扫描（`entityId.toLowerCase()` 匹配）当前只匹配 ID，不匹配别名。别名列表让引用解析可验证。
- **缺失后果**: LLM 为同一角色发明不一致的昵称/尊称。散文说"县令"在一处、"知县"在另一处——系统无法验证它们是同一人。
- **MVI**: `aliases?: string[]`（扁平字符串数组）。KnowledgeValidator 匹配任意别名。ContextAssembler 注入 "Also known as"。
- **全实现**: 结构化 `{name, type, context}[]`。RelevanceEngine 评分前做别名→entityId 解析。新建 AliasValidator。

#### 8. ruleClass — 规则严重度校准

- **管线层**: RuleDefinition → WorldRuleValidator
- **计算**: 当前所有规则被统一处理。违反重力（自然法则）和违反礼仪（社会规范）得到相同严重度。`ruleClass` 区分"这个规则可以打破（有叙事理由）"和"绝对不行"。
- **缺失后果**: LLM 不知道哪些规则可打破。验证器不能区分严重度——违反礼仪被标记为错误而不是警告。
- **MVI**: `ruleClass?: 'natural_law' | 'social_norm' | 'moral_principle' | 'game_rule' | 'legal_code'`。WorldRuleValidator 按类校准严重度。
- **全实现**: 类特定检查模式。ISS 世界构建维度按规则类加权。

#### 9. gender — CJK 代词/语体控制

- **管线层**: CharacterDefinition → ContextAssembler → VoiceDriftDetector → 新建 PronounValidator
- **计算**: 中文小说中性别语言是结构性的（非风格性的）——"他"vs"她"，古典中文的"妾"vs"我"。VoiceDriftDetector 的语体分类（archetype/traits regex）可以用性别作为额外的分类轴。
- **缺失后果**: LLM 对中文名用错代词。无法在古典中文小说中强制执行性别化语言模式。
- **MVI**: `gender?: string`。ContextAssembler 包含。无验证器。
- **全实现**: PronounConsistencyValidator。VoiceDriftDetector 按性别分层语体期望。

#### 10. synopsis — 长程连贯性

- **管线层**: ProjectConfig → SystemContext(L1) → PromptAssembler
- **计算**: 系统当前**没有项目级叙事摘要**。第 15 章的 LLM 只有前一个场景的上下文——全局情节在 20+ 章后漂移。
- **缺失后果**: LLM 在长篇小说中失去情节连贯性。每个场景只用局部上下文生成。
- **MVI**: `synopsis?: string`。ContextAssembler 注入 SystemContext。

#### 11. age — 年龄一致性 + 语体

- **管线层**: CharacterDefinition → ContextAssembler → VoiceDriftDetector → TimelineValidator
- **计算**: VoiceDriftDetector 可调整年龄层词汇期望。TimelineValidator 可检查年龄随 timeAnchor 增量的漂移。
- **缺失后果**: LLM 用成人词汇写 12 岁角色。无法捕捉"第 1 章 30 岁但在设定为 20 年后的第 5 章被描述为'年轻人'"的矛盾。
- **MVI**: `age?: number | string`。ContextAssembler 包含。无验证器。

#### 12. emotionalValence — 情感弧控制

- **管线层**: NarrativeEvent → PromptAssembler SceneSpecification → ReachabilityValidator
- **计算**: 情感状态在 `initialState` 中作为可变属性跟踪，但**没有场景级情感方向**。当前部分由 `styleGuidance.tone` 覆盖。
- **缺失后果**: LLM 每个场景写相似的情感调子。情感弧线平坦。
- **MVI**: `emotionalValence?: string`。PromptAssembler 在 SceneSpecification 中作为 tone 补充。无验证器。

#### 13. profession — 语体细化

- **管线层**: CharacterDefinition → VoiceDriftDetector
- **计算**: VoiceDriftDetector 当前只检查 archetype 和 traits。职业提供比自由文本 archetype 更可靠的分类轴。
- **缺失后果**: LLM 用相同职业范式写所有角色。
- **MVI**: `profession?: string`。ContextAssembler 包含。无验证器。

#### 14. $provenance — 信任校准

- **管线层**: 所有 Entity/Event → ContextAssembler 事实权重 → Validator 严重度校准 → CLI 报告
- **计算**: 系统当前**零溯源追踪**。手写角色描述和 AI 生成的角色描述信任度相同。ContextAssembler 在 token 预算紧张时不能区分来源可信度。
- **缺失后果**: 无法区分精选数据和推断数据。当 AI 生成与原始故事矛盾的角色描述时，没有溯源链来确认哪个是权威的。
- **MVI**: `$provenance?: { source: string; confidence: number }`。存储不计算。
- **全实现**: 完整链：{source, confidence, annotator, timestamp}。ContextAssembler 使用置信度加权。Validator 按置信度校准严重度。

### 3.4 字段分类：PURELY METADATA（存储，不参与计算）

| 字段 | 用途 |
|---|---|
| `tags[]` — string[] | CLI/MCP 项目筛选。不影响 prose 生成或验证。 |
| `status` — enum | CLI 工作流守卫。不影响管线。 |
| `target_audience` — string | 可选 PromptAssembler 修饰。影响低，目前不需要计算角色。 |

### 3.5 字段分类：REDUNDANT（已有等价字段，不新增）

| 提议字段 | 已有字段 | 处置 |
|---|---|---|
| `alignment` | `traits[]` + `archetype` | 道德对齐已被 traits 更灵活地捕捉。alignment 是一个 D&D 主义，对文学小说有限适用性。**不新增。** |
| `cast[]` | `participants.entities[]` (event.ts:33) | 除非语义不同（如 onScreen ≠ affected），否则冗余。需要明确语义区分才新增。**目前不新增。** |
| `genre` | `SystemContext.genre` (context.ts:41) | 字段已存在但硬编码为 'fantasy'。**修复 bug，不新增。** |
| `importance` | `role` (character.ts:13) | `role` 字段已存在但未被 RelevanceEngine 消费。**激活现有字段，不新增。** |
| `conflictType` | — (无现有字段) | PromptAssembler 指令分支（内部冲突→聚焦内心，外部冲突→聚焦行动）+ Pass 2 conflictAnalysis 验证。**新增。** |
| `resolutionType` | — (无现有字段) | PromptAssembler 指令（cliffhanger→结尾不解决）+ ConflictValidator 检查 Pass 2 resolutionAchieved。**新增。** |

### 3.6 全部 COMPUTATIONAL 字段（全部必做，执行顺序由依赖决定）

| 字段 | 处置 | 管线消费点 |
|---|---|---|
| genre | 激活现有（修 bug） | SystemContext → PromptAssembler → VoiceDriftDetector |
| tense | **新增** | PromptAssembler → TenseConsistencyValidator (Pass 2) |
| discourseMode | **新增** | PromptAssembler 指令分支 → DiscourseBalanceValidator (Pass 2) |
| arcPosition | **新增** | SceneSpecification → PromptAssembler → PacingValidator |
| conflictType | **新增** | PromptAssembler 指令分支 → ConflictValidator (Pass 2) |
| resolutionType | **新增** | PromptAssembler 指令 → ConflictValidator (Pass 2) |
| role→importance | 激活现有 | RelevanceEngine importanceBonus → ContextAssembler token 分配 |
| appearance | **新增** | CharacterSnapshot → PromptAssembler → AppearanceValidator (Pass 2) |
| aliases[] | **新增** | EntityRegistry 反向查找 → RelevanceEngine → AliasValidator (Pass 2) |
| ruleClass | **新增** | WorldRuleValidator 严重度校准 |
| gender | **新增** | VoiceDriftDetector → PronounValidator (Pass 2) |
| synopsis | **新增** | SystemContext(L1) → PromptAssembler |
| age | **新增** | VoiceDriftDetector → TimelineValidator |
| emotionalValence | **新增** | SceneSpecification → PromptAssembler → ReachabilityValidator |
| profession | **新增** | VoiceDriftDetector |
| $provenance | **新增** | ContextAssembler 置信度加权 → Validator 严重度校准 → CLI 溯源报告 |

**新增字段合计：13 个（开发阶段直接加进 schema，不做 backward compat）。激活现有字段：2 个。纯元数据：2 个（tags, status）。不新增：1 个（alignment）。**

---

## 第五部分：测试体系设计

### 4.1 测试层次

```
回归测试（一个已知故事的端到端正确性）
  ├ 祝福（线性叙事，框架+倒叙）
  │
变种测试（基于祝福的构造变异）
  ├ 分支变种（祝福 + 系统构造的分支路径）
  ├ 错误注入变种（祝福 + 故意的 YAML 错误 → 测验证器检测率）
  └ 极端变种（祝福 + 故意破坏一致性的极端数据）
  │
外部数据集基准（证明通用性）
  ├ ChiNovelKE → 角色/关系/地点加载基准
  ├ Novel Agent SFT → 事件骨架生成基准
  └ 中文互动小说 3K → 批量验证器吞吐基准
```

### 4.2 回归测试：祝福（单故事，线性，倒叙）

- 7 个事件（E0-E6），E2-E6 为 flashback
- 7 角色 / 4 地点 / 4 规则（四大绳索）/ 5 关系
- narrativeOrder → Assembler 拼装用
- storyTime DAG → StateManager 状态计算 + Validator 一致性检查
- 生成 prose → LLM 辅助人工对比原文

### 4.3 变种测试：分支（独立于回归测试）

基于祝福构造的分支变种，不是原始文本，而是系统构造的平行路径。

| 变种 | 内容 | 测试什么 |
|---|---|---|
| 分支变种 A | E1 分支点："我"诚实回答灵魂问题 → 祥林嫂得到安慰 → 不同结局 | BranchMergeValidator, ReachabilityValidator |
| 分支变种 B | E4 分支点：贺老六没死 → 祥林嫂不回鲁镇 → 不同人生轨迹 | 长分支链的 DAG 遍历 |
| 错误注入 20 例 | 在祝福 YAML 中故意引入时间线矛盾、角色状态违反、因果断裂等 | 11 个验证器的 recall/precision |
| 极端破坏 5 例 | 随机删除事件、交换 postconditions、制造死循环 | 系统鲁棒性边界 |

每个变种有独立的 fixture 目录（`fixtures/zhu-fu-variants/branch-A/` 等），不会污染主回归测试。

### 4.4 外部数据集基准

| 基准 | 数据集 | 指标 |
|---|---|---|
| EntityMapper 基准 | ChiNovelKE 150 角色 + 150 关系 | 加载成功率、别名解析精确率、去重正确率 |
| StateManager 基准 | ChiNovelKE 135 地点层级 | 地点层级重放正确率 |
| TimelineValidator 大规模 | 中文互动小说 3K 100K 章节 | 误报率（连续章节不应触发时间线错误） |
| RenderPipeline 吞吐 | Novel Agent SFT 40K 章节 | 缓存命中率、并发吞吐量、内存占用 |
| Consistency 对照 ConStory | 所有转换产物 | CED 对照 ConStory-Bench F1=0.678 |

### 4.5 打分标准（如何把验证器输出变成一个可比分数）

**学术来源：** 本文档引用的所有基准数据、公式、数值来自以下已发表论文和开源代码。每一处引用在文中标注来源编号。

#### 参考文献

| # | 基准/论文 | 完整标题 | 会议/期刊 | 年份 | 类型 |
|---|---|---|---|---|---|
| **[CB]** | ConStory-Bench | *Lost in Stories: Consistency Bugs in Long Story Generation by LLMs* | ACL 2026 Findings | 2026 | 一致性基准 |
| **[WB]** | WebNovelBench | *WebNovelBench: Benchmarking Large Language Models in Web Novel Generation* | EACL 2026 Findings | 2026 | 生成质量排名 |
| **[HANNA]** | HANNA (Human ANNotated) | *Of Human Criteria and Automatic Metrics: A Benchmark of the Evaluation of Story Generation* | COLING 2022 | 2022 | 元评估基准 |
| **[HANNA-LLM]** | HANNA TACL 后续 | *Do Language Models Enjoy Their Own Stories? Prompting Large Language Models for Automatic Story Evaluation* | TACL 2024 | 2024 | LLM-as-Judge |
| **[IS]** | INSTRUCTSCORE | *INSTRUCTSCORE: Explainable Text Generation Evaluation with Finegrained Feedback* | EMNLP 2023 | 2023 | 严重度权重 |
| **[OM]** | OpenMEVA | *OpenMEVA: A Benchmark for Evaluating Open-ended Story Generation Metrics* | ACL 2021 | 2021 | 元评估基准 |
| **[K21]** | Karpinska et al. | *The Perils of Using Mechanical Turk to Evaluate Open-Ended Text Generation* | EMNLP 2021 | 2021 | 标注方法论 |
| **[TEMP]** | Temperature paper | *The Necessity of Setting Temperature in LLM-as-a-Judge* | arXiv 2603.28304 | 2025 | 温度校准 |
| **[CCR]** | Cross-Context Review | *Cross-Context Review Removes Sycophancy from LLM Evaluations* | arXiv 2603.12123 | 2025 | 上下文分离验证 |

**链接：** HANNA → https://aclanthology.org/2022.coling-1.509/ · HANNA-LLM → https://aclanthology.org/2024.tacl-1.62/ · HANNA GitHub → https://github.com/dig-team/hanna-benchmark-asg · ConStory-Bench → https://aclanthology.org/2026.findings-acl.410/ · ConStory GitHub → https://github.com/Picrew/ConStory-Bench · WebNovelBench → https://aclanthology.org/2026.findings-eacl.94/ · WebNovelBench GitHub → https://github.com/OedonLestrange42/webnovelbench · INSTRUCTSCORE → https://aclanthology.org/2023.emnlp-main.719/

#### 数据流

```
11 验证器 run → ValidationResult { errors[], warnings[], infos[] }
    ↓ 每个 Issue.validatorName 标记来源
ResultAggregator 合并所有 issue
    ↓
Scoring module 消费 aggregated result + word count + groundTruth?
    ↓
BenchmarkReport { nCED, nCEDcategory, sCED, nScore, grade, pipelineF1? }
```

#### 前置：使用现有的 `ValidationIssue.validator` 和 `Validator.category`

当前 `ValidationIssue` 已有 `validator: string` 字段，`Validator` 接口已有 `category` 属性（同 5 枚举值）。不需要新增字段或静态映射表。

```typescript
// 现有（types/validator.ts:line 67, 86）— 直接用
interface ValidationIssue {
  validator: string;       // 已有 — 哪个验证器报告的
  severity: 'error' | 'warning' | 'info';
  message: string;
  // ...
}

interface Validator {
  category: 'characterization' | 'timeline_plot' | 'worldbuilding'
          | 'factual_detail' | 'narrative_style';  // 已有
}

// scoring.ts — 直接用 validator.category，不需要映射表
function countByCategory(issues: ValidationIssue[], validators: Validator[]): Record<string, number> {
  const map = new Map(validators.map(v => [v.name, v.category]));
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    const cat = map.get(issue.validator) ?? 'unknown';
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}
```

**注意：** 所有新增验证器（P5a-g）必须在构造函数中设置 `category`。现有验证器已有该字段。

---

#### 核心指标 1：N-CED（Novalistically Consistency Error Density）

与 ConStory-Bench [CB] 的 CED 完全同构——**不加权，不做分类系数**：

```
N_CED = (error+warning+info 总数) / (总字数 / 10000)
N_CED_category = (该类别 issue 数) / (总字数 / 10000)
```

```typescript
function computeNCED(issues: ValidationIssue[], wordCount: number) {
  const nCED = issues.length / (wordCount / 10000);

  const nCEDcategory: Record<string, number> = {};
  const errorsByCategory: Record<string, number> = {};
  for (const [cat, count] of Object.entries(countByCategory(issues))) {
    errorsByCategory[cat] = count;
    nCEDcategory[cat] = count / (wordCount / 10000);
  }

  return { nCED, nCEDcategory, errorsByCategory };
}

function countByCategory(issues: ValidationIssue[], validators: Validator[]): Record<string, number> {
  const vMap = new Map(validators.map(v => [v.name, v.category]));
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    const cat = vMap.get(issue.validator) ?? 'unknown';
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}
```

**分数解读：ConStory-Bench 对标参考（仅用于方向参考，非固定边界）**

ConStory-Bench 在 AI 生成故事上的 CED 数值：

| ConStory CED | 对应模型 |
|---|---|
| 0.113 | GPT-5-Reasoning |
| 0.520 | Claude-Sonnet-4.5 |
| 0.711 | GPT-4o |
| 3.419 | DeepSeek-R1 |

*(数据来自 [CB] Table 3)*
**注意：** 这是 ConStory-Bench 报告在他们自己的 AI 生成故事上的 CED，不是"人类故事的标准值"。

**注意：** 这是 ConStory-Bench 报告在他们自己的 AI 生成故事上的 CED，不是"人类故事的标准值"。我们不应该把 "< 0.2 = 优秀" 当成固定 grade。人类写的故事（如祝福原文）可能 N-CED ≈ 0（一致性完美），但不代表"优秀"——它只是没有检测到的错误。

---

#### 核心指标 2：S-CED（严重度加权）⚠️ EXPERIMENTAL — 待校准

N-CED 把 error 和 info 同等对待。S-CED 按 severity + category 双重加权：

```
S_CED = Σ(severity_weight · category_coefficient) / (字数 / 10000)
```

```typescript
// severity weight — 初始值来自 INSTRUCTSCORE [IS] 的 5:1 major:minor 比例
const SEVERITY_WEIGHT: Record<string, number> = {
  error: 1.0, warning: 0.3, info: 0.1,   // ⚠️ 初始值，待 logistic regression 校准
};

// category coefficient — 方向来自 WebNovelBench PCA，数值为初始估计
const CATEGORY_COEFFICIENT: Record<string, number> = {
  characterization: 1.3,   // WebNovelBench [WB] D5 PCA 载荷最高 (0.1377)
  timeline_plot:    1.2,   // ConStory-Bench [CB]: 最常见的错误类别
  worldbuilding:    1.0,
  factual_detail:   1.1,   // ConStory-Bench [CB]: 第二常见
  narrative_style:  0.8,   // HANNA [HANNA]: 对人类读者判断影响最小
  // ⚠️ [WB] 实际 PCA 载荷范围 0.115–0.138（max仅比min高20%）
  // 我们 0.8-1.3 的 spread 是 63%，可能过度放大类别差异
  // 真实系数需要在自己数据上跑 PCA 得出
};

function computeSCED(issues: ValidationIssue[], wordCount: number, validators: Validator[]): number {
  const vMap = new Map(validators.map(v => [v.name, v.category]));
  let weightedSum = 0;
  for (const issue of issues) {
    const sevW = SEVERITY_WEIGHT[issue.severity] ?? 1.0;
    const cat = vMap.get(issue.validator) ?? 'unknown';
    const catC = CATEGORY_COEFFICIENT[cat] ?? 1.0;
    weightedSum += sevW * catC;
  }
  return weightedSum / (wordCount / 10000);
}
```

**校准计划（P4 后执行）：**
1. Logistic regression on ≥100 human-rated samples: `logit(P) = β₀ + β_error·n_errors + β_warning·n_warnings + β_info·n_infos` → β ratio = data-calibrated severity weight
2. PCA on own data (≥20 stories) → first PC loadings = data-calibrated category coefficients
3. 校准前所有 S-CED 输出标记 `experimental: true`

---

#### 核心指标 3：Pipeline F1（验证器本身精度）

对标 ConStory-Checker [CB] F1=0.678（P=0.884, R=0.550）。需要错误注入夹具提供 ground truth：

```yaml
# fixtures/zhu-fu-variants/error-injection/001_timeline.yaml
injected:
  - entityId: "xianglin_sao"
    attribute: "storyTime"
    expectedValidator: "TimelineValidator"
    expectedSeverity: "error"
    description: "E3 storyTime is earlier than E2 but sceneType is linear"
```

```typescript
interface InjectedError {
  entityId: string;
  attribute: string;
  expectedValidator: string;
  expectedSeverity: 'error' | 'warning' | 'info';
  description: string;
}

function computeF1(
  detected: ValidationIssue[],
  groundTruth: InjectedError[],
): { precision: number; recall: number; f1: number } {
  let tp = 0, fn = 0;

  for (const injection of groundTruth) {
    const flagged = detected.some(i =>
      i.validator === injection.expectedValidator &&
      i.severity === injection.expectedSeverity
    );
    flagged ? tp++ : fn++;
  }

  // FP = 报告的但不匹配任何 injected error 的 issue
  // 注意：验证器可能正确发现注入错误之外的 pre-existing 错误
  // → 需要先跑一轮 baseline（干净夹具），再从注入测试里减去 baselineFP
  const fp = detected.length - tp;

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0
           : 2 * precision * recall / (precision + recall);

  return { precision, recall, f1 };
}
```

**FP 偏差处理：** Pipeline F1 分两轮：
1. **Baseline round** — 在干净祝福夹具上跑验证器，记录 `baselineFP`（夹具自身已有的真实问题数）
2. **Injection round** — 在注入夹具上跑，`fp = detected.length - tp - baselineFP`

ConStory-Checker = P=0.884, R=0.550, F1=0.678。我们目标：P > 0.95（确定性检查几乎不误报），R > 0.70（比 LLM judge 更高召回率）。

---

#### 核心指标 4：ECDF 百分位排名 ✅ STANDARD（WebNovelBench [WB] EACL 2026）

**原则：不做固定边界映射，用参考语料的经验分布。**

```
ECDF(x) = (1/N) · Σ I(s_i ≤ x)
```

解释：故事 x 的 S-CED 在参考语料（N 个人类创作故事）中的百分位位置。

```typescript
function computePercentileRank(
  storySCED: number,
  referenceCorpus: number[],     // N 个参考故事的 S-CED
): { percentile: number; rank: string } {
  const better = referenceCorpus.filter(r => r <= storySCED).length;
  const percentile = better / referenceCorpus.length;

  // 简易描述（纯描述性，无固定边界）
  const rank = percentile >= 0.95 ? 'top 5%'
             : percentile >= 0.75 ? 'top quartile'
             : percentile >= 0.50 ? 'above median'
             : percentile >= 0.25 ? 'below median'
             : 'bottom quartile';

  return { percentile, rank };
}
```

**参考语料 fallback：** 如果外部数据集不足以构建可靠分布，用自参照 ECDF——同一批 benchmark run 里的多个故事相互比较。"

---

#### 核心指标 5：Per-Validator N-CED（调试粒度）

类别级 CED 把 3-4 个验证器合并为一个数字。需要看单个验证器的贡献：

```typescript
interface PerValidatorBreakdown {
  validator: string;
  category: string;
  errors: number;  warnings: number;  infos: number;
  nCED: number;    // 该验证器单独的错误密度
}
```

这个指标不对外报告——用于调试和理解"哪个验证器在拖分"。对应 HANNA 的分维度分析风格。

#### 核心指标 6：Severity-Level N-CED（不加权细粒度）

在 S-CED 用权重之前，先看纯 severity 分层数据：

```typescript
interface SeverityLevelCED {
  error_N_CED: number;     // error 级别 issue 的 N-CED
  warning_N_CED: number;
  info_N_CED: number;
}
```

不加任何加权，纯粹展示 severity 分布。S-CED 是"一个数字"的总结，这个是"拆开看"的透明度。

---

#### 核心指标 7：HANNA 兼容相关系数 🎯 最终验证目标

**对标 HANNA [HANNA] + [HANNA-LLM] — 故事级 Spearman ρ 与人类判断。**

这是所有指标中最重要的验证目标。HANNA [HANNA] 证明：
- 72 个 NLP 指标故事级最高 ρ < 0.4（[HANNA] Table 5）
- LLM-as-Judge（Beluga-13B）故事级 ρ = 0.25（[HANNA-LLM]）
- 72 个指标里**没有一个**基于结构化叙事状态（全部基于平面文本 ner）

我们的验证器基于 event-sourced state，这是完全不同的信息维度。

```typescript
function computeHANNACompatibleCorrelation(
  storyScores: { storyId: string; nCED: number; humanScore: number }[],
): { spearmanRho: number; kendallTau: number; pValue: number } {
  const nCEDs = storyScores.map(s => s.nCED);
  const humanScores = storyScores.map(s => s.humanScore);

  // Spearman ρ — HANNA 主指标
  const rho = spearmanr(nCEDs, humanScores);

  // Kendall τ — HANNA 原文用的主系数
  const tau = kendalltau(nCEDs, humanScores);

  return {
    spearmanRho: rho.statistic,
    kendallTau: tau.statistic,
    pValue: rho.pvalue,
  };
}
```

**衰减修正（关键——来自心理测量学标准，被 [HANNA] 数据证实）：**

```
disattenuated_ρ = observed_ρ / √(ICC)

如果 ICC(Coherence) = 0.29（HANNA 的数据）:
  observed_ρ = 0.35  →  disattenuated = 0.35 / √0.29 = 0.65
  → 这个指标解释了 65% 的非噪声方差——接近理论极限

如果 ICC(Coherence) 未知（我们自己的数据）:
  → 标注时 ≥5 个工人，先算 ICC，再修正
```

**验证路径（分阶段）：**

| 阶段 | 数据 | 目标 |
|---|---|---|
| **开发期** | 祝福注入变种（20 例已知错误） | Pipeline F1。验证"验证器能检测到错误" |
| **基准期** | HANNA 96 prompts → 我们的系统生成 → 跑验证器 → 对比 HANNA 已有的人类标注 | Spearman ρ。验证"验证器分数和人类判断相关" |
| **论文期** | 自己标注的数据（5+ worker, ICC 计算 + 衰减修正） | 最高标准的可发表证据 |

**目标：** 在 HANNA 96 prompt 上 story-level Spearman ρ > 0.4（击败全部 72 个 NLP 指标 + 全部 LLM judge）。如果达到 ρ > 0.5，这是叙事评估领域的前所未有的结果——因为 HANNA 证明了所有现有方法都做不到。

---

#### 输出格式（`consistency.ts` → `BenchmarkReporter`）

```typescript
interface BenchmarkReport {
  storyId: string;
  totalWords: number;

  // —— 原始数据 ——
  errorsByCategory: Record<string, number>;
  severityBreakdown: { error: number; warning: number; info: number };
  perValidatorBreakdown: PerValidatorBreakdown[];  // 调试粒度

  // —— 派生指标 ——
  nCED: number;
  nCEDcategory: Record<string, number>;
  severityLevelCED: SeverityLevelCED;   // error/warning/info 分层的 N-CED
  sCED: number;
  sCEDexperimental: true;
  percentileRank: number;
  rankDescription: string;

  // —— validation targets ——
  pipelineF1?: { ... };
  hannaCorrelation?: {         // 仅在有人类标注时
    spearmanRho: number;
    kendallTau: number;
    disattenuatedRho?: number; // 衰减修正后
    iccGroundTruth?: number;   // 人类标注的 ICC
  };
}
```

输出 JSON 示例：

```json
{
  "storyId": "zhu-fu",
  "totalWords": 4200,
  "errorsByCategory": { "characterization": 1, "timeline_plot": 2, "worldbuilding": 0, "factual_detail": 0, "narrative_style": 1 },
  "severityBreakdown": { "error": 1, "warning": 2, "info": 1 },
  "severityLevelCED": { "error_N_CED": 0.24, "warning_N_CED": 0.48, "info_N_CED": 0.24 },
  "perValidatorBreakdown": [
    { "validator": "TimelineValidator", "category": "timeline_plot", "errors": 1, "nCED": 0.24 },
    { "validator": "CharacterStateValidator", "category": "characterization", "errors": 0, "nCED": 0 }
  ],
  "nCED": 0.95,
  "nCEDcategory": { "characterization": 0.24, "timeline_plot": 0.48, "worldbuilding": 0, "factual_detail": 0, "narrative_style": 0.24 },
  "sCED": 0.52,
  "sCEDexperimental": true,
  "percentileRank": 0.85,
  "rankDescription": "top quartile",
  "pipelineF1": {
    "precision": 0.96,
    "recall": 0.72,
    "f1": 0.82,
    "baselineFP": 2,
    "injectionTP": 18,
    "injectionFN": 2
  }
}
```

---

#### 实现位置

| 模块 | 文件 | 内容 |
|---|---|---|
| Validator 消费 | `Validator.category`（现有） | 类别标签 — 所有新 validator 的构造函数必须设此字段 |
| 打分核心 | `packages/bench/src/consistency.ts` | `computeNCED`, `computeSCED`, `computeF1`, `computePercentileRank`, `computeCorrelation` |
| 错误注入格式 | `fixtures/zhu-fu-variants/error-injection/*.yaml` | `injected[]` 带 `expectedValidator` + `expectedSeverity` |
| 报告输出 | `packages/bench/src/reporters.ts` | `BenchmarkReporter` 生成 JSON + Markdown |

---

## 第六部分：实现阶段（按依赖排序）

### 依赖图总览

```
P0a scene+C1-C4   ─┐
P0d genre fix     ─┤
P0h placeholder   ─┼─ 无外部依赖，可并行
P0f 全部类型字段  ─┘
    │
    ├──→ P0i Fact 双表示（依赖 types）
    ├──→ P0c narrationTime（依赖 EventFile types）
    ├──→ P0e role 激活（依赖 新 types）
    │
    ├──→ P0b DAG（依赖 Fact model）
    └──→ P0g Pass 2（依赖 types + Fact model）
              │
              ├──→ P5 新增 7 验证器（依赖 Pass 2 schema + compareFact）
              │
              └──→ P0x BatchRenderPipeline（依赖 RenderPipeline 稳定，P0-tier3 后）
                        │
                        └──→ P1 祝福夹具（依赖 types 稳定）
                                  │
                                  └──→ P2 Bench 重构（依赖 fixtures + validators + P0x）
                                            │
                                            ├──→ P3 外部适配器（依赖 bench + types）
                                            │         │
                                            │         └──→ P4 一致性基准（依赖适配器数据）
                                            │
                                            └──→ P6 管线增强（依赖 DAG + validators）
                                                      │
                                                      └──→ P7 管线完整（依赖 P6）
```

---

### 第一阶段：类型基础 + 独立修复（P0-tier1）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P0f** | **全部 13 个 computational 字段**（types + schemas + mapper 接线）。合并原 P2b。 | ~800 行 types + ~350 行管线 | 无 |
| **P0a** | 场景定义锁定 + C1-C4 矛盾修复 | ~200 行 | 无 |
| **P0d** | genre bug 修复（assembler.ts:62） | ~20 行 | 无 |
| **P0h** | 占位符 value 清零 — Zod schema 拒绝 `/^(changed|resolved|updated|affected|modified|altered)$/i` 匹配的 value；ISS `isPlaceholderValue` 改为警告（不再 error） | ~30 行 | 无 |

**可并行。** P0a/d/h 改动相互不重叠，P0f 新增 types 不冲突。

### 第二阶段：核心模型变更（P0-tier2）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P0i** | Fact 双表示模型（value? + narrativeHint?，compareFact()，StateManager 跳过 narrativeHint，Pass 2 narrativeChecks[]） | ~300 行 | P0f（types 已定） |
| **P0c** | narrationTime 完整实现（EventFile + schema + mapper + TimelineValidator） | ~200 行 | P0f（EventFile types） |
| **P0e** | role→importance 激活（RelevanceEngine importanceBonus） | ~50 行 | P0f（新 types） |

**可并行。** P0i/P0c/P0e 改不同文件。

### 第三阶段：计算层 + Pass 2（P0-tier3）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P0b** | DAG 因果边计算 + StateManager 拓扑排序重放 + Validator DAG 遍历 | ~400 行 | P0i（Fact model 稳定） |
| **P0g** | Pass 2 AnalysisResult 扩展（5 新块，temp 保持 0.3，retry-with-feedback，重复输出验证，seed=42，三级输出模式） | ~250 行 types + ~150 行 prompt + ~100 行 render | P0f + P0i |

**可并行。** P0b 和 P0g 改不同文件。

### 第四阶段：分批渲染系统（P0x）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P0x** | BatchRenderPipeline — 滑动窗口分批渲染（编排层，组合 RenderPipeline）。含 BatchRenderPipeline 类 + BatchConfig/BatchProgress/BatchStats 类型 + api.ts batch 分支 + 单元测试 | ~250 行 core + ~30 行 api + ~200 行 test | P0-tier3（RenderPipeline 稳定） |

**可并行于 P5。** P0x 只新增文件 + api.ts 加一个分支，不改 RenderPipeline/P5 代码。

### 第五阶段：新增验证器（P5）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P5a** | PacingValidator — arcPosition 序列 + 高潮位置 | ~200 行 | P0f, P0g |
| **P5b** | TenseConsistencyValidator — Pass 2 tenseDetected vs 声明 tense | ~150 行 | P0f, P0g |
| **P5c** | DiscourseBalanceValidator — Pass 2 对话/叙述比例 vs 声明 discourseMode | ~150 行 | P0f, P0g |
| **P5d** | AliasValidator — Pass 2 namesUsed ⊆ aliases ∪ {id} | ~100 行 | P0f, P0g |
| **P5e** | PronounValidator — 代词性别 vs gender | ~100 行 | P0f, P0g |
| **P5f** | AppearanceValidator — Pass 2 appearanceChecks.matchLevel | ~200 行 | P0f, P0g, P0i |
| **P5g** | ConflictValidator — Pass 2 conflictAnalysis vs 声明 | ~100 行 | P0f, P0g |

全部依赖 P0g 的 schema 和 P0i 的 compareFact。**可并行。**

### 第六阶段：祝福夹具 + 变种（P1）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P1a** | 《祝福》回归测试夹具（7 events + 7 chars + 4 locations + 4 rules + 5 rels） | 25 YAML | P0（types 稳定） |
| **P1b** | 祝福分支变种 + 错误注入变种 | 5 × ~5 文件 | P1a |
| **P1c** | 祝福原文对比（LLM 辅助人工审核） | 文档 | P1a |

### 第七阶段：Bench 重构（P2）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P2a** | Bench 重构 — regression.ts + variants.ts + consistency.ts + 新 reporters。调用 BatchRenderPipeline 做分批渲染 | ~600 行 | P1（fixtures）, P5（validators）, P0x（BatchRenderPipeline） |
| **P2c** | performance.ts 保留不变 | — | 无 |

### 第八阶段：外部数据集适配器（P3）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P3a** | ChiNovelKE adapter（机械映射 + provenance） | ~500 行 | P2a（bench） |
| **P3b** | Novel Agent SFT adapter | ~600 行 | P2a |
| **P3c** | 中文互动小说 3K adapter | ~700 行 | P2a |
| **P3d** | LLM 提取层 + 转换产物标注 | ~500 行 | P3a-c |

### 第九阶段：一致性基准 + 最终验证（P4）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P4a** | 一致性基准 — 7 指标系统（N-CED, S-CED, Pipeline F1, ECDF, Per-Validator, Severity-Level CED, HANNA ρ）+ ConStory 对照报告 | ~600 行 | P3, P2 |
| **P4b** | 最终验证（typecheck + all tests）+ Oracle 审查 | — | P4a |

### 第十阶段：管线增强（P6）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P6a** | Circuit breaker — 3-round escalation | ~150 行 | P0b（DAG）, P5 |
| **P6b** | 反向验证 MVI — 错误反馈注入重渲染提示 → 最多 2 轮修复 | ~250 行 | P5 |
| **P6c** | 祝福原文对比框架（LLM 辅助，单故事） | ~200 行 | P1c |
| **P6d** | cast 语义化 — `{onScreen, affected}` | ~150 行 | P0f |

### 第十一阶段：管线增强完整实现（P7）

| ID | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P7a** | target_audience 进管线 | ~80 行 | P6 |
| **P7b** | status 进 CLI | ~100 行 | P6 |
| **P7c** | 全功能反向验证（3 轮 + 策略选择 + 降级） | ~300 行 | P6b |
| **P7d** | DAG 可视化 MVI — `nova graph --format dot` | ~150 行 | P0b |

### 后续迭代（本轮不做）

| ID | 内容 | 原因 |
|---|---|---|
| F1 | 交互式 DAG 可视化（前端 UI） | 项目无前端层 |
| F2 | 全自动 LLM-as-Judge 多故事评估 pipeline | 研究型工作，P6c 的 MVI 已覆盖 |

---

## 第七部分：测试组织

```
fixtures/
  zhu-fu/                          # ✅ committed — 回归测试：祝福主线
    nova.yaml
    definitions/                   # 7 chars / 4 locations / 4 rules / 5 rels
    chapters/chapter_01/           # 7 events
  zhu-fu-variants/                 # ✅ committed — 变种测试（独立于主线）
    branch-A/                      # "我"诚实回答
    branch-B/                      # 贺老六没死
    error-injection/               # 20 个故意破坏的 YAML
    extreme-damage/                # 5 个极端破坏
  chi-novelke/                     # ❌ gitignored — 外部数据集下载产物
  novel-agent-sft/                 # ❌ gitignored — 外部数据集下载产物
  interactive-novels-3k/           # ❌ gitignored — 外部数据集下载产物

packages/bench/
  src/
    index.ts                       # runAll(), runRegression(), runVariants(), runExternalBench()
    regression.ts                  # 祝福回归测试（代替原 functional.ts）
    variants.ts                    # 分支变种 + 错误注入测试
    external.ts                    # ChiNovelKE / NovelAgentSFT / InteractiveNovels3K 基准
    consistency.ts                 # CED 指标 + ConStory 对照
    performance.ts                 # 保留（合成事件性能测试，与夹具无关）
    reporters.ts                   # 保留并扩展
    context-helper.ts              # 保留
    adapters/
      chinovelke.ts                # ChiNovelKE 机械映射层
      novel-agent-sft.ts           # Novel Agent SFT 机械映射层
      interactive-novels-3k.ts     # 中文互动小说 3K 机械映射层
      llm-extractor.ts             # LLM 提取层（共享）
      annotations.ts               # 转换产物标注（UNEXTRACTABLE/LLM-INFERRED/provenance）
```

---

## 总结：计划规模

| 类别 | 规模 |
|---|---|
| 架构修正 | DAG 因果边 + StateManager 拓扑排序 + Validator DAG 遍历 + Pass 2 AnalysisResult 扩展 + Fact 双表示模型（value/narrativeHint）+ 占位符清零 + 统一比较函数 + 3 个现有字段激活 |
| 矛盾修复 | C1-C4 四个（C5 不是矛盾 — maxTokens 10000 用于模型思考空间） |
| 新增类型字段 | 13 个 computational（开发阶段直接加 schema，不做 backward compat）+ 2 个纯元数据 |
| 打分标准 | 7 指标系统：N-CED ✅, S-CED ⚠️, Pipeline F1 ✅, ECDF ✅, Per-Validator N-CED ✅, Severity-Level CED ✅, HANNA 兼容 ρ 🎯 + 衰减修正 + 校准协议 |
| 激活现有字段 | genre, role→importance（非新增，修复/接线） |
| 新增验证器（Pass 2 消费） | 7 个：PacingValidator, TenseConsistencyValidator, DiscourseBalanceValidator, AliasValidator, PronounValidator, AppearanceValidator, ConflictValidator |
| 管线增强 | Circuit breaker, 反向验证（3 轮+策略+降级）, 祝福原文对比, cast 语义化, target_audience, status CLI, DAG DOT 输出 |
| 夹具文件 | 祝福主线 25 YAML + 4 变种集 ~25 YAML |
| Adapter 代码 | 3 adapter × ~600 行 + LLM 提取层 500 行 |
| Bench 代码 | 5 个新模块 + 2 个保留 |
| BatchRenderPipeline | ~485 行（新增编排层，core 通用） |
| 总阶段数 | 11 个阶段（P0-tier1/2/3 → P0x → P5 → P1 → P2 → P3 → P4 → P6 → P7），按依赖排序 |
| 总预估代码量 | ~11000 行 + ~50 YAML 文件 |
| 关键依赖链 | types → Fact model → DAG + Pass 2 → validators + BatchRenderPipeline → fixtures → bench → adapters → consistency |

## Git 管理规则

**进入仓库：**
- `fixtures/zhu-fu/` — 回归测试夹具
- `fixtures/zhu-fu-variants/` — 变种测试夹具
- `packages/bench/src/` — 全部 bench 源码（含 adapters）
- `packages/bench/tests/` — bench 测试代码

**不进入仓库（gitignore）：**
- 外部数据集下载产物（`fixtures/chi-novelke/`, `fixtures/novel-agent-sft/`, `fixtures/interactive-novels-3k/`）
- 转换产物（adapter 生成的 YAML、中间 JSON）
- Bench 运行结果（`packages/bench/**/results/` — 已有规则）
- 外部数据缓存（`packages/bench/data/`）

**.gitignore 新增：**
```
# External benchmark data — downloaded at runtime
fixtures/chi-novelke/
fixtures/novel-agent-sft/
fixtures/interactive-novels-3k/
packages/bench/data/
```

### 字段计算链示意（每个新字段如何参与管线）

```
genre ──────────────────→ SystemContext(L1) → PromptAssembler → LLM prose
                             ↓
                        VoiceDriftDetector（时代词汇检查）

tense ──────────────────→ PromptAssembler → LLM prose
                             ↓
                        TenseConsistencyValidator（散文时态检查）

discourseMode ─────────→ PromptAssembler 指令分支 → LLM prose
                             ↓
                        DiscourseBalanceValidator（对话/动作比例检查）

arcPosition ───────────→ SceneSpecification(L2) → PromptAssembler → LLM prose
                             ↓
                        PacingValidator（高潮位置、弧线分布）

appearance ────────────→ CharacterSnapshot(L3) → PromptAssembler → LLM prose
                             ↓
                        FactualDetailValidator（散文 vs 声明外貌对比）

aliases[] ─────────────→ EntityRegistry 反向查找 → RelevanceEngine（评分前解析）
                             ↓
                        KnowledgeValidator（散文别名匹配）

ruleClass ─────────────→ WorldRuleValidator（类特定严重度 + 可打破性）

gender ────────────────→ VoiceDriftDetector（性别语体分层）
                             ↓
                        PronounValidator（代词一致性）

synopsis ──────────────→ SystemContext(L1) → PromptAssembler（全局叙事上下文）

role → importance ─────→ RelevanceEngine（importanceBonus 维度）→ ContextAssembler（token 分配）

age ───────────────────→ VoiceDriftDetector（年龄层词汇期望）
                             ↓
                        TimelineValidator（年龄漂移 vs timeAnchor 增量）

emotionalValence ──────→ SceneSpecification(L2)（tone 补充）→ PromptAssembler
                             ↓
                        ReachabilityValidator（情感弧线跟踪）

profession ────────────→ VoiceDriftDetector（职业语体规则）

$provenance ───────────→ ContextAssembler（事实置信度加权）
                             ↓
                        Validator（严重度按置信度校准）
                             ↓
                        CLI（溯源分布报告）
```
