# Discourse YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/discourse.ts` — `discourseStateSchema`, `narratorProfileSchema`, `narratorAssertionSchema`, `disclosureActionSchema`, `plannedDiscourseLedgerSchema`, `discourseContextProjectionSchema`, `hintSchema`, `withholdingPolicySchema`, `disclosureObservationSchema`, `sparseRunDeclarationSchema`  

The discourse contract governs **how** narrative information is disclosed to the reader — the telling, not the told. It models narrator profiles, disclosure actions (reveals, claims, hints, retractions, corrections, withholds), hint lifecycles, and the planned disclosure ledger. Author-facing YAML surfaces in scene-level discourse files; most discourse structures are compiler-produced from event data and narrator configurations.

## Fields

### NarratorAssertion Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **required** | — | Unique assertion identifier. |
| `narrator` | `string` | **required** | — | Narrator profile ID making this assertion. |
| `proposition` | `string` | **required** | — | The proposition being asserted (free text). |
| `polarity` | `enum` | **required** | — | `"affirmative"` or `"negative"`. |
| `type` | `enum` | **required** | — | `"authoritative_reveal"`, `"claim"`, `"conjecture"`, `"quotation"`, `"implication"`. |
| `truthBoundary` | `boolean` | **required** | — | Whether this assertion crosses a truth boundary (false = in-world truth). |
| `narrationBoundary` | `object` | **required** | — | Context for the assertion. See below. |
| `evidence` | `object` | optional | — | Supporting evidence. See below. |

### NarrationBoundary Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `narratorId` | `string` | required | — | Who is narrating this assertion. |
| `focalizerId` | `string` | optional | — | Through whose perspective. |
| `narrationTime` | `string` | optional | — | When the narration occurs (time anchor ID or free text). |

### AssertionEvidence Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `enum` | required | — | `"direct_observation"`, `"testimony"`, `"inference"`, `"documented"`, `"knowledge_boundary"`. |
| `source` | `string` | required | — | Source of the evidence. |
| `confidence` | `enum` | optional | — | `"certain"`, `"probable"`, `"speculative"`. |

## DisclosureAction Fields (Planned Ledger)

Disclosure actions are a discriminated union on `type`.

### RevealAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"reveal"`. |
| `assertionId` | `string` | required | The assertion being revealed. |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

### ClaimAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"claim"`. |
| `assertionId` | `string` | required | The assertion being claimed (lower epistemic certainty than reveal). |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

### HintAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"hint"`. |
| `hintId` | `string` | required | The hint's identifier. |
| `surfaceProposition` | `string` | required | What the reader sees (the surface text). |
| `targetProposition` | `string` | required | What is being hinted at. |
| `threadId` | `string` | optional | Narrative thread the hint belongs to. |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

### RetractionAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"retraction"`. |
| `assertionId` | `string` | required | The assertion being retracted. |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

### CorrectionAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"correction"`. |
| `priorAssertionId` | `string` | required | The old (incorrect) assertion. |
| `newAssertionId` | `string` | required | The new (correct) assertion. |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

### WithholdStartAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"withhold_start"`. |
| `policyId` | `string` | required | Withholding policy identifier. |
| `reason` | `string` | optional | Why the information is being withheld. |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

### WithholdEndAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"withhold_end"`. |
| `policyId` | `string` | required | The withholding policy being ended. |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

## NarratorProfile Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | required | — | Narrator identifier. |
| `type` | `enum` | required | — | `"focalizer_bound"`, `"retrospective_entity"`, `"explicit_ledger"`, `"omniscient"`. |
| `access` | `enum` | required | — | `"full"`, `"focalizer_only"`, `"limited"`. |
| `assertion` | `enum` | required | — | `"full"`, `"constrained"`, `"minimal"`. |
| `truth` | `enum` | required | — | `"full_knowledge"`, `"limited_knowledge"`, `"opaque"`. |
| `fidelity` | `enum` | required | — | `"reliable"`, `"unreliable"`, `"ambiguous"`. |
| `sincerity` | `enum` | required | — | `"sincere"`, `"deceptive"`, `"ambiguous"`. |

Type-specific extra fields:
- `retrospective_entity`: `knowledgeBoundary` (string, required)
- `omniscient`: `autoReveal` (literal `false`, required; omniscient narrators never auto-reveal)

