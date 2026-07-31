# Rule YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/rule.ts` — `ruleDefinitionSchema` (author-facing YAML); `packages/core/src/schemas/primitives.ts` — `logicalConsequenceSchema`, `ruleEffectSchema`; `packages/core/src/schemas/rule.ts` — `ruleRuntimeStateSchema`, `ruleTransactionSchema`, `ruleEvaluationRecordSchema` (runtime IR)
**Replay:** `packages/core/src/state/rule-replay.ts` (`applyRuleTransaction`, `convertLegacyRuleEffect`)
**Validation:** `packages/core/src/validator/world-rule.ts` (`WorldRuleValidator`, `ruleCheckSchema`)
**Fixture files:** `fixtures/zhu-fu/definitions/rules/*.yaml`, `fixtures/arcane-aftermath/definitions/rules/*.yaml`, `fixtures/most-dangerous-game/definitions/rules/*.yaml`

Rules define the governing principles of the story world — natural laws, social norms, moral principles, game mechanics, and legal codes. They are authored as YAML files in `definitions/rules/`, validated by `ruleDefinitionSchema`, registered as entities of `kind: "rule"`, and enforced through replay transactions plus the `WorldRuleValidator` during analysis.

## Fields

## RuleDefinition Fields (Author-Facing)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `ruleId` | `string` | **required** | — | Unique identifier (e.g. `widow_purity`, `zaroff_hunt_3day`). Convention: `snake_case`. |
| `name` | `string` | **required** | — | Human-readable name in the story's language. |
| `category` | `string` | **required** | — | Logical category (e.g. `ritual_taboo`, `social_structure`, `game_rule`, `state_invariant`). |
| `type` | `string` | **required** | — | Rule type (e.g. `constraint`, `conflict_rule`, `rule`). |
| `statement` | `string` | **required** | — | Prose description of what the rule means in the world. |
| `ruleClass` | `enum` | optional | `undefined` | `"natural_law"`, `"social_norm"`, `"moral_principle"`, `"game_rule"`, `"legal_code"`. |
| `logicalConsequences` | `array` | **required** | — | Array of `LogicalConsequence` (see below). The key is required; an empty array passes schema validation. |
| `exceptions` | `array` | optional | `undefined` | Conditions where the rule does not apply. Each entry has `condition` (string) **and** `note` (string) — both required within an entry. |
| `evidenceChain` | `array` | **required** | — | Array of `RuleEffectEntry` (historical evidence of the rule being reinforced, weakened, etc.). |

### LogicalConsequence Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | `string` | **required** | — | Prose description of this consequence. |
| `check` | `object` | **required** | — | The check specification (see sub-fields below). |
| `check.type` | `enum` | required | — | `"state_invariant"`, `"transition_constraint"`, or `"progression"`. |
| `check.filter` | `string` | required | — | Entity/event filter expression. |
| `check.assert` | `string` | required | — | Assertion expression that must hold. |
| `check.severity` | `enum` | required | — | `"error"` or `"warning"`. |
| `check.unlessEvent` | `string` | optional | — | Event ID that, if it occurred, nullifies this check. |
| `check.direction` | `string` | optional | — | Direction hint (e.g. `"count_strict"`). |
| `check.tolerance` | `number` | optional | — | Tolerance for numeric comparisons. |

`unlessEvent`, `direction`, and `tolerance` are plain optional fields on the check object — the schema does not condition their validity on `check.type`. They are authoring hints; no runtime code branches on them.

### RuleEffectEntry Fields (evidenceChain / event ruleEffects)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `rule` | `string` | **required** | — | Rule ID being affected. |
| `effect` | `enum` | **required** | — | `"reinforce"`, `"weaken"`, `"introduce_exception"`, or `"nullify"`. |
| `evidence` | `string` | **required** | — | Prose describing the narrative evidence. |

## Closed Enums / IDs

- `ruleClass`: `"natural_law"`, `"social_norm"`, `"moral_principle"`, `"game_rule"`, `"legal_code"` (5 values)
- `check.type`: `"state_invariant"`, `"transition_constraint"`, `"progression"` (3 values)
- `check.severity`: `"error"`, `"warning"` (2 values)
- `effect`: `"reinforce"`, `"weaken"`, `"introduce_exception"`, `"nullify"` (4 values)
- `ruleId`: authoring convention is a non-empty `snake_case` identifier, unique across all rules. Enforcement is weaker than the convention: `ruleIdSchema` is a plain `z.string()` (the empty string passes schema validation), `EntityMapper.loadProject` performs no duplicate-ID pass, and `InMemoryEntityRegistry.load` inserts rules into a `Map` by ID, silently replacing an earlier rule on collision.

## Mutual Exclusions & Semantics

