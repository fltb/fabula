# integration: Cross-domain resolution, merge, and reference eligibility

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| INTEGRATION-2 | [ ] | STATE-3 [x] | `docs/TODO.md` lines 934-940 |
| INTEGRATION-1 | [ ] | STATE-1..6 [x], DAG-1..5 [x] | `docs/TODO.md` lines 1026-1034 |

## Group-level dependencies
- **state-model**: STATE-3 [x] ✅ for INTEGRATION-2; STATE-1..6 [x] ✅ for INTEGRATION-1
- **dag-replay**: DAG-1..5 [x] ✅ for INTEGRATION-1
- INTEGRATION-2 and INTEGRATION-1 have non-overlapping file scopes → parallel.

## Sub-plan

### INTEGRATION-2: ReferenceEligibility & lifecycle closure

**Binding constraints**:

1. **Reference mode**: every entity reference has explicit `identity|live|historical` mode. `identity` = only references stable declaration, no current existence assertion. `live` = current runtime participation. `historical` = bound to fixed past boundary/tombstone.
2. **ReferenceIndex**: runtime-maintained, recomputed from canonical Entity/Relationship/Knowledge/Thread/Rule/BoundaryReference/artifact state. NOT independently writable. Snapshot can cache but MUST match canonical recomputation hash.
3. **Same EntityId at same boundary**: can be proposition/identity target legally. CANNOT be new live member simultaneously. Reference kind/mode is part of canonical validation.
4. **Committed artifacts → automatically historical**: InformationAct actor/recipient, Knowledge claim ownership, RuleEvaluation source — once committed, they are immutable historical artifacts/archived records, automatically excluded from live ReferenceIndex. They do NOT block subsequent entity retirement.
5. **Live references (MUST be explicitly closed)**: relationship membership, current runtime foreign key, active Thread binding, active Rule scope. These MUST be closed/historicalized in retirement final candidate state. Retiring rule entity MUST also same-node revoke current rule epoch. Archived artifacts CANNOT continue producing new claim/act/participation.
6. **Default eligibility**: catalog-only/absent → CANNOT create new live reference. Active → can create new. Inactive → existing live references retained, CANNOT create new (by default). Retired → permanently forbidden new live use, only identity/historical.
7. **Foreign key classification**: structural immutable → identity. Current location/owner/controller/container (mutable) → live. MUST NOT duplicate with writable relationship truth source. Fixed BoundaryReference/provenance/causal output/historical proposition → historical.
8. **Inactive overrides**: type/role/scope can versionedly widen inactive eligibility. Core safety CANNOT be overridden: CANNOT allow absent/retired new live reference. Retired can ONLY become historical via explicit historical conversion + fixed boundary/tombstone.
9. **ReferenceKind coverage (MUST include all)**: declaration, runtime foreign key, relationship membership, knowledge subject, proposition target, thread binding, rule scope, scene participant, POV focalizer, narrator subject, discourse target, causal output, provenance, historical boundary.
10. **Default active-only**: knowledge subject/InformationAct actor/recipient, new Thread binding, new active Rule scope, scene cast/POV default to active-only. Inactive: existing live relationship memberships can be retained per relationship policy.
11. **Retirement archival rules**: committed InformationActs/claims/evaluation artifacts → automatically archival historical. Relationship memberships/current foreign keys → MUST be explicitly closed. Thread/Rule bindings → MUST be explicitly closed OR fixed-boundary historical conversion authorized by type policy. CANNOT blanket-archive.
12. **Discourse**: can discuss inactive/retired entity, CANNOT let it re-live-participate. Narrator can reference historical entity, CANNOT create new live reference.
13. **Atomic node order (FIXED)**: stateBefore preconditions → build lifecycle/cross-domain candidate → recompute candidate ReferenceIndex → validate each new reference target eligibility → validate each retirement has closed/historicalized all incoming live refs → commit or reject.
14. **Same-node legality**: introduction+relationship/thread/rule use AND retirement+explicit closure are legal. NO implicit retirement cascade.
15. **Conflict rules**: same-time lifecycle write + unordered new/retained reference → conflict. Branch filter BEFORE eligibility. Merge: resolve entity lifecycle/identity FIRST, then atomic validate complete reference candidate.
16. **Minimum tests**: matrix cells (mode × kind × lifecycle state), introduction+use, retirement closure, historical conversion, POV/narrator boundary, inactive overrides, branch/merge/race, index recomputation/snapshot/cache, independent matrix interpreter properties.

### INTEGRATION-1: Cross-domain resolution, Merge & dual coverage

**Binding constraints**:

