# dag-replay: DAG causal edges, replay, and snapshot keying

## Group Status: [-] in progress — DAG-0 + DAG-3 collapsed to [x] (already implemented by CLI-2); DAG-1/2/4/5 genuinely open

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| DAG-0 | [x] | — | `docs/TODO.md` lines 281-296 — `topologicalSort()` throws `DagCycleError` (dag.ts:125), no catch/fallback in `replay()`, test `dag.test.ts:29-36` covers cycle rejection, zhu-fu fixture confirmed cycle-free by CLI-2 |
| DAG-1 | [ ] | — (test-only) | `docs/TODO.md` lines 796-806 — `getStateAtOptimized()` filters events by `narrativeOrder` (replay.ts:397), diverges from `replay()` DAG-sorted path. Needs divergence test fixture, then deletion in DAG-5 |
| DAG-2 | [ ] | — | `docs/TODO.md` lines 808-820 — provider selection already storyTime-based (dag.ts:58-68). Remaining: remove `narrativeOrder` tiebreaker from `compareByStory` (dag.ts:99); broader semantic provider resolution deferred to GRAPH-1 (Wave 3) |
| DAG-3 | [x] | — | `docs/TODO.md` lines 822-832 — `buildCausalEdges` filters by branch BEFORE edge construction (dag.ts:31-33); `replay()` filters at :115; already branch-safe |
| DAG-4 | [ ] | — | `docs/TODO.md` lines 836-844 — `system:genesis` already filtered from events (api.ts:507,587), initialFacts applied separately (story-boundaries.ts:64). Remaining: formal `initialState` root parameter on `compileStoryBoundaries` and `replay` signatures |
| DAG-5 | [ ] | DAG-1, DAG-2, DAG-4 | `docs/TODO.md` lines 846-870 — snapshot.ts uses narrativeOrder everywhere (filename :37, findNearest :44, shouldSnapshot :24). `getStateAt`/`getStateAtOptimized` exist. No `replayStory`/`replayDiscourse` split. Full refactor |

## Group-level dependencies
- **state-model**: STATE-3 [x] ✅ — all DAG items' preconditions met.
- DAG-0 has no cross-group deps and is already done.
- DAG-5 depends on DAG-1 (divergence test exists before method deletion) and DAG-4 (initialState root before unified replay signature).

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
- `buildCausalEdges()` (dag.ts:31-33): `events.filter((event) => includesPath(event.branchExistence, options.branchPath!))` — filters BEFORE edge construction
- `replay()` (replay.ts:115): `events.filter((event) => includesPath(event.branchExistence, bp))` — filters BEFORE `buildCausalEdges` call at :116
- `compileStoryBoundaries()` (story-boundaries.ts:58-59): receives pre-filtered events, builds edges on those only
- No post-topology filtering that could drop providers

No work needed. Mark [x].

### DAG-1: Divergence test — getStateAtOptimized vs replay

**Scope**: Test-only. Create a fixture proving `getStateAtOptimized()` returns different state than `replay()` when causal order ≠ narrativeOrder. This test freezes the divergence as a regression precondition for DAG-5 (which deletes the method).

**Target file**: `packages/core/tests/state/dag-divergence.test.ts` (NEW)

**Steps**:
1. Create a minimal 3-event fixture where:
   - Event A (narrativeOrder=1, storyTime=day_5) writes `entity.status = "alive"`
   - Event B (narrativeOrder=2, storyTime=day_1) writes `entity.status = "dead"` (earlier storyTime, later narrativeOrder)
   - Event C (narrativeOrder=3, storyTime=day_3) has precondition `entity.status = "dead"` (depends on B in causal order)
