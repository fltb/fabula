# 扩展 Pass 2 — 添加 AnalysisResult 块

> ~450 字 — 向 LLM Pass 2 输出添加新的结构化分析块的指南。

Pass 2 生成结构化的 JSON 分析（`AnalysisResult`），供后渲染验证器使用。添加一个新块需要修改两个文件并创建一个消费者验证器。

## 第 1 步：在验证器中定义块类型与 Zod schema

块的 schema 归**验证器所有**：在 `packages/core/src/validator/{your-validator}.ts` 中定义 Zod schema，并用 `z.infer` 导出类型。块 schema **不再**放入 `packages/core/src/schemas/analysis.ts`（该文件只保留 `eventId` 包装与解析器），新块的类型也不放入 `packages/core/src/types/analysis.ts`。注意：该文件目前仍保留旧的块级类型（`NarrativeCheck`、`AppearanceCheck`、`CharacterReference`、`ConflictAnalysis`、`RuleCheck`、`KnowledgeCheck`、`PreconditionAnalysis`、`POVAnalysis`、`InventedDetail`、`QualityAnalysis`、`ChecklistResult`）以及 `AnalysisResult` 聚合——“块类型随验证器”只适用于**新增**块，旧类型没有迁移。参考实现：

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

编辑 `packages/core/src/validator/index.ts`：把新块的 schema 导入并加入 `analysisContentSchema`（第 67 行）。它由所有内建验证器的块 schema 聚合而成，供 Pass 2 JSON 解析校验：

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

然后在 `packages/core/src/validator/aggregator.ts` 构造函数中注册 `new WorldRuleValidator()`，并从 `validator/index.ts` 导出。

## 第 4 步：动态提示模板集成

`buildDynamicJsonTemplate()`（`render-analysis.ts` 第 54 行）自动工作——无需手写 `schemaExample`：

1. 从 `ResultAggregator.getAnalysisRequirements()`（`aggregator.ts` 第 458 行）收集需求，按字段合并并检测冲突
2. 按顶层字段分组（通过 `topField()` 按 `.` 分割）
3. 调用 `zodExample(req.schema)`（`render-analysis.ts` 第 89 行，实现在 `packages/core/src/ai/util/zod-example.ts`）从该字段的 Zod schema 生成确定性 JSON 模板
4. 对于 `narrativeChecks`，合并所有消费者验证器的 `attributes` 并附加 `matchLevel`

无需修改模板——提示构建器完全动态。

## 端到端工作流程

```
Validator.getAnalysisRequirements()（返回自有 schema）
  → validator/index.ts 的 analysisContentSchema 聚合所有内建块 schema
    → ResultAggregator.getAnalysisRequirements() 合并需求，检测冲突
      → buildDynamicJsonTemplate() 用 zodExample(req.schema) 生成 JSON 模板
        → buildAnalysisPrompt() 使用动态模板渲染提示
          → LLM 生成 JSON
            → parseAnalysisJSON()（schemas/analysis.ts）用聚合 schema 验证
              → Validator.validatePost() 使用解析后的块
```

## 示例：ruleChecks

- **Schema/类型：** `packages/core/src/validator/world-rule.ts:17` — `ruleCheckSchema`；`:24` — `RuleCheck`（`z.infer`）
- **聚合：** `packages/core/src/validator/index.ts:67` — `analysisContentSchema`
- **需求声明：** `packages/core/src/validator/world-rule.ts:114` — `getAnalysisRequirements()`
- **消费者：** `packages/core/src/validator/world-rule.ts:26` — `WorldRuleValidator`
