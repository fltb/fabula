# 状态管理

**源文件：** `packages/core/src/state/replay.ts` (ReplayEngine)，`packages/core/src/state/dag.ts`（因果边），`packages/core/src/state/manager.ts` (StateManager)，`packages/core/src/state/event-store.ts` (EventStore)，`packages/core/src/state/snapshot.ts` (SnapshotEngine)  
**类型：** `packages/core/src/types/world.ts` (WorldState、Snapshot)，`packages/core/src/types/entity.ts` (Fact)  
**比较：** `packages/core/src/entity/compare.ts` (compareFact)

## 事件溯源模型

Novalistically 使用纯事件溯源架构：每个状态变更都被记录为一个 `NarrativeEvent`。世界状态从不就地修改——它始终通过**从初始状态重放事件来推导**。位于 `packages/core/src/state/replay.ts` 的 `ReplayEngine` 类是此系统的核心。

`WorldState` 接口（`types/world.ts`）捕获了叙事状态的六个维度：

```
entities       Record<EntityId, Record<string, unknown>>
relationships  Record<string, RelationshipState>
knowledge      Record<EntityId, { knownFacts: FactId[] }>
threads        Record<string, { progress: number; total: number }>
rules          Record<string, RuleState>
facts          Fact[]
```

每个属性都在重放处理事件时增量构建。实体状态存储为平面键值记录；关系状态追踪定向维度和感知。

## DAG 因果边

与朴素的时间顺序重放不同，Novalistically 按**因果依赖**而不是 `narrativeOrder` 对事件进行排序。`packages/core/src/state/dag.ts` 中的 `buildCausalEdges()` 函数通过匹配 `eventA.postconditions` → `eventB.preconditions`（基于 `entityId + attribute + value`）来构建邻接表。多重匹配选择最新的提供者。`narrativeHint` 事实（非确定性）被跳过——它们不能创建因果边。

`topologicalSort()` 应用带有环检测的 Kahn 算法。无连接的事件（无因果边）按 `narrativeOrder` 排序。如果检测到环，`ReplayEngine` 会回退到 `narrativeOrder` 排序并发出警告。导出函数 `exportDAGtoDOT()` 和 `exportDAGtoMermaid()` 可对图进行可视化。

## ReplayEngine

`replay()` — 从初始状态开始完全重放。通过 `includesPath()` 在 `branchExistence` 上过滤分支路径。应用后置条件（仅确定性值）、前提条件（如果尚未设置）、线程进度、关系效果、知识更新和规则效果。

`getStateAt(narrativeOrder)` — 过滤 `narrativeOrder <= N` 的事件，然后从初始状态重放。简单但正确。

`getStateAtOptimized(narrativeOrder, snapshot)` — 从序列化的 `Snapshot` 开始，增量地重放 `snapshot.narrativeOrder` 之后的事件。使用快照状态的深拷贝以避免突变。对于重复访问要快得多。

## 快照

`SnapshotEngine` 在 `snapshot_interval`（默认为 20）处捕获 `WorldState`。每个快照存储 `{ narrativeOrder, eventId, timestamp, state }`。`StateManager`（`packages/core/src/state/manager.ts`）编排提交 → 快照 → 重放，找到最近的快照并向前重放。

## 事实的双重表示

每个 `Fact` 可以携带 `value?`（确定性，如 `boolean`、枚举、简单字符串）或 `narrativeHint?`（语义属性字符串，由 Pass 2 分析消费，不写入 WorldState）。Zod Schema 强制执行互斥性。

- `value !== undefined` → 在重放期间写入 `state.entities`，创建因果边
- `narrativeHint !== undefined` → 被重放跳过，由 Pass 2 验证器消费

## compareFact()

位于 `packages/core/src/entity/compare.ts` 中的统一比较函数：

```typescript
function compareFact(fact: Fact, stateValue: unknown): CompareOutcome
```

返回 `'match'`（值等于状态）、`'mismatch'`（值不同）或 `'deferred'`（仅 narrativeHint——由 Pass 2 处理）。**所有验证器必须使用此函数**——不允许临时性比较。

## 规则效果

`replay.ts` 中的 `applyRuleEffect()` 处理四种规则效果类型：

| 效果 | 行为 |
|---|---|
| `reinforce` | 增加 `activeEvidence`，清除 `nullified` |
| `weaken` | 减少 `activeEvidence`（最小为 0） |
| `nullify` | 设置 `activeEvidence = 0`，设置 `nullified = true` |
| `introduce_exception` | 向 `exceptions[]` 添加证据字符串 |
