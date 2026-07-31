# 状态管理

**源文件：** `packages/core/src/state/replay.ts` (ReplayEngine)，`packages/core/src/state/graph-adapter.ts`（compileStoryRuntimeGraph），`packages/core/src/state/graph-compiler.ts`（compileGraph），`packages/core/src/state/dag.ts`（buildStoryOrderIndex），`packages/core/src/state/manager.ts` (StateManager)，`packages/core/src/state/event-store.ts` (EventStore)，`packages/core/src/state/snapshot.ts` (SnapshotEngine)，`packages/core/src/entity/timestamp.ts`（parseStoryTimestamp / resolveTemporalContext）
**类型：** `packages/core/src/types/world.ts` (WorldState、Snapshot)，`packages/core/src/types/entity.ts` (Fact、TimeAnchor)，`packages/core/src/types/thread.ts` (ThreadRuntimeState)
**比较：** `packages/core/src/entity/compare.ts` (compareFact)

## 事件溯源模型

Novalistically 使用纯事件溯源架构：每个状态变更都被记录为一个 `NarrativeEvent`。世界状态从不就地修改——它始终通过**从初始状态重放事件来推导**。位于 `packages/core/src/state/replay.ts` 的 `ReplayEngine` 类是此系统的核心。

`WorldState` 接口（`types/world.ts`）捕获叙事状态的核心维度：

```
entities       Record<EntityId, Record<string, unknown>>
relationships  Record<RelationshipId, RelationshipRuntimeState>
knowledge      Record<EntityId, { knownFacts: FactId[] }>
threads        Record<string, ThreadRuntimeState>
rules          Record<string, RuleRuntimeState>
facts          Fact[]
```

另有 STATE-4 可选扩展：`epistemicLedger?`（角色对命题的态度账本）与 `propositionCatalog?`（不可变命题目录）。每个属性都在重放处理事件时增量构建。实体状态存储为平面键值记录；关系状态追踪定向维度和感知（`RelationshipRuntimeState`，见 `types/relationship.ts`）；线程状态是 `ThreadRuntimeState`（`types/thread.ts`：`threadId`、`status`、`currentRunId`、`phase`、`bindings`、`goalStates`、`milestoneStates`、`semanticStateHash`）。

## 图编译与状态边界（GRAPH-1）

因果序由三层编译管线决定，不再有独立的 `buildCausalEdges()` / `topologicalSort()`：

1. **`compileStoryRuntimeGraph()`**（`state/graph-adapter.ts`）在 branch 过滤前用 `resolveTemporalContext()` 解析全部事件时间；按 `includesPath()` 过滤 selected events；把 genesis 的 postconditions 与 initial facts 归并到 `system:initial` root（不把 genesis 当普通事件重放）；产出 `CompileNode[]`。
2. **`compileGraph()`**（`state/graph-compiler.ts`）按固定 12 阶段编译 StoryGraph/DiscourseGraph：normalize outputs → 提取 reads → branch 过滤 → declarations 解析 → coordinate/order 校验 → 时间边 → provider/absence 推断 → commutativity → branch/closure/cycle 校验 → hash。四条边类：`author_origin`（显式 `causalPredecessors`）、`provider`（读→写）、`same_coordinate_order`、`internal`（由 story 点坐标派生的双分时间边）。
3. **`buildStoryOrderIndex()`**（`state/dag.ts`）做 Kahn 拓扑排序：确定性 precondition 的读会要求一个可见的 maximal provider；未声明的缺失（absence）只对 `not_exists` 谓词或带合法 `absentApparatus` claim 的读合法，其余 exists/equals 缺失、歧义、自依赖和环都是编译错误（经 `compileStoryRuntimeGraph` 汇总为 phase `narrative-graphs` 的 `ConfigError`）。

`narrativeOrder` 不参与因果排序（Kahn tie-break 用事件 ID）；它只用于 catalog/selector 排序与 scene metadata，不是组装顺序。`narrationTime` 不参与 provider 选择。

`buildStoryOrderIndex()` 不修改输入的邻接表，环直接抛 `DagCycleError`；没有 narrative-order fallback。`ReplayEngine` 不再以 precondition 初始化状态：确定性前置条件必须经 `event-application.ts` 私有 `preconditionMatches()`（`validatePreconditions()` 按全部 10 个 operator 分派）匹配，否则抛 `PreconditionMismatchError`；`compareFact()` 只做严格 `===` 相等比较，其调用方限于 causality/branch-merge 验证器与 deferred resolver。`narrativeHint` 不写 `state.entities`、不产生因果边，但 hint-only postcondition 会被 `applyPostconditions()` 追加到 `WorldState.facts` 事实日志（`ContextAssembler._buildWorldFacts()` 可消费）。

`compileStoryBoundaries()` 是渲染编排使用的唯一 story-state 边界：initial writes 独立输入，不合成 `system:genesis` narrative event；它产出 causal order、每个 event 的 `stateBeforeByEventId` / `stateAfterByEventId` 与 final state。空 BranchPath 只包含 `{ type: "all" }` 事件，绝不泄漏 path-scoped scenes。

最小 diamond 只支持显式 `{ type: "all" }` trunk 与 `{ type: "paths" }` lane（BranchSet 另有 `condition` 变体，经 `evaluateCondition()` 对 BranchPath 求值）；图编译与 assembler 共享同一 `includesPath()` predicate。无 decision 的 linear run 绝不包含 lane-scoped event；选定 lane 绝不读取另一 lane 的 provider 或 scene。
> **YAML game tree**：production `EventFile.choices` 现在编译为 rooted tree。mapper 对每个
> authored event、ordinary Fact 与 synthetic choice transition 写入 derived `BranchSet`（root 保持 `{ type: 'all' }`，其余事件取 descendant leaf scope）；tree
> replay 因而在 selected leaf 中只读取本 lane 的 Fact provider。explicit
> `causalPredecessors` 同样必须在 selected branch 内存在。外部 `branches.yaml` 与
> `branchPoint` 仍未解析；详见 [分支游戏对话](./yaml-format/branch.md)。

