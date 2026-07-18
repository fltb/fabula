# 扩展 Pass 2 — 添加 AnalysisResult 块

> ~350 字 — 向 LLM Pass 2 输出添加新的结构化分析块的指南。

Pass 2 生成结构化的 JSON 分析（`AnalysisResult`），供后渲染验证器使用。添加一个新块需要修改四个文件并创建一个消费者验证器。

## 第 1 步：添加 TypeScript 接口

编辑 `packages/core/src/types/analysis.ts`。定义你的块类型，并将其作为可选属性添加到 `AnalysisContent`：

```typescript
export interface RuleCheck {
  ruleId: string;
  violated: boolean;
  evidence: string;
  severity: 'minor' | 'major';
}

export interface AnalysisContent {
  // ... 现有字段 ...
  ruleChecks?: RuleCheck[];   // ← 新块
  knowledgeChecks?: KnowledgeCheck[];  // ← 另一个示例
}
```

## 第 2 步：添加 Zod schema

编辑 `packages/core/src/schemas/analysis.ts`。用 Zod schema 镜像接口：

```typescript
export const ruleCheckSchema = z.object({
  ruleId: z.string(),
  violated: z.boolean(),
  evidence: z.string(),
  severity: z.enum(['minor', 'major']),
});

export const analysisContentSchema = z.object({
  // ... 现有字段 ...
  ruleChecks: z.array(ruleCheckSchema).optional(),  // ← 新块
});
```

## 第 3 步：创建消费者验证器

每个块需要一个验证器，通过 `getAnalysisRequirements()` 声明该块。`packages/core/src/ai/prompts/render-analysis.ts` 中的 `buildDynamicJsonTemplate()` 函数会根据需求自动包含块——无需手动编辑提示模板。

```typescript
export class WorldRuleValidator implements Validator {
  getAnalysisRequirements() {
    return [{
      field: 'ruleChecks',
      schemaExample: { ruleId: 'R1', violated: false, evidence: '...', severity: 'minor' },
      instruction: 'ruleChecks: For each active world rule, check if the prose complies...',
    }];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const ruleChecks = input.analysis?.analysis.ruleChecks ?? [];
    // ... 检查违规情况 ...
  }
}
```

## 第 4 步：动态提示模板集成

`buildDynamicJsonTemplate()`（`render-analysis.ts` 的第 50 行）自动工作：

1. 从 `ResultAggregator.getAnalysisRequirements()` 收集需求
2. 按顶层字段分组（通过 `topField()` 按 `.` 分割）
3. 使用第一个需求的 `schemaExample` 作为 JSON 模板
4. 对于 `narrativeChecks`，合并所有消费者验证器的 `attributes`

无需修改模板——提示构建器是完全动态的。

## 端到端工作流程

```
Validator.getAnalysisRequirements()
  → ResultAggregator.getAnalysisRequirements() 合并所有需求，检测冲突
    → buildDynamicJsonTemplate() 根据合并后的需求生成 JSON schema
      → buildAnalysisPrompt() 使用动态 schema 渲染提示模板
        → LLM 生成 JSON
          → parseAnalysisJSON() 根据 analysisContentSchema 验证
            → Validator.validatePost() 使用解析后的块
```

## 示例：ruleChecks

- **类型：** `packages/core/src/types/analysis.ts:45` — `RuleCheck` 接口
- **Schema：** `packages/core/src/schemas/analysis.ts:40` — `ruleCheckSchema`
- **消费者：** `packages/core/src/validator/world-rule.ts` — `WorldRuleValidator`
