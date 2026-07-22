# corpus: Long-form novel corpus benchmark (Phase 2)

## Group Status: [ ] unstarted

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| CORPUS-1 | [ ] | — | `docs/TODO.md` lines 1072-1077 |
| CORPUS-2 | [ ] | CORPUS-1 | `docs/TODO.md` lines 1079-1083 |
| CORPUS-3 | [ ] | CORPUS-2 | `docs/TODO.md` lines 1085-1089 |
| CORPUS-4 | [ ] | CORPUS-3, DAG-2/3/5 [x], API-2/4 [x] | `docs/TODO.md` lines 1091-1095 |
| CORPUS-5 | [ ] | CORPUS-4 | `docs/TODO.md` lines 1097-1101 |

## Group-level dependencies
- **dag-replay**: DAG-2, DAG-3, DAG-5 [x] ✅ (for CORPUS-4)
- **api-core-validator**: API-2, API-4 [x] ✅ (for CORPUS-4)
- CORPUS-1→2→3→4→5 are serial internal dependencies.

## Scope
Phase 2 only — external long-form benchmark. Does NOT change Stage 1 full fixture render. Does NOT impose corpus obligations on Stage 3 original author workflows.

## Sub-plan

### CORPUS-1: NarrativeNode + NarrativeEllipsis contract

**Scope**: Formalize `NarrativeNode = NarrativeEvent | NarrativeEllipsis` with explicit discriminant. Create `NarrativeEllipsis` type with identity, branch scope, single valid storyTime, optional source-grounded diagnostic summary, and reusable preconditions + Entity/Relationship/Knowledge/Thread/Rule transactions.

**New files**:
- `packages/core/src/types/corpus.ts` — NarrativeEllipsis, NarrativeNode, EllipsisProvenance types
- `packages/core/src/schemas/corpus.ts` — Zod schemas
- `packages/core/tests/state/corpus-ellipsis.test.ts` — test suite

**Binding constraints**:
1. `NarrativeNode = NarrativeEvent | NarrativeEllipsis` with explicit discriminant field
2. Ellipsis has: identity, branch scope, one valid storyTime, optional diagnostic summary, preconditions, Entity/Relationship/Knowledge/Thread/Rule transactions
3. Summary MUST NOT create claim/provider
4. Ellipsis MUST NOT have: POV, cast, scene brief, style, target words, narrationTime, narrativeOrder
5. Ellipsis NEVER produces: RenderedScene, RenderJob, Pass 2, scene validator, Assembler, scene count, CED/F1 denominator
6. Raw summary ONLY for source review/diagnostics — NEVER enters target logical prompt, produces Fact/causal edge/WorldState/DiscourseState change
7. Every replay-changing Fact/effect MUST have atomic `$provenance`
8. Multiple incompatible storyTimes/branches/causal positions within one ellipsis → MUST split; unprovable source/dependency/effective time → hard fail

**Acceptance**: New types, schemas, and tests. `grep "NarrativeEllipsis" packages/core/src/types/corpus.ts` returns matches.

### CORPUS-2: Full work index, anchors & provenance

**Scope**: Build versioned full-work index for each work variant. Fixed anchors: 《红楼梦》前80回, `David Copperfield`, 《四世同堂》87章+103章回译.

**New files**:
- `packages/core/src/state/corpus-index.ts` — WorkIndex, CandidateEventIndex, SourceManifest
- `packages/core/tests/state/corpus-index.test.ts` — test suite

**Binding constraints**:
1. Each work variant: fixed source manifest, chapter/source locations, character+alias, locations, main/sub threads, NarrativeNode list, DiscourseNode list, frozen candidate-event index
2. Candidates: natural source boundary scene candidates. Index records eligibility, ID, source range, exclusion reason
3. Narrative coverage + discourse coverage: each bound to source hash, non-overlapping, complete within declared layer. Same source range can appear in both layers. No unexplained gaps within each layer.
4. Anchors frozen: 《红楼梦》前80回 main model, `David Copperfield` fixed public domain English edition, 《四世同堂》87章 Chinese main model + 103章回译 extension. 87/103章 separate manifests/indexes/selections/reports. NO pooling or double-counting. 《四世同堂》 NOT in default public CI/aggregate score.
5. Each anchor: freeze edition/source hash, legal mode, adapter/schema version, source cleaning rules before modeling. Unrequested local external corpus → `not-run` + excluded. Once requested: missing text/legal prerequisite/manifest → build failure.

**Acceptance**: WorkIndex type, source manifest, candidate index. Tests cover coverage completeness, anchor freezing, double-counting prevention.

### CORPUS-3: Reproducible selective rendering

**Scope**: Selection algorithm: `min(32, max(20, ceil(0.15 * N)))` from frozen candidate index. Manual modeling of selected candidates as NarrativeEvents. Runnable selection only references existing NarrativeEvent IDs.

