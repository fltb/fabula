# Knowledge / Proposition YAML Contract

**Source Zod Schemas:** `packages/core/src/schemas/knowledge.ts` — `groundedPropositionSchema`, `epistemicPropositionSchema`, `actPropositionSchema`, `intensionalPropositionSchema`, `propositionSchema`, `propositionCatalogSchema`, `claimSchema`, `claimAssessmentSchema`, `settledAssessmentSchema`, `conflictedAssessmentSchema`, `suspendedAssessmentSchema`, `forgottenAssessmentSchema`, `unsetAssessmentSchema`, `claimEvidenceRecordSchema`, `epistemicLedgerSchema`, `commonGroundRecordSchema`, `narrativeKnowledgeBoundarySchema`, `claimGradeSchema`, `claimPolaritySchema`, `informationActTypeSchema`, `evidenceSourceSchema`, `groupEpistemicModeSchema`, `groupEpistemicQueryDefinitionSchema`, `evaluationResultSchema`; `packages/core/src/schemas/corpus.ts` — `informationActSchema`; `packages/core/src/schemas/timestamp.ts` — `storyTimestampSchema`, `locatableStoryTimestampSchema` (runtime AST), `authoredStoryTimeSchema` (author YAML)
**Replay / evaluation:** `packages/core/src/state/knowledge-replay.ts` (`evaluate`, `applyClaimTransaction`, `recordInformationAct`, `hasSufficientWarrant`, `validatePropositionCatalog`)
**Fixture sources:** `fixtures/zhu-fu/definitions/state_initial.yaml` (worldFacts), `fixtures/zhu-fu/chapters/*/E*.yaml` (preconditions/expectedPostconditions), ellipsis files (knowledgeTransactions)

The knowledge contract models **what is known** in the story world. It has three tiers:

1. **Propositions** — atomic truth-bearers; the fundamental units of content
2. **Claims** — an epistemic agent's stance toward a proposition (know/believe/suspect, affirmative/negative)
3. **Ledgers** — collections of claims indexed by subject and proposition

## Authoring / Runtime Boundary

Authors never write proposition, claim, or ledger YAML directly. The author-facing surface is:

- `worldFacts` in `definitions/state_initial.yaml` — established world facts (become `concept` registry entities and the initial facts projected from them);
- event `preconditions` / `expectedPostconditions` (see [event.md](../yaml-format/event.md)) — deterministic reads/writes that ground grounded propositions;
- ellipsis `knowledgeTransactions` (array of `InformationAct`, see [ellipsis-bridge.md](./ellipsis-bridge.md)) — authored information acts (schema-validated and mapped onto the runtime ellipsis, but not replayed into the ledger).

The proposition catalog, claim assessments, and epistemic ledger are **runtime/API IR**: the schemas below validate them, but no project loader or compiler path derives them — callers must supply them externally (via `validatePropositionCatalog`, `applyClaimTransaction`, `recordInformationAct`, and the `evaluate()` API). `emptyWorldState` initializes an empty `propositionCatalog` and `EpistemicLedger`; world/event facts are mapped only into `Fact` state and graph reads/writes. Timestamps inside knowledge structures use the **runtime `StoryTimestamp` AST**, not the authored YAML spelling; see [event.md](../yaml-format/event.md) for how authored timestamps normalize.

## Fields

## Proposition Fields

Propositions come in four discriminated kinds.

### GroundedProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"grounded"`. |
| `id` | `string` | required | — | Unique proposition ID (nonblank). |
| `entityId` | `string` | required | — | The entity this proposition is about (nonblank). |
| `attribute` | `string` | required | — | The attribute being asserted (nonblank). |
| `value` | `unknown` | required | — | The attribute value. |
| `quantifier` | `enum` | optional | `undefined` | `"identity"`, `"all"`, `"any"`, or `"not"`. The schema has no default; `evaluate()` treats an absent quantifier as `"identity"`. |
| `factId` | `string` | optional | — | Links to the canonical fact that grounds this proposition. |

### EpistemicProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"epistemic"`. |
| `id` | `string` | required | — | Unique proposition ID (nonblank). |
| `subject` | `string` | required | — | The epistemic agent (entity ID). |
| `propositionId` | `string` | required | — | The proposition the agent has an attitude about. |
| `attitude` | `enum` | required | — | `"knows"`, `"believes"`, `"suspects"`, `"denies"`, `"doubts"`. |

### ActProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"act"`. |
| `id` | `string` | required | — | Unique proposition ID (nonblank). |
| `actType` | `enum` | required | — | See information act types below. |
| `actor` | `string` | required | — | Entity performing the act. |
| `recipients` | `array` | optional | `[]` | Recipient entity IDs. |
| `contentPropositions` | `array` | optional | `[]` | Proposition IDs communicated in this act. |
| `storyBoundary` | `string` | optional | — | The story-timeline boundary within which this act is visible. |
| `inWorldSource` | `string` | optional | — | In-world source identifier (document, prophecy, artifact). |
| `corpusProvenance` | `string` | optional | — | Corpus/metadata provenance reference. |

### IntensionalProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"intensional"`. |
| `id` | `string` | required | — | Unique proposition ID (nonblank). |
| `content` | `string` | required | — | Opaque stable content of the intensional state. |
| `domain` | `enum` | required | — | `"plan"`, `"dream"`, `"prophecy"`, `"theory"`, `"moral_judgment"`, `"counterfactual"`. |

## Claim Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `subject` | `string` | required | — | Entity ID who holds this claim. |
| `propositionId` | `string` | required | — | The proposition the claim is about. |
| `assessment` | `object` | required | — | Claim assessment (see below). |
| `evidence` | `array` | optional | `[]` | Evidence records (ordered, most recent first). |

### ClaimAssessment (discriminated union)

| discriminator `type` | Fields | Description |
|----------------------|--------|-------------|
| `"settled"` | `grade`: `"know"`\|`"believe"`\|`"suspect"`, `polarity`: `"affirmative"`\|`"negative"` | Certain knowledge |
| `"conflicted"` | `affirmations`: nonnegative integer, `rejections`: nonnegative integer | Evidence on both sides |
| `"suspended"` | _(none)_ | Pending judgment |
| `"forgotten"` | _(none)_ | Once known, now forgotten |
| `"unset"` | _(none)_ | Never evaluated |

### ClaimEvidenceRecord

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | `enum` | required | — | `"direct_experience"`, `"testimony"`, `"inference"`, `"revelation"`, `"default"`. |
| `warrant` | `string` | optional | — | Why this source is credible. |
| `provider` | `string` | optional | — | Entity that provided the evidence. |
| `provenance` | `array` | optional | `[]` | Event-ID chain establishing provenance. |
| `acquiredAt` | `StoryTimestamp` | required | — | Runtime story timestamp AST (see below). |

## StoryTimestamp (Runtime AST)

All timestamps inside knowledge IR (`claimEvidenceRecord.acquiredAt`, `commonGroundRecord.establishedAt`, `InformationAct.timestamp`, `narrativeKnowledgeBoundary.boundaryTime`) use the runtime `StoryTimestamp` AST. The authored YAML spelling (`authoredStoryTimeSchema`) is a different, wire-only type: a legacy nonblank string or one of `{ at }`, `{ after }`, `{ offset }`, `{ chapter }`, `{ type: "indeterminate" }` — normalized to this AST by `parseStoryTimestamp()`.

| `type` | Fields | Description |
|--------|--------|-------------|
| `"absolute"` | `value`: string | ISO instant or legacy day label (e.g. `"2024-12-01T09:00:00Z"`, `day_0`). |
| `"relative"` | `anchor`: string, `offset`: `{ amount: number ≥ 0, unit }` | Offset from a named time anchor. |
| `"chapter"` | `chapter`: integer | Chapter clock position. |
| `"offset"` | `amount`: number (signed), `unit` | Signed offset on the story clock. |
| `"indeterminate"` | `mode`: `"unspecified"` \| `"intentional"`, `reason?`: string | No locatable coordinate. |

`unit` is one of `"minute"`, `"hour"`, `"day"`, `"week"`, `"month"`. `narrativeKnowledgeBoundary.boundaryTime` is restricted to the locatable subset (`locatableStoryTimestampSchema`).

### InformationAct (act log / knowledgeTransactions)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `enum` | required | — | Information act type (see below). |
| `actor` | `string` | required | — | Entity performing the act. |
| `recipients` | `array` | optional | `[]` | Recipient entity IDs. |
| `contentPropositions` | `array` | optional | `[]` | Proposition IDs communicated. |
| `storyBoundary` | `string` | optional | — | Story-timeline boundary of the act. |
| `inWorldSource` | `string` | optional | — | In-world source identifier. |
| `corpusProvenance` | `string` | optional | — | Corpus provenance. |
| `timestamp` | `StoryTimestamp` | required | — | When the act occurred. |
| `eventId` | `string` | required | — | The event that recorded the act. |
| `warrantJustification` | `string` | optional | — | Semantic warrant justification for `"know"` production. |

## Closed Enums / IDs

- `informationActType`: `"perception"`, `"thought"`, `"testimony"`, `"assertion"`, `"inference"`, `"reading"`, `"recall"`, `"revelation"` (8 values)
- `propositionQuantifier`: `"identity"`, `"all"`, `"any"`, `"not"` (4 values)
- `attitude`: `"knows"`, `"believes"`, `"suspects"`, `"denies"`, `"doubts"` (5 values)
- `claimGrade`: `"know"`, `"believe"`, `"suspect"` (3 values)
- `claimPolarity`: `"affirmative"`, `"negative"` (2 values)
- `intensionalDomain`: `"plan"`, `"dream"`, `"prophecy"`, `"theory"`, `"moral_judgment"`, `"counterfactual"` (6 values)
- `evidenceSource`: `"direct_experience"`, `"testimony"`, `"inference"`, `"revelation"`, `"default"` (5 values)
- `claimAssessment.type`: `"settled"`, `"conflicted"`, `"suspended"`, `"forgotten"`, `"unset"` (5 values)
- `storyTimestamp.type`: `"absolute"`, `"relative"`, `"chapter"`, `"offset"`, `"indeterminate"` (5 values)
- `timeUnit`: `"minute"`, `"hour"`, `"day"`, `"week"`, `"month"` (5 values)
- `groupEpistemicMode`: `"institutional"`, `"distributed"`, `"mutual"` (3 values)
- `evaluationResult`: `"true"`, `"false"`, `"indeterminate"` (3 values)

