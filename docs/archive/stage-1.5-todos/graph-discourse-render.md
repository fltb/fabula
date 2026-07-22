# graph-discourse-render: Typed causal graph, discourse model, and render surface

## Group Status: [x] complete — all 3 items done. Build+test green (1319/1319).

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| GRAPH-1 | [x] | STATE-1, STATE-3 [x], DAG-2 [x] | `docs/TODO.md` lines 996-1007 — StoryGraph+DiscourseGraph, 4 edge classes, OutputDescriptor, ReadResolution, 24 error types, 50 tests |
| DISCOURSE-1 | [x] | GRAPH-1 | `docs/TODO.md` lines 1009-1020 — DiscourseState, 7 disclosure actions, 6 hint states, 4 narrator profiles, DiscourseContextProjection, 55 tests |
| RENDER-SURFACE-1 | [x] | DISCOURSE-1 | `docs/TODO.md` lines 1022-1031 — CompiledSceneContract, SurfaceDependencyGraph, 2 group policies, 4 cache keys, 39 tests |

## Group-level dependencies
- **state-model**: STATE-1 + STATE-3 [x] ✅
- **dag-replay**: DAG-2 [x] ✅
- DISCOURSE-1 needs GRAPH-1; RENDER-SURFACE-1 needs DISCOURSE-1. All internal serial.

## Sub-plan

### GRAPH-1: Typed causalDependencies + graph compiler

**Binding constraints (MUST follow exactly)**:

1. **Two separate graphs**: `StoryGraph` (effectiveCoordinate=storyTime) and `DiscourseGraph` (effectiveCoordinate=DiscoursePosition). Each has 4 edge classes: `author_origin`, `provider`, `same_coordinate_order`, `internal`. Edge classes are NEVER mixed.
2. **No cross-graph causal/provider edges**: StoryGraph and DiscourseGraph cannot have causal/provider edges between them. Only `BoundaryReference` (hash-pinned, one-way, readonly) can flow from StorySnapshot → Discourse validation/context.
3. **author_origin ≠ provider**: author_origin never covers provider resolution. provider never auto-proves narrative causation. They are separate edge classes.
4. **One predecessor per dependency**: each cross-node dependency has exactly one predecessor/dependent. Multiple causes use multiple dependency edges (can share causalGroupId).
5. **OutputDescriptor normalization**: every replay effect → immutable OutputDescriptor with: stable output/effect/node ID, canonical state/artifact key, set/unset after value, branch scope, effectiveCoordinate, provenance hash.
6. **What IS a StoryGraph output**: entity/relationship (incl implicit scope unsets)/knowledge/story-thread/rule writes, materialized defaults, merge writes, information acts, rule evaluations.
7. **What IS a DiscourseGraph output**: planned disclosure/narrator assertion/hint/withhold/discourse-thread/DiscourseBridge acts.
8. **What is NEVER an output**: summary, narrativeHint, prose, Pass 2 results, LLM judgment.
9. **ReadRequirement**: every deterministic consumer exposes: read ID, exact canonical key/artifact, presence-aware predicate, stateBefore/stateAfter phase, branch scope, origin (precondition/source/rule/scope/lifecycle/merge).
10. **Canonical selector coverage**: must cover ALL domains — Entity lifecycle/type/attribute; n-ary Relationship (MUST use RelationshipId/EpochId/MembershipId, NEVER participant name/direction prose/current-member wildcard); Knowledge claim; Thread status/run/phase/binding/goal/milestone+clock; Rule epoch/activation/effectiveness/scope/exception; DiscourseState (discourse deps only).
11. **Explicit dependency rules**: each explicit dependency MUST select at least one actual predecessor output, bind expected operation/value/output hash, selector MUST resolve uniquely per applicable concrete branch. REJECTED: generic `dependsOn`, no-output edges, semantic hint/prose output dependency.
12. **Provider resolution**: for each branch/read — collect exact-key branch-compatible writes with coordinate earlier-or-same-and-ordered; select unique coordinate/declared partial-order MAXIMAL write; verify its output satisfies read predicate; record output→read provider edge. NEVER skip intervening unset/override/reversion/membership/claim/thread/rule/disclosure revision to pick an earlier matching value.
13. **`provider_selection` explicit form**: MUST resolve to same unique maximal output. Can disambiguate same-coordinate order. CANNOT specify stale provider.
14. **Auto-inference (compiler MAY infer)**: exact-cell provider, initialState provider, transaction-named information act/rule evaluation provider, same-node internal introduction/binding edges, implicit relationship unsets, finite rule read sets, merge reconciliation outputs+edges. Finite aggregate predicates MUST expand to exact reads.
15. **Author MUST explicitly declare**: author narrative causation, same-time noncommuting order, multiple/incomparable providers, branch-different providers, unnamed information/testimony/inference/announcement, multi-output cross-domain dependency, merge input/non-equal reconciliation, corpus/ellipsis causation not recoverable from exact state read.
16. **Coordinate legality**: StoryGraph predecessor storyTime MUST be earlier than dependent, or same+declared edge establishes acyclic order. DiscourseGraph predecessor DiscoursePosition MUST be earlier or same+internal order. FAILS: future/incomparable/unresolved story anchor, duplicate discourse position. `narrationTime` does NOT enter causality. Story/discourse clocks CANNOT cross-domain depend.
17. **Same-coordinate conflict**: MUST be ordered OR provably commutative on complete read/write sets. NEVER stable ID/filename/narrativeOrder/last-writer-wins tie-break.
18. **initialState**: StoryGraph non-narrative root — no predecessor/scene/branch variation/unset/semantic output. Emits complete deterministic initial writes. CAN be exact provider. CANNOT be author_origin/same_coordinate_order predecessor. Real story priors MUST be event/ellipsis, NEVER hidden in initialState.
19. **Dynamic entity catalog declarations**: do NOT provide runtime existence. Cross-node use reads lifecycle provider. Same-node introduce/use creates internal edge.
20. **Retirement**: conflicts with unordered relationship/thread/rule/knowledge references. Same-node closure uses internal dependencies.
21. **Branch scope**: MUST be subset of predecessor/dependent applicability. Filter concrete branch BEFORE resolving provider. Each dependent read per branch has exactly one ReadResolution = ProviderOutput | AbsenceWitness. FAILS: overlapping provider declarations, cross-branch leakage, coverage gap.
22. **NarrativeEllipsis**: only StoryGraph predecessor/dependent. Required output MUST be actual replay effect of its single storyTime. Summary NEVER selected.
23. **Compiler order (FIXED)**: normalize outputs → reads → filter branch → resolve declarations → validate coordinate/order → infer providers/absence → commutativity → branch/closure/cycle validation → hash/replay.
24. **Typed errors (MUST include all)**: unknown/self predecessor, missing/ambiguous output, assertion/read mismatch, unknown read ID, stale provider selection, duplicate branch provider, branch coverage/incompatibility, future/incomparable time, unordered same-time conflict, cross-clock edge, edge-origin cycle, initial-root misuse, semantic-output dependency, dynamic lifecycle/merge input/ellipsis summary/provenance error.
25. **Cache**: MUST include target coordinate prefix + same-coordinate ancestors + all dependency/output/absence hashes.

