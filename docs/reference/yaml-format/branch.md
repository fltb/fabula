# 分支 YAML 格式

**源类型：** `packages/core/src/types/branch.ts`（BranchPath, BranchSet, BranchPoint, BranchChoice, Condition）  
**实现：** `packages/core/src/branch/path.ts`（`branchPathsEqual`、`branchPathToString`）、`packages/core/src/branch/set.ts`（`includesPath`、`evaluateCondition`、`getAvailableChoices`）

分支系统支持分支叙事，其中读者（或 LLM）的选择会产生不同的故事路径。它以三个主要概念构建：**BranchPath**——当前读者所走路径的记录；**BranchSet**——声明哪些路径在一个分支点可见；**Condition**——基于 WorldState 决定可用性的谓词。

这些类型并非独立的 YAML 定义文件，而是嵌入在事件 YAML 文件（`EventFile`）的 `branchPoint` 字段和场景元数据中，用于控制叙事流程。
## Fields

| 字段 | 类型 | 描述 |
|---|---|---|
| `decisions` | `Array<{ atEventId, choiceId, narrativeOrder }>` | 在分支点做出的选择，按叙事顺序排列 |

每个决策条目包含：

| 字段 | 类型 | 描述 |
|---|---|---|
| `atEventId` | `string` | 做出决策时所在的事件标识符（例如 `"E0"`） |
| `choiceId` | `string` | 所选选项的标识符（例如 `"trust_seraphine"`） |
| `narrativeOrder` | `number` | 决策在叙事中的位置（从 1 开始） |

**示例：** 一个经历了两次分支决策的路径：

```yaml
decisions:
  - atEventId: E0
    choiceId: trust_seraphine
    narrativeOrder: 1
  - atEventId: E3
    choiceId: attack
    narrativeOrder: 2
```

字符串表示（由 `branchPathToString` 生成）：`BP1:trust_seraphine → BP2:attack`

## BranchSet

`BranchSet` 定义了哪些叙事路径在一个上下文中可见。它有四种形式：

| 类型 | 描述 |
|---|---|
| `{ type: 'all' }` | 所有路径都包含——适用于线性叙事或对分支不可知的场景 |
| `{ type: 'paths', paths: BranchPath[] }` | 显式列出的路径被包含——等于任一路径时匹配 |
| `{ type: 'condition', condition: Condition }` | 运行时条件评估为 true 时包含 |
| `{ type: 'except', branches: BranchSet }` | 对内部 BranchSet 的求值取反——内部包含则排除 |

### includesPath 逻辑

`includesPath(branchSet, branchPath)` 是核心过滤谓词：

- **`type: 'all'`** → 始终返回 `true`（线性叙事仅当 `branchPath` 为空时才匹配 `type: 'all'`）。
- **`type: 'paths'`** → 如果 `branchPath` 与任何列出的路径深度相等则返回 `true`。
- **`type: 'condition'`** → 委托给 `evaluateCondition`，后者基于 BranchPath 中的字段评估 `Condition` 对象。
- **`type: 'except'`** → 返回 `!includesPath(branchSet.branches, branchPath)`。
- **线性叙事（空 BranchPath）** → 仅当 `branchSet.type === 'all'` 时匹配。

### BranchSet 示例

```yaml
# 包含所有路径（线性默认）
existenceCondition:
  type: all

# 显式列出两个可能的分支路径
existenceCondition:
  type: paths
  paths:
    - decisions:
        - atEventId: E0
          choiceId: trust_seraphine
          narrativeOrder: 1
    - decisions:
        - atEventId: E0
          choiceId: betray_seraphine
          narrativeOrder: 1

# 条件分支——仅在满足 Condition 时可见
existenceCondition:
  type: condition
  condition:
    type: equals
    field: "decisions.0.choiceId"
    value: "trust_seraphine"

# 排除某个特定路径——除指定路径外所有路径都包含
existenceCondition:
  type: except
  branches:
    type: paths
    paths:
      - decisions:
          - atEventId: E0
            choiceId: betray
            narrativeOrder: 1
```

## Condition

`Condition` 定义了运行时评估的谓词：

| 字段 | 类型 | 描述 |
|---|---|---|
| `type` | `enum` | `equals`、`not_equals`、`greater_than`、`less_than`、`contains`、`and`、`or` |
| `field` | `string`（可选） | 点号路径，用于从 BranchPath 中解引用字段（例如 `"decisions.0.choiceId"`） |
| `value` | `unknown`（可选） | 与字段值比较的参考值 |
| `conditions` | `Condition[]`（可选） | 用于 `and`/`or` 逻辑的子条件数组 |

