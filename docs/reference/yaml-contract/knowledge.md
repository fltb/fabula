# Knowledge / Proposition YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/knowledge.ts` — `propositionSchema`, `claimSchema`, `epistemicLedgerSchema`, `claimAssessmentSchema`, `claimEvidenceRecordSchema`, `commonGroundRecordSchema`, `narrativeKnowledgeBoundarySchema`  
**Fixture sources:** `fixtures/zhu-fu/definitions/state_initial.yaml` (worldFacts), `fixtures/zhu-fu/chapters/*/E*.yaml` (knowledge references)

The knowledge contract models **what is known** in the story world. It has three tiers:


## Fields
1. **Propositions** — atomic truth-bearers; the fundamental units of content
2. **Claims** — an epistemic agent's stance toward a proposition (know/believe/suspect, affirmative/negative)
3. **Ledgers** — collections of claims indexed by subject and proposition

Author-facing YAML surfaces propositions via event-level `preconditions`/`expectedPostconditions` (see [event.md](../yaml-format/event.md)) and initial facts via `worldFacts`. The full proposition catalog and epistemic ledger are compiler-produced.

## Proposition Fields

Propositions come in four discriminated kinds.

### GroundedProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"grounded"`. |
| `id` | `string` | required | — | Unique proposition ID. |
| `entityId` | `string` | required | — | The entity this proposition is about. |
| `attribute` | `string` | required | — | The attribute being asserted. |
| `value` | `unknown` | required | — | The attribute value. |
| `quantifier` | `enum` | optional | `undefined` | `"identity"`, `"all"`, `"any"`, or `"not"`. |
| `factId` | `string` | optional | `undefined` | Links to a worldFacts entry. |

### EpistemicProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"epistemic"`. |
| `id` | `string` | required | — | Unique proposition ID. |
| `subject` | `string` | required | — | The epistemic agent (entity ID). |
| `propositionId` | `string` | required | — | The proposition the agent has an attitude about. |
| `attitude` | `enum` | required | — | `"knows"`, `"believes"`, `"suspects"`, `"denies"`, `"doubts"`. |

### ActProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"act"`. |
| `id` | `string` | required | — | Unique proposition ID. |
| `actType` | `enum` | required | — | See information act types below. |
| `actor` | `string` | required | — | Entity performing the act. |
| `recipients` | `array` | optional | `[]` | Recipient entity IDs. |
| `contentPropositions` | `array` | optional | `[]` | Proposition IDs communicated in this act. |
| `storyBoundary` | `string` | optional | — | Scene/event where this act occurred. |
| `inWorldSource` | `string` | optional | — | Source of information in the story world. |
| `corpusProvenance` | `string` | optional | — | Corpus-level provenance reference. |

### IntensionalProposition

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `kind` | `literal` | required | — | Must be `"intensional"`. |
| `id` | `string` | required | — | Unique proposition ID. |
| `content` | `string` | required | — | Free-text content of the intensional state. |
| `domain` | `enum` | required | — | `"plan"`, `"dream"`, `"prophecy"`, `"theory"`, `"moral_judgment"`, `"counterfactual"`. |

## Claim Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `subject` | `string` | required | — | Entity ID who holds this claim. |
| `propositionId` | `string` | required | — | The proposition the claim is about. |
| `assessment` | `object` | required | — | Claim assessment (see below). |
| `evidence` | `array` | optional | `[]` | Evidence records. |

### ClaimAssessment (discriminated union)

| discriminator `type` | Fields | Description |
|----------------------|--------|-------------|
| `"settled"` | `grade`: `"know"`\|`"believe"`\|`"suspect"`, `polarity`: `"affirmative"`\|`"negative"` | Certain knowledge |
| `"conflicted"` | `affirmations`: number, `rejections`: number | Evidence on both sides |
| `"suspended"` | _(none)_ | Pending judgment |
| `"forgotten"` | _(none)_ | Once known, now forgotten |
| `"unset"` | _(none)_ | Never evaluated |

