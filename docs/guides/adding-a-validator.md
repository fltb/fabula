# 添加验证器

> ~400 字 — 向 Novalistically 核心引擎添加新验证器的分步指南。

验证器是检查叙事输出质量的主要机制。每个验证器实现 `packages/core/src/types/validator.ts` 中的 `Validator` 接口。注册分两条路径：**built-in** 验证器编译进 Core 的默认集合；**plugin** 验证器在构造 `ResultAggregator` 时通过 `customValidators` 注入（见第 4 步），不修改任何 Core 源文件。

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

- **`validatePre(input: PreRenderInput): ValidationIssue[]`** — 在渲染前对事件定义和世界状态进行结构性检查。`PreRenderInput` 提供 `event`、`worldState`、`events`、`entities`、`chapter`、`queryState`、`getKnowledge` 和 `getThreadProgress`（`story`、`entityTypeCatalog` 可选）。

- **`validatePost(input: PostRenderInput): ValidationIssue[]`** — 使用 Pass 2 分析对渲染后的散文进行语义检查。`PostRenderInput` 提供 `event`、`worldState`、`prose`、`analysis`（已解析的 `AnalysisResult | null`）和 `chapter`（`entities`、`entityTypeCatalog`、`context` 可选）。

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

## 第 4 步：注册验证器（built-in 与 plugin 是两条路径）

**Built-in 验证器**：编辑 `packages/core/src/validator/builtins.ts`，把 `new MyValidator()` 加入 `createBuiltInValidators()` 返回的数组。这是默认集合的唯一来源：`ResultAggregator` 构造函数在未传 `customValidators` 时调用它，`render-service.ts` 也显式用它构造聚合器。**不要**在 `aggregator.ts` 里插入验证器——它的构造函数只接受注入的 `customValidators` 列表。当前默认集合共 28 个验证器；`GreyLineValidator` 已导出但不在默认集合中（opt-in），需要启用时自行加入数组。

**Plugin 验证器**：不修改任何 Core 源文件。在宿主代码中构造 `new ResultAggregator(customValidators, entityTypeCatalog)` 并传入验证器实例。注意 `customValidators` 是**整体替换**默认集合而不是追加——通常用 `[...createBuiltInValidators(), new MyValidator()]` 扩展。验证器的 `getAnalysisRequirements()` 会通过 `ResultAggregator.getCombinedValidationSchema()` / `getAnalysisContract()` 动态合并进 Pass 2 的 JSON schema 与提示模板。

如果你的验证器引入**新的顶层 Pass 2 字段**：

- **Built-in**：把块 schema 登记到 `packages/core/src/validator/index.ts` 中的静态 `analysisContentSchema`（当前 20 个字段），并相应更新其契约测试/辅助类型。`parseAnalysisJSON()`（默认 built-in 合约）与持久化合约解析仍使用这个静态 schema；只有 `parseAnalysisJSONWithErrors()` 被传入动态 `combinedSchema` 时才包含 plugin 字段。
- **Plugin**：**无需**登记到 `analysisContentSchema`——字段通过 validator requirements 动态进入 `combinedSchema`，live 管线用 `analysisContract.combinedSchema` 解析。字段必须是顶层块（带 `.` 的路径会被截断为顶层段，见第 3 步）。

如果复用的是已有块（例如 `narrativeChecks`），则不引入新字段，以上登记步骤都不需要。

## 第 5 步：添加模块导出（仅 built-in）

Plugin 验证器位于 Core 之外、由宿主注入，**不**改动 Core 的任何导出。Built-in 验证器需要两步：

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
