# dag-replay: DAG causal edges, replay, and snapshot keying

## Group Status: [-] in progress — DAG-0 + DAG-3 [x] (already implemented by CLI-2); DAG-1/2/4/5 open

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| DAG-0 | [x] | — | `docs/TODO.md` lines 281-296 — `topologicalSort()` throws `DagCycleError` (dag.ts:125), no catch/fallback in `replay()`, test `dag.test.ts:29-36` covers cycle rejection, zhu-fu fixture confirmed cycle-free by CLI-2 |
| DAG-1 | [x] | — (test-only) | `docs/TODO.md` lines 796-806 — divergence test proving getStateAtOptimized diverges from replay(); 3 tests in dag-divergence.test.ts |
| DAG-2 | [x] | — | `docs/TODO.md` lines 808-820 — narrativeOrder tiebreaker removed from compareByStory; replay() now extracts anchors from storyTimes; dag-tiebreaker.test.ts (2 tests) |
| DAG-4 | [x] | — | `docs/TODO.md` lines 836-844 — buildInitialState() helper deduped across 3 call sites; genesis-root.test.ts (4 tests) |
| DAG-5 | [ ] | DAG-1, DAG-2, DAG-4 | `docs/TODO.md` lines 846-870 — snapshot.ts uses narrativeOrder everywhere (filename :37, findNearest :44, shouldSnapshot :24). `getStateAtOptimized` diverges. Split into 5a/5b/5c |

## Group-level dependencies
- **state-model**: STATE-3 [x] ✅ — all DAG items' preconditions met.
- DAG-5 depends on DAG-1 (divergence test exists before method deletion) and DAG-2 (tiebreaker removed before snapshot keying) and DAG-4 (genesis helper before replay signature changes).

## Sub-plan

### DAG-0: Cycle detection — no silent fallback to narrativeOrder

**Already implemented.** Verified:
- `topologicalSort()` (dag.ts:123-126) throws `DagCycleError` with cycle event ID list
- `replay()` (replay.ts:117) calls `topologicalSort()` with no try/catch — error propagates
- `compileStoryBoundaries()` (story-boundaries.ts:61) calls `topologicalSort()` — same, no catch
- `DagCycleError` defined in errors.ts:34
- Test: `dag.test.ts:29-36` ("does not mutate indegree and rejects cycles")
- zhu-fu fixture: validated 0 errors, 0 warnings — no cycle
- narrativeOrder remains discourse-only (Assembler); DAG/provider/replay ignore it for causal ordering

No work needed. Mark [x].

### DAG-3: Branch filtering before DAG construction

**Already implemented.** Verified:
- `buildCausalEdges()` (dag.ts:31-33): filters by branch BEFORE edge construction
- `replay()` (replay.ts:115): filters BEFORE `buildCausalEdges` call at :116
- `compileStoryBoundaries()` (story-boundaries.ts:58-59): receives pre-filtered events
- No post-topology filtering that could drop providers

No work needed. Mark [x].

### DAG-1: Divergence test — getStateAtOptimized vs replay

**Scope**: Test-only. Create a fixture proving `getStateAtOptimized()` with a snapshot returns different state than `replay()` when causal order ≠ narrativeOrder. This test freezes the divergence as a regression precondition for DAG-5b (which deletes the method).

**Target file**: `packages/core/tests/state/dag-divergence.test.ts` (NEW)

**Fixture events** (inline in the test, constructed programmatically — not YAML files):

```typescript
// Event A: narrativeOrder=1, storyTime=day_5, writes entity.status="alive"
// Event B: narrativeOrder=2, storyTime=day_1, writes entity.status="dead"  
// Event C: narrativeOrder=3, storyTime=day_3, precondition entity.status="dead"
//
// Causal order: B (day_1) → C (day_3, depends on B) → A (day_5)
// narrativeOrder: A(1), B(2), C(3)
//
// Snapshot at narrativeOrder=1 captures A's effects only.
// getStateAtOptimized(events, 3, snapshot) replays events with narrativeOrder > 1 && ≤ 3 = [B, C]
// But A (storyTime=day_5, narrativeOrder=1) is causally LATEST — its "alive" should override B's "dead"
// The snapshot captured A's "alive" state, but B's "dead" (causally earlier) gets applied AFTER the snapshot,
// producing "dead" — which is WRONG. Full replay() would produce "alive" (A is causally latest).
```