**New files**:
- `packages/core/src/state/corpus-selection.ts` — selection algorithm, SelectionPlan, RunnableSelection
- `packages/core/tests/state/corpus-selection.test.ts` — test suite

**Binding constraints**:
1. Plan selection: `min(32, max(20, ceil(0.15 * N)))` from frozen candidate-event index. N < 20 → not benchmark-eligible.
2. Each planned candidate: user manually models as existing NarrativeEvent, completes ellipsis splits, state effect attribution, provenance, causal dependency validation before runnable selection.
3. Planning selection frozen before any model results: algorithm, seed, strata, quotas, rounding, tie-break, exclusion, replacement policy, candidate IDs, source ranges.
4. Runnable selection: only references existing NarrativeEvent IDs. At minimum covers: beginning/middle/end, main thread, at least one sub-thread, major character state changes.
5. Only NarrativeEvents generate independent rendered scene files. NO normal Assembler disguising discontinuous prose as full novel.
6. Unselected source content: covered by user-maintained NarrativeEllipsis or non-state-affecting source location. Selection NEVER auto-modifies complete story model.
7. Runnable selection referencing ellipsis-covered candidate → hard fail with source range + duplicate/missing effect diagnosis.

**Acceptance**: Selection algorithm, frozen plan, coverage requirements. Tests cover formula, seed determinism, coverage categories, ellipsis conflict detection.

### CORPUS-4: Mixed causal replay + boundary oracle

**Scope**: DAG/replay/StorySnapshot accept `NarrativeNode[]`. Mixed-node ordering by GRAPH-1 exact output/read/provider + typed causal edges + storyTime. Boundary oracles for each selected event.

**New files**:
- `packages/core/src/state/corpus-replay.ts` — mixed-node replay
- `packages/core/tests/state/corpus-replay.test.ts` — test suite

**Binding constraints**:
1. DAG/replay/StorySnapshot accept `NarrativeNode[]`. Filter by branch scope, then GRAPH-1 exact output/read/provider + typed causal edges + storyTime → mixed-node order. Same-time noncommuting writes → source-supported dependency or hard fail.
2. narrativeOrder: discourse/Assembler ONLY. NEVER affects story provider, stateBefore, or StorySnapshot.
3. Selected event stateBefore: from complete mixed-node causal graph, excluding target and future effects.
4. Snapshot MUST record replayed NarrativeNode IDs.
5. Each selected event: independent, human source-verified StoryBoundaryOracle + planned pre-scene DiscourseOracle. Story oracle: asserts expected projection of all canonical state domains, provider/AbsenceWitness/required artifacts. Discourse oracle: asserts model-reader/narrator disclosure projection.
6. Oracles: fixed schema/version, source hash, reviewer/review status/hash, written to run manifest. Canonical equality uses fixed sort/NFC/LF serialization.
7. Mixed replay/discourse compile MUST match oracles exactly. NO self-proving via same YAML replay.

**Acceptance**: Mixed-node replay, boundary oracles. Tests cover mixed event/ellipsis ordering, oracle matching, stateBefore correctness, snapshot compatibility.

### CORPUS-5: Build failure, metric isolation & acceptance

**Scope**: Dataset-integrity gate. Missing source/provenance/causal dep/branch-compatible provider/boundary oracle coverage/legal mode/selection manifest → build failure. Ellipsis completely excluded from prose/scene/Pass2/validator/CED/F1 metrics.

**New files**:
- `packages/core/src/state/corpus-gate.ts` — dataset-integrity gate validation
- `packages/core/tests/state/corpus-gate.test.ts` — test suite

**Binding constraints**:
1. Missing/mismatched source, $provenance, causal dependency, branch-compatible provider, boundary oracle coverage, legal mode, or selection manifest → corpus loading/compilation failure.
2. NO new validator abstention states. NO deferred/skip/zero CED/zero F1 masking build failure.
3. All ellipsis build integrity is dataset-integrity gate, NOT prose validator result. Ellipsis completely excluded from prose, scene, Pass 2, validator, and CED/F1 metric population — NOT zero-value observations.
4. Selected rendered scene file count MUST equal frozen selection event count exactly.
5. Minimum tests: event/ellipsis schema mutual exclusion; DiscourseBridge/coverage checkpoint; raw ellipsis summary cannot enter logical prompt or leak; atomic provenance; missing dependency/cycle/time/order ambiguity hard fails; Story/Discourse snapshot-full replay equivalence + hash compatibility; target/future effects don't leak; dual boundary oracle consistency; full-work dual coverage completeness; selection reproducibility; 87/103 non-pooling; unrequested local external correctly marked `not-run` in public CI; independent scene outputs not joined by assembler.

**Acceptance**: Dataset-integrity gate, all minimum tests covered. Build green.

## Evidence
—