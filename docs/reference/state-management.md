# 状态管理

**源文件：** `packages/core/src/state/replay.ts` (ReplayEngine)，`packages/core/src/state/graph-adapter.ts`（compileStoryRuntimeGraph），`packages/core/src/state/graph-compiler.ts`（compileGraph），`packages/core/src/state/dag.ts`（buildStoryOrderIndex），`packages/core/src/state/manager.ts` (StateManager)，`packages/core/src/state/event-store.ts` (EventStore)，`packages/core/src/state/snapshot.ts` (SnapshotEngine)，`packages/core/src/entity/timestamp.ts`（parseStoryTimestamp / resolveTemporalContext）
**类型：** `packages/core/src/types/world.ts` (WorldState、Snapshot)，`packages/core/src/types/entity.ts` (Fact、TimeAnchor)，`packages/core/src/types/thread.ts` (ThreadRuntimeState)
**比较：** `packages/core/src/entity/compare.ts` (compareFact)

> 本页为 current reference，与 [`docs/current-state.md`](../current-state.md)（2026-08-02 源码核验基线）同步。

## 事件溯源模型

Novalistically derives state by replaying authored `NarrativeEvent`s on a declaration-owned baseline. The baseline is materialized before the first event; neither baseline materialization nor initial entity facts create a synthetic genesis narrative event. `ReplayEngine` in `packages/core/src/state/replay.ts` applies the selected event order.

`WorldState` 接口（`types/world.ts`）捕获叙事状态的核心维度：

```
entities         Record<EntityId, Record<string, unknown>>
relationships    Record<RelationshipId, RelationshipRuntimeState>
epistemicLedger  EpistemicLedger
propositionCatalog PropositionCatalog
commonGround     CommonGroundRecord[]
threads          Record<string, ThreadRuntimeState>
rules            Record<string, RuleRuntimeState>
facts            Fact[]
```

`materializeNarrativeBaseline()` constructs the required epistemic ledger, proposition catalog, common ground, threads, relationships, and rules from canonical source declarations before replay. Entity state remains a flat key/value record; relationship state uses epochs, memberships, and scoped dimensions; thread state is `ThreadRuntimeState` (`threadId`、`status`、`currentRunId`、`phase`、`bindings`、`goalStates`、`milestoneStates`、`semanticStateHash`).

## 图编译与状态边界（GRAPH-1）

因果序由三层编译管线决定，不再有独立的 `buildCausalEdges()` / `topologicalSort()`：

1. **`compileStoryRuntimeGraph()`**（`state/graph-adapter.ts`）在 branch 过滤前用 `resolveTemporalContext()` 解析全部事件时间；按 `includesPath()` 过滤 selected events；把 **initial facts（去重与冲突校验后）和初始 thread declarations** 归并到 `system:initial` root 节点（`INITIAL_STORY_ROOT_ID`；**不存在 genesis narrative event**——initial writes 是独立确定性输入，不合成 genesis 事件）；产出 `CompileNode[]`。
2. **`compileGraph()`**（`state/graph-compiler.ts`）按固定 12 阶段编译 StoryGraph/DiscourseGraph：normalize outputs → extract reads → branch 过滤 → declarations 解析 → coordinate/order 校验 → 推导 temporal internal 边 → 前 provider StoryOrderIndex → provider/absence 推断 → 重建最终 StoryOrderIndex → commutativity → branch/closure/cycle 校验 → hash/replay。四条边类：`author_origin`（显式 `causalPredecessors`）、`provider`（读→写）、`same_coordinate_order`、`internal`（由 story 点坐标派生的双分时间边）。
3. **`buildStoryOrderIndex()`**（`state/dag.ts`）做 Kahn 拓扑排序：确定性 precondition 的读会要求一个可见的 maximal provider；未声明的缺失（absence）只对 `not_exists` 谓词或带合法 `absentApparatus` claim 的读合法，其余 exists/equals 缺失、歧义、自依赖和环都是编译错误（经 `compileStoryRuntimeGraph` 汇总为 phase `narrative-graphs` 的 `ConfigError`）。

`narrativeOrder` 不参与因果排序（Kahn tie-break 用事件 ID）——这是已核验不变量；它仍用于 catalog/selector 排序、scene metadata，并存在于按 `narrativeOrder` 排序的 runtime/legacy 路径（`EventStore.getAll()` 按它升序返回、`ProseConcatenator` 按它拼接场景）——canonical release assembly 以 discourse scene sequence 为主，因此“`narrativeOrder` 从不使用”是不准确的。`narrationTime` 不参与 provider 选择。

`buildStoryOrderIndex()` 不修改输入的邻接表，环直接抛 `DagCycleError`；没有 narrative-order fallback。`ReplayEngine` 不再以 precondition 初始化状态：确定性前置条件必须经 `event-application.ts` 私有 `preconditionMatches()`（`validatePreconditions()` 按全部 10 个 operator 分派）匹配，否则抛 `PreconditionMismatchError`；`compareFact()` 只做严格 `===` 相等比较，其调用方限于 causality/branch-merge 验证器与 deferred resolver。`narrativeHint` 不写 `state.entities`、不产生因果边，但 hint-only postcondition 会被 `applyPostconditions()` 追加到 `WorldState.facts` 事实日志（`ContextAssembler._buildWorldFacts()` 可消费）。

`compileStoryBoundaries()` 是渲染编排使用的唯一 story-state 边界：initial writes 独立输入，不合成 `system:genesis` narrative event；它产出 causal order、每个 event 的 `stateBeforeByEventId` / `stateAfterByEventId` 与 final state。空 BranchPath 只包含 `{ type: "all" }` 事件，绝不泄漏 path-scoped scenes。