## Hint Lifecycle Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `hintId` | `string` | required | — | Unique hint identifier. |
| `state` | `enum` | required | — | See hint states below. |
| `surfaceProposition` | `string` | required | — | Reader-visible text. |
| `targetProposition` | `string` | required | — | What is being foreshadowed. |
| `threadId` | `string` | optional | — | Thread this hint belongs to. |
| `discoursePosition` | `number` | required | — | Discourse position where hint is planted. |

## Closed Enums / IDs

- `assertionType`: `"authoritative_reveal"`, `"claim"`, `"conjecture"`, `"quotation"`, `"implication"` (5 values)
- `assertionPolarity`: `"affirmative"`, `"negative"` (2 values)
- `evidenceType`: `"direct_observation"`, `"testimony"`, `"inference"`, `"documented"`, `"knowledge_boundary"` (5 values)
- `evidenceConfidence`: `"certain"`, `"probable"`, `"speculative"` (3 values)
- `narratorProfile.type`: `"focalizer_bound"`, `"retrospective_entity"`, `"explicit_ledger"`, `"omniscient"` (4 values)
- `narratorAccess`: `"full"`, `"focalizer_only"`, `"limited"` (3 values)
- `narratorAssertion`: `"full"`, `"constrained"`, `"minimal"` (3 values)
- `narratorTruth`: `"full_knowledge"`, `"limited_knowledge"`, `"opaque"` (3 values)
- `narratorFidelity`: `"reliable"`, `"unreliable"`, `"ambiguous"` (3 values)
- `narratorSincerity`: `"sincere"`, `"deceptive"`, `"ambiguous"` (3 values)
- `disclosureAction.type`: `"reveal"`, `"claim"`, `"hint"`, `"retraction"`, `"correction"`, `"withhold_start"`, `"withhold_end"` (7 values)
- `hintState`: `"planned"`, `"contract_planted"`, `"contract_reinforced"`, `"contract_fulfilled"`, `"contract_subverted"`, `"retracted"` (6 values)
- `discourseObservation.type`: `"reveal"`, `"claim"`, `"hint"`, `"retraction"`, `"correction"`, `"unplanned_exposure"` (6 values)
- `observationMatchLevel`: `"exact_match"`, `"partial_match"`, `"mismatch"`, `"unobserved"` (4 values)

## Mutual Exclusions

- `reveal` and `claim` actions differ in epistemic certainty: reveals are authoritative, claims are tentative.
- `hint` actions cannot be used to reveal information directly — they always pair a `surfaceProposition` (visible) with a `targetProposition` (concealed).
- `retraction` and `correction` are mutually exclusive for the same assertion: an assertion is either retracted (withdrawn) or corrected (replaced with a new assertion).
- `withhold_start` and `withhold_end` must reference the same `policyId`.
- An assertion's `narrationBoundary.focalizerId` must match a known character entity ID.

## Valid Example

```yaml
# Narrator assertion (author-facing)
narratorAssertions:
  - id: narrator_first_meeting
    narrator: default_narrator
    proposition: "Xianglin's Wife was working at Fourth Master Lu's house"
    polarity: affirmative
    type: authoritative_reveal
    truthBoundary: false
    narrationBoundary:
      narratorId: default_narrator
      focalizerId: narrator
      narrationTime: "retrospective"
```

## Invalid Example

```yaml
# ERROR: invalid polarity, missing discoursePosition in action
assertions:
  - id: bad_assertion
    narrator: unknown_narrator
    proposition: "Test"
    polarity: maybe      # not in enum
    type: claim
    truthBoundary: false
    narrationBoundary:
      narratorId: unknown_narrator
```

**Expected error:**
```
ConfigError at discourse.yaml:5:13
  path: /assertions/0/polarity
  message: Invalid enum value 'maybe'. Expected one of 'affirmative', 'negative'
```

## Normalized Target

The compiler produces:

- `DiscourseState` — the complete discourse position, assertion registry, hint tracker, and active withholding policies.
- `PlannedDiscourseLedger` — ordered sequence of disclosure actions with scene assignments, branch context, and discourse positions.
- `DiscourseContextProjection` — Pass 1 projection of planned reveals, open claims, visible hints, and active withholds for the context compiler.
- `DisclosureObservation` — Pass 2 observations of whether planned disclosures were executed, with match-level assessment.
- Narrator profiles are resolved against the narrator registry; unknown narrator IDs cause an error.

## Source-Map Diagnostic Format

```
ConfigError at <file>.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