**Minimum test categories (MUST cover all)**:
All domain selector/output/read; initial root; reversion/unset/stale selection; author-origin/provider separation; n-ary relationship scope; knowledge acts/higher-order claims; thread/rule reads; same-time commutativity/order; dynamic entities; branch partition/convergence/merge; ellipsis provenance/selection closure; cycle diagnostics; snapshot/full replay/cache invalidation.

### DISCOURSE-1: Model Reader, Narrator & spoiler-safe context

**Binding constraints**:

1. **DiscourseState independence**: NOT part of WorldState. CANNOT satisfy story precondition, provide WorldState provider, or cross story/discourse clock edges. Real reader psychology is NOT modeled. Planned retraction only changes assertion contract status, does NOT fake reader forget.
2. **ModelReaderProfile v1**: only immutable/versioned built-in `default_model_reader_v1`. Profile ID/hash, audience semantics, narration/disclosure policy, empty initial exposure contract defined by compiler. Profile NEVER inferred from prose/reader telemetry/runtime. CANNOT rewrite StoryState. Custom profiles are X until versioned profile catalog + migration + manifest row + discourse reference conformance exist.
3. **Canonical DiscourseState**: only replays `PlannedDiscourseLedger`. YAML (or fixed corpus source-verified contract) is the ONLY reader/narrator/disclosure truth. All scene contracts determined before any prose generation. Pass 2/human review disclosure observations are scene-local validation evidence ONLY — MUST NOT write/revise canonical discourse ledger, become downstream logical provider, change scene precondition/reveal contract, or make downstream render wait for "actual reveal" confirmation.
4. **Disclosure actions**: reveal, claim, hint, retraction, correction, withhold_start, withhold_end.
5. **reveal truth-boundary**: reveal can ONLY plan to expose truth-boundary=true propositions as authoritative narrative truth. false/indeterminate content can ONLY plan claim/conjecture/red herring/intensional proposition. **This is a hard rule — subagent MUST NOT conflate reveal and claim.**
6. **claim**: plans to expose assertion without committing truth.
7. **hint**: plans to expose surface proposition + author-only target proposition linkage. Target NEVER enters model-reader/Pass1 projection. Hint states: planned|contract_planted|contract_reinforced|contract_fulfilled|contract_subverted|retracted — all are contract status, NOT prose observation. Can link to discourse Thread. Suspense/foreshadowing progress belongs to discourse Thread.
8. **retraction**: does NOT make planned reader contract fake forget.
9. **correction**: ONLY supersedes prior discourse assertion contract. NEVER retcons WorldState — WorldState changes must be separately modeled via YAML story-state change/provenance.
10. **NarratorProfile**: focalizer_bound, retrospective_entity, explicit_ledger, omniscient. Access, assertion, truth, fidelity, sincerity/deception are INDEPENDENT. Omniscience grants truth read access ONLY, NEVER auto-reveal. Retrospective narrator uses explicit later Knowledge boundary. Reliability is per-assertion derived evaluation — truth mismatch does NOT auto-infer lie.
11. **NarratorAssertion**: narrator/proposition/polarity, authoritative_reveal|claim|conjecture|quotation|implication, truthBoundary, narrationBoundary/evidence. Scene contract fixes narrator/focalizer boundaries, audiences, prerequisite disclosure reads, planned effects, withholding policies. Private thought can be visible to reader but not to other characters.
12. **Pass 1 DiscourseContextProjection**: capability-separated. ONLY: previous planned reader reveals, open claims, visible hint surfaces, focalizer/narrator accessible claims, current-scene explicitly authorized reveal/claim targets, active withholding policies. FORBIDDEN: future/unrelated truth, hint target, raw generated previous-scene summary, catalog metadata, unauthorized WorldState truth. Previous logical summary MUST be compiled from planned disclosure projection. Downstream scene NEVER changes reader state or logical contract due to prior prose/Pass 2 observation.
13. **Flashback/flashforward**: flashback reads historical WorldState/Knowledge but advances current planned DiscourseState. Flashforward can reveal fixed future-boundary proposition. Returning to earlier storyTime NEVER rolls back planned reader exposure. narrationTime only selects narrator boundary — ambiguous boundary hard fails.
14. **Discourse branches**: independent. Shared post-merge scene ONLY if all incoming branches have IDENTICAL complete discourse read projection — otherwise generate branch variants. NEVER union/intersection/max exposure/destructive replacement. One branch's generated prose/validation NEVER changes another branch's planned contract.
15. **NarrativeEllipsis**: no discourse position. NEVER produces reader disclosure/narrator assertion/hint/retraction/withholding effect. Summary NEVER reader evidence.
16. **Sparse corpus**: MUST choose `isolated_excerpt` (source-verified ExcerptDisclosureCheckpoint) or `full_work_context` (all prior source-verified DiscourseBridge planned records). Missing checkpoint/bridge coverage → CANNOT claim complete reader context. Selection NEVER auto-infers/changes planned disclosure from unrendered prose.
17. **Pass 2 disclosure observations**: structured (planned effect ID, reveal/claim/hint/retraction/correction/unplanned exposure, proposition/polarity/assertion/evidence/matchLevel/authority presentation) + suspected withholding/POV/narrator leak. They ONLY verify current prose matches planned contract. Failure can trigger retry/block/human review. NEVER updates canonical discourse ledger, downstream logical contract, WorldState/Knowledge/deterministic causal provider. "No leak detected" is NOT proof of no leak.
18. **Cache**: `ValidationKey` (prose hash, analysis schema/model, validator/reference policy) is INDEPENDENT from logical/discourse cache. Prose surface references use RENDER-SURFACE-1 independent cache. Discourse snapshots/cache include: run key/cursor/planned state hash/assertion-hint-policy/provider index/branch/narrator-profile/proposition catalog/selection/provenance hash.
19. **REJECTED (hard fails)**: discourse as WorldState provider, actual reader subject, duplicate branch position, ambiguous narrator boundary, false reveal, claim-as-reveal/access violation, unknown assertion retraction/exposure erase/hint target leak, withhold boundary break.