条件评估（`evaluateCondition`）通过点号路径（例如 `decisions.length`、`decisions.0.choiceId`）从 BranchPath 中读取值。对于 `and`/`or` 类型，递归计算每个子条件。

```yaml
# 复合条件：两个条件都必须满足
existenceCondition:
  type: condition
  condition:
    type: and
    conditions:
      - type: equals
        field: "decisions.0.choiceId"
        value: "trust_seraphine"
      - type: not_equals
        field: "decisions.1.choiceId"
        value: "betray"
```

## BranchPoint

`BranchPoint` 定义了故事中读者面临选择的一个节点：

| 字段 | 类型 | 描述 |
|---|---|---|
| `branchPointId` | `string` | 该分支点的唯一标识符（例如 `bp_choice_ally`） |
| `atEventId` | `string` | 此分支点出现的事件 ID |
| `description` | `string` | 分支情境的叙述描述 |
| `choices` | `BranchChoice[]` | 读者可用的选项列表 |
| `defaultBranch` | `string`（可选） | 未做选择时的默认 `choiceId` |
| `existenceCondition` | `BranchSet` | 此分支点在当前路径中是否可见 |

### BranchChoice

| 字段 | 类型 | 描述 |
|---|---|---|
| `choiceId` | `string` | 此选项的唯一标识符 |
| `label` | `string` | 显示给读者的标签 |
| `condition` | `Condition`（可选） | 使此选项可用的额外条件 |
| `narrativeOrder` | `number` | 选项在分支点中的排序 |

### BranchPoint 示例（YAML 片段）

```yaml
branchPointId: bp_luchen_choice
atEventId: E0
description: "祥林嫂被婆家带走后，鲁四老爷面临选择"
defaultBranch: stay_out
existenceCondition:
  type: all
choices:
  - choiceId: intervene
    label: "出面干预"
    narrativeOrder: 1
    condition:
      type: equals
      field: "decisions.0.choiceId"
      value: "protect_reputation"
  - choiceId: stay_out
    label: "置身事外"
    narrativeOrder: 2
```

## 无效示例

```yaml
# BranchSet 的 type 必须是合法值之一
existenceCondition:
  type: maybe               # 错误：'all' | 'paths' | 'condition' | 'except' 之一

# 缺少 condition.type
existenceCondition:
  type: condition
  condition:                # 错误：缺少 type 字段
    field: "decisions.0.choiceId"
    value: "trust"

# BranchPath 中缺少 required 字段的决策
decisions:
  - atEventId: E0           # 错误：缺少 choiceId 和 narrativeOrder
```

**预期错误：** 类型不匹配导致的 TypeScript 编译错误或运行时验证错误——`BranchSet.type` 必须是四字面量联合类型之一；`Condition` 缺少 `type` 会导致评估失败。

## 规范化 IR

编译器将 BranchSet/BranchPath 结构作为纯 TypeScript 接口内联使用（非独立 YAML 定义）。无单独的文件加载或 Zod schema 验证——BranchSet 和 BranchPath 对象嵌入在事件文件中的 `existenceCondition`、`branchPoint` 和运行时状态中的 `currentBranchPath` 字段中。

- `BranchPath` 通过 `createEmptyBranchPath()` 初始化为 `{ decisions: [] }`（线性叙事）。
- `BranchSet` 由 `includesPath()` 解释，后者委托给 `evaluateCondition()` 进行条件评估。
- `getAvailableChoices()` 过滤 `BranchChoice[]`，返回满足条件（或无条件的）选项。
- 分支点定义在事件 YAML 中，作为事件级别 `branchPoint` 字段的一部分；运行时路径在 `WorldState.currentBranchPath` 中追踪。

## 生命周期

分支路径不是独立的实体——它们是运行时叙事状态的一部分：

- **初始化：** 每个故事从线性分支路径开始（`{ decisions: [] }`）。
- **分支决策：** 当场景包含一个分支点时，渲染引擎评估 `existenceCondition`（通过 `includesPath`）以确定哪些分支点可见，然后 `getAvailableChoices` 确定哪些选项可用。
- **路径记录：** 当做出选择时，一个包含 `{ atEventId, choiceId, narrativeOrder }` 的新决策条目被追加到当前分支路径的 `decisions` 数组中。
- **场景过滤：** `filterScenesByBranchPath()` 使用 `includesPath` 确定哪些场景包含在当前路径中——仅在场景的 `BranchSet` 包含当前路径时场景才可见。
