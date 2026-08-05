# 规则 YAML 格式

> **当前契约。** 本页是 `definitions/rule-types.yaml`、`definitions/rules/*.yaml` 与事件 `ruleEffects` 的作者入口。完整字段、重放语义和约束执行规则见 [规则 YAML Contract](../yaml-contract/rule.md)。

## 文件拓扑

```text
definitions/rule-types.yaml
definitions/rules/<ruleId>.yaml
```

`rule-types.yaml` 定义可复用类型目录；`types` 的映射键必须等于内部的 `typeId`。每个 `definitions/rules/<ruleId>.yaml` 是一个 `RuleDeclaration`，文件名必须与其中的 `ruleId` 一致。

```yaml
# definitions/rule-types.yaml
types:
  constraint:
    typeId: constraint
    name: 祭祀禁忌
    category: ritual_taboo
    ruleClass: social_norm
    defaultConstraints: []
```

```yaml
# definitions/rules/widow_purity.yaml
ruleId: widow_purity
name: 寡妇不洁禁忌
typeId: constraint
initialEpochId: widow_purity:epoch-1
initialSpecificationId: widow_purity:specification-1
initialActivation: enabled
initialEffectiveness: full
scopeBindings: {}
exceptions: []
specifications:
  widow_purity:specification-1:
    statement: 只有符合条件的人可以触碰祭器。
    constraints: []
```

规则声明必须引用已知 `typeId`，并且 `initialSpecificationId` 必须存在于 `specifications`。加载器拒绝重复规则 ID、文件名/ID 不一致、未知类型和无效初始 specification。

## 事件事务

事件通过 `ruleEffects` 声明规范的 `RuleTransaction`；不存在旧式 `{ rule, effect, evidence }` 形式，也不存在兼容转换。

```yaml
ruleEffects:
  - type: rule_transaction
    ruleId: widow_purity
    operation: suspend
    evidence: E12 的裁决暂缓了这一禁忌。
    epochId: widow_purity:epoch-1
    specificationId: widow_purity:specification-1
```

允许的 `operation`：`enable`、`suspend`、`revoke`、`amend`、`replace`、`set_effectiveness`、`add_exception`、`remove_exception`。不同操作所需的附加字段由 `ruleTransactionSchema` 验证。

## 重放与上下文

`materializeNarrativeBaseline()` 在任何事件重放前，为每个规则声明创建运行时状态；该状态继承声明的 epoch、specification、activation、effectiveness、scope bindings 和 exceptions。未 materialize 的规则不能由事务临时创建。

启用且未 nullified 的规则被投影到渲染上下文。`WorldRuleValidator` 消费 Pass 2 的 `ruleChecks`，同时执行确定性的状态写入策略检查。约束谓词保留为声明数据；重放记录 `RuleEvaluationRecord`，不会把通用表达式语言当作可执行代码。
