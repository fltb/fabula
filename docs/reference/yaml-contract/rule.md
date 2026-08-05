# Rule YAML Contract

**Current source:** `schemas/rule.ts`, `entity/mapper.ts`, `state/narrative-baseline.ts`, `state/rule-replay.ts`, `state/event-application.ts`, and `validator/world-rule.ts`.

## Required source topology

```text
definitions/rule-types.yaml
definitions/rules/<ruleId>.yaml
```

The required type catalog uses keys equal to `typeId`:

```yaml
types:
  social_norm:
    typeId: social_norm
    name: Social norm
    category: social
    ruleClass: social_norm
    defaultConstraints: []
```
Each declaration file uses its filename as `ruleId`:

```yaml
ruleId: ritual_purity
name: Ritual purity
typeId: social_norm
initialEpochId: ritual_purity:epoch-1
initialSpecificationId: ritual_purity:spec-1
initialActivation: dormant
initialEffectiveness: full
scopeBindings: {}
exceptions: []
specifications:
  ritual_purity:spec-1:
    statement: Only eligible people may touch the ritual vessels.
    constraints: []
```

The mapper rejects duplicate rule IDs, file/ID mismatch, unknown type, missing initial specification, and unknown rule/exception scope references before graph compilation or rendering.

## Event effects

Events use canonical rule transactions directly:

```yaml
ruleEffects:
  - type: rule_transaction
    ruleId: ritual_purity
    operation: enable
    evidence: E1 establishes the ritual restriction.
    epochId: ritual_purity:epoch-1
    specificationId: ritual_purity:spec-1
```

Allowed operations are `enable`, `suspend`, `revoke`, `amend`, `replace`, `set_effectiveness`, `add_exception`, and `remove_exception`. There is no legacy `{ rule, effect, evidence }` source form or compatibility conversion.

## Runtime materialization and enforcement

`materializeNarrativeBaseline()` creates a `RuleRuntimeState` for every declaration before event replay, using its initial epoch, specification, activation, effectiveness, bindings, and exceptions. Transactions therefore cannot synthesize misspelled or undeclared rule state; `applyRuleTransaction()` fails closed when a rule is not materialized.

Active, non-nullified declarations are projected to the render context. `WorldRuleValidator` consumes their Pass 2 `ruleChecks` and deterministic state-write policy checks.

Rule predicates remain declaration data. Existing replay records hard/audit/semantic constraint outcomes through `RuleEvaluationRecord`; the predicate evaluator intentionally does not interpret a general expression language. A hard violation throws `RuleConstraintViolationError`; audit and semantic outcomes remain structured evaluation records.
