# 规则 YAML 格式

**源类型：** `packages/core/src/types/rule.ts` (RuleDefinition, LogicalConsequence, RuleEffectEntry, RuleTransaction)
**Schema：** `packages/core/src/schemas/rule.ts` — `ruleDefinitionSchema`（作者 YAML 加载）、`ruleEffectEntrySchema`；`packages/core/src/schemas/primitives.ts` — `logicalConsequenceSchema`、`ruleEffectSchema`（事件级 `ruleEffects`）

规则定义了世界的治理原则——从自然法则和社会规范到道德原则和法律法规。它们以 YAML 文件形式存放在 `definitions/rules/` 目录中，由 `EntityMapper.loadProject()` 通过 `ruleDefinitionSchema`（严格模式）验证并加载。

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
| `exceptions` | `{ condition, note }[]`（可选） | 规则不适用的条件；`condition` 与 `note` 均为必填字符串 |
| `evidenceChain` | `RuleEffectEntry[]` | 规则被强化、削弱或无效化的历史证据（`rule`、`effect`、`evidence`，均为必填） |

### LogicalConsequence

每个推论包含一个 `check` 对象，具有：
- `type`：`state_invariant`、`transition_constraint` 或 `progression`
- `filter`：实体过滤表达式（伪 SQL）
- `assert`：必须为真的内容
- `severity`：`error` 或 `warning`
- 可选：`unlessEvent`、`direction`、`tolerance`

## 事件级规则效果（ruleEffects）

事件 YAML 的 `ruleEffects` 数组（`ruleEffectSchema`）接受遗留的 `RuleEffectEntry` 形式，每个条目包含 `rule`（规则 ID）、`effect` 和 `evidence`（散文证据）：

- **`reinforce`** — 规则被叙事中的事件所支持
- **`weaken`** — 事件挑战或削弱了规则
- **`introduce_exception`** — 建立了规则的新例外情况
- **`nullify`** — 规则被裁定为不适用

重放时，`applyEventRuleEffects`（`packages/core/src/state/event-application.ts`）通过 `convertLegacyRuleEffect`（`packages/core/src/state/rule-replay.ts`）把每个遗留条目转换为一条 `RuleTransaction`，再由 `applyRuleTransaction` 应用到 `WorldState.rules`（`Record<ruleId, RuleRuntimeState>`）：

| 遗留 effect | 转换后的操作 |
|---|---|
| `reinforce` | `enable` |
| `weaken` | `suspend` |
| `introduce_exception` | `add_exception`（新建 `effect: exempt` 的异常） |
| `nullify` | `set_effectiveness`（`newEffectiveness: nullified`） |

`RuleTransaction` 的完整操作集合为 `enable`、`suspend`、`revoke`、`amend`、`replace`、`set_effectiveness`、`add_exception`、`remove_exception`。渲染管线（`pipeline/output.ts`）从已渲染事件收集规则效果，写入 `.nova/derived/rules.yaml` 作为证据链产物。

## 规则的流动方式

1. **YAML → EntityRegistry** — `EntityMapper.loadProject()` 读取 `definitions/rules/` 下的所有 YAML 文件，通过 `ruleDefinitionSchema` 验证。每个规则被注册为 `kind: 'rule'` 的 `Entity`；`buildRuleState` 只把 `category` 和 `type` 两个字段提升进实体 `state`（`statement`、`logicalConsequences` 等保留在 `RuleDefinition` 上，供验证器与作者参考，不进入注册表状态）。

2. **EntityRegistry → WorldState.rules** — `WorldState.rules` 是 `Record<ruleId, RuleRuntimeState>`。每个规则在首次被事件 `ruleEffects` 触及时，由 `applyRuleTransaction` 惰性创建运行时状态（`activation: 'dormant'`，`effectiveness: 'full'`），此后通过事务推进 `activation`（`dormant`/`enabled`/`suspended`/`revoked`）与 `effectiveness`（`full`/`limited`/`nullified`）。

3. **WorldState.rules → ContextPackage.activeRules** — `ContextAssembler._buildActiveRules` 选择 `activation === 'enabled'` 且 `effectiveness !== 'nullified'` 的规则，组装成 `RuleDefinition[]` 放入 `ContextPackage.activeRules`，经 `PromptAssembler` 渲染进 Pass 1 散文提示（“Prose must not contradict these rules”）。注意：`_buildActiveRules` 只从注册表实体 `state` 重建规则对象，而 `buildRuleState` 仅提升 `category` 和 `type`，因此 `name` 回退为规则 ID、`statement` 为空字符串、`logicalConsequences` 与 `evidenceChain` 为空数组——作者在 YAML 中编写的规则陈述与推论**不会**进入上下文包或 LLM 提示；Pass 2 的 `WorldRuleValidator` 同样只消费 `ruleChecks` 块与事件级 `ruleEffects`，不读取这些作者字段。

4. **Pass 2 → WorldRuleValidator** — LLM 在 Pass 2 分析中以 `ruleChecks` 块报告规则合规性（`ruleCheckSchema`：`ruleId`、`violated`、`evidence`、`severity: minor|major`）。`WorldRuleValidator.validatePost()`（`packages/core/src/validator/world-rule.ts`）消费该块，对 `violated: true` 的条目生成验证问题；`validatePre()` 则确定性检查事件 `ruleEffects` 对已启用规则的 `nullify` 以及不可变属性（如 `rule` 种类的 `category`/`type`）的写违反。

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
