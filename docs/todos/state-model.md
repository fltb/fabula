# state-model: Entity state model — Fact, Relationship, Entity lifecycle, Knowledge, Thread, Rule

## Group Status: [-] in progress — STATE-1 + STATE-3 [x] implemented (defects #1,#3 fixed); STATE-2,4,5,6 sub-plan authored, implementation in progress (this session).

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| STATE-1 | [x] | — | `docs/TODO.md` lines 889-898 — implemented: canonical FactValue, three-form postconditions, presence-aware preconditions, replay set/unset + hard errors, defect #2 fixed, 5 test files/72 tests, build+test green |
| STATE-3 | [x] | STATE-1 | `docs/TODO.md` lines 914-924 — STATE-3a (catalog types + registry refactor, defect #3) + STATE-3b (21 validator checks catalog-driven, defect #1/zhu-fu fix) + STATE-3c (replay lifecycle transactions); 3 test files/75 tests; build+test green |
| STATE-2 | [ ] | STATE-3 | `docs/TODO.md` lines 900-912 |
| STATE-4 | [ ] | STATE-3 | `docs/TODO.md` lines 934-948 |
| STATE-5 | [ ] | STATE-3 | `docs/TODO.md` lines 950-960 |
| STATE-6 | [ ] | STATE-3 | `docs/TODO.md` lines 962-973 |

## Group-level dependencies
None — this is a Wave 1 group. STATE-1 has no external deps; STATE-3 needs STATE-1; STATE-2/4/5/6 need STATE-3. All internal.

## Sub-plan

This sub-plan is the decision-complete execution spec for all 6 STATE items. Each item maps the `docs/TODO.md` spec to exact files, signatures, and ordered steps. An implementer who never saw the planning conversation executes this top-to-bottom with zero design decisions.

**Cross-item invariants** (apply to every STATE item unless overridden):
- New types go in `packages/core/src/types/`; new schemas in `packages/core/src/schemas/`; both re-exported from `types/index.ts` and `schemas/index.ts` barrels.
- All new Zod schemas reject placeholder values (`changed`, `resolved`, `updated`, etc.) at schema level — extend the existing placeholder-rejection pattern.
- Every new domain write produces a provider record with `{nodeId, factId/effectId, operation, before, after, storyTime, branch, provenanceHash}`.
- Every hard error is a typed error class extending `NovalisticallyError` in `packages/core/src/errors.ts`.
- Tests go in `packages/core/tests/state/` (or `packages/core/tests/entity/` for value-level utils); each test file defends an observable contract and fails on a plausible bug.
- Do NOT touch `packages/core/src/api.ts`, `validator/aggregator.ts`, `validator/index.ts`, `schemas/analysis.ts`, `index.ts` exports — those are owned by the api-core-validator group (or their own groups).
- Run `npm run build` + `npx vitest run --exclude '**/e2e.test.ts'` after each item; tree must stay green.

### STATE-1: Entity Fact 的 presence-aware set/unset 规范

**Source**: `docs/TODO.md:889-898` (10 bullets). **Status**: [ ] — **this is the root prerequisite, no deps.**

**Files to touch** (exhaustive):
- `packages/core/src/entity/fact-value.ts` (NEW) — canonical FactValue utils
- `packages/core/src/entity/index.ts` — re-export new utils
- `packages/core/src/types/event.ts` — extend `Fact` with `operation?: 'set' | 'unset'`; enforce `value`/`narrativeHint` mutual exclusivity at type level
- `packages/core/src/schemas/event.ts` (or wherever the postcondition/precondition Zod schemas live — grep for `expectedPostconditions` schema) — three-form postconditions, presence-aware preconditions
- `packages/core/src/state/replay.ts` — precondition validation before effects; set/unset application with canonical values; hard errors; remove broken knowledge-push block (lines 134-141)
- `packages/core/src/state/story-boundaries.ts` — reject initialFacts with `operation: 'unset'` or narrativeHint-only
- `packages/core/src/entity/fact.ts` or wherever `compareFact` lives — return `'deferred'` for narrativeHint-only facts
- `packages/core/tests/entity/canonical-fact-value.test.ts` (NEW)
- `packages/core/tests/state/fact-three-forms.test.ts` (NEW)
- `packages/core/tests/state/presence-aware-preconditions.test.ts` (NEW)
- `packages/core/tests/state/replay-set-unset.test.ts` (NEW)
- `packages/core/tests/entity/comparefact-deferred.test.ts` (NEW)

**Ordered steps**:
1. Create `packages/core/src/entity/fact-value.ts`:
   - `export type CanonicalFactValue = null | boolean | number | string | CanonicalFactValue[] | {[k: string]: CanonicalFactValue}`
   - `export function isCanonicalFactValue(v: unknown): boolean` — returns false for `undefined`, `NaN`, `Infinity`, `-Infinity`, `Date` instances, class instances (prototype not Object.prototype and not null), functions, symbols; recursively checks arrays and plain objects.
   - `export function canonicalizeFactValue(v: unknown): CanonicalFactValue` — deep-copies arrays/objects, freezes each level recursively, throws `new ConfigError('Non-canonical FactValue: ...')` for rejected types. For numbers: reject non-finite. For objects: only accept plain objects (Object.getPrototypeOf(obj) === Object.prototype || === null).
   - `export function canonicalDeepEqual(a: CanonicalFactValue, b: CanonicalFactValue): boolean` — structural equality (Object.is for primitives; recursive for arrays/objects; key order independent).
2. Extend `Fact` in `types/event.ts`: add `operation?: 'set' | 'unset'` (default `'set'`). Keep `value?` and `narrativeHint?` as existing optional fields. Add a TS-side invariant via a union: `Fact = DeterministicSetFact | DeterministicUnsetFact | SemanticFact` where `DeterministicSetFact = {value: FactValue, operation?: 'set', narrativeHint?: never}` etc. If a full union is too disruptive, keep the single interface but document the mutual exclusivity and enforce it in Zod.
3. Update Zod postcondition schema (find it via `grep -r "expectedPostconditions" packages/core/src/schemas/`):
   - Use `z.discriminatedUnion('operation', [setForm, unsetForm, hintForm])` OR a refined `z.object` with `.refine` enforcing: if `operation === 'unset'` → `value` and `narrativeHint` forbidden; if `value` present → `operation` defaults to `'set'`, `narrativeHint` forbidden; if only `narrativeHint` → `value` and `operation` forbidden. Default `operation` to `'set'` when `value` present and `operation` omitted.
   - Reject placeholder string values in `value` (extend existing placeholder-rejection pattern).
   - Add same-node duplicate-effect rejection: this is enforced at replay time (not schema) since schema validates one Fact at a time. Document this in a comment.
4. Update Zod precondition schema: if `operator` is `'exists'` or `'not_exists'` → `value` forbidden; if operator is `eq/neq/gt/gte/lt/lte/contains/not_contains` → `value` required; `narrativeHint`-only precondition allowed (no operator, no value). Invalid operator+value combos → Zod error.
5. Update `compareFact` (find via `grep -r "export function compareFact\|export const compareFact" packages/core/src/`): add early return — if fact has `narrativeHint` and no `value` → return `'deferred'` before any value comparison. Verify callers handle `'deferred'` (grep `compareFact` callers; they should already — it's an existing return value).
6. Update `packages/core/src/state/replay.ts`:
   - Before the postcondition application loop (currently around line 67-99), add precondition validation: for each deterministic precondition (has `operator` and `value`, or `exists`/`not_exists`), check current state; on failure throw `new PreconditionMismatchError(...)` BEFORE applying any effects. NEVER initialize state from preconditions.
   - In the postcondition application: for `operation: 'set'` (or default with `value`), write `canonicalizeFactValue(fact.value)` to `state.entities[entityId][attribute]`. For `operation: 'unset'`, `delete state.entities[entityId][attribute]`. Skip narrativeHint-only facts (no WorldState write).
   - Hard errors (throw typed): `unset` on already-absent attribute → `ConfigError`; unknown entity → `ConfigError`; same-node duplicate write to same `(entityId, attribute)` → `ConfigError`; same-time unordered racing writes → `ConfigError`.
   - Remove the broken knowledge-push block (replay.ts:134-141, the `if (fact.attribute === 'knows' || fact.attribute === 'knowledge')` block). Replace with comment: `// Knowledge state is owned by STATE-4 EpistemicLedger; replay does not write state.knowledge.`
   - Before removing: grep for `knownFacts` and `state.knowledge` readers. If a reader exists and will break, leave `state.knowledge[entityId] = {knownFacts: []}` initialization but DO NOT push string ids. If no reader, full removal is safe.
7. Update `packages/core/src/state/story-boundaries.ts`: when compiling `initialFacts`, reject any with `operation: 'unset'` or narrativeHint-only (initial state must be deterministic sets only). Throw `ConfigError` with a clear message.
8. Write the 5 test files (full test matrix in the spec bullet 10, `docs/TODO.md:898`):
   - `canonical-fact-value.test.ts`: accept matrix (null, bool, finite number, string, array, plain object); reject matrix (undefined, NaN, Infinity, Date, class instance, function, symbol); freeze verification (mutating a frozen copy throws); deep equality of canonical copies.
   - `fact-three-forms.test.ts`: set form (value + operation set/omitted); unset form (operation unset + no value/narrativeHint); narrativeHint form (only narrativeHint); Zod rejects value+unset, value+narrativeHint, unset+narrativeHint; operation defaulting; duplicate-effect rejection at replay level (two set effects on same entityId+attribute in one node throws).
   - `presence-aware-preconditions.test.ts`: eq/neq with absent/present-null/present-value; exists/not_exists forbid value (Zod reject); missing-state does not satisfy neq (returns mismatch, not match); narrativeHint-only precondition returns deferred from compareFact.
   - `replay-set-unset.test.ts`: set/repeat/overwrite/unset/re-set; A→B→A provider (last A wins, no fallback to pre-B value); unset-on-absent hard error; same-node duplicate write hard error; unknown entity hard error; PreconditionMismatchError thrown before effects applied.
   - `comparefact-deferred.test.ts`: compareFact returns 'deferred' for narrativeHint-only facts; returns 'match'/'mismatch' for value facts.
9. Run `npm run build` + `npx vitest run --exclude '**/e2e.test.ts'`. Fix until green. No regressions in existing tests.

**Edge cases / failure handling**:
- `null` is a valid present value: `set attribute=null` then `exists` → true; `not_exists` → false. `unset` then `exists` → false.
- Missing entity (not in state.entities): `exists` → false; `not_exists` → true; any comparison → mismatch (not error); `set` on missing entity → ConfigError (must be introduced first, per STATE-3 — but STATE-3 isn't done yet, so for STATE-1 scope, `set` creates the entity slot if missing? NO — throw ConfigError "unknown entity" per spec bullet 5. STATE-3 will formalize introduction. For STATE-1, require entity to exist in initialFacts or be introduced by a prior event).
- Repeat set records new write/provider: do NOT deduplicate; the canonical value is overwritten but provider lineage (when implemented in GRAPH-1) records each write. For STATE-1, the observable behavior is: final state has the last set's value.
- A→B→A: after set A=1, set A=2 (B), set A=1 (A again) → final value is 1 (last write), NOT "fall back to original 1". This is just last-write-wins at the value level; provider lineage distinction is GRAPH-1 scope.

**Verification**: `npm run build` exits 0; `npx vitest run --exclude '**/e2e.test.ts'` all pass; 5 new test files pass. Defect #2 (broken knowledge path) fixed by replay.ts:134-141 removal.

### STATE-3: 通用 Entity instance lifecycle 规范

**Source**: `docs/TODO.md:914-924` (10 bullets). **Status**: [ ] — **needs STATE-1.**

**Files to touch** (exhaustive, ~40 files — this is the prime candidate for sub-sub-plan splitting):
- `packages/core/src/types/entity.ts` — `EntityTypeCatalog`, `EntityDeclarationCatalog`, `EntityTypeRef`, `EntityRuntimeState`, `EntityDeclaration`, `AttributeDefinition` (with `requiredAt`, `writePolicy`, `unsetAllowed`)
- `packages/core/src/types/entity-kind.ts` (NEW) — kind-specific fact domain mapping (character/location/item/faction/concept/rule)
- `packages/core/src/schemas/entity-type.ts` (NEW) — Zod for EntityTypeCatalog, EntityTypeRef, AttributeDefinition
- `packages/core/src/schemas/entity-declaration.ts` (NEW) — Zod for EntityDeclaration
- `packages/core/src/entity/registry.ts` — refactor to load `EntityDeclarationCatalog` from definitions, not character-special-cased 6-field promotion
- `packages/core/src/entity/mapper.ts` — load EntityTypeCatalog from project config or built-in defaults
- `packages/core/src/state/replay.ts` — `introduce`/`retire`/lifecycle transitions as atomic transactions; lifecycle preconditions; cross-domain referential integrity check
- `packages/core/src/state/story-boundaries.ts` — initialFacts compiled as deterministic set writes from `initialState` (already mostly there; verify no unset/hint)
- `packages/core/src/validator/*.ts` — replace 21 hardcoded attribute-name checks with `EntityTypeCatalog`-driven `semanticRole` + `writePolicy` metadata (this fixes defect #1 from stage-1-acceptance.md)
- `packages/core/src/types/index.ts` + `packages/core/src/schemas/index.ts` — barrel re-exports
- `packages/core/tests/entity/entity-type-catalog.test.ts` (NEW)
- `packages/core/tests/state/entity-lifecycle.test.ts` (NEW)
- `packages/core/tests/validator/catalog-driven-checks.test.ts` (NEW)

**Ordered steps** (high-level — full detail requires reading current validator/*.ts hardcoded checks and current registry.ts load path):
1. Define `EntityTypeRef = {typeId: string, schemaVersion: number}` (immutable).
2. Define `AttributeDefinition = {attributeId, valueSchema (Zod reference), requiredAt: 'introduction'|'activation'|'never', writePolicy: 'immutable'|'write_once'|'mutable'|'lifecycle_managed', allowedLifecycleStates?, unsetAllowed: boolean, semanticRole?: string, typedReferenceConstraint?}`.
3. Define `EntityTypeDefinition = {typeRef: EntityTypeRef, kind: 'character'|'location'|'item'|'faction'|'concept'|'rule', attributes: AttributeDefinition[], lifecyclePolicy, referenceCapabilities, typedInvariants}`.
4. Define `EntityDeclaration = {entityId: string, typeRef: EntityTypeRef, immutableMetadata, provenance}`.
5. Define `EntityRuntimeState = 'active'|'inactive'|'retired'`.
6. Define `EntityTypeCatalog = Map<typeId, EntityTypeDefinition>` (static, versioned) and `EntityDeclarationCatalog = Map<entityId, EntityDeclaration>` (stable identity reservation).
7. `WorldState.entities[entityId]` becomes `{lifecycle: EntityRuntimeState, typeRef, attributes: Map<attributeId, CanonicalFactValue>}` (not `Record<string, unknown>`).
8. Refactor `InMemoryEntityRegistry.load` to populate `EntityDeclarationCatalog` from YAML definitions (not the current character-special-cased 6-field promotion). Location/item/faction use generic `initialState` → deterministic set writes. Character/location/etc. kind-specific facts stay in `attributes` (character: life/POV/aliases/knowledge/location as attribute cells; location: containment/access; etc.).
9. Build a default `EntityTypeCatalog` for the 6 kinds with sensible `AttributeDefinition`s covering the current hardcoded attribute names (marital_status, status, alive, knows, location, mood, appearance, traits, aliases, character_state, time_period, pacing, voice_*, pronoun, discourse_balance). Each gets a `semanticRole` + `writePolicy` (e.g., marital_status: `writePolicy: 'mutable'`, `semanticRole: 'lifecycle'` — NOT immutable, fixing the zhu-fu false world_rule errors).
10. Refactor each of the 12 validators with hardcoded attribute checks (grep `marital_status\|status\|alive\|knows\|location\|mood\|appearance\|traits\|aliases\|character_state\|time_period\|pacing\|voice_\|pronoun\|discourse_balance` in `packages/core/src/validator/*.ts`) to read `semanticRole`/`writePolicy` from `EntityTypeCatalog` instead of hardcoding the attribute name.
11. Implement `introduce`/`retire`/`active→inactive`/`inactive→active` as atomic transactions in replay.ts: preconditions read stateBefore; final cross-domain referential integrity checked once; `introduce` creates active + writes all introduction-required attributes; `retire` is terminal, hard-fails if any active membership/reference unclosed.
12. `requiredAt: activation` contract: direct introduce-to-active final candidate satisfies both introduction-required and activation-required; inactive-to-active re-checks activation requirements but unchanged attributes pass through.
13. Tests: lifecycle matrix (active/inactive/retired transitions + invalid transitions rejected); required/immutable/write-once/mutable attributes; kind-specific death/closure/consumption/nullification (character death writes `lifeStatus: dead` but stays active; retire only for permanent departure); catalog-driven validator checks (the 21 sites now read catalog metadata); zhu-fu fixture no longer produces false world_rule errors on marital_status.

**Note on size**: This item touches ~40 files and is the prime candidate for sub-sub-plan splitting per the plan's Phase 3 step 3. If too large for one session, split into: `state-1.5-state-model-state-3-type-catalog` (steps 1-7, types+catalog+registry refactor) and `state-1.5-state-model-state-3-validator-catalog-driven` (steps 8-13, validator refactor + lifecycle transactions + tests). Each gets its own `xd://propose` approval.

### STATE-2: 完整多元 Relationship 的状态规范

**Source**: `docs/TODO.md:900-912` (13 bullets). **Status**: [ ] — **needs STATE-3.**

**Files to touch** (exhaustive):
- `packages/core/src/types/relationship.ts` (NEW or major rewrite of existing) — `RelationshipTypeCatalog`, `RelationshipId`, `EpochId`, `MembershipId`, `RelationshipRuntimeState`, `RelationshipEpoch`, `RelationshipMembership`, `RelationshipDimension`, scope signatures
- `packages/core/src/schemas/relationship.ts` — Zod for relationship types, epochs, memberships, dimensions, transactions
- `packages/core/src/state/relationship-replay.ts` (NEW) — relationship transaction application, provider resolution, merge
- `packages/core/src/state/replay.ts` — replace current `relationshipEffects` handling (replay.ts:107-131, the `relKey = [participants].sort().join('_')` + direction-prose parsing) with structured `RelationshipTransaction` application
- `packages/core/src/types/event.ts` — replace `RelationshipChange` with `RelationshipTransaction` (effectId, relationship/epoch ID, lifecycleAfter, membershipAfter, dimension set/unset writes, provenance)
- `packages/core/tests/state/relationship-identity.test.ts` (NEW)
- `packages/core/tests/state/relationship-lifecycle.test.ts` (NEW)
- `packages/core/tests/state/relationship-dimensions.test.ts` (NEW)
- `packages/core/tests/state/relationship-merge.test.ts` (NEW)

**Ordered steps** (high-level):
1. Define `RelationshipTypeId` (project-defined string, catalog-validated, not global enum), `RelationshipTypeDefinition` (roles with min/max cardinality, allowed entity kinds, mutability, exclusive group, `continuityImpact: 'preserve'|'new_epoch'|'new_relationship'`).
2. Define three-layer identity: `RelationshipId` (permanent lineage, independent of participants, never reused), `EpochId` (one establishment→dissolution incarnation, max one undissolved epoch per relationship/branch), `MembershipId` (one entity's continuous tenure in an epoch; rejoin = new ID).
3. Define epoch lifecycle: `active|suspended|dissolved` only. suspended preserves state; dissolved terminates; rebuild in same lineage = new epoch; identity-critical role change = new relationship.
4. Define dimension scopes: `global|role|member|subset|positional` with structured state key `{relationshipId, epochId, dimensionId, scope}`. subset = canonical unordered membership set; positional = named participant groups in type-schema-fixed order. NOT derived from participant concatenation, direction prose, filename, or input order.
5. Define `RelationshipTransaction` (one per node per relationship): `effectId, relationshipId, epochId?, lifecycleAfter?, membershipAfter (complete), dimensionSet/Unset writes, provenance`. Author-facing add/remove/assign/unassign/move/replace YAML convenience syntax normalizes to complete `membershipAfter`. Validate final cardinality/type/exclusivity/lifecycle before commit; intermediate half-established state unobservable.
6. Replace `replay.ts:107-131` (current `relKey = [participants[0], participants[1]].sort().join('_')` + `direction.match(/(\S+)\s*→\s*(\S+)/)` parsing) with structured transaction application using the new types. Binary relationships are a specialization (two roles, cardinality 1 each) with equivalence to the full n-ary IR.
7. Implement hard errors: same-node duplicate cell writes, stale epoch/state writes, invalid scope/value, suspended/dissolved writes, orphaned scope cells, entity retirement with active membership unclosed.
8. Implement branch replay: per concrete `BranchPath` independent. Merge: semantic state equal → auto-converge (provider lineage preserved branch-locally); else `requireEqual`/`selectBranch`/literal merge state. Different MembershipIds → remint on merge. Different active epochs → new merge epoch. Different relationship type or identity-critical occupant → new relationship.
9. Implement `RelationshipIdentityTransitionGroup` for `continuityImpact: new_epoch|new_relationship`: atomic old closure + new establishment + new memberships + new dimensions + carry/unset map + provenance. No implicit participant identity rewrite, no MembershipId reuse, no tenure-bound cell inheritance.
10. Tests: role min/max/repeated/multi-role/exclusivity; identity/epoch/leave-rejoin; all 5 scope permutations; lifecycle; provider/reversion/implicit unset; same-time commute/conflict; branch isolation/equal convergence/literal merge; same-node entity creation+establishment; binary specialization equivalence; full replay/snapshot/cache equality.

### STATE-4: 有限确定性 Knowledge/Belief 规范

**Source**: `docs/TODO.md:934-948` (14 bullets). **Status**: [ ] — **needs STATE-3.**

**Files to touch** (exhaustive):
- `packages/core/src/types/knowledge.ts` (NEW or major rewrite) — `PropositionCatalog`, `Proposition` (4 kinds: Grounded/Epistemic/Act/Intensional), `EpistemicLedger`, `ClaimSemanticState`, `ClaimEvidenceRecord`, `InformationAct`, `GroupEpistemicQueryDefinition`, `CommonGroundRecord`, `NarrativeKnowledgeBoundary`
- `packages/core/src/schemas/knowledge.ts` — Zod for all of the above
- `packages/core/src/state/knowledge-replay.ts` (NEW) — claim/act transaction application, provider resolution, merge
- `packages/core/src/state/replay.ts` — remove any remaining `state.knowledge` writes (STATE-1 already removed replay.ts:134-141; verify no other writes)
- `packages/core/src/types/event.ts` — replace `KnowledgeDefinition` (if exists) with new proposition/claim types; knowledge transactions in events
- `packages/core/src/validator/knowledge.ts` — refactor to use `EpistemicLedger` + `ClaimSemanticState` instead of current `state.knowledge[entityId].knownFacts` string list
- `packages/core/src/entity/fact.ts` (compareFact) — no change needed (STATE-1 handled narrativeHint deferred)
- `packages/core/tests/state/proposition-catalog.test.ts` (NEW)
- `packages/core/tests/state/epistemic-ledger.test.ts` (NEW)
- `packages/core/tests/state/information-act.test.ts` (NEW)
- `packages/core/tests/state/knowledge-boundary.test.ts` (NEW)

**Ordered steps** (high-level):
1. Define `Proposition = {id, kind: 'Grounded'|'Epistemic'|'Act'|'Intensional', canonicalBody, semanticHash, schemaVersion, provenance}`. IDs immutable, no rebound/delete. Proposition dependency graph finite/acyclic (reject self-reference, cycles, runtime coinage).
2. Define `ClaimSemanticState = {assessment: 'settled'|'conflicted'|'suspended'|'forgotten'|unset, polarity?, grade?: 'know'|'believe'|'suspect', affirm/reject positions?}`. `ClaimEvidenceRecord` separate (source/warrant/provider/provenance lineage).
3. Define `EpistemicLedger = Map<{subject, propositionId}, ClaimSemanticState>`. Canonical claim cell key `{subject, propositionId}`.
4. Define `evaluate(proposition, WorldState): 'true'|'false'|'indeterminate'` — deterministic three-valued; for Grounded propositions reads canonical state cells with finite all/any/not; for Epistemic reads nested claim cells; for Act checks event-log; Intensional cannot provide deterministic truth.
5. Define `InformationAct` (immutable event-log output): perception/thought/testimony/assertion/inference/reading/recall/revelation; records actor, recipients, content propositions, story boundary, in-world source, corpus provenance. `know` requires verified warrant (observation+truth agreement, or sufficient-warrant testimony+complete communication, or truth-preserving inference with all premise providers). False testimony can produce false belief; false alone ≠ deceptive intent.
6. Define group epistemic forms: institutional ledger, `distributed` (any member matches), `mutual` (all members match), `CommonGroundRecord`. `GroupEpistemicQueryDefinition` immutable with frozen audience snapshot; empty audience → both distributed/mutual false (no vacuous mutual truth).
7. Define `NarrativeKnowledgeBoundary`: focalizer's accessible claims at event stateBefore; retrospective narrator references explicit later boundary with disclosure-policy marking; `narrationTime` doesn't change story replay. Pass 1 receives only allowlisted claims/attitudes; forgotten/future/pending truth not leaked.
8. Implement `knowledge-replay.ts`: claim/act transactions write full `ClaimSemanticState` after-state or explicit unset + generate independent `ClaimEvidenceRecord`. Same-node same-cell duplicate write → hard error. Branch replay independent; semantic equality converges with provider lineage preserved; else `requireEqual`/`selectBranch`/literal/unset.
9. Refactor `validator/knowledge.ts` to read `EpistemicLedger` instead of `state.knowledge[entityId].knownFacts` string list (which STATE-1 removed).
10. Tests: 4 proposition kinds + canonical nesting + cycle rejection; truth boundary/null/absent; all assessment/source/warrant states; private thought/testimony/lie/inference/recall; truth drift (world changes don't silently rewrite claims); finite temporal claims; group forms; narrator/disclosure separation; branch merge/concurrency/lifecycle; snapshot/cache.

### STATE-5: Thread 的长程叙事结构规范

**Source**: `docs/TODO.md:950-960` (9 bullets). **Status**: [ ] — **needs STATE-3.**

**Files to touch** (exhaustive):
- `packages/core/src/types/thread.ts` (NEW or major rewrite) — `ThreadTypeCatalog`, `ThreadDeclarationCatalog`, `ThreadId`, `ThreadRunId`, `ThreadRuntimeState`, `ThreadTypeDefinition` (roles, phases, lifecycle/reopen policy, time domain, goals/milestones)
- `packages/core/src/schemas/thread.ts` — Zod for thread types, declarations, runtime state, transactions
- `packages/core/src/state/thread-replay.ts` (NEW) — thread transaction application, clock isolation, merge
- `packages/core/src/state/replay.ts` — replace current `threadProgress` handling (replay.ts:99-105, scalar progress) with structured `ThreadTransaction`
- `packages/core/src/types/event.ts` — replace `threadProgress` with `ThreadTransaction`
- `packages/core/src/validator/thread-progress.ts` — refactor to use `ThreadRuntimeState` absolute goal/milestone states
- `packages/core/tests/state/thread-identity.test.ts` (NEW)
- `packages/core/tests/state/thread-lifecycle.test.ts` (NEW)
- `packages/core/tests/state/thread-clock-isolation.test.ts` (NEW)

**Ordered steps** (high-level):
1. Define `ThreadTypeDefinition` (finite role schemas, phases, lifecycle/reopen policy: `forbidden|allowed|requiresExplicitReason`, time domain: `story|discourse`, stable goals/milestones/narrative hints/provenance).
2. Define `ThreadId` (permanent lineage), `ThreadRunId` (one activation-to-closure), `ThreadRuntimeState = {status, currentRunId, phase, bindings, goalStates, milestoneStates, semanticStateHash}`.
3. Define lifecycle: `planned|active|blocked|completed|abandoned|retired`. Transitions: planned→active; active↔blocked; active→completed/abandoned; blocked→completed (if all blockers resolved + required goals met in final candidate); blocked→abandoned; completed/abandoned→new run per reopen policy; retired terminal. No scalar-progress/LLM/missing-goal completion guessing.
4. Define canonical progress: `goal: pending|active|achieved|failed|waived`; `milestone: pending|achieved|failed|waived|invalidated`. Fraction display only from fixed integer weights/branch applicability — never stored as provider/precondition. Semantic goal deterministic status = author-declared structure; Pass 2 validates prose realization; failure doesn't rewrite ThreadRuntimeState/WorldState.
5. Define bindings (narrative function, not world relationship): role→entity/relationship-lineage/epoch/proposition; type limits min/max/target-kind/mutability/exclusivity/lifecycle. Entity introduction + thread binding can be same-node atomic; entity retirement must close bindings or type-policy-allow historical reference.
6. Clock isolation: each thread type picks ONE clock. `story` → branch-resolved storyTime in WorldState replay; `discourse` → assembled narrative/disclosure order in DiscourseState. No cross-clock provider edges. Flashback replays story-thread past state but never reverses discourse-thread.
7. Define `ThreadTransaction` (one per node per thread): thread/run ID, optional status/phase/bindingsAfter, goal/milestone set/unset writes, provenance. Author-facing add/remove/advance normalizes to complete final bindings/absolute states.
8. Replace `replay.ts:99-105` (current scalar `state.threads[tp.thread] = {progress: tp.progressAfter, total: tp.progressTotal}`) with structured transaction application.
9. Branch merge: story-domain semantic equality auto-converges (provider lineage preserved); else `requireEqual`/`selectBranch`/literal; no max-progress/milestone-union/completion-wins/average. Different active story runs merging → new merge run, branch-local bindings remint. Discourse-domain threads stay branch-local/non-destructive.
10. `NarrativeEllipsis` advances story-domain threads only (one source-proven storyTime), never discourse. Selection never edits canonical thread state — only `selectionHash` for coverage.
11. Tests: identity/runs/lifecycle; weighted projection/waivers; state/authored/semantic goals; prerequisites/bindings; provider/concurrency; branch merge; clock isolation/flashback; ellipsis/selection invariance; Pass 2 evidence keys; full replay/snapshot/cache.

### STATE-6: Rule 的约束、审计与语义规范

**Source**: `docs/TODO.md:962-973` (12 bullets). **Status**: [ ] — **needs STATE-3.**

**Files to touch** (exhaustive):
- `packages/core/src/types/rule.ts` (NEW or major rewrite) — `RuleTypeDefinition`, `RuleSpecification`, `RuleId`, `RuleSpecificationId`, `RuleEpochId`, `RuleExceptionId`, `RuleRuntimeState`, `RuleConstraint` (4 kinds), `RuleEvaluationRecord`, `RuleException`
- `packages/core/src/schemas/rule.ts` — Zod for all of the above
- `packages/core/src/state/rule-replay.ts` (NEW) — rule transaction application, constraint evaluation, exception handling
- `packages/core/src/state/replay.ts` — replace current `ruleEffects` handling (replay.ts:143-144, `applyRuleEffect`) with structured `RuleTransaction`
- `packages/core/src/types/event.ts` — replace `RuleEffectEntry` with `RuleTransaction`
- `packages/core/src/validator/world-rule.ts` — refactor to use `RuleRuntimeState` + `RuleEvaluationRecord` instead of current `ruleEffects` evidence
- `packages/core/tests/state/rule-identity.test.ts` (NEW)
- `packages/core/tests/state/rule-lifecycle.test.ts` (NEW)
- `packages/core/tests/state/rule-constraint-evaluation.test.ts` (NEW)
- `packages/core/tests/state/rule-exception.test.ts` (NEW)

**Ordered steps** (high-level):
1. Define `RuleTypeDefinition` (reusable static schema: parameter/scope/exception/evolution/effectiveness), `RuleSpecification` (immutable enacted formal semantics), `RuleId` (permanent lineage), `RuleSpecificationId` (immutable version), `RuleEpochId` (one governing period), `RuleExceptionId` (never reused).
2. Define `RuleRuntimeState = {currentEpoch, activation: 'dormant'|'enabled'|'suspended'|'revoked', effectivenessLevel: 'full'|'limited'|'nullified', scopeBindings, exceptions, semanticHash}`. Entity active ≠ rule in force (enabled applies; suspended doesn't; revoked ends epoch). Nullified preserves identity/epoch/exception (not implicit clear).
3. Define `RuleConstraint = {id, kind: 'state_invariant'|'transition_constraint'|'precondition_requirement'|'postcondition_requirement', enforcement: 'hard'|'audit'|'semantic', applicableEffectivenessLevels, scope, predicate (closed AST), semanticHint?}`. Predicate allows finite compiled selectors, all/exists/count, canonical state/transition tests; rejects free strings/regex/arbitrary code/LLM true-false.
4. Define 3 enforcement channels: `hard` rejects transition before commit; `audit` accepts + produces immutable `RuleEvaluationRecord`; `semantic` Pass 2 only (no replay). Hard rule doesn't auto-write penalties/damage/knowledge/thread effects — all consequences are author transactions. Semantic LLM results never create deterministic violation/exception/provider/state.
5. Define `RuleEvaluationRecord = {id (derived from rule/epoch/constraint/node/scope/branch/evaluator-version), result: 'compliant'|'violated'|'exempt', evaluatorVersion, provenance}`. Hard violation aborts node (diagnostic only, no committed output). Audit always produces immutable record. StorySnapshot keeps evaluation descriptor + sufficient payload for future exact artifact reads.
6. Fixed evaluation order per node: read stateBefore rule/preconditions; build candidate entity/relationship/knowledge/thread/rule results; run transition/precondition constraints with stateBefore activation; run invariants/postcondition constraints with candidate stateAfter activation; verify cross-domain referential integrity; commit or reject. Initial state must satisfy every enabled hard invariant.
7. Define `RuleException = {exceptionId, status: 'active'|'suspended'|'revoked', constraintIds, scopeBindings, conditionProposition?, effect: 'exempt'|'replaceWith(replacementConstraintId)'}`. Multiple exemptions can coexist; multiple different replacements matching simultaneously → hard error; no priority/most-specific/definition-order resolution. Exceptions don't cross epochs automatically.
8. Replace `replay.ts:143-144` (`applyRuleEffect(state, re)`) with structured `RuleTransaction` application following the fixed evaluation order.
9. Refactor `validator/world-rule.ts` to use `RuleRuntimeState` + `RuleEvaluationRecord` instead of current `ruleEffects` evidence strings.
10. Tests: identity/specification immutability/epochs/replacement; lifecycle/effectiveness; 4 constraint kinds/initial invariants; hard/audit/semantic enforcement; finite scopes/quantifiers; exceptions; provider/concurrency; branch merge; ellipsis/selection; snapshot/cache.

## Evidence

### STATE-1
- [pending implementation] `npm run build` + `npx vitest run --exclude '**/e2e.test.ts'` green; 5 new test files pass; defect #2 fixed (replay.ts:134-141 removed).

### STATE-2..6
- [deferred] Multi-session architecture work. Each item's Sub-plan above is decision-complete; implementation is a follow-up session per the plan's Phase 3 workflow. STATE-3 is the largest (~40 files) and may split into sub-sub-plans.