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

## DAG 因果边与状态边界

`buildCausalEdges()` 仅用确定性 `value` 事实构图。每个前置条件只能由 initial state 或 story time 严格更早的唯一最新写入提供；缺失、未来、同刻歧义、自依赖和环均抛具稳定 code 的 typed error。`narrativeOrder` 只用于组装显示，`narrationTime` 不参与 provider 选择。

`topologicalSort()` 不修改输入入度表，环直接抛 `DagCycleError`；没有 narrative-order fallback。`ReplayEngine` 不再以 precondition 初始化状态：确定性前置条件必须经 `compareFact()` 匹配，否则抛 `PreconditionMismatchError`。`narrativeHint` 仍不写入 `WorldState`。

`compileStoryBoundaries()` 是渲染编排使用的唯一 story-state 边界：initial writes 独立输入，不合成 `system:genesis` narrative event；它产出 causal order、每个 event 的 `stateBefore` 与 final state。空 BranchPath 只包含 `{ type: "all" }` 事件，绝不泄漏 path-scoped scenes。

最小 diamond 只支持显式 `{ type: "all" }` trunk 与 `{ type: "paths" }` lane；DAG 和 assembler 共享同一 `includesPath()` predicate。无 decision 的 linear run 绝不包含 lane-scoped event；选定 lane 绝不读取另一 lane 的 provider 或 scene。

快照优化尚未证明与因果边界等价；阶段一受限路径不得把快照作为 render state 的来源。

## 阶段一文本计数与组装

`countNarrativeText(text, language)` 是唯一版本化文本计数器：先 NFC，再排除 Markdown/HTML/link 表现语法；中文按 CJK 字符加连续 Latin/digit run，英文按可见 lexical token。全量发布只在七场都 released 后组装；empty scene、零场景与 duplicate `narrativeOrder` 均拒绝，novel 的计数必须等于各 scene prose 计数和。

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
