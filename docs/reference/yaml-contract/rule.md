# Rule YAML Contract

**Source Zod Schema:** `packages/core/src/schemas/rule.ts` (in-line YAML-loading schema), `packages/core/src/schemas/primitives.ts` (`logicalConsequenceSchema`, `ruleEffectSchema`)  
**Fixture files:** `fixtures/zhu-fu/definitions/rules/*.yaml`, `fixtures/arcane-aftermath/definitions/rules/*.yaml`, `fixtures/most-dangerous-game/definitions/rules/*.yaml`

Rules define the governing principles of the story world — natural laws, social norms, moral principles, game mechanics, and legal codes. They are authored as YAML files in `definitions/rules/` and are enforced by the `WorldRuleValidator` during Pass 2 analysis.

## Fields

## RuleDefinition Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `ruleId` | `string` | **required** | — | Unique identifier (e.g. `widow_purity`, `zaroff_hunt_3day`). |
| `name` | `string` | **required** | — | Human-readable name in the story's language. |
| `category` | `string` | **required** | — | Logical category (e.g. `ritual_taboo`, `social_structure`, `game_rule`, `state_invariant`). |
| `type` | `string` | **required** | — | Rule type (e.g. `constraint`, `conflict_rule`, `rule`). |
| `statement` | `string` | **required** | — | Prose description of what the rule means in the world. |
| `ruleClass` | `enum` | optional | `undefined` | `"natural_law"`, `"social_norm"`, `"moral_principle"`, `"game_rule"`, `"legal_code"`. |
| `logicalConsequences` | `array` | **required** | — | Array of `LogicalConsequence` (see below). |
| `exceptions` | `array` | optional | `[]` | Conditions where the rule does not apply. Each exception has `condition` (string) and optional `note` (string). |
| `evidenceChain` | `array` | **required** | — | Array of `RuleEffectEntry` (historical evidence of the rule being reinforced, weakened, etc.). |

### LogicalConsequence Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | `string` | **required** | — | Prose description of this consequence. |
| `check` | `object` | **required** | — | The check specification (see sub-fields below). |
| `check.type` | `enum` | required | — | `"state_invariant"`, `"transition_constraint"`, or `"progression"`. |
| `check.filter` | `string` | required | — | Entity filter expression (pseudo-SQL; validated by the rule engine). |
| `check.assert` | `string` | required | — | Assertion expression that must hold. |
| `check.severity` | `enum` | required | — | `"error"` or `"warning"`. |
| `check.unlessEvent` | `string` | optional | — | Event ID that, if it occurred, nullifies this check. |
| `check.direction` | `string` | optional | — | Direction hint for progression checks (e.g. `"count_strict"`). |
| `check.tolerance` | `number` | optional | — | Tolerance for numeric comparisons. |

### RuleEffectEntry Fields (Event-Level)

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
- `ruleId`: Any non-empty string, must be unique across all rules. Convention: `snake_case` identifiers.

## Mutual Exclusions

- `exceptions` and `evidenceChain` are independent arrays; both can be empty.
- `check.unlessEvent` is valid only for `state_invariant` and `transition_constraint` check types.
- `check.direction` and `check.tolerance` are valid only for `progression` check type.
- A rule with zero `logicalConsequences` is syntactically valid but semantically meaningless — the compiler issues a warning.
- `ruleClass` is optional; when absent, the rule engine infers heuristics from `category`.

## Valid Example

```yaml
# From fixtures/zhu-fu/definitions/rules/widow_purity.yaml
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
# ERROR: invalid effect enum, missing required logicalConsequences, unknown key
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

**Expected error:**
```
ConfigError at definitions/rules/bad_rule.yaml:7:3
  path: /ruleClass
  message: Invalid enum value 'invalid_class'. Expected one of 'natural_law', 'social_norm', 'moral_principle', 'game_rule', 'legal_code'

ConfigError at definitions/rules/bad_rule.yaml:11:7
  path: /evidenceChain/0/effect
  message: Invalid enum value 'nullify_all'. Expected one of 'reinforce', 'weaken', 'introduce_exception', 'nullify'
```

## Normalized Target

The compiler registers rules as entities of `kind: 'rule'` in the `EntityRegistry`. During compilation:

- `RuleDefinition` → `Entity` with `initialState` containing the rule statement, category, type, and serialized logical consequences.
- `logicalConsequences` are compiled into `WorldRuleValidator` check functions.
- `evidenceChain` entries accumulate in `WorldState.rules[ruleId].evidenceChain`.
- Event `ruleEffects` are applied to the evidence chain via `applyRuleEffect()`.
- Pass 2 LLM output's `ruleChecks` are validated against active rules by `WorldRuleValidator.validatePost()`.

## Source-Map Diagnostic Format

```
ConfigError at definitions/rules/<id>.yaml:<line>:<col>
  path: <JSON pointer>
  message: <Zod validation error>
```
