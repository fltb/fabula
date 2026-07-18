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
  category: 'characterization' | 'factual_detail' | 'timeline_plot' | 'worldbuilding' | 'narrative_style' | 'prose_quality';
```

该接口支持两个可选的检查方法：

- **`validatePre(input: PreRenderInput): ValidationIssue[]`** — 在渲染前对事件定义和世界状态进行结构性检查。`PreRenderInput` 提供 `event`、`worldState`、`events`、`entityRegistry`、`chapter`、`eventStore`、`queryState`、`getKnowledge` 和 `getThreadProgress`。

- **`validatePost(input: PostRenderInput): ValidationIssue[]`** — 使用 Pass 2 分析对渲染后的散文进行语义检查。`PostRenderInput` 提供 `event`、`worldState`、`prose`、`analysis`（已解析的 `AnalysisResult | null`）和 `chapter`。

## 第 3 步：声明分析需求

如果你的验证器使用 Pass 2，请实现 `getAnalysisRequirements()`：

```typescript
getAnalysisRequirements() {
  return [{
    field: 'narrativeChecks',
    attributes: ['my_attribute'],
    schemaExample: { entityId: 'E1', attribute: 'my_attribute', hint: '...', evidence: '...', matchLevel: 'exact' },
    instruction: 'narrativeChecks[my_attribute]: Description of what to check...',
  }];
}
```

- **`field`** — JSON 字段路径（例如 `'narrativeChecks'`、`'ruleChecks'`、`'pov.leaks'`）
- **`attributes`** — 对于 `narrativeChecks` 风格的块，指定 LLM 应生成的属性值
- **`schemaExample`** — 展示输出结构的 JSON 模板
- **`instruction`** — 必须以字段名开头，为 LLM 提供详细指导

`ResultAggregator` 会合并所有验证器的需求并检测属性冲突（如果两个验证器声称同一字段上的同一属性，则抛出异常）。

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

## 第 5 步：添加模块导出

添加到 `packages/core/src/validator/index.ts`：

```typescript
export { MyValidator } from './my-validator.js';
```

## 第 6 步：编写测试

测试文件位于 `packages/core/tests/validator/`。对于 `validatePre` 检查，使用 mock 提供商（无需 LLM）。对于使用 Pass 2 的 `validatePost` 检查，使用预编写的分析数据的 `MockPass2Provider`，或者如果测试需要真实 LLM，则标记为 `skip: 'no_pass2'`。

## 示例：PacingValidator

请参阅 `packages/core/src/validator/pacing.ts` — 一个完整的参考实现，其功能包括：
- 在 `validatePre` 中检查 `arcPosition` 递进规则
- 在 `validatePost` 中使用 `attributes: ['pacing', 'pace']` 的 `narrativeChecks`
- 使用 `getAnalysisRequirements()` 声明其 Pass 2 需求
- 导出 `makeIssue()` 以实现一致的问题格式化
