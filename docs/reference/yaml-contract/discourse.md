# Discourse YAML Contract

**Source Zod Schemas:** `packages/core/src/schemas/discourse.ts` — `discourseStateSchema`, `modelReaderProfileSchema`, `narratorProfileSchema` (with `narratorProfileTypeSchema`, `narratorAccessSchema`, `narratorAssertionCapabilitySchema`, `narratorTruthCapabilitySchema`, `narratorFidelitySchema`, `narratorSinceritySchema`), `voiceProfileSchema` (with `narrativeLevelSchema`, `diegeticRelationSchema`), `narratorAssertionSchema` (with `assertionTypeSchema`, `assertionPolaritySchema`, `truthBoundarySchema`, `narrationBoundarySchema`, `assertionEvidenceSchema`), `disclosureActionSchema` (with `revealActionSchema`, `claimActionSchema`, `hintActionSchema`, `retractionActionSchema`, `correctionActionSchema`, `withholdStartActionSchema`, `withholdEndActionSchema`, `discoursePositionSchema`), `hintSchema` (with `hintStateSchema`), `withholdingPolicySchema`, `plannedLedgerEntrySchema`, `ledgerChapterSchema`, `plannedDiscourseLedgerSourceSchema`, `discourseContextProjectionSchema`, `disclosureObservationSchema`, `excerptDisclosureCheckpointSchema`, `fullWorkContextSchema`, `sparseRunDeclarationSchema`

The discourse contract governs **how** narrative information is disclosed to the reader — the telling, not the told. It models narrator profiles, disclosure actions (reveals, claims, hints, retractions, corrections, withholds), hint lifecycles, and the planned disclosure ledger.

## Authoring Surfaces

Four author-facing YAML surfaces exist. Three are dedicated definition-level surfaces (below); the fourth is scene content on event files (last row, documented in full below the table). Everything else below is compiler-produced or runtime state:

| Surface | Path | Schema | Mandatory |
|---------|------|--------|-----------|
| Narrator profiles | `definitions/narrators/*.yaml` (one profile per file) | `narratorProfileSchema` | optional directory |
| Planned disclosure ledger | `definitions/discourse-ledger.yaml` | `plannedDiscourseLedgerSourceSchema` | **required** — the mandatory reader-order source |
| Narrator assertions | `definitions/assertions/*.yaml` (one assertion per file) | `narratorAssertionSchema` | optional directory; required when the ledger contains reveal/claim/retraction/correction actions |
| Scene event files | `chapters/chapter_<N>/*.yaml` (one scene per file) | `eventFileSchema` (`voice`, `focalization`, `narratorProfileRef`) | required — scenes are the primary narrative surface; every reachable `event_file` scene must be listed in the ledger |

The following are **not** authored YAML:

- `PlannedDiscourseLedger` (runtime) — the compiled ledger with a SHA-256 hash derived at runtime by `compilePlannedDiscourseLedger()` from the canonical serialization of the source. The `hash` field is never authored.
- `DiscourseState`, `DiscourseContextProjection`, `DisclosureObservation` — replay/pass products.
- `Hint` lifecycle records and `WithholdingPolicy` records — runtime state built by discourse replay from the ledger's hint/withhold actions.
- `ModelReaderProfile` — a single immutable built-in (`id: "default_model_reader_v1"`); not authored.
- `SparseRunDeclaration` (`excerptDisclosureCheckpointSchema` / `fullWorkContextSchema`) — declared types with no authored YAML surface.

Scene-level narrative voice, focalization, and narrator references are authored on **event files** — the fourth authoring surface (`packages/core/src/schemas/event.ts::eventFileSchema`): `voice` (`voiceProfileSchema`), `focalization`, `narratorProfileRef`. They are documented here because their schemas live in `discourse.ts`.

## NarratorProfile Fields

