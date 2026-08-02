# 扩展 Pass 2 — 添加 AnalysisResult 块

> ~450 字 — 向 LLM Pass 2 输出添加新的结构化分析块的指南。

Pass 2 生成结构化的 JSON 分析（`AnalysisResult`），供后渲染验证器使用。当前 envelope 是 `{ eventId, protocol, observations, analysis }`：`protocol` 钉住精确测量配置，`observations` 按顶层字段记录 produced/abstained/ambiguous 处置，`analysis` 是动态 domain payload（语义详见下文“协议与观测流”）。添加一个新块需要定义块 schema、把它聚合进验证 schema，并创建一个消费者验证器。

## 第 1 步：在验证器中定义块类型与 Zod schema

块的 schema 归**验证器**所有：在 `packages/core/src/validator/{your-validator}.ts` 中定义 Zod schema，并用 `z.infer` 导出类型。块 schema **不再**放入 `packages/core/src/schemas/analysis.ts`（该文件只保留 `eventId`/`protocol`/`observations` envelope、observation disposition schema 与解析器），新块的类型也不放入 `packages/core/src/types/analysis.ts`。注意：该文件目前仍保留旧的块级类型（`NarrativeCheck`、`AppearanceCheck`、`CharacterReference`、`ConflictAnalysis`、`RuleCheck`、`KnowledgeCheck`、`PreconditionAnalysis`、`POVAnalysis`、`InventedDetail`、`QualityAnalysis`、`ChecklistResult`）以及 `AnalysisResult` 聚合——“块类型随验证器”只适用于**新增**块，旧类型没有迁移。参考实现：

```typescript
// packages/core/src/validator/world-rule.ts（参考实现）
export const ruleCheckSchema = z.object({
  ruleId: z.string(),
  violated: z.boolean(),
  evidence: z.string(),
  severity: z.enum(['minor', 'major']),
});

export type RuleCheck = z.infer<typeof ruleCheckSchema>;
```

## 第 2 步：注册聚合 schema

编辑 `packages/core/src/validator/index.ts`：把新块的 schema 导入并加入 `analysisContentSchema`（第 68 行）。该静态 schema 由所有 built-in 验证器的块 schema 聚合而成（当前 20 个字段），作为 built-in 合约的 Pass 2 JSON 解析基础；plugin 字段**不**登记到这里，而是通过 `ResultAggregator.getCombinedValidationSchema()` 动态加入（见第 4 步）：

```typescript
import { ruleCheckSchema } from './world-rule.js';
// ...
export const analysisContentSchema = z.object({
  // ... 现有块 ...
  ruleChecks: z.array(z.lazy(() => ruleCheckSchema)),  // ← 新块
});
```

## 第 3 步：创建消费者验证器

每个块需要一个验证器，通过 `getAnalysisRequirements()` 声明该块。需求对象包含 `field`、`schema`（第 1 步定义的 Zod schema，不是手写示例对象）和 `instruction`：

```typescript
export class WorldRuleValidator implements Validator {
  getAnalysisRequirements() {
    return [{
      field: 'ruleChecks',
      schema: z.array(ruleCheckSchema),
      instruction: 'ruleChecks: For each active world rule, check if the prose complies...',
    }];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const ruleChecks =
      z.array(ruleCheckSchema).safeParse(input.analysis?.analysis.ruleChecks).data ?? [];
    // ... 检查违规情况 ...
  }
}
```

然后按 built-in/plugin 两条路径注册（详见《添加验证器》第 4 步）：built-in 把 `new WorldRuleValidator()` 加入 `packages/core/src/validator/builtins.ts` 的 `createBuiltInValidators()` 数组，并从 `validator/index.ts` 导出；plugin 通过 `new ResultAggregator([...createBuiltInValidators(), new WorldRuleValidator()])` 注入，不改 Core 源文件。

## 第 4 步：动态提示模板集成

`buildDynamicJsonTemplate()`（`render-analysis.ts` 第 94 行）自动工作——无需手写 `schemaExample`：

