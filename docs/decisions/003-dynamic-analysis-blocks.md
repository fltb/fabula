# ADR-003: 动态分析块需求

**Date:** 2026-07  
**Status:** Accepted  
**Designer:** Novalistically Core Team  
**Files:** `packages/core/src/types/validator.ts:29-38`、`packages/core/src/ai/prompts/render-analysis.ts`、`packages/core/src/validator/aggregator.ts:275-311`

## Context

Pass 2 提示词模板最初硬编码了全部 14 个分析块。添加新的验证器需要同时编辑提示词模板和验证逻辑。未使用的分析块（例如没有消费者时仍存在的 `quality`）浪费了 LLM token 并降低了分析质量。

## Decision

每个验证器通过 `getAnalysisRequirements(): AnalysisBlockRequirement[]` 声明其所需的分析块：

```typescript
interface AnalysisBlockRequirement {
  field: string;            // JSON 字段路径，例如 'narrativeChecks'、'ruleChecks'
  attributes?: string[];    // 仅用于 narrativeChecks 风格的关键字型分析块
  schemaExample: unknown;   // 显示输出结构的 JSON 模板
  instruction: string;      // LLM 引导文本（必须以字段名开头）
}
```

`ResultAggregator.getAnalysisRequirements()`（aggregator.ts:275）合并所有验证器的需求：
- 按顶级字段分组（以 `.` 分割）
- 合并共享字段的 `attributes` 数组（例如 PacingValidator + AliasValidator 共享的 `narrativeChecks`）
- **在属性冲突时抛出异常**：如果两个验证器声明了同一个 `field` 上的相同 `attribute`
- 合并相同字段的 `instruction` 文本

`buildDynamicJsonTemplate()`（render-analysis.ts:50）根据合并后的需求生成 JSON schema：
- 只包含有活跃消费者的分析块
- 对于 `narrativeChecks`，属性被合并成以竖线分隔的列表
- 对于所有其他分析块，直接使用 `schemaExample`

## Consequences

- **Pass 2 提示词模板中零硬编码分析块**
- **新验证器自动注册**：只需实现 `getAnalysisRequirements()`，提示词构建器就会将该分析块包含在内
- **属性冲突在聚合器构建时被捕获** — 清晰的错误消息
- **未使用的分析块被排除**：`quality` 和 `threadProgressAchieved` 分析块仅在其验证器已注册时才出现
- **所有现有验证器已迁移**：请参考 `pacing.ts`、`world-rule.ts`、`quality.ts` 作为示例