Validated by `narratorProfileSchema`, a discriminated union on `type` with four members. Base fields (all required):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | required | Narrator identifier (also the registry key). |
| `type` | `enum` | required | `"focalizer_bound"`, `"retrospective_entity"`, `"explicit_ledger"`, `"omniscient"`. |
| `access` | `enum` | required | `"full"`, `"focalizer_only"`, `"limited"`. |
| `assertion` | `enum` | required | Assertion capability: `"full"`, `"constrained"`, `"minimal"`. |
| `truth` | `enum` | required | `"full_knowledge"`, `"limited_knowledge"`, `"opaque"`. |
| `fidelity` | `enum` | required | `"reliable"`, `"unreliable"`, `"ambiguous"`. |
| `sincerity` | `enum` | required | `"sincere"`, `"deceptive"`, `"ambiguous"`. |

Type-specific extra fields (strict — other keys rejected):

- `retrospective_entity`: `knowledgeBoundary` (`string`, required)
- `omniscient`: `autoReveal` (`false` literal, required — omniscient narrators grant truth read access only, never auto-reveal)
- `focalizer_bound` and `explicit_ledger`: no extra fields

> Note: the `NarratorProfileBase` TypeScript type declares an optional `voice?: VoiceProfile`, but `narratorProfileSchema` — the schema that validates `definitions/narrators/*.yaml` — does not currently accept `voice` (the profile schemas are `.strict()`). Profile YAML validates the base capabilities plus type-specific fields only. Scene-level narrative voice is declared on event files via `voice`.

```yaml
# definitions/narrators/narrator_wo.yaml
id: narrator_wo
type: retrospective_entity
access: full
assertion: constrained
truth: limited_knowledge
fidelity: reliable
sincerity: sincere
knowledgeBoundary: narrator_wo_present_day_knowledge
```

## Voice Fields (Scene-Level)

Validated by `voiceProfileSchema` on event files (`eventFileSchema.voice`). Combines Genette's narrative level and diegetic relation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `level` | `enum` | required | `"extradiegetic"`, `"intradiegetic"`, `"metadiegetic"`, `"hypodiegetic"`. |
| `relation` | `enum` | required | `"heterodiegetic"` (narrator absent from the story), `"homodiegetic"` (narrator present). |
| `nestingDepth` | `integer` | optional | Nesting depth (0 = extradiegetic primary, 1 = intradiegetic, etc.). Must be a nonnegative integer (`z.number().int().nonnegative()`); fractional or negative values are rejected. |
| `embeddedStory` | `object` | optional | `narratingCharacter` (required string), `audienceCharacter` (optional string). |

## NarratorAssertion Fields

Validated by `narratorAssertionSchema`. Authoring surface: one assertion per file in `definitions/assertions/*.yaml`, each file validated as a single assertion object.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **required** | Unique assertion identifier; duplicate IDs across `definitions/assertions/` are rejected by the mapper. |
| `narrator` | `string` | **required** | Narrator profile ID or character ID making this assertion. |
| `proposition` | `string` | **required** | The proposition being asserted (free text). |
| `polarity` | `enum` | **required** | `"affirmative"` or `"negative"`. |
| `type` | `enum` | **required** | `"authoritative_reveal"`, `"claim"`, `"conjecture"`, `"quotation"`, `"implication"`. |
| `truthBoundary` | `boolean` | **required** | `true` = authoritative truth the narrator knows (reveal-capable); `false` = non-authoritative/unknown truth status (claim/conjecture only). The schema is `z.boolean()`: only `true` or `false` are accepted — `indeterminate` is not an authored value. |
| `narrationBoundary` | `object` | **required** | See below. |
| `evidence` | `object` | optional | See below. |

### NarrationBoundary Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `narratorId` | `string` | required | Who is narrating this assertion. |
| `focalizerId` | `string` | optional | Through whose perspective. |
| `narrationTime` | `string` | optional | Narration-time boundary reference — a plain string label, **not** parsed as a story timestamp (unlike the scene-level `narrationTime` field, which uses the authored timestamp union via `eventFileSchema`). |

