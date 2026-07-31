# 添加验证器

> ~400 字 — 向 Novalistically 核心引擎添加新验证器的分步指南。

验证器是检查叙事输出质量的主要机制。每个验证器实现 `packages/core/src/types/validator.ts` 中的 `Validator` 接口，并注册到 `ResultAggregator`。

## 第 1 步：创建验证器文件

```
packages/core/src/validator/my-validator.ts
```

所有验证器都位于 `packages/core/src/validator/` 下。请参阅 `pacing.ts` 和 `world-rule.ts` 以获取完整的参考实现。

## 第 2 步：实现 Validator 接口

从 `../types/index.js` 导入：

```typescript
import type { PreRenderInput, PostRenderInput, Validator, ValidationIssue } from '../types/index.js';
import { makeIssue } from './base.js';

export class MyValidator implements Validator {
  name = 'my_validator';
  category = 'narrative_style' as const; // 必须初始化为一个具体字面量：
  // 'characterization' | 'factual_detail' | 'timeline_plot' | 'worldbuilding' | 'narrative_style' | 'prose_quality'
}
```

仓库的 TypeScript 配置启用了 `strict` 属性初始化检查，因此 `category` 必须像内置验证器（例如 `pacing.ts` 的 `category = 'narrative_style' as const`）那样用具体字面量初始化，而不是声明未赋值的联合类型。

该接口支持两个可选的检查方法：

- **`validatePre(input: PreRenderInput): ValidationIssue[]`** — 在渲染前对事件定义和世界状态进行结构性检查。`PreRenderInput` 提供 `event`、`worldState`、`events`、`entityRegistry`、`chapter`、`queryState`、`getKnowledge` 和 `getThreadProgress`（`eventStore`、`story` 可选）。

- **`validatePost(input: PostRenderInput): ValidationIssue[]`** — 使用 Pass 2 分析对渲染后的散文进行语义检查。`PostRenderInput` 提供 `event`、`worldState`、`prose`、`analysis`（已解析的 `AnalysisResult | null`）和 `chapter`（`entityRegistry`、`context` 可选）。

## 第 3 步：声明分析需求

如果你的验证器使用 Pass 2，请实现 `getAnalysisRequirements()`，返回 `AnalysisBlockRequirement[]`（定义于 `packages/core/src/types/validator.ts`）：

```typescript
import { z } from 'zod';
import { narrativeCheckSchema } from './schemas.js';

getAnalysisRequirements() {
  return [{
    field: 'narrativeChecks',
    attributes: ['my_attribute'],
    schema: z.array(narrativeCheckSchema),
    instruction: 'narrativeChecks[my_attribute]: Description of what to check...',
  }];
}
```

- **`field`** — 顶层 JSON 块名（例如 `'narrativeChecks'`、`'ruleChecks'`、`'postconditions'`）。**目前只支持顶层块**：`buildDynamicJsonTemplate()`（`packages/core/src/ai/prompts/render-analysis.ts`）与 `ResultAggregator.getAnalysisContract()`（`packages/core/src/validator/aggregator.ts`）都会把带点的路径截断为顶层段（`'pov.leaks'` → `'pov'`），并把你的 schema 安装为整个顶层块的值 schema——这与已有块（如 `pov`）冲突，或产生错误的 JSON 形状。若要约束 `pov` 下的子字段，必须提供整个 `pov` 块的 schema。
- **`attributes`** — 仅用于 `narrativeChecks` 风格的分块字段：指定 LLM 应生成的属性值。可选。
- **`schema`** — 该分析块的 Zod schema；Pass 2 的 JSON 模板和提示词示例由它自动生成
- **`instruction`** — 必须以字段名开头，为 LLM 提供详细指导

`ResultAggregator` 会按字段合并所有验证器的需求，并检测同一字段上属性和 schema 的冲突。

## 第 4 步：在聚合器中注册

编辑 `packages/core/src/validator/aggregator.ts`：添加导入并在构造函数的验证器数组中插入 `new MyValidator()`：

```typescript
import { MyValidator } from './my-validator.js';

// 构造函数内：
this.validators = customValidators ?? [
  // ... 现有验证器 ...
  new MyValidator(),
];
```

如果你的验证器引入**新的顶层 Pass 2 字段**，还需要把它登记到 `packages/core/src/validator/index.ts` 中的静态 `analysisContentSchema`（并相应更新其契约测试/辅助类型）——在 `ResultAggregator` 中注册只更新动态 schema，`parseAnalysisJSON()` 与 schema 合并测试仍然使用这个静态 `analysisContentSchema`。如果复用的是已有块（例如 `narrativeChecks`），则无需此步。

## 第 5 步：添加模块导出

1. 添加到 `packages/core/src/validator/index.ts`：

```typescript
export { MyValidator } from './my-validator.js';
```

2. **同时**把 `MyValidator` 加入包入口 `packages/core/src/index.ts` 的 `// Validator` 命名导出列表——否则包消费者无法使用该类：`packages/core/package.json` 的 `exports` 只暴露包根（`./dist/index.js`），`packages/core/build.mjs` 也只打包 `src/index.ts`。如果该验证器仅供内部使用（不对外发布），可以只做第 1 步，但请明确它是内部实现。

## 第 6 步：编写测试

测试文件位于 `packages/core/tests/validator/`。对于 `validatePre` 检查，使用 mock 提供商（无需 LLM）。对于使用 Pass 2 的 `validatePost` 检查，使用 `MockPass2Provider`（`packages/core/src/ai/providers/mock-pass2.ts`）配合预编写的 `{prose, analysis}` 条目——参考 `packages/core/tests/fixtures/mock-pass2-helpers.ts` 中的 `makeAnalysisResult`/`makeAnalysisEntries` 辅助函数，无需真实 LLM。

## 示例：PacingValidator

请参阅 `packages/core/src/validator/pacing.ts` — 一个完整的参考实现，其功能包括：
- 在 `validatePre` 中检查 `arcPosition` 递进规则
- 在 `validatePost` 中使用 `attributes: ['pacing', 'pace']` 的 `narrativeChecks`
- 使用 `getAnalysisRequirements()` 声明其 Pass 2 需求（`schema: z.array(narrativeCheckSchema)`）
- 通过 `./base.js` 导出的 `makeIssue()` 实现一致的问题格式化