- `exceptions` and `evidenceChain` are independent arrays; both may be absent/empty (only `evidenceChain` is required).
- An empty `logicalConsequences` array is schema-valid. However, ISS executability scoring requires at least one consequence with a complete `check` (`calcRuleExecutability`), and strict-mode validation rejects a rule with no executable check (`iss/strict.ts`).
- `ruleClass` is optional with no inference: nothing derives a class from `category`.
- At replay, event `ruleEffects` entries (legacy `RuleEffectEntry` shape `{ rule, effect, evidence }`) are converted by `convertLegacyRuleEffect` into `RuleTransaction`s:
  - `reinforce` → `enable` (with generated `epochId`/`specificationId`)
  - `weaken` → `suspend`
  - `introduce_exception` → `add_exception` (exempt effect, empty constraint set)
  - `nullify` → `set_effectiveness: nullified`
  `applyRuleTransaction` then creates or advances the rule's `RuleRuntimeState` in `WorldState.rules` (`activation: dormant → enabled/suspended/revoked`, `effectiveness: full/limited/nullified`, exceptions). `RuleRuntimeState` has no evaluation-record field: `convertLegacyRuleEffect` builds transactions without `constraintEvaluation`, and `applyRuleTransaction` returns `RuleEvaluationRecord[]` only when a transaction explicitly carries `constraintEvaluation`. Event replay (`applyTransactions` in `event-application.ts`) discards that return value, so evaluation records exist only as a transient return to a direct caller of `applyRuleTransaction`/`evaluateConstraints` with explicit constraints.

## Valid Example

```yaml
# Structure of fixtures/zhu-fu/definitions/rules/widow_purity.yaml
ruleId: widow_purity
name: "Widow Purity Taboo"
category: ritual_taboo
type: constraint
statement: "Widows are considered impure and inauspicious. A widow cannot participate in ritual sacrifices."
ruleClass: social_norm
logicalConsequences:
  - description: "Widows cannot touch ritual vessels"
    check:
      type: state_invariant
      filter: "entity.gender='female' AND entity.marital_status IN ('widow', 'remarried_widow')"
      assert: "entity.can_touch_ritual_items=false"
      severity: error
  - description: "Widow's death during blessings is inauspicious"
    check:
      type: transition_constraint
      filter: "event.season='new_year_eve'"
      assert: "widow_death.is_ritually_polluting=true"
      severity: warning
exceptions:
  - condition: "If the widow's son has come of age and hosts the ritual"
    note: "With son alive the mother is elevated; with son dead she falls"
evidenceChain:
  - rule: widow_purity
    effect: reinforce
    evidence: "Fourth Aunt excludes Xianglin's Wife from the ritual"
```

## Invalid Example

```yaml
# ERROR: invalid ruleClass enum, invalid effect enum
ruleId: bad_rule
name: "Invalid Rule"
category: nonsense
type: constraint
statement: "A rule that breaks every constraint"
ruleClass: invalid_class  # not in enum
logicalConsequences: []
evidenceChain:
  - rule: bad_rule
    effect: nullify_all   # not in enum
    evidence: "Test evidence"
```

**Expected error (standard loader — first issue only):**
```
error.message:      YAML schema validation failed at ruleClass: Invalid enum value. Expected 'natural_law' | 'social_norm' | 'moral_principle' | 'game_rule' | 'legal_code', received 'invalid_class'
error.context.path: definitions/rules/bad_rule.yaml:ruleClass
```

## Normalized Target

- `RuleDefinition` YAML files are loaded by `EntityMapper` (validated by `ruleDefinitionSchema`) and registered in the entity registry as `kind: "rule"` entities, with `category` and `type` promoted into the entity state (`name` on the entity, `ruleId` as the entity ID).
- `logicalConsequences` and `evidenceChain` are not compiled into check functions. The deterministic enforcement surface is:
  - **Replay:** event `ruleEffects` → rule transactions building/advancing `RuleRuntimeState` in `WorldState.rules` (activation `dormant` → `enabled`/`suspended`/`revoked`, effectiveness `full`/`limited`/`nullified`, exceptions). Evaluation records are not retained: the runtime state schema has no evaluation-record field, and the records `applyRuleTransaction` returns for transactions that carry `constraintEvaluation` are discarded by event replay.
  - **`WorldRuleValidator.validatePre`:** flags a `nullify` effect when the target rule is `enabled` and not already `nullified`, and flags postcondition writes that contradict an immutable attribute defined by the entity registry.
  - **`WorldRuleValidator.validatePost`:** consumes Pass 2 LLM `ruleChecks` (`{ ruleId, violated, evidence, severity: "minor" | "major" }`), mapping `major` violations to errors and `minor` to warnings. `getAnalysisRequirements()` instructs the analysis pass to report a `ruleChecks` block for each active rule.
- Context assembly exposes rules that are `enabled` and not `nullified` as `activeRules` to the LLM context.

## Source-Map Diagnostic Format

`readYamlFile` reports only the **first** validation issue, as two separate properties on the `ConfigError`:

- `error.message` — `YAML schema validation failed at <dot-joined path | <root>>: <Zod message>`
- `error.context.path` — the project-relative file path, suffixed with the dot-joined Zod path when the issue is not at the root

Zod issue paths are joined with dots (`logicalConsequences.0.check.type`), not JSON Pointer syntax; a root-level issue reports `<root>` in the message and stores only the file path in `error.context.path`. No second `path:` line is rendered. Replay-time constraint violations surface as `RuleConstraintViolationError` with phase `rule-replay`.
