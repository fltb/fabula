# 规则 YAML 格式

**源类型：** `packages/core/src/types/rule.ts` (RuleDefinition, LogicalConsequence)  
**Schema：** 通过 `EntityMapper` 中的 YAML 加载内联定义

规则定义了世界的治理原则——从自然法则和社会规范到道德原则和法律法规。它们以 YAML 文件形式存放在 `definitions/rules/` 目录中，由 `WorldRuleValidator`（渲染后，消费 Pass 2 `ruleChecks`）执行，并通过事件的 `RuleEffectEntry` 进行追踪。

## RuleDefinition 字段

| 字段 | 类型 | 描述 |
|---|---|---|
| `ruleId` | `string` | 唯一标识符（例如 `widow_purity`、`patriarchal_clan_authority`） |
| `name` | `string` | 故事语言中的人类可读名称 |
| `category` | `string` | 逻辑类别（例如 `ritual_taboo`、`social_structure`） |
| `type` | `string` | 规则类型（例如 `constraint`） |
| `statement` | `string` | 规则在世界中含义的散文描述 |
| `ruleClass` | `enum`（可选） | `natural_law`、`social_norm`、`moral_principle`、`game_rule`、`legal_code` |
| `logicalConsequences` | `LogicalConsequence[]` | 规则的可机器检查的逻辑推论 |
| `exceptions` | `{ condition, note }[]`（可选） | 规则不适用的条件 |
| `evidenceChain` | `RuleEffectEntry[]` | 规则被强化、削弱或无效化的历史证据 |

### LogicalConsequence

每个推论包含一个 `check` 对象，具有：
- `type`：`state_invariant`、`transition_constraint` 或 `progression`
- `filter`：实体过滤表达式（伪 SQL）
- `assert`：必须为真的内容
- `severity`：`error` 或 `warning`
- 可选：`unlessEvent`、`direction`、`tolerance`

## 规则效果

事件携带 `ruleEffects: RuleEffectEntry[]`，`effect` 值包括：
- **`reinforce`** — 规则被叙事中的事件所支持
- **`weaken`** — 事件挑战或削弱了规则
- **`introduce_exception`** — 建立了规则的新例外情况
- **`nullify`** — 规则被裁定为不适用

这些由 `applyRuleEffect()`（状态引擎中）追踪，并用于构建 `.nova/derived/rules.yaml` 中的证据链。

## 规则的流动方式

1. **YAML → EntityRegistry** — 规则以 `kind: 'rule'` 加载到注册表中，`initialState` 存储规则陈述、类别和逻辑推论。

2. **EntityRegistry → WorldState.rules** — 在状态初始化期间，规则被投影到 `WorldState.rules` 中，后者追踪每条规则的激活状态和累积的证据链。

3. **WorldState.rules → ContextPackage.activeRules** — `ContextCompiler` 选择与当前场景相关的激活规则，并将其包含在上下文包中，使 LLM 提示可获得规则意识（作为 `activeRules` 传递给 Pass 2 分析提示）。

4. **Pass 2 → WorldRuleValidator** — LLM 在其自己的散文中分析规则合规性，在 `ruleChecks` 块中报告违规行为。`WorldRuleValidator.validatePost()` 消费此信息，标记违反规则的情况，并附带证据引用。

## 示例（来自 zhu-fu 测试夹具: widow_purity.yaml）

```yaml
ruleId: widow_purity
name: "寡妇不洁禁忌"
category: ritual_taboo
type: constraint
statement: "寡妇被视为不洁、不祥的人。祭祀是洁净的仪式，容不得'不洁'的人触碰。祥林嫂因为寡妇和再寡的双重身份，被彻底排除在祝福祭祀的参与之外..."
ruleClass: social_norm
logicalConsequences:
  - description: "寡妇不能触碰祭祀器皿"
    check:
      type: state_invariant
      filter: "entity.gender='女' AND entity.marital_status IN ('widow', 'remarried_widow')"
      assert: "entity.can_touch_ritual_items=false"
      severity: error
  - description: "寡妇死在祝福期间被视为不吉"
    check:
      type: transition_constraint
      filter: "event.season='new_year_eve'"
      assert: "widow_death.is_ritually_polluting=true"
      severity: warning
exceptions:
  - condition: "如果寡妇的儿子成年并主持祭祀..."
    note: "子存则母贵，子亡则母坠"
evidenceChain:
  - rule: widow_purity
    effect: reinforce
    evidence: "四婶安排祝福祭祀时，祥林嫂被明确排除"
  - rule: widow_purity
    effect: reinforce
    evidence: "祥林嫂捐了门槛后坦然去拿酒杯筷子，被四婶喝止——'你放着罢，祥林嫂！'"
```