**Steps**:
1. Create `packages/core/tests/state/dag-divergence.test.ts`
2. Construct 3 events with the timeline above using the existing `event()` and `fact()` helpers from `dag.test.ts` (copy them — they're 2-line factory functions)
3. Test 1: `replay([A, B, C])` returns `entity.status = "alive"` (A is causally latest at day_5)
4. Test 2: Create a snapshot object: `{ narrativeOrder: 1, eventId: 'A', timestamp: '', state: replay([A]) }` — this contains A's effects (status="alive")
5. Test 3: `getStateAtOptimized([A, B, C], 3, snapshot)` returns `entity.status = "dead"` — DIVERGENCE: it replays B and C after the snapshot, B writes "dead", and the snapshot's "alive" is overwritten. But full replay says "alive" because A (day_5) is causally latest.
6. Assert: `getStateAtOptimized` result ≠ `replay()` result. This is the frozen divergence.
7. Assert: `replay()` result is correct (`"alive"`), `getStateAtOptimized` result is wrong (`"dead"`)

**Acceptance**: `npx vitest run packages/core/tests/state/dag-divergence.test.ts` passes. The test demonstrates and freezes the divergence. No production code changes.

**Evidence**: `packages/core/tests/state/dag-divergence.test.ts` — 3 test cases, all pass.

### DAG-2: Remove narrativeOrder tiebreaker from topologicalSort

**Scope**: Remove `narrativeOrder` as tiebreaker in `compareByStory` (dag.ts:99). Replace with storyTime day → event ID only.

**Target file**: `packages/core/src/state/dag.ts` (line 99), `packages/core/tests/state/dag-tiebreaker.test.ts` (NEW)

**Current code** (dag.ts:94-100):
```ts
function compareByStory(a: string, b: string): number {
  const ea = eventById.get(a)!;
  const eb = eventById.get(b)!;
  const dayA = anchors ? resolveTimestampToDay(ea.storyTime, anchors) : 0;
  const dayB = anchors ? resolveTimestampToDay(eb.storyTime, anchors) : 0;
  return (dayA - dayB) || (ea.narrativeOrder - eb.narrativeOrder) || a.localeCompare(b);
}
```

**Change**: Remove `(ea.narrativeOrder - eb.narrativeOrder)` from the chain:
```ts
return (dayA - dayB) || a.localeCompare(b);
```

**Edge case**: Two events with same storyTime day and no causal edge → ordered by event ID (lexicographic), not narrativeOrder. If a specific order is needed, authors must declare a causal dependency. This is deterministic and discourse-order-independent.

**Regression test** (`packages/core/tests/state/dag-tiebreaker.test.ts`, NEW):
```typescript
// Two events at same day, no causal edge:
// E_alpha (narrativeOrder=5, day_1) and E_zeta (narrativeOrder=1, day_1)
// Old behavior: E_zeta first (narrativeOrder 1 < 5)
// New behavior: E_alpha first (lexicographic "E_alpha" < "E_zeta")
// Assert: topologicalSort result starts with E_alpha, not E_zeta
// Assert: narrativeOrder is NOT consulted in the ordering
```

Also verify existing `dag.test.ts:14-20` ("uses strictly earlier story-time providers, not narrative order") still passes — it tests storyTime-based ordering which is unaffected.

**Acceptance**: `npm run build` green, `npx vitest run packages/core/tests/state/dag.test.ts packages/core/tests/state/dag-tiebreaker.test.ts` passes, `grep "narrativeOrder" packages/core/src/state/dag.ts` returns zero matches (narrativeOrder fully removed from DAG ordering logic).

**Evidence**: `packages/core/tests/state/dag-tiebreaker.test.ts` — new test proves narrativeOrder no longer affects tiebreaker. `dag.test.ts:14-20` — existing test still passes.

### DAG-4: Dedupe genesis + initialFacts construction

**Scope**: The identical genesis-filtering + initialFacts construction block is duplicated in `api.ts` at lines 303-316 (renderNovel) and 572-588 (getProjectStatus). Extract into a shared helper.

**Target files**:
- `packages/core/src/api.ts` — extract helper, dedupe two call sites
- `packages/core/tests/state/genesis-root.test.ts` (NEW) — verify helper correctness

**Current duplicated block** (appears at api.ts:303-312 and api.ts:572-582):
```ts
const genesis = events.find((event) => event.id === 'system:genesis');
const initialFacts: Fact[] = [
  ...(genesis?.postconditions ?? []),
  ...registry.getAll().flatMap((entity) => Object.entries(entity.state ?? {}).map(([attribute, value]) => ({
    id: `${entity.id}.${attribute}`,
    entityId: entity.id,
    attribute,
    value,
    validity: { temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null }, branches: { type: 'all' as const } },
  }))),
];
```

**Change**: Extract to:
```ts
function buildInitialFacts(events: NarrativeEvent[], registry: InMemoryEntityRegistry): Fact[] {
  const genesis = events.find((event) => event.id === 'system:genesis');
  return [
    ...(genesis?.postconditions ?? []),
    ...registry.getAll().flatMap((entity) => Object.entries(entity.state ?? {}).map(([attribute, value]) => ({
      id: `${entity.id}.${attribute}`,
      entityId: entity.id,
      attribute,
      value,
      validity: { temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null }, branches: { type: 'all' as const } },
    }))),
  ];
}
```

Replace both call sites. Also extract the `authoredEvents` filter and `initialThreads` construction if they're duplicated. The helper is NOT exported — it's api.ts-internal.

**Test** (`packages/core/tests/state/genesis-root.test.ts`, NEW):
```typescript
// Test 1: buildInitialFacts with genesis event → includes genesis postconditions
// Test 2: buildInitialFacts without genesis event → only registry facts
// Test 3: compileStoryBoundaries with genesis-filtered events + initialFacts → genesis effects present in initial state, not double-applied
// Test 4: verify renderNovel and getProjectStatus produce same initialFacts for same input (no divergence between the two code paths)
```

**Acceptance**: `npm run build` green, `npx vitest run --exclude '**/e2e.test.ts'` green, `grep -c "genesis.*postconditions" packages/core/src/api.ts` returns 1 (the helper), not 2 (the duplicates).

**Evidence**: `packages/core/tests/state/genesis-root.test.ts` — 4 test cases. Existing zhu-fu validate + render-full-chain tests still pass.

### DAG-5: Snapshot keying + method unification (split into 5a/5b/5c)

**Architecture decision**: `getStateAt` has 28 test references across 3 files. `getStateAtOptimized` has 6. Full deletion would require rewriting 34 test references — large blast radius. Instead:
- **Delete `getStateAtOptimized`** (6 references, all in tests, divergence proven by DAG-1)
- **Keep `getStateAt` as thin compat wrapper** around `replay()` — but change its implementation to use DAG-ordered event count, not narrativeOrder filtering
- **Migrate `diffEvent`** to use `compileStoryBoundaries` for before/after states (eliminates the `stateManager.getStateAt(narrativeOrder - 1)` pattern)
- **Migrate `StateManager.getStateAt`** to use `replay()` with snapshot optimization based on event count, not narrativeOrder

This satisfies the spec's intent ("统一为显式结果", no narrativeOrder as data order, no divergent optimized path) while keeping test churn manageable.

#### DAG-5a: Snapshot key migration

**Scope**: `snapshot.ts` uses `narrativeOrder` in 3 places: filename (`snapshot_${narrativeOrder}.json`), `findNearest(targetOrder)`, `shouldSnapshot(narrativeOrder)`. Replace with event-count-based keying.

**Target file**: `packages/core/src/state/snapshot.ts`

**Changes**:
1. `shouldSnapshot(eventCount: number): boolean` — trigger by event count (commit count), not narrativeOrder. Same interval logic: `eventCount > 0 && eventCount % this.snapshotInterval === 0`.
2. `createSnapshot(eventCount: number, eventId: string, state: WorldState): Snapshot` — filename becomes `snapshot_${eventCount}.json`. `Snapshot` type's `narrativeOrder` field renamed to `eventCount` (or kept as `narrativeOrder` with a deprecation alias — check `Snapshot` type definition).
3. `findNearest(targetCount: number): Snapshot | null` — find snapshot with largest eventCount ≤ targetCount.
4. `invalidateFrom(eventCount: number): void` — delete snapshots with eventCount ≥ threshold.
5. `listSnapshots(): number[]` — return eventCounts.

**Caller update**: `StateManager.commit()` (manager.ts:25-28) currently calls `shouldSnapshot(event.narrativeOrder)` and `createSnapshot(event.narrativeOrder, event.id, state)`. Change to pass the commit count (track a counter or use `this.eventStore.getAll().length`).

**Check Snapshot type**: Read `types/index.ts` for the `Snapshot` interface. If it has `narrativeOrder: number`, add `eventCount: number` and keep `narrativeOrder` as deprecated compat. Update `Snapshot` type.

**Acceptance**: `npm run build` green, `npx vitest run --exclude '**/e2e.test.ts'` green, `grep "narrativeOrder" packages/core/src/state/snapshot.ts` returns zero matches. Snapshot files named `snapshot_N.json` where N = event count.

**Evidence**: `packages/core/tests/state.test.ts` — existing snapshot tests (lines ~925-1050) pass with updated keying. `packages/core/tests/state/snapshot-key.test.ts` (NEW) — test that shouldSnapshot triggers by count, findNearest finds by count, filename uses count.

#### DAG-5b: Delete getStateAtOptimized, unify getStateAt, migrate diffEvent

**Scope**: Delete the divergent `getStateAtOptimized`. Rewrite `getStateAt` to use `replay()` with DAG-ordered event filtering by position (not narrativeOrder). Migrate `diffEvent` to use `compileStoryBoundaries`.

**Target files**:
- `packages/core/src/state/replay.ts` — delete `getStateAtOptimized` (lines 382-506), rewrite `getStateAt` (lines 368-377)
- `packages/core/src/state/manager.ts` — update `getStateAt` to not call `getStateAtOptimized`
- `packages/core/src/api.ts` — `diffEvent` (lines 675-756) use `compileStoryBoundaries` instead of `stateManager.getStateAt`

**Changes**:

1. **Delete `getStateAtOptimized`** (replay.ts:382-506). The entire method body.

2. **Rewrite `getStateAt`** (replay.ts:368-377):
   ```ts
   getStateAt(events: NarrativeEvent[], position: number, branchPath?: BranchPath): WorldState {
     // position = index into DAG-ordered event list (0 = empty state, N = after N events)
     const bp = branchPath ?? createEmptyBranchPath();
     const selectedEvents = events.filter((event) => includesPath(event.branchExistence, bp));
     const { edges, inDegree } = buildCausalEdges(selectedEvents, { branchPath: bp });
     const sortedIds = topologicalSort(selectedEvents, edges, inDegree);
     const eventById = new Map(selectedEvents.map(e => [e.id, e]));
     const eventsToReplay = sortedIds.slice(0, position).map(id => eventById.get(id)!);
     return this.replay(eventsToReplay, bp);
   }
   ```
   This uses DAG-ordered position, not narrativeOrder. `position` is the count of events to replay in causal order.

3. **Update `StateManager.getStateAt`** (manager.ts:37-44):
   ```ts
   getStateAt(position: number, branchPath?: BranchPath): WorldState {
     const snapshot = this.snapshotEngine.findNearest(position);
     if (snapshot) {
       // Replay from snapshot state + events after snapshot's eventCount
       const allEvents = this.eventStore.getAll();
       const { edges, inDegree } = buildCausalEdges(allEvents, { branchPath });
       const sortedIds = topologicalSort(allEvents, edges, inDegree);
       const eventsAfterSnapshot = sortedIds.slice(snapshot.eventCount, position);
       // ... apply to snapshot state
     }
     return this.replayEngine.getStateAt(this.eventStore.getAll(), position, branchPath);
   }
   ```
   Or simpler: just call `this.replayEngine.getStateAt(this.eventStore.getAll(), position, branchPath)` without snapshot optimization (snapshots are an optimization, not a correctness requirement). The optimization can be re-added later if needed.

4. **Migrate `diffEvent`** (api.ts:675-756): Instead of `stateManager.getStateAt(narrativeOrder - 1)` and `stateManager.getStateAt(narrativeOrder)`, use `compileStoryBoundaries`:
   ```ts
   const boundaries = compileStoryBoundaries(authoredEvents, initialFacts, anchors, undefined, initialThreads);
   const beforeState = boundaries.stateBeforeByEventId.get(eventId);
   const afterState = /* replay including this event */;
   ```
   The `stateBeforeByEventId` already gives the before-state. For after-state, replay up to and including the target event. Or: compare `stateBeforeByEventId[eventId]` with `stateBeforeByEventId[nextEventInOrder]` (or `finalState` if it's the last event).

**Test impact**: `getStateAtOptimized` has 6 references in `state.test.ts:925-1051` (one `describe` block). These tests must be deleted or rewritten to use `getStateAt`. The `getStateAt` tests (state.test.ts:859-922, integration.test.ts:553-572, e2e.test.ts:179-186) use `narrativeOrder` as the position argument — these need updating to use event-count position instead. BUT: if we keep the `getStateAt` signature accepting a number that is now "position in causal order" rather than "narrativeOrder", the tests that pass `1, 2, 3` as position will still work IF the events' causal order matches their narrativeOrder (which it does in the test fixtures, since they use linear timelines). Verify this.

**Acceptance**: `npm run build` green, `npx vitest run --exclude '**/e2e.test.ts'` green, `grep "getStateAtOptimized" packages/core/src/` returns zero matches, `diffEvent` no longer calls `stateManager.getStateAt`.

**Evidence**: DAG-1 divergence test rewritten to assert `getStateAt` (unified) produces correct result. `packages/core/tests/state.test.ts` — `getStateAtOptimized` describe block removed, `getStateAt` tests pass. `packages/cli/tests/render-full-chain.test.ts` — zhu-fu full chain still passes.

#### DAG-5c: Test updates for unified replay

**Scope**: Update all test files that reference `getStateAt` or `getStateAtOptimized` to work with the new DAG-ordered position semantics.

**Target files**:
- `packages/core/tests/state.test.ts` — remove `getStateAtOptimized` describe block (lines 925-1051), update `getStateAt` tests if needed
- `packages/core/tests/integration.test.ts` — update getStateAtOptimized test (lines 569-571) to use getStateAt
- `packages/core/tests/e2e.test.ts` — verify getStateAt calls still work (lines 180, 183)
- `packages/core/tests/state/dag-divergence.test.ts` — rewrite: assert `getStateAt` (unified) produces correct result (no divergence)

**Key insight**: Most test fixtures use linear timelines where causal order = narrativeOrder. For these, `getStateAt(events, N)` with position N produces the same result as before (first N events in causal order = first N events in narrativeOrder). The tests should pass without changes to their assertions — only the `getStateAtOptimized` tests need removal.

**Verify**: For each test that calls `getStateAt(events, N)`, check if the events' causal order differs from narrativeOrder. If not (linear fixtures), the test passes unchanged. If yes (non-linear), update the position argument.

**Acceptance**: `npx vitest run --exclude '**/e2e.test.ts'` green (1083+ tests pass, only pre-existing ai-sdk failure). DAG-1 divergence test rewritten and passes.

**Evidence**: Full test suite green. `grep "getStateAtOptimized" packages/core/tests/` returns zero matches.

## Evidence

### DAG-0 [x]
- `packages/core/tests/state/dag.test.ts:29-36` — cycle rejection test passes
- `packages/core/src/state/dag.ts:125` — `throw new DagCycleError(...)`
- zhu-fu `nova validate` — 0 errors, 0 warnings (no cycle)

### DAG-3 [x]
- `packages/core/src/state/dag.ts:31-33` — branch filter before edge construction
- `packages/core/src/state/replay.ts:115` — branch filter before buildCausalEdges
- `packages/core/tests/state/dag.test.ts` — branch-aware edge tests pass

### DAG-1
- `packages/core/tests/state/dag-divergence.test.ts` (NEW) — 3 test cases proving divergence

### DAG-2
- `packages/core/tests/state/dag-tiebreaker.test.ts` (NEW) — tiebreaker no longer uses narrativeOrder
- `packages/core/tests/state/dag.test.ts:14-20` — existing storyTime ordering test still passes

### DAG-4
- `packages/core/tests/state/genesis-root.test.ts` (NEW) — 4 test cases for helper correctness
- `grep -c "genesis.*postconditions" packages/core/src/api.ts` returns 1

### DAG-5a
- `packages/core/tests/state/snapshot-key.test.ts` (NEW) — count-based snapshot keying
- `packages/core/tests/state.test.ts` — existing snapshot tests pass with updated keying

### DAG-5b
- `grep "getStateAtOptimized" packages/core/src/` returns 0
- `packages/core/tests/state/dag-divergence.test.ts` — rewritten, divergence resolved
- `packages/cli/tests/render-full-chain.test.ts` — zhu-fu full chain passes

### DAG-5c
- `npx vitest run --exclude '**/e2e.test.ts'` — full suite green
- `grep "getStateAtOptimized" packages/core/tests/` returns 0