2. Call `replay([A, B, C])` — DAG sorts B before A (day_1 < day_5), C's precondition satisfied by B
3. Call `getStateAtOptimized([A, B, C], 3, snapshot=null)` — falls back to `getStateAt(events, 3)` which filters `narrativeOrder <= 3` and replays. But `replay()` inside also uses DAG sort, so the divergence is actually in `getStateAtOptimized` with a snapshot.
4. Create a snapshot at narrativeOrder=1 (contains A's effects only, since A is narrativeOrder=1). Then `getStateAtOptimized(events, 3, snapshot)` replays events with `narrativeOrder > 1 && narrativeOrder <= 3` = [B, C]. But B (storyTime=day_1) should have been replayed before A (storyTime=day_5) in causal order. The snapshot at narrativeOrder=1 captured A's state, but B (which is causally earlier) wasn't included. This is the divergence: snapshot-based replay misses causally-earlier events with higher narrativeOrder.
5. Assert: `getStateAtOptimized` result ≠ `replay()` result (specifically, `entity.status` differs)
6. Assert: `replay()` returns correct state (B's "dead" overrides A's "alive")

**Acceptance**: New test file passes, demonstrates the divergence. No production code changes.

### DAG-2: Remove narrativeOrder tiebreaker from topologicalSort

**Scope**: Remove `narrativeOrder` as tiebreaker in `compareByStory` (dag.ts:99). Replace with storyTime day only, falling back to event ID (already the last resort).

**Target file**: `packages/core/src/state/dag.ts`

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

**Change**: Remove `(ea.narrativeOrder - eb.narrativeOrder)` from the comparison chain. Result:
```ts
return (dayA - dayB) || a.localeCompare(b);
```

**Edge case**: When two events have the same storyTime day and no causal edge between them, order is now determined by event ID (lexicographic), not narrativeOrder. This is deterministic and discourse-order-independent. If two events at the same storyTime need a specific order, they must declare a causal dependency (precondition→postcondition edge).

**Update test**: `dag.test.ts:14-20` — the test "uses strictly earlier story-time providers, not narrative order" already validates storyTime-based ordering. Verify it still passes. Add a test for same-day tiebreaker using event ID, not narrativeOrder.

**Acceptance**: `npm run build` green, `npx vitest run packages/core/tests/state/dag.test.ts` passes, narrativeOrder no longer referenced in `compareByStory`.

### DAG-4: Formal initialState root for replay

**Scope**: Make `system:genesis` handling explicit and formal. The current code filters it out ad-hoc in api.ts (lines 507, 587) and applies initialFacts separately. Formalize this as an `initialState` parameter.

**Target files**:
- `packages/core/src/state/story-boundaries.ts` — add `initialState?: WorldState` parameter
- `packages/core/src/api.ts` — pass initialFacts-derived state as `initialState` instead of applying inside `compileStoryBoundaries`
- `packages/core/src/state/replay.ts` — `ReplayEngine.replay()` already takes events; document that genesis must be pre-filtered

**Steps**:
1. In `story-boundaries.ts`, change `compileStoryBoundaries` signature:
   ```ts
   export function compileStoryBoundaries(
     events: NarrativeEvent[],
     initialFacts: readonly Fact[],
     anchors: Map<string, number>,
     branchPath?: BranchPath,
     initialThreads?: Array<{ id: string }>,
   ): StoryBoundaries
   ```
   → Keep as-is. The `initialFacts` + `initialThreads` already serve as the initialState. The key change is **documentation and type clarity**: add a doc comment that `events` must NOT contain `system:genesis` — initialFacts is the genesis root.

2. In `api.ts`, extract the genesis filtering + initialFacts construction into a helper:
   ```ts
   function buildInitialState(events: NarrativeEvent[], registry: InMemoryEntityRegistry, data: ...): { initialFacts: Fact[]; authoredEvents: NarrativeEvent[]; initialThreads: Array<{id:string}> } {
     const genesis = events.find(e => e.id === 'system:genesis');
     const initialFacts = [...(genesis?.postconditions ?? []), ...registryFacts];
     const authoredEvents = events.filter(e => e.id !== 'system:genesis');
     return { initialFacts, authoredEvents, initialThreads };
   }
   ```
   This deduplicates the identical block at api.ts:303-316 (renderNovel) and api.ts:572-588 (getProjectStatus).

3. Add a test: `packages/core/tests/state/genesis-root.test.ts` — verifies that `compileStoryBoundaries` with genesis-filtered events + initialFacts produces correct boundaries, and that genesis events in the events array are ignored (not double-applied).

**Acceptance**: Build green, existing tests pass, new test passes, no ad-hoc genesis filtering duplicated.

### DAG-5: Unified replay — remove narrativeOrder from snapshot, delete getStateAt/getStateAtOptimized

**Scope**: The largest item. Snapshot system uses narrativeOrder as data order in 3 places. `getStateAt`/`getStateAtOptimized` duplicate replay logic with narrativeOrder assumptions. Unify into a single replay path.

**Target files**:
- `packages/core/src/state/snapshot.ts` — replace narrativeOrder keying with canonical state hash
- `packages/core/src/state/replay.ts` — delete `getStateAt` and `getStateAtOptimized`, unify into `replay()`
- `packages/core/src/api.ts` — update all callers of `getStateAt`/`getStateAtOptimized`
- `packages/core/src/state/manager.ts` — update StateManager if it uses these methods

**Steps**:
1. **Snapshot keying**: Replace `snapshot_${narrativeOrder}.json` with `snapshot_${eventCount}_${stateHash}.json` where `stateHash = SHA256(JSON.stringify(state)).slice(0,16)`. Update `findNearest` to find the snapshot with the most events (largest prefix) that is ancestor-compatible. Update `shouldSnapshot` to trigger by event count, not narrativeOrder. Update `invalidateFrom` to delete snapshots with event count >= threshold.
2. **Delete `getStateAt`**: It filters by `narrativeOrder <= N` then calls `replay()`. All callers should instead pass the pre-filtered event list to `replay()` directly. Find callers via grep.
3. **Delete `getStateAtOptimized`**: It uses snapshot + narrativeOrder-filtered incremental replay. The optimized path should instead: find nearest snapshot by event-count prefix, replay only events after that prefix in DAG order. But this optimization is complex and may not be worth it for the current fixture sizes. If no caller depends on the optimization, simply remove it and let callers use `replay()` (full replay is fast enough for fixture-scale projects).
4. **Update StateManager**: Check if `StateManager` calls `getStateAt`/`getStateAtOptimized`. If so, update to use `replay()` or `compileStoryBoundaries` instead.
5. **Update tests**: The DAG-1 divergence test should be updated to verify that the unified `replay()` produces correct results (the divergence no longer exists because the divergent method is deleted).

**IMPORTANT**: This is a refactor, not a feature addition. The observable behavior (state output) must not change for any existing fixture. All existing tests must pass. The DAG-1 divergence test is the regression guard — after deletion, the test should be rewritten to assert `replay()` produces the correct state (proving the unified path handles the case the old method got wrong).

**Acceptance**: Build green, all existing tests pass (except the divergence test which is rewritten), snapshot files no longer named by narrativeOrder, no `getStateAt`/`getStateAtOptimized` in the codebase.

## Evidence
—