1. 从 `ResultAggregator.getAnalysisRequirements()`（`aggregator.ts` 第 401 行，委托给 `getAnalysisContract()`，第 425 行）收集需求，按字段合并并检测冲突
2. 按顶层字段分组（通过 `topField()` 按 `.` 分割）
3. 调用 `zodExample(req.schema)`（`render-analysis.ts` 第 130 行的 `buildDynamicJsonTemplate()` 内，实现在 `packages/core/src/ai/util/zod-example.ts`）从该字段的 Zod schema 生成确定性 JSON 模板
4. 对于 `narrativeChecks`，合并所有消费者验证器的 `attributes` 并附加 `matchLevel`

模板为每个 active 顶层字段配一个 `observations` 条目（默认 `produced`），并携带真实 `protocol` 对象。无需修改模板——提示构建器完全动态。

## 协议与观测流（envelope 语义）

解析与校验路径（`packages/core/src/schemas/analysis.ts`）：

- **envelope**：`AnalysisResult` = `{ eventId, protocol, observations, analysis }`（`types/analysis.ts`）。`analysis` 是 `Record<string, unknown>` 动态 payload——plugin 字段在运行时进入，不改类型。
- **observations↔payload 配对**：每个 active 顶层字段必须有恰好一个 observation。`produced` 要求 `analysis[field]` 存在且通过块 schema；`abstained`/`ambiguous` 要求该 payload 缺席（`pairObservationsWithPayload()` 强制，schema 层 fail-closed）。
- **protocol fail-closed**：`protocol` 钉住测量配置（prose/schema/model/提示/采样/validator 策略）。解析时若提供了 `expectedProtocol`，逐字段比对，任何缺失/多余/不一致都使整个分析失败——模型永远看到并回显真实 protocol（两阶段构造：Phase A 用 sentinel 计算 `analysisPromptHash`，Phase B 才以真实 protocol 重建提示）。
- **证据校验**：`produced` observation 的 evidence quotes 必须是渲染散文的精确子串（解析器拿到 prose 时校验）。
- **无 regex fallback**：`stripFences()` 只剥离 markdown 围栏；JSON 解析失败即返回 null/错误，不回退到正则提取。
- **重试与耗尽**：`parseAnalysisJSONWithErrors()` 返回 `zodErrors`/`parseError`，pipeline 用结构化反馈重试（最多 4 个子尝试，拒绝盲试）；反馈尝试耗尽时该场景记录 “Pass 2 exhausted: …” 错误并进入 review/release 决策路径，不是所有外层处理立即终止。

## 端到端工作流程

```
Validator.getAnalysisRequirements()（返回自有 schema）
  → validator/index.ts 的 analysisContentSchema 聚合 built-in 块 schema（20 字段）
    → ResultAggregator.getAnalysisContract() 合并需求、检测冲突，产出动态 combinedSchema（含 plugin 字段）
      → buildDynamicJsonTemplate() 用 zodExample(req.schema) 生成 JSON 模板（配 observations + 真实 protocol）
        → buildAnalysisPrompt() 两阶段构造（Phase A sentinel 哈希 → Phase B 真实 protocol）渲染提示
          → LLM 生成 JSON
            → parseAnalysisJSONWithErrors()（schemas/analysis.ts）用 combinedSchema + expectedProtocol + prose 校验：
                协议 fail-closed 比对、observations↔payload 配对、证据精确子串；无 regex fallback
              → 失败则结构化反馈重试；耗尽后场景记录错误进入 review/release 路径
                → Validator.validatePost() 使用解析后的块
```

## 示例：ruleChecks

- **Schema/类型：** `packages/core/src/validator/world-rule.ts:14` — `ruleCheckSchema`；`:21` — `RuleCheck`（`z.infer`）
- **聚合：** `packages/core/src/validator/index.ts:68` — `analysisContentSchema`
- **需求声明：** `packages/core/src/validator/world-rule.ts:122` — `getAnalysisRequirements()`
- **消费者：** `packages/core/src/validator/world-rule.ts:23` — `WorldRuleValidator`