1. **AbsenceWitness**: `not_exists`/unintroduced entity/never-written cell → immutable AbsenceWitness. Binds: concrete branch, temporal prefix, catalog/lifecycle/closed-world basis, latest unset (if any), resolution hash. CAN satisfy presence-aware read. Enters provider/absence index/snapshot/cache/reference tests. IS NOT: WorldState write, initialState unset, author-origin output, narrative causation.
2. **ReadResolution = ProviderOutput | AbsenceWitness**: every deterministic read has EXACTLY ONE. ProviderOutput produces provider edge. AbsenceWitness uses independent absence index/temporal basis, does NOT pretend to be write/output. All read/provider coverage, branch validation, snapshot/cache/reference tests use ReadResolution. CANNOT force absence into initial unset or author causal origin.
3. **stateBefore vs stateAfter reads**: stateBefore — only from cross-node exact latest provider/AbsenceWitness. stateAfter — only checks current atomic node's complete candidate projection, ordered by internal effect graph. Does NOT expose intermediate WorldState. Does NOT create node self-edge or cross-node provider. Rule final invariants/postconditions, same-node introduce+establish, implicit scope unsets, final referential integrity → all use candidate path. Internal cycle/duplicate effect/invalid final state → hard fail.
4. **BoundaryReference**: hash-pinned, branch-compatible, one-way immutable StorySnapshot/StateBoundary input. DiscourseState/narrator/reveal validation CAN verify explicit proposition truth at past/future boundary. BoundaryReference does NOT generate provider/order/causal edge, does NOT change story replay/WorldState, does NOT put whole future snapshot into Pass 1. Scene contract can ONLY authorize exact proposition projection. Merge shared render needs each applicable branch reference to give identical truth — otherwise branch variant/reject. Source/graph/state hash change → discourse/cache invalidates.
5. **MergePlan (compiler-level)**: all cross-branch reconciliation handled by MergePlan. Normal concrete BranchPath replay NEVER reads other branch state. MergePlan specifies: incoming pinned snapshots, merge node/effective coordinate, `requireEqual|selectBranch(branchId)|literal` policy, source/merge provenance. Atomically builds ALL domain candidate results, validates with typed cross-domain read sets, generates branch-specific reconciliation transactions + explicit downstream outputs.
6. **MergePlan legality**: each reconciliation transaction MUST be legal from every incoming lifecycle/identity/reference state. `selectBranch`/literal MUST NOT implicitly revive retired entity, bypass reference closure, or change immutable identity. Otherwise reject or explicit new identity/epoch. `selectBranch` ONLY legal in MergePlan. FORBIDDEN: domain fixed merge order, auto union/average/active-wins/retired-wins.
7. **MergePlan order (FIXED)**: resolve identity/lifecycle/reference FIRST, then build one candidate merge graph, validate all cross-domain read sets.
8. **Dual coverage manifest**: `NarrativeNode = NarrativeEvent | NarrativeEllipsis` covers story replay/source state. `DiscourseNode = ScenePresentation | DiscourseBridge` covers reader discourse order/planned disclosure. Orthogonal — no double-counting.
9. **DiscourseBridge**: source-verified omitted-text disclosure record (position/planned acts/provenance). NO WorldState effect/render/POV/Pass2 job. CAN coexist with same source range's narrative ellipsis. NOT double-counted in either coverage layer.
10. **Sparse run**: MUST declare `isolated_excerpt` (ExcerptDisclosureCheckpoint) or `full_work_context` (preceding bridge completeness). Missing checkpoint/bridge → hard fail.
11. **StorySnapshot**: binds branch, ancestor-closed temporal node prefix, ordered node/effect/output IDs, complete WorldState, provider/AbsenceWitness indexes, entity/relationship/thread tombstones, rule epoch/exception/specification-transition/retired-ID tombstones, retained InformationActs/RuleEvaluationRecords, type/declaration catalog hashes, normalized graph hash, state/provenance/schema/replay hashes. STRICTLY selection-independent. Recovery result MUST equal full story replay EXACTLY.
12. **DiscourseSnapshot**: binds assembly/branch/DiscoursePosition, planned DiscourseState, narrator/profile/proposition catalog/BoundaryReference/selection/discourse graph/schema hashes. Recovery result MUST equal full planned discourse replay.
13. **NEVER in snapshots**: generated prose, Pass 2 observations, surface packets.
14. **Minimum tests**: never-written/pre-introduction/after-unset/branch-local absence; snapshot restart; aggregate three-valued evaluation; exactly-one ReadResolution; stateBefore vs stateAfter; BoundaryReference one-way/no-edge; MergePlan requireEqual/selectBranch/literal; retired entity non-revival; identity conflict; dual coverage orthogonality; DiscourseBridge no double-count; sparse run coverage; StorySnapshot selection-independent full-replay equivalence; DiscourseSnapshot planned-replay equivalence.

## Evidence
—
