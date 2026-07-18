# ADR-001: 事实的双重表示

**Date:** 2026-07  
**Status:** Accepted  
**Designer:** Novalistically Core Team  
**File:** `packages/core/src/types/entity.ts:61-73`

## Context

Fact 系统服务于两种不同的验证需求：
1. **确定性事实**（例如 `location: "luchen_town"`、`marital_status: "widow"`）— 这些需要精确的值比较，并被写入 `WorldState` 以支持因果推理和状态回放。
2. **语义属性**（例如语气、节奏感、情感潜台词）— 这些无法以离散值的形式捕获，但必须由 Pass 2 LLM 分析对照渲染后的散文进行检查。

最初，两者都用一个 `value` 字段表示，但这迫使语义提示被塞入确定性值，导致比较歧义并使 `WorldState` 变得臃肿。

## Decision

`Fact.value` 现在是可选的。新增 `Fact.narrativeHint` 用于语义属性：

```typescript
interface Fact {
  id: FactId;
  entityId: EntityId;
  attribute: string;
  value?: unknown;        // 确定性 — 由 compareFact() 使用
  narrativeHint?: string;  // 语义 — 由 Pass 2 消费，不写入 WorldState
  validity: FactValidity;
}
```

根据 Zod 验证，这两者是**互斥的** — 一个 Fact 必须恰好包含 `value` 或 `narrativeHint` 中的一个。

## Consequences

- **`compareFact()`**（`packages/core/src/entity/compare.ts`）是统一的比较入口点。它返回 `'match' | 'mismatch' | 'deferred'`。所有验证器都使用它 — 不存在临时性的比较策略。
- **narrativeHint 事实在状态回放期间被跳过** — `packages/core/src/state/replay.ts` 中的 `ReplayEngine` 不会将其写入 `WorldState`。
- **因果 DAG 边**（`packages/core/src/state/dag.ts:35`）只考虑 `value !== undefined` 的后置条件 — narrativeHint 事实不会创建因果边。
- **验证器必须处理两条路径**：`compareFact` 用于确定性验证，`validatePost` + 分析消费用于语义验证。
- **占位符值**（`"changed"`、`"resolved"`、`"updated"`）在 Zod schema 层面被拒绝 — 只接受具体值或 `narrativeHint`。