### AssertionEvidence Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `enum` | required | `"direct_observation"`, `"testimony"`, `"inference"`, `"documented"`, `"knowledge_boundary"`. |
| `source` | `string` | required | Source of the evidence. |
| `confidence` | `enum` | optional | `"certain"`, `"probable"`, `"speculative"`. |

> Focalizer semantics: `focalizerId` is **not** validated against known character entity IDs. It is a projection gate used by `canProjectAssertionSurface()` in `state/discourse-replay.ts`: an assertion surface is projected only when a loaded narrator profile matches `narrationBoundary.narratorId` (`profile.id === narratorId`); for `focalizer_only` and `limited` access profiles, the assertion must also declare `focalizerId` equal to the scene's focalizer character. A mismatch silently gates the projection — it is not an error.

```yaml
# definitions/assertions/xianglin_death.yaml
id: assertion_xianglin_death
narrator: narrator_wo
proposition: "祥林嫂死于祝福前夜——'昨天夜里，或者就是今天罢'"
polarity: affirmative
type: authoritative_reveal
truthBoundary: true
narrationBoundary:
  narratorId: narrator_wo
```

## Planned Discourse Ledger

Validated by `plannedDiscourseLedgerSourceSchema` from `definitions/discourse-ledger.yaml`. The `hash` field of the runtime `PlannedDiscourseLedger` is **never authored** — `compilePlannedDiscourseLedger()` derives it at runtime.

### Ledger Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | required | Ledger identifier. Schema: `z.string().min(1).trim()` — the minimum-length check runs **before** trimming, so a whitespace-only value is accepted and normalized to an empty string. (Entry and chapter IDs instead use `.trim().min(1)` and reject whitespace-only values.) |
| `chapters` | `array` | required | Nonempty; chapters are grouped by branch. |
| `entries` | `array` | required | Ordered disclosure entries by discourse position; may be empty. |

### LedgerChapter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | `string` | required | Branch this chapter belongs to. |
| `chapter` | `number` | required | Positive integer. |
| `sceneIds` | `array` | required | Nonempty sequence of scene IDs in narrative order. |

### LedgerEntry Fields

Each entry nests a disclosure action plus its placement. `plannedLedgerEntrySchema`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | required | Entry identifier (nonblank). |
| `action` | `object` | required | One of the 7 disclosure action types below. |
| `sceneId` | `string` | required | Scene where the action is planned. |
| `branch` | `string` | required | Branch this entry belongs to. |
| `discoursePosition` | `number` | required | Nonnegative integer; must equal `action.discoursePosition` (preflight). |

## DisclosureAction Fields

Disclosure actions are a discriminated union on `type`. In the ledger they are authored nested under `entries[].action`; each action carries its own `discoursePosition` (`discoursePositionSchema` = nonnegative integer). Ordering is enforced by preflight, not by source order: entries are sorted by `discoursePosition` and must be exactly contiguous from 0 per branch (see Enforced Preflight Rules).

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
| `assertionId` | `string` | required | The assertion being claimed (no truth commitment). |
| `discoursePosition` | `number` | required | Position in the discourse sequence. |

### HintAction

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `literal` | required | Must be `"hint"`. |
| `hintId` | `string` | required | The hint's identifier. |
| `surfaceProposition` | `string` | required | What the reader sees (the surface text). |
| `targetProposition` | `string` | required | What is being hinted at (author-only; never enters the Pass 1 projection). |
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

```yaml
# definitions/discourse-ledger.yaml (required surface)
id: zhu_fu_main_ledger
chapters:
  - branch: main
    chapter: 1
    sceneIds:
      - E0
      - E1
      - E2
entries:
  - id: entry_reveal_death
    action:
      type: reveal
      assertionId: assertion_xianglin_death
      discoursePosition: 0
    sceneId: E0
    branch: main
    discoursePosition: 0
  - id: entry_claim_afterlife
    action:
      type: claim
      assertionId: assertion_afterlife_uncertain
      discoursePosition: 1
    sceneId: E0
    branch: main
    discoursePosition: 1
```

