# capability-contract: Capability manifest and YAML authoring contract

## Group Status: [x] complete — both items done. Build+test green (1349/1349).

## Items in this group

| Item ID | Status | Internal Deps | Source |
|---------|--------|---------------|--------|
| CAPABILITY-1 | [x] | all architecture [x] | `docs/TODO.md` lines 1043-1049 — CapabilityManifest (S|C|X, 5 evidence classes), CapabilityRegistry, 3-stage gate, 30 tests |
| YAML-CONTRACT | [x] | all architecture [x] | `docs/TODO.md` lines 1051-1056 — 10 YAML contract docs with field tables + valid/invalid examples |

## Group-level dependencies
All architecture groups [x] ✅. CAPABILITY-1 and YAML-CONTRACT are independent → parallel.

## Sub-plan

### CAPABILITY-1: Capability Manifest gate

**Scope**: Build a versioned `CapabilityManifest` system. Each claimed capability maps to capability ID, S|C|X status, schema/normalization versions, supported input forms, reference/property/rejection cases, snapshot/cache cases, fixture IDs, provenance requirements, stage gate, evidence artifact hash.

**New files**:
- `packages/core/src/types/capability.ts` — CapabilityManifestEntry, CapabilityManifest, EvidenceClass, CapabilityStatus types
- `packages/core/src/schemas/capability.ts` — Zod schemas
- `packages/core/src/state/capability-manifest.ts` — manifest registry + gate validation
- `packages/core/tests/state/capability-manifest.test.ts` — test suite

**Key types**:
- `CapabilityStatus = 'S' | 'C' | 'X'` — S=supported (deterministic, prod impl, independent ref interpreter, property tests, fixtures, evidence), C=capable (structural/contract expressible but prose/Pass 2/human detection is measurement), X=unsupported
- `EvidenceClass` — state_replay, discourse_replay, schema_rejection, surface_scheduler, validation_measurement
- `CapabilityManifestEntry` — capabilityId, status, schemaVersions, normalizationVersions, supportedInputForms, referenceCaseIds, propertyCaseIds, rejectionCaseIds, snapshotCases, fixtureIds, provenanceRequirements, stageGate, evidenceArtifactHash
- `CapabilityManifest` — versioned registry of all entries

**Binding constraints**:
1. Every YAML schema variant, compiled IR variant, runtime domain operation, cross-domain combination MUST belong to one manifest row
2. No manifest entry → input default REJECTED (no loader fallback, no docs-implied support)
3. `S` status requires: finite deterministic semantics, typed rejection, production implementation, independent reference interpreter, property/model tests, human-readable fixtures, applicable snapshot/replay/cache equivalence, stage evidence
4. Reference implementation MUST NOT import production replay/canonicalization/key/provider/predicate/merge helpers
5. RENDER-SURFACE must have at least 2 rows: `surface_scheduler_contract` (S candidate) and `surface_prose_continuity_outcome` (C)
6. Stage 1 gate: all declared S core capabilities must be manifest-complete. Default offline CI runs conformance suites
7. Stage 2 gate: external corpus, C metrics, human annotation, source/legal/provenance, performance/cache/parallel evidence each bound to manifest
8. Stage 3 gate: every project render/assemble records manifest/version/config; X or uncovered YAML/IR combinations hard fail
9. Minimum cross-domain conformance suite covers AbsenceWitness, candidate-state reads, dynamic introduction/retirement, full n-ary identity transitions, all MergePlan operators, etc.

**Acceptance**: Build green, new tests pass, existing tests pass. `grep "CapabilityManifest" packages/core/src/types/capability.ts` returns matches.

**Evidence**: `packages/core/tests/state/capability-manifest.test.ts`

### YAML-CONTRACT: Author-facing YAML interfaces

**Scope**: Every frozen normalized runtime contract must have a versioned YAML authoring interface. YAML is the author/LLM-readable intermediate representation, NOT an independent second semantic. Build YAML contract documentation from the schema registry.

**New files**:
- `docs/reference/yaml-contract/README.md` — index of all YAML contracts
- `docs/reference/yaml-contract/initial-state.md` — initialState YAML contract
- `docs/reference/yaml-contract/entity.md` — Entity type/declaration/lifecycle transaction contract
- `docs/reference/yaml-contract/relationship.md` — n-ary relationship type/epoch/membership/dimension contract
- `docs/reference/yaml-contract/knowledge.md` — Proposition/claim/information act contract
- `docs/reference/yaml-contract/thread.md` — Thread type/run/goal/milestone contract
- `docs/reference/yaml-contract/rule.md` — Rule specification/constraint/exception contract
- `docs/reference/yaml-contract/causal-deps.md` — typed causalDependencies contract
- `docs/reference/yaml-contract/discourse.md` — Discourse scene contract/acts contract
- `docs/reference/yaml-contract/ellipsis-bridge.md` — NarrativeEllipsis + DiscourseBridge contract

**Each contract document MUST include**:
- Required/optional fields
- Mutually exclusive forms
- Closed enums/IDs
- Branch/time/provenance
- Author-facing convenience syntax and exact normalized target
- Valid/invalid YAML examples (copy from fixtures where possible)
- Source-map diagnostic expected format

**Binding constraints**:
1. Compiler only executes `YAML → normalized IR` — no loader guessing
2. Internal provider/output/read/hash/tombstone/derived projection NEVER required from author
3. Schema validation errors MUST locate: YAML path, source span, expected normalized form, related predecessor/provider
4. Forbidden: unknown field silent drop, stringly-typed fallback, free-text direction/predicate, inferred defaults changing replay
5. Each schema version has adjacent migration, canonical formatter, valid/invalid examples, round-trip/normalization fixtures
6. Every internal semantic contract change MUST include YAML interface/Zod/schema registry/migration/source-map diagnostic/fixture in same changeset

**Acceptance**: All 10 YAML contract docs exist. Each contains at minimum: field table, valid example, invalid example. `grep -c "## Fields" docs/reference/yaml-contract/*.md` ≥ 10.

**Evidence**: `docs/reference/yaml-contract/README.md` + 10 contract documents

## Evidence
—