最小 diamond 只支持显式 `{ type: "all" }` trunk 与 `{ type: "paths" }` lane（BranchSet 另有 `condition` 变体，经 `evaluateCondition()` 对 BranchPath 求值）；图编译与 assembler 共享同一 `includesPath()` predicate。无 decision 的 linear run 绝不包含 lane-scoped event；选定 lane 绝不读取另一 lane 的 provider 或 scene。
> **YAML game tree**：production `EventFile.choices` 现在编译为 rooted tree。mapper 对每个
> authored event、ordinary Fact 与 synthetic choice transition 写入 derived `BranchSet`（root 保持 `{ type: 'all' }`，其余事件取 descendant leaf scope）；tree
> replay 因而在 selected leaf 中只读取本 lane 的 Fact provider。explicit
> `causalPredecessors` 同样必须在 selected branch 内存在。外部 `branches.yaml` 与
> `branchPoint` 仍未解析；详见 [分支游戏对话](./yaml-format/branch.md)。

`StateManager` 的内存快照只是 recovery primitive：当前 `getCurrentState()` / `getStateAt()` 仍通过 `ReplayEngine` 重放，**没有**已接线的快照恢复加速，不能宣传为已接入的 snapshot-hydration。快照优化尚未证明与因果边界等价；受限路径不得把快照作为 render state 的来源。

## 时间戳解析

`entity/timestamp.ts` 把 authored story time 归一化为运行时 `StoryTimestamp`，再由 `resolveTemporalContext()` 解析成图坐标（`coordinatesByEventId`、`narrationCoordinatesByEventId`、`coordinatesByAnchorId`）：

- `day_N`（或裸 duration 字符串）→ **story clock** 点：`scalar = 数值 × unit 毫秒`（`day` = 86_400_000），例如 `day_3` → 259_200_000。
- ISO 日期时间 → **calendar clock** 点（UTC 毫秒，带时区修正）。
- `chapter_N` → **chapter clock** 点（标量 = 章节号）。
- `indeterminate` / 省略 → `{ type: 'storyTime', kind: 'unlocated' }`，不产生时间边。
- 事件/anchor 引用 → 解析到被引用点；`relative`（`anchor + N unit`）要求 story/calendar 点基。
- **引用/循环/未知都是 resolver 错误**：`Unknown story-time reference`、`Cyclic story-time reference`、`Unknown event`、`Unknown time anchor`、重复/保留 ID、anchor 与事件 ID 冲突、非有限标量、非法 ISO 日期/时区，均抛 `ConfigError`（phase `'timestamp'`），发生在任何图编译之前。

## 文本计数与组装

`countNarrativeText(text, language)`（`assembler/count.ts`，`NARRATIVE_TEXT_COUNT_VERSION = 1`）是版本化文本计数器：先 NFC，再排除 Markdown/HTML/link 表现语法；中文按 CJK 字符加连续 Latin/digit run，英文按可见 lexical token。发布状态按**分支 scope** 判定：`buildPublicationResult()`（`editorial/render-service.ts`）仅在所选事件的 release decision 全部为 `accepted` 且零 editorial errors 时返回 `current`，否则 `stale`（空 scope 为 `unchanged`）；Core 只输出结构化结果，novel 文件写入由 Host repositories 负责。零场景 / 空 scope 在 assembly 中拒绝。`canonicalAssemble()` 的 `wordCount` 是对整篇 markdown 做空白分词后的词数（`markdown.split(/\s+/).filter(Boolean).length`），与 `assembleNovel()` 按 scene 累加 `countNarrativeText()` 得到的 `wordCount` 口径不同，**不保证**相等；两个 assembly 入口都以 discourse scene sequence 排序场景。

## 快照

`SnapshotEngine`（`state/snapshot.ts`）在 `snapshot_interval`（默认为 20）处捕获 `WorldState`，是**纯内存 value 语义**（间隔策略、深拷贝序列化、nearest 选择与失效），从不触碰文件系统。每个快照存储 `{ eventCount, eventId, timestamp, version, state }`（按 event count 键控，与 `narrativeOrder` 无关）。`StateManager`（`state/manager.ts`）编排：`commit(event)` 先写 EventStore，再在 `shouldSnapshot(eventCount)` 时用 `getCurrentState()` 生成快照；`getCurrentState()` / `getStateAt(position)` **仍通过 `ReplayEngine` 重放**（`getStateAt` 的 0 = baseline），不会从快照恢复。`initialize()` 只把事件载入 store，不触发快照。`EventStore`（`state/event-store.ts`）是**纯内存 append-only 日志**，持久化有意缺失：durable 事件日志与快照属于语义端口 `StateLogRepository` / `StateSnapshotRepository`（`ports/state-repository.ts`），由 Host 负责写入；`commit()` 拒绝重复 `narrativeOrder`，`getAll()` 按 `narrativeOrder` 升序返回。



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

## Rule transactions

`state/narrative-baseline.ts` materializes every declared `RuleRuntimeState` before replay. `state/rule-replay.ts` applies canonical `RuleTransaction` operations — `enable`, `suspend`, `revoke`, `amend`, `replace`, `set_effectiveness`, `add_exception`, and `remove_exception` — to that declared state. An event cannot create an undeclared rule: replay raises `RuleConstraintViolationError`.

Rule constraints produce structured `RuleEvaluationRecord`s. Hard violations fail the transaction; audit and semantic results remain records for the caller. There is no legacy `RuleEffectEntry` conversion path.