快照优化尚未证明与因果边界等价；阶段一受限路径不得把快照作为 render state 的来源。

## 时间戳解析

`entity/timestamp.ts` 把 authored story time 归一化为运行时 `StoryTimestamp`，再由 `resolveTemporalContext()` 解析成图坐标（`coordinatesByEventId`、`narrationCoordinatesByEventId`、`coordinatesByAnchorId`）：

- `day_N`（或裸 duration 字符串）→ **story clock** 点：`scalar = 数值 × unit 毫秒`（`day` = 86_400_000），例如 `day_3` → 259_200_000。
- ISO 日期时间 → **calendar clock** 点（UTC 毫秒，带时区修正）。
- `chapter_N` → **chapter clock** 点（标量 = 章节号）。
- `indeterminate` / 省略 → `{ type: 'storyTime', kind: 'unlocated' }`，不产生时间边。
- 事件/anchor 引用 → 解析到被引用点；`relative`（`anchor + N unit`）要求 story/calendar 点基。
- **引用/循环/未知都是 resolver 错误**：`Unknown story-time reference`、`Cyclic story-time reference`、`Unknown event`、`Unknown time anchor`、重复/保留 ID、anchor 与事件 ID 冲突、非有限标量、非法 ISO 日期/时区，均抛 `ConfigError`（phase `'timestamp'`），发生在任何图编译之前。

## 阶段一文本计数与组装

`countNarrativeText(text, language)` 是唯一版本化文本计数器：先 NFC，再排除 Markdown/HTML/link 表现语法；中文按 CJK 字符加连续 Latin/digit run，英文按可见 lexical token。发布完整性按**分支 scope** 判定：`EditorialPublisher.publish()` 的 `isCurrent` 要求 `scopeEventIds` 全部有 verified head 且零 reasons（novel 仅此时写入）；零场景 / 空 scope（`scopeEventIds.length === 0` 或没有 branch-required scenes）在 assembly 中拒绝。`canonicalAssemble()` 报告 `countNovelWords()`（剥离标题后的空白计数）与 scene 数，**不保证**等于各 scene 版本化 `countNarrativeText()` 计数之和；不存在固定场景数要求，assembly 路径也没有 duplicate-`narrativeOrder` 拒绝。

## 快照

`SnapshotEngine` 在 `snapshot_interval`（默认为 20）处捕获 `WorldState`。每个快照存储 `{ eventCount, eventId, timestamp, version, state }`（按 event count 键控，与 `narrativeOrder` 无关）。`StateManager`（`packages/core/src/state/manager.ts`）编排：`commit(event)` 先写 EventStore，再在 `shouldSnapshot(eventCount)` 时用 `getCurrentState()` 生成快照；`getCurrentState()` / `getStateAt(position)` 从 event store 重放（`getStateAt` 的 0 = baseline）。`initialize()` 只把事件载入 store，不触发快照。



## Fact 的三种形式

每个 `Fact` 的 postcondition 是**三形式**合同（`postconditionSchema`）：`value`（可附 `operation: set`）、`operation: unset`（无 value / narrativeHint）、或仅 `narrativeHint`；Zod 强制互斥。

- `value !== undefined` → 在重放期间写入 `state.entities`（`operation: 'unset'` 则删除属性），并追加 `state.facts`，创建因果边
- `narrativeHint !== undefined`（hint-only）→ 不写 `state.entities`、不产生因果边，但 `applyPostconditions()` 会把该 fact **追加到 `WorldState.facts` 事实日志**，`ContextAssembler._buildWorldFacts()` 可消费该日志；同时作为 Pass 2 semantic input

## compareFact()

位于 `packages/core/src/entity/compare.ts` 中的统一比较函数：

```typescript
function compareFact(fact: Fact, stateValue: unknown): CompareOutcome
```

返回 `'match'`（值等于状态）、`'mismatch'`（值不同）或 `'deferred'`（仅 narrativeHint）。它的实际角色是**严格相等比较器**：调用方限于 causality / branch-merge 验证器（`compareFact` 比较 precondition 与 queryState）与 deferred resolver（确认 hint 被分类为 `deferred`）。重放前置条件校验**不走它**——`validatePreconditions()` 通过私有 `preconditionMatches()` 按全部 10 个 operator 分派（`eq`/`neq`/`gt`/…/`exists`/`not_exists`），失败抛 `PreconditionMismatchError`；同一事实的 operator 语义由 `preconditionMatches()` / `applyNarrativeEvent()` 定义。

## 规则效果

`state/rule-replay.ts` 的 `applyRuleTransaction()` 处理 `RuleTransaction` 操作：`enable` / `suspend` / `revoke` / `amend` / `replace` / `set_effectiveness` / `add_exception` / `remove_exception`，更新 `RuleRuntimeState`（`activation`、`effectiveness`、`exceptions[]`、`scopeBindings`）。YAML 层的 legacy `RuleEffectEntry` 在应用时由 `convertLegacyRuleEffect()` 映射：

| legacy 效果 | 映射操作 |
|---|---|
| `reinforce` | `enable`（+ audit） |
| `weaken` | `suspend` |
| `introduce_exception` | `add_exception` |
| `nullify` | `set_effectiveness: nullified` |