## Mutual Exclusions

- A proposition's `kind` discriminator determines which fields are valid: grounded, epistemic, act, and intensional propositions have disjoint field sets (`.strict()` objects).
- `claimAssessment` is a discriminated union — exactly one of the five assessment types applies.
- `evidence` and `assessment.type === "unset"` may coexist (evidence for why it's unset).
- In a `relative` timestamp, `offset.amount` is nonnegative; signed offsets use the `offset` timestamp type instead.

## Valid Example

```yaml
# Runtime IR shapes (validated by the schemas below but supplied externally —
# no compiler derives them from authored files; the author-facing spellings are
# worldFacts / preconditions / expectedPostconditions / knowledgeTransactions)
propositions:
  p_xianglins_wife_location:
    kind: grounded
    id: p_xianglins_wife_location
    entityId: xianglins_wife
    attribute: location
    value: luchen_town
  p_narrator_knows_her:
    kind: epistemic
    id: p_narrator_knows_her
    subject: narrator
    propositionId: p_xianglins_wife_location
    attitude: knows

claims:
  c_narrator_knows_location:
    subject: narrator
    propositionId: p_xianglins_wife_location
    assessment:
      type: settled
      grade: know
      polarity: affirmative
    evidence:
      - source: direct_experience
        provider: narrator
        acquiredAt:
          type: chapter
          chapter: 1
```

## Invalid Example

```yaml
# ERROR: grounded + epistemic fields mixed
# Validated directly against groundedPropositionSchema — there is no standard
# loader for definitions/propositions.yaml, and propositionCatalogSchema would
# additionally require 'version' and 'dependencyGraph' at the root.
kind: grounded
id: bad_prop
entityId: xianglins_wife
attribute: location
value: luchen_town
attitude: knows          # Not valid for grounded propositions
actType: perception      # Not valid for grounded propositions
```

**Expected error (direct schema validation — first issue only; Zod aggregates unknown keys into one issue):**
```
error.message:      YAML schema validation failed at <root>: Unrecognized key(s) in object: 'attitude', 'actType'
error.context.path: <project-relative file path>   # root issue: no path suffix
```

## Normalized Target

The runtime produces:

- `PropositionCatalog` — an available runtime/API IR that must be supplied externally: an immutable, versioned record of all propositions with an expected per-kind dependency graph (`grounded` → `[]`, `epistemic` → `[propositionId]`, `act` → `contentPropositions`, `intensional` → `[]`). `validatePropositionCatalog` rejects self-references, dependencies on propositions absent from the catalog, and cycles; it does not derive a catalog from authored facts, and `emptyWorldState` starts with an empty catalog. Facts can be evaluated by an existing grounded proposition but do not create propositions. Intensional propositions are recognized but do not provide world-truth access.
- `EpistemicLedger` — claims keyed by `${subject}:${propositionId}`, with `bySubject` / `byProposition` indices and an ordered `actLog` of `InformationAct`s. `applyClaimTransaction` rejects duplicate writes to the same claim cell; `recordInformationAct` appends acts.
- `worldFacts` entries in `state_initial.yaml` become registry entities of `kind: "concept"` (entity state `{ value, description }`), and `buildInitialFacts` (`entity/project-runtime.ts`) projects those concept states into the runtime initial facts (`<worldFactId>.value`, `<worldFactId>.description`) — there is no synthetic genesis event and no `entityId: "world"` fact; they do not become proposition-catalog entries. Event preconditions/expectedPostconditions ground deterministic reads/writes. Ellipsis files carry `knowledgeTransactions` (an `InformationAct` array) that is schema-validated and copied onto the runtime ellipsis by `mapToNarrativeEllipsis`, but it is **not currently replayed**: `computeStateBefore` explicitly skips ellipsis/non-event nodes, and `recordInformationAct` (the API that would append acts to `EpistemicLedger.actLog`) has no production callsite. The array is thus validated/mapped authoring input, not recorded ledger activity.
- `evaluate()` computes deterministic three-valued truth for propositions: grounded compares against `WorldState` entities, epistemic checks the subject's settled claim against the attitude, act checks the act log, intensional is always `"indeterminate"`. `hasSufficientWarrant` decides whether an evidence chain supports a `"know"` claim.

## Source-Map Diagnostic Format

`readYamlFile` reports only the **first** validation issue, as two separate properties on the `ConfigError`:

- `error.message` — `YAML schema validation failed at <dot-joined path | <root>>: <Zod message>`
- `error.context.path` — the project-relative file path, suffixed with the dot-joined Zod path when the issue is not at the root

Zod issue paths are joined with dots (e.g. `propositions.p_1.entityId`), not JSON Pointer syntax; a root-level issue reports `<root>` in the message and stores only the file path in `error.context.path`. No second `path:` line is rendered.
