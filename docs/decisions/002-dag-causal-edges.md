# ADR-002: DAG 因果边时间模型

**Date:** 2026-07  
**Status:** Accepted  
**Designer:** Novalistically Core Team  
**File:** `packages/core/src/state/dag.ts`

## Context

事件具有前提条件（preconditions）和后置条件（postconditions）。事件在叙事中出现的顺序（`narrativeOrder`）可能与因果依赖顺序不同 — 特别是在闪回、非线性时间线和框架故事中（例如 zhu-fu 测试夹具中 E0→E6 的线性话语顺序与 E2→E3→E4→E5 的时间顺序不同）。

原始设计使用 `narrativeOrder` 进行状态回放，当事件引用由后续出现的事件设定的前提条件时，会产生错误的世界状态。

## Decision

状态回放由**基于后置条件与前提条件匹配构建的 DAG 因果边的拓扑排序**驱动：

1. **边构建**（`buildCausalEdges()`，dag.ts:25）：以后置条件索引为键 `"entityId.attribute.value"`（仅确定性值 — 跳过 narrativeHint 事实）。对于每个前提条件，找到匹配的后置条件，并从最近的提供者创建一条有向边。
2. **拓扑排序**（`topologicalSort()`，dag.ts:84）：Kahn 算法。初始队列以 `inDegree=0` 的事件按 `narrativeOrder` 排序（无关联的事件保留话语顺序）。
3. **循环检测**：如果 `result.length < events.length`，则抛出错误，列出未访问的事件 ID。

`narrativeOrder` 仅保留给 Assembler 输出排序使用。

## Consequences

- **`ReplayEngine.replay()`**（`packages/core/src/state/replay.ts`）在回放时使用 `topologicalSort` — 如果循环检测失败，则回退到 `narrativeOrder` 排序。
- **TimelineValidator** 使用 DAG 边进行时间锚点比较。
- **narrativeHint 事实不创建边** — 只有确定性的 `value` 事实参与因果排序。
- **DAG 可视化**可通过 `edges` 和 `inDegree` 数据结构实现。
- **确定性行为**：给定相同的事件，`buildCausalEdges` + `topologicalSort` 总是产生相同的顺序。