## Hint Lifecycle (Runtime State)

`hintSchema` records are **runtime state**, not authored YAML. Discourse replay (`applyAction` in `state/discourse-replay.ts`) creates a `Hint` in `planned` state for each `hint` action in the ledger; the six states are contract statuses, not prose observations.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hintId` | `string` | required | Unique hint identifier. |
| `state` | `enum` | required | See hint states below. |
| `surfaceProposition` | `string` | required | Reader-visible text. |
| `targetProposition` | `string` | required | Author-only target (never in Pass 1 projection). |
| `threadId` | `string` | optional | Thread this hint belongs to. |
| `discoursePosition` | `number` | required | Discourse position where hint is planted. |

## Enforced Preflight Rules

`compileDiscourseBoundaries()` (`state/discourse-context.ts`) enforces these rules and throws `ConfigError` on violation:

- Assertion-bearing entries (reveal/claim/retraction/correction) require an assertion catalog loaded from `definitions/assertions/`.
- Every referenced assertion must exist in the catalog.
- `reveal` requires the referenced assertion to have `truthBoundary: true` (§5 hard rule).
- `claim` requires the referenced assertion to be non-authoritative (`truthBoundary !== true` and `type !== 'authoritative_reveal'`) (§6).
- `retraction` must reference an assertion that is **still active at the retraction point** on the same branch (§8): a member of the active reveal set or an open claim. Retraction removes the target from the open-claim set (reveals persist), so a later second retraction of the same claim is rejected even though it was claimed earlier.
- `correction` requires a currently-active `priorAssertionId`, distinct from `newAssertionId`, which must not already be active; correcting an `authoritative_reveal` requires an `authoritative_reveal` replacement with `truthBoundary: true`.
- Entries are branch-local, and `compileDiscourseSceneSequence()` (`state/discourse-sequence.ts`) enforces the full scene-sequence contract:
  - Only `source === 'event_file'` scenes participate; duplicate event IDs are rejected.
  - The branch must have at least one chapter block, and chapter numbers must be strictly increasing.
  - Every ledger `sceneId` must match an event ID, scene IDs must not repeat within a branch, and every reachable `event_file` scene must appear in the ledger exactly once.
  - Branch entry positions are sorted and must be exactly contiguous from 0; source-array order need not be increasing.
  - Each scene's own positions must form a contiguous range, and action intervals must follow the chapter scene-sequence order.
  - `entry.discoursePosition` must equal `action.discoursePosition`; duplicate or non-monotonic positions are rejected.

Not enforced: `narrationBoundary.focalizerId` is never checked against character entities, and withhold-start/end policies are validated structurally (schema shape) without cross-entry policy matching.

## Closed Enums / IDs

- `assertionType`: `"authoritative_reveal"`, `"claim"`, `"conjecture"`, `"quotation"`, `"implication"` (5 values)
- `assertionPolarity`: `"affirmative"`, `"negative"` (2 values)
- `assertionEvidence.type`: `"direct_observation"`, `"testimony"`, `"inference"`, `"documented"`, `"knowledge_boundary"` (5 values)
- `assertionEvidence.confidence`: `"certain"`, `"probable"`, `"speculative"` (3 values)
- `narratorProfile.type`: `"focalizer_bound"`, `"retrospective_entity"`, `"explicit_ledger"`, `"omniscient"` (4 values)
- `narratorAccess` (field `access`): `"full"`, `"focalizer_only"`, `"limited"` (3 values)
- `narratorAssertionCapability` (field `assertion`): `"full"`, `"constrained"`, `"minimal"` (3 values)
- `narratorTruthCapability` (field `truth`): `"full_knowledge"`, `"limited_knowledge"`, `"opaque"` (3 values)
- `narratorFidelity`: `"reliable"`, `"unreliable"`, `"ambiguous"` (3 values)
- `narratorSincerity`: `"sincere"`, `"deceptive"`, `"ambiguous"` (3 values)
- `narrativeLevel`: `"extradiegetic"`, `"intradiegetic"`, `"metadiegetic"`, `"hypodiegetic"` (4 values)
- `diegeticRelation`: `"heterodiegetic"`, `"homodiegetic"` (2 values)
- `disclosureAction.type`: `"reveal"`, `"claim"`, `"hint"`, `"retraction"`, `"correction"`, `"withhold_start"`, `"withhold_end"` (7 values)
- `hintState`: `"planned"`, `"contract_planted"`, `"contract_reinforced"`, `"contract_fulfilled"`, `"contract_subverted"`, `"retracted"` (6 values)
- `disclosureObservation.observationType`: `"reveal"`, `"claim"`, `"hint"`, `"retraction"`, `"correction"`, `"unplanned_exposure"` (6 values)
- `disclosureObservation.matchLevel`: `"exact_match"`, `"partial_match"`, `"mismatch"`, `"unobserved"` (4 values)

## Valid Example

```yaml
# definitions/assertions/afterlife_uncertain.yaml
id: assertion_afterlife_uncertain
narrator: narrator_wo
proposition: "灵魂和地狱是否存在——'也许有罢……说不清'"
polarity: affirmative
type: claim
truthBoundary: false
narrationBoundary:
  narratorId: narrator_wo