**Minimum test categories**: DiscourseState replay by position; all 7 disclosure actions; hint state lifecycle (6 states); claim vs reveal truth-boundary enforcement; narrator profile boundaries (4 types × access/assertion/truth/fidelity/sincerity); Pass 1 projection filtering (forbidden items excluded); flashback/flashforward; branch-independent discourse; shared post-merge scene identical-projection check; Pass 2 observation non-mutation; sparse corpus coverage modes; ValidationKey independence.

### RENDER-SURFACE-1: Logical-independent text coherence & grouped parallel

**Binding constraints**:

1. **Four-graph separation**: render plan MUST separate `logicalGraph` (STATE/GRAPH contract), `plannedDiscourseGraph`, `SurfaceDependencyGraph`, `ValidationGateGraph`. YAML/catalog/compiled deterministic state/planned DiscourseState is scene logic's ONLY input. Generated prose, Pass 2, summary, surface packet NEVER write/revise WorldState/Knowledge/Thread/Rule/planned DiscourseState. NEVER become logical provider/causal dependency/precondition/reveal contract. If prose has unmodeled detail that later logic depends on, author MUST promote it to YAML and recompile.
2. **CompiledSceneContract**: every scene has one BEFORE prose. Contains: branch/discourse position, WorldState/Knowledge/narrator/planned discourse boundary hashes, resolved versioned StyleProfile, deterministic authored continuity packet, prompt contract hash. StyleProfile resolves by project→chapter→narrator/POV→scene deterministic precedence. Can include voice/diction/rhythm/paragraphing/typography/dialogue/avoid. Continuity packet ONLY: transition (continuous/hard_cut/time_jump/location_jump/pov_shift/chapter/flashback), authored motifs/callbacks/open-close mode. Generated prose NEVER rewrites style profile. Generated phrase NEVER becomes mandatory callback unless author writes it to YAML and recompiles.
3. **Default `logical_parallel`**: all scenes render in parallel, only constrained by deterministic contract. `serial_surface_groups` is author-controlled, short, branch-local, discourse-order ordered lane.
4. **SurfaceReferencePacket**: fixed tail/full excerpt of accepted source prose + deterministic style metrics + authored anchor. Non-authoritative, rhythm/transition ONLY. **YAML ALWAYS wins on conflict.**
5. **Group rules**: each rendered scene belongs to exactly one group. Group order is branch discourse order subsequence. MUST NOT be inferred from filename/storyTime/causal order/completion timing. HARD FAILS: cross-branch surface edge, merge shared render consuming branch-specific prose, surface cycle, unaccepted source prose, unversioned extraction/budget.
6. **Group policies**: `manual` (author writes group), `suggest` (deterministic planner proposes but doesn't apply), `auto` (only if project explicitly authorizes). Any effective result outputs versioned, hash-pinned, overridable `RenderGroupManifest` (policy version/source definition hash/group IDs/lanes/surface policy) → enters surface cache key. **Planner MUST NOT read prose/LLM judgment, modify YAML/logic/discourse/causal edges, or reorder by completion timing.**
7. **Supported policies**: `parallel`, `serial_surface` ONLY. `parallel_then_harmonize` and `joint_group` are EXPLICITLY X. NEVER as implicit optimization or benchmark workload.
8. **Chapter default**: does NOT carry prose excerpt. POV/narrator switch MUST declare: none/rhythm_only/tail_excerpt/authored_anchor.
9. **Validation gate**: determines if prose artifact can release/assemble + be surface source. Pass 1→Pass 2/deterministic checks→accept/retry/block. Accepted prose → surface packet. Failed scene ONLY blocks surface descendants; logical compilation/unrelated groups still valid. Retry has independent AttemptKey. Replacement prose hash makes transitive surface descendants stylistically stale → cannot assemble → must re-render. `fallback_without_surface` ONLY legal if group policy explicitly states it AND enters cache key. Exhausted retry MUST NOT patch state/skip hard validation/invent disclosure.
10. **Cache layering (4 independent keys)**:
    - `LogicalRenderKey`: scene contract/WorldState/planned discourse/catalog/graph/style/profile/prompt-provider
    - `SurfaceRenderKey`: + group manifest/surface policy/ordered source prose hashes/extractor-truncation version
    - `ValidationKey`: + prose hash/Pass2 schema-model/validator-reference policy
    - `AttemptKey`: + surface key/attempt/prior prose/same-scene retry guidance
11. **Cache invalidation rules**: YAML/state change → invalidates logical dependents + surface descendants. Prose-only change → invalidates validation/assembly/surface descendants. Group repartition/policy change → invalidates surface keys ONLY.
12. **Performance**: benchmark logical_parallel, balanced/skewed serial groups, cold/warm cache, source prose fanout/retry/branch variants. Report total work, critical path, makespan, cache hit, invalidated scene count, retry amplification, scheduler efficiency vs `max(totalWork/poolSize, longestSurfaceCriticalPath)`. NEVER penalize pool speedup for necessarily serial groups.

**Minimum test categories**: surface NEVER enters logical/discourse reads; author group/order/branch validation; manual/suggest/auto manifest determinism; excerpt budget/normalization; POV/chapter/flashback policies; source retry/stale descendants/fallback; branch merge isolation; cache partition/invalidation; parallel groups completion order doesn't affect results.

## Evidence
—
