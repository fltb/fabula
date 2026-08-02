# 分支游戏对话：EventFile `choices` 合同

每个 `E*.yaml` 都可以直接声明玩家选择。系统把这些选择编译为严格的 rooted tree；
选择后果不是 prose 推断，而是 canonical replay 中的 synthetic transition event。

```yaml
event: E0
narrativeOrder: 0
title: "The offer"
storyTime: day_0
pov:
  character: narrator
  type: omniscient
sceneBrief: "The player receives an offer."
beats:
  - "The player receives an offer that changes the route."
preconditions: []
expectedPostconditions: []
choices:
  - id: accept_hunt
    label: "Accept the hunt"
    description: "Enter the jungle with a knife and three hours' head start."
    targetEvent: E1a
    effects:
      - entity: hero
        attribute: chose_hunt
        value: true
```

## Authoring 合同

- `choices` 是可选字段；没有它的 event 是终端节点。
- 显式 `choices` 必须非空，且同一个 event 内 `id` 唯一。choice object 是 strict：只接受
  `id`、`label`、`description`、`targetEvent`、`effects`。
- `effects` 默认 `[]`，并复用 `expectedPostconditions` 的 Fact 合同：只能是 `value`、
  `operation: unset`，或 `narrativeHint` 三种互斥形式之一。
- `targetEvent` 必须存在且不能指向自身；仅当目标在同一条 story clock 上被证明早于
decision event 时才拒绝——坐标相等、未定位（unlocated）和跨 clock 的转移均允许。
- 图必须是一个树：恰好一个 root、每个非 root 恰好一个 incoming choice、全部 event 可达、
  不允许 self edge、cycle 或收敛（多个 choice 指向同一 event）。
- `branchPoint`、`branches.yaml`、`branches/branch_points.yaml`、snake_case alias、string
  `condition` 都不是输入合同；strict schema 会拒绝 EventFile 内的 legacy key，外部 legacy
  文件不会被 loader 读取。

## 编译与 replay

`compileGameDialogueTree()` 为每个 terminal route 生成完整 `BranchPath`。root 取得
`{ type: 'all' }`；其他 event 与普通 pre/post Fact 使用其 descendant leaf paths 作为
`BranchSet`。这很重要：`includesPath()` 的 `paths` 是**完整 path 的精确匹配**，不是 prefix。

每个 choice 会产生 `system:branch-choice:<eventId>:<choiceId>` transition event：它显式依赖
trigger event、在 choice descendant scope 应用 `effects`，并成为 target event 的
`causalPredecessors`。因此 `compileStoryBoundaries()` 和 `ReplayEngine` 保持唯一的状态
实现；系统不会创建 choice reducer 或 `WorldState.currentBranchPath`。

`compileNarrativeGraphs()`（`state/graph-adapter.ts`）在选择具体 `BranchPath` 后验证 explicit
predecessor：`causalPredecessors` 必须是该 branch 上可达的 event，否则抛出带
`narrative-graphs` phase 的 `ConfigError`（`game-dialogue-tree.test.ts` 对未知或 branch 排除的
predecessor 明确断言 `ConfigError`）。普通 Fact provider 也独立按每个 Fact 的
`validity.branches` 过滤，不能因为 event 本身可见而跨 lane 提供状态。

## 渲染与交付

- `renderNovel({ branchPath })` 的 `branchPathV1Schema` 只校验形状；
  `executeEditorialRender()` 也只检查 `branchPath` 是否缺失，并不把提供的 path 与编译后的
  `tree.leafPaths` 比对。因此 truthy 的空 path、prefix、未知 choice 或乱序 path 都能通过
  preflight，之后只会经 `includesPath()` 选出部分 event（空 decisions 的 path 仅匹配
  `type: 'all'` 的 root）。精确的完整 leaf path 校验仅由 CLI 的 `requireCompleteGameLeaf()`
  （`nova assemble`）执行。它只渲染该 route 的 authored EventFile；matching transition 只参与
  state replay。
- `renderGameDialogueTree()` 枚举每条 leaf route，为每条 route 唯一解析 discourse branch，
  并按 `(eventId, discourseBranch)` 去重——同一 discourse branch 下的共享节点（例如 root）
  只渲染一次；每个 content event 都必须有 representative path。它拒绝配置了 `renderSurface`
  的项目。注意：`allRenderJobs`、`decisions`、`revisionIds`、`resultByEventId` 以及
  `assembleGameDialogueTree()` 都只按 `eventId` 存储结果，因此同一 event 在不同 leaf route
  解析出不同 discourse branch 时，后一次结果会覆盖前一次，每个 event 只能交付一份散文——
  逐 branch 交付尚未实现。
- decision scene 的 raw Pass 1 prose / Pass 2 analysis 从不含 choices。接受后系统在 `.md`
  末尾追加 `<!-- FABULA:PLAYER_CHOICES:v1 -->` YAML block，并把完整 structured choices 写入
  scene metadata。
- 全树只有所有 node 都 accepted 时才写 `output/dialogue-tree.md`。它按 root-to-leaf preorder
  组织节点，并为每个 choice 生成到 target 的 Markdown anchor。全树渲染绝不写
  `output/novel.md`；`assembleNovel({ branchPath })` 仍用于选定 route 或线性项目。

## API、CLI 与 fixture

- API：`renderGameDialogueTree(request, runtime?)`；`RenderGameDialogueTreeRequestV1` 不接受
  `eventId`、`branchPath` 或 `discourseBranch`（strict schema 拒绝未知键）。
- CLI：`nova render-tree` 渲染整棵树；`nova render ... --branch-path '<json>'` 和
  `nova assemble --branch-path '<json>'` 使用 exact `BranchPath` JSON。
- MCP：`nova_render_tree`，以及带可选 `branchPath` 的 `nova_render`、`nova_render_scene`、
  `nova_assemble`。MCP 不维护 branch session；每个调用必须自带 path。
- 端到端 authoring contract：`fixtures/game-dialogue-tree/`。

## discourse branch

`definitions/discourse-ledger.yaml` 的 `entries[].branch` 仍是 disclosure projection label，
不是 story `BranchPath`。选定 route 保留原有 discourse 规则；全树 render 不为整棵树使用单一
`discourseBranch`——每条 leaf route 独立解析自己的 branch，共享节点按 `(eventId, discourseBranch)`
去重。但渲染结果只按 `eventId` 归档（jobs、decisions、revisions、assembly 均如此），同一
event 跨 route 解析出不同 branch 时只能保留一份结果，尚无逐 branch 交付。