```

Optional boundary fields are accepted but not required:

```yaml
narrationBoundary:
  narratorId: narrator_wo
  focalizerId: narrator
  narrationTime: "retrospective"
```

## Invalid Example

```yaml
# definitions/assertions/bad_assertion.yaml — ERROR
id: bad_assertion
narrator: narrator_wo
proposition: "Test"
polarity: maybe          # not in the polarity enum
type: claim
truthBoundary: false
narrationBoundary:
  narratorId: narrator_wo
```

**Expected error** (schema validation via `readYamlFile` — dot-path, no line/column):

```
ConfigError (code CONFIG_INVALID)
  message: YAML schema validation failed at polarity: Invalid enum value. Expected 'affirmative' | 'negative', received 'maybe'
  context.path: definitions/assertions/bad_assertion.yaml:polarity
```

A semantic violation (e.g. a reveal referencing a `truthBoundary: false` assertion, or an entry whose `action.discoursePosition` differs from its `discoursePosition`) is a preflight `ConfigError` with a plain message, not a schema path:

```
ConfigError: Reveal in entry "entry_reveal_unknown" on branch "main" references assertion "a1" which has truthBoundary=false. Reveals require truthBoundary=true.
```

## Normalized Target

The compiler/replay produces:

- `DiscourseState` — the replayed discourse position, reveal/claim/retraction/correction records, hint tracker, active withholding policies, narrator profiles, assertion catalog, provider index, branch, and ledger hash.
- `PlannedDiscourseLedger` (runtime) — the source ledger plus the derived SHA-256 `hash`.
- `DiscourseContextProjection` — Pass 1 projection of planned reveals, open claims, visible hint surfaces, focalizer/narrator-accessible claims, authorized targets, and active withholds.
- `DisclosureObservation` — Pass 2 observations of whether planned disclosures were executed, with match-level assessment.

## Source-Map Diagnostic Format

The YAML compiler (`readYamlFile` / `readYamlFilesInDir` in `entity/yaml-loader.ts`) reports schema failures as a `ConfigError` with `code = "CONFIG_INVALID"` and a **dot-path** (the first failing Zod issue's `path.join('.')`) — not a JSON pointer, and without line/column numbers:

```
ConfigError (code CONFIG_INVALID)
  message: YAML schema validation failed at <dot-path>: <Zod message>   # <dot-path> is '<root>' when empty
  context.path: <file>:<dot-path>                                        # e.g. definitions/assertions/a.yaml:polarity
```

Parse failures report `YAML parsing failed`; a missing required file reports `Required YAML file is missing`; both carry only the file path in `context.path`.