### ClaimEvidenceRecord

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | `enum` | required | — | `"direct_experience"`, `"testimony"`, `"inference"`, `"revelation"`, `"default"`. |
| `warrant` | `string` | optional | — | Why this source is credible. |
| `provider` | `string` | optional | — | Entity that provided the evidence. |
| `provenance` | `array` | optional | `[]` | Chain of custody for evidence. |
| `acquiredAt` | `object` | required | — | Temporal anchor (see below). |

### TemporalAnchor (used in evidence, acts, commonGround)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `enum` | required | — | `"absolute"`, `"relative"`, `"chapter"`. |
| `value` | `string \| number` | required | — | The time value. |
| `anchor` | `string` | optional | — | Time anchor ID (only for relative). |
| `chapter` | `number` | optional | — | Chapter number (only for chapter type). |
| `offset` | `{ amount: number, unit: enum }` | optional | — | Offset from anchor. Unit: `"minute"`, `"hour"`, `"day"`, `"week"`, `"month"`. |

## Closed Enums / IDs

- `informationActType`: `"perception"`, `"thought"`, `"testimony"`, `"assertion"`, `"inference"`, `"reading"`, `"recall"`, `"revelation"` (8 values)
- `propositionQuantifier`: `"identity"`, `"all"`, `"any"`, `"not"` (4 values)
- `attitude`: `"knows"`, `"believes"`, `"suspects"`, `"denies"`, `"doubts"` (5 values)
- `claimGrade`: `"know"`, `"believe"`, `"suspect"` (3 values)
- `claimPolarity`: `"affirmative"`, `"negative"` (2 values)
- `intensionalDomain`: `"plan"`, `"dream"`, `"prophecy"`, `"theory"`, `"moral_judgment"`, `"counterfactual"` (6 values)
- `evidenceSource`: `"direct_experience"`, `"testimony"`, `"inference"`, `"revelation"`, `"default"` (5 values)
- `claimAssessment.type`: `"settled"`, `"conflicted"`, `"suspended"`, `"forgotten"`, `"unset"` (5 values)
- `temporalAnchor.type`: `"absolute"`, `"relative"`, `"chapter"` (3 values)
- `temporalOffset.unit`: `"minute"`, `"hour"`, `"day"`, `"week"`, `"month"` (5 values)

## Mutual Exclusions

- A proposition's `kind` discriminator determines which fields are valid: grounded, epistemic, act, and intensional propositions have disjoint field sets.
- `claimAssessment` is a discriminated union — exactly one of the five assessment types applies.
- `evidence` and `assessment.type === "unset"` may coexist (evidence for why it's unset).
- `acquiredAt.anchor` is meaningful only when `type === "relative"`.

## Valid Example

```yaml
# Propositions in the story state
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
          value: 1
```

## Invalid Example

```yaml
# ERROR: grounded + epistemic fields mixed, invalid source enum, missing id
propositions:
  bad_prop:
    kind: grounded
    id: bad_prop
    entityId: xianglins_wife
    attribute: location
    value: luchen_town
    attitude: knows          # Not valid for grounded propositions
    actType: perception      # Not valid for grounded propositions
```

**Expected error:**
```
ConfigError at definitions/propositions.yaml:5:5
  path: /propositions/bad_prop/attitude
  message: Unrecognized key(s) in object: 'attitude'

ConfigError at definitions/propositions.yaml:6:5
  path: /propositions/bad_prop/actType
  message: Unrecognized key(s) in object: 'actType'
```

## Normalized Target

The compiler produces:

- `PropositionCatalog` — versioned record of all propositions, with a dependency graph of proposition references.
- `EpistemicLedger` — all claims indexed by `subject` and `proposition`, with evidence chains and act logs.
- For author-facing YAML, `worldFacts` entries in `state_initial.yaml` become grounded propositions with `assessment.type: "settled"`, `grade: "know"`, `polarity: "affirmative"`.
- Event preconditions/postconditions are normalized into the proposition catalog during compilation.

## Source-Map Diagnostic Format

```
ConfigError at definitions/<file>.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
