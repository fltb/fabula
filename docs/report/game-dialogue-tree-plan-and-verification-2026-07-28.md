# 游戏对话树方案与测试方法报告

> **时间**: 2026-07-28 10:47 CST

> **方案来源**: `local://branch-support-plan.md`（已批准的 authoritative plan）
> **执行范围**: Plan-approved 5 个阶段 + 端到端验证
> **方法**: 直接源码 + 真实 mock provider 全链路运行，不依赖文档自我陈述

---

## 一、方案目标（来自 plan）

把分支能力从"程序构造的 BranchPath primitive"提升为 **authoring-level**：

- 每个 `E*.yaml` 直接声明玩家 choice、目标 scene、选择后果。
- 编译期保证严格 rooted tree（单 root、无 cycle、无 merge、严格时序、不可达节点、缺 target → 失败）。
- 渲染期把 decision scene 的 choice 文本以 deterministic YAML block 写入交付文档，prose 始终来自 LLM。
- 旧 `branches.yaml` / `branches/branch_points.yaml` / `branchPoint` / snake_case alias 全部不进入合同。

## 二、方案与代码对照（plan 5 阶段）

| 阶段 | 计划落点 | 实现文件 / 锚点 | 备注 |
|---|---|---|---|
| 1. EventFile choices 合同 | `types/game-dialogue.ts`、`schemas/game-dialogue.ts`、`eventFileSchema.strict()` | `packages/core/src/types/game-dialogue.ts:1-20`、`schemas/game-dialogue.ts:1-46`、`schemas/event.ts:51`（`choices: gameDialogueChoicesSchema.optional()`） | strict + unique ID 在 Zod 阶段完成，duplicate / snake_case / `branchPoint` 写入被严格拒绝；mapper 只新增 `eventFile.choices` 透传，linear project byte-for-byte 等价 |
| 2. 编译 rooted tree | `compileGameDialogueTree()` 输出 `leafPaths / eventScopes / representativePath / transitionEvents / choicesByEventId` | `packages/core/src/branch/game-dialogue-tree.ts:99-258` | root 固定 `{ type: 'all' }`；其余 event 与普通 Fact 取 descendant leaf `BranchSet`（exact path，非 prefix）；transition 事件以 `system:branch-choice:<event>:<choice>` 命名并加入 `causalPredecessors: [eventId]` |
| 2. mapper 集成 + 因果边 | `EntityMapper.loadAllEvents()` 编译 tree 并在 final mapping 前应用 scope | `packages/core/src/entity/mapper.ts:318-322,329-359` | tree scope 写入 authored event 的 `branchExistence` 与每条 Fact 的 `validity.branches`；transition 事件附到对应 target 的 `causalPredecessors` |
| 3. 因果边分支校验 | `buildCausalEdges()` 验证 explicit predecessor 必须在 selected branch 内、且 Fact scope 独立过滤 | `packages/core/src/state/dag.ts:29-124` | unknown / 非选中 predecessor → `DagProviderError`；Fact 写入 / 读取也按 `fact.validity.branches` 单独过滤；`applyInitialFacts` 加 `branchPath` 参数 |
| 3. renderNovel 选线 | selected route 渲染、empty/prefix/未知 path 早期 fail | `packages/core/src/api.ts:845-866` | pre-flight 拒绝非 leaf path；render jobs 只含 `event_file` source；`applyInitialFacts(state, initialFacts, { branchPath })` 保持 canonical replay |
| 4. 全树渲染 + 选择文本嵌入 | `renderGameDialogueTree()` 一次遍历全节点、`output/dialogue-tree.md` 组装；`buildAndWriteOutputs()` 追加 `<!-- FABULA:PLAYER_CHOICES:v1 -->` block | `packages/core/src/api.ts:1522-1610`、`assembler/game-dialogue-tree.ts:1-105`、`pipeline/output.ts:33-57,199-213` | decision scene 的 raw Pass 1 prose / Pass 2 / response artifact 不含 choices；only accepted `.md` 含；metadata 持久化 structured choices |
| 4. 决策指令 | `PromptAssembler` 收到 `gameDialogue` 时输出 "End this scene at the decision beat. ... The system will append the YAML-authored choices" | `packages/core/src/context/prompt-assembler.ts:77-79,279-286` | LLM 不写 choice list |
| 5. CLI / MCP / 文档 | `nova render-tree`、`--branch-path` JSON、`mcpNovaRenderTree`、fixtures、API/CLI/wiring/yaml 文档更新 | `packages/cli/src/index.ts:51-100,385-396,604-660,699-757`、`mcp-server.ts:8-38,210-271,370-415,562-569`、`fixtures/game-dialogue-tree/*`、`docs/reference/yaml-format/branch.md`、`docs/reference/api.md`、`docs/reference/cli.md`、`docs/reference/wiring.md`、`docs/reference/state-management.md`、`docs/reference/competitive-analysis.md`、`public-api.manifest.json` | CLI/MCP 拒绝 surface scheduling 与非 main discourse ledger；invalid JSON / 非 leaf path 非零退出 |

## 三、测试方法（plan 5 阶段 + Verification）

### 3.1 单元 / 集成测试（Vitest，in-process）

| 测试文件 | 覆盖 | 关键断言 |
|---|---|---|
| `packages/core/tests/branch/game-dialogue-tree.test.ts` | strict Zod contract、tree 编译、事件与 Fact scope、synthetic transition、跨 leaf replay 字节一致、invalid graph 失败 | 6 个 invalid case（missing target、self edge、two parents、unreachable、cycle、non-increasing storyTime）全部抛错；`rejected legacy` 验证 `target_event` 与 `branchPoint` 写入失败 |
| `packages/core/tests/pipeline/game-dialogue-tree-render.test.ts` | `MemoryStorage + MockPass2Provider` 全链路 | `renderGameDialogueTree()` 每个节点 render 一次；`E0.md` 含完整 `FABULA:PLAYER_CHOICES:v1` block 且 `id/label/description/targetEvent` 与 YAML 严格一致；response `E0.json` raw prose 不含 block；`output/dialogue-tree.md` 含 `<a id="event-...">` + `[Accept the hunt](#event-E1a)`；`output/novel.md` 不存在；`--branch-path '{decisions:[...]}'` accept / refuse 各自的 `stateBefore`；invalid path 不调用 provider；修改 label 触发 cache invalidation |
| `packages/core/tests/branch.test.ts` + `branch/diamond.test.ts` | 既有 BranchSet / `includesPath()` 行为 | unchanged 仍 pass |
| `packages/cli/tests/render-tree.test.ts` | built CLI smoke | `nova render-tree --provider mock-pass2 --reference-dir ...` 退出 0；`output/dialogue-tree.md` 含 block + 锚；`output/novel.md` 不存在；invalid JSON / non-leaf path 退出 1 + stderr |
| `packages/cli/tests/mcp-game-dialogue-tree.test.ts` | built MCP handlers | `mcpNovaRenderTree` 返回 tree + results + `choicesByEventId` + dialogueTree 文本；`mcpNovaRender(...,branchPath)` 写入 dry-run；`mcpNovaAssemble` 过滤后 sceneCount=2；`createMCPServer` 注册 `nova_render_tree` |

**运行结果**：

```text
$ npx vitest run packages/core/tests/branch/game-dialogue-tree.test.ts \
    packages/core/tests/pipeline/game-dialogue-tree-render.test.ts \
    packages/core/tests/branch.test.ts \
    packages/core/tests/branch/diamond.test.ts \
    packages/cli/tests/render-tree.test.ts \
    packages/cli/tests/mcp-game-dialogue-tree.test.ts

 Test Files  6 passed (6)
      Tests  52 passed (52)
   Duration  958ms
```

### 3.2 全套非 E2E 测试

```text
$ npx vitest run --exclude '**/e2e.test.ts'

 Test Files  135 passed (135)
      Tests  2285 passed (2285)
   Duration  38.45s
```

### 3.3 类型与构建

```text
$ npm run typecheck        # tsc -b core bench cli  → 0 error
$ npm run build            # tsc -b + esbuild core/bench/cli → 0 error
$ node scripts/check-public-api.mjs
  ✅ Public API manifest checks passed
```

### 3.4 端到端真实运行（built CLI + committed fixture）

```js
// eval cell on 2026-07-28
const root = process.cwd();
const project = await mkdtemp(join(tmpdir(), 'nova-game-dialogue-smoke-'));
await cp(join(root, 'fixtures', 'game-dialogue-tree'), project, { recursive: true });
const proc = Bun.spawn({ cmd: [process.execPath, 'packages/cli/dist/index.js',
  'render-tree', '--provider', 'mock-pass2',
  '--reference-dir', join(project, 'reference/data')],
  cwd: project, stdout: 'pipe', stderr: 'pipe' });
const [exitCode, stdout, stderr] = await Promise.all([proc.exited, ...]);
assert exitCode === 0
const dialogueTree = await readFile(join(project, 'output', 'dialogue-tree.md'), 'utf8');
assert dialogueTree.includes('<!-- FABULA:PLAYER_CHOICES:v1 -->');
assert !(await Bun.file(join(project, 'output', 'novel.md')).exists());
```

**观察到的真实输出**：

- `exitCode: 0`
- 3 个 `##` section（E0、E1a、E1b）
- `dialogue-tree.md` 包含 deterministic YAML choice block
- `output/novel.md` **不存在**（全树渲染不写它）

### 3.5 Lint

`npm run lint` 在受影响的 3 个 feature 文件上 **0 diagnostics**；仓库范围仍有 20 个陈年 diagnostics（bench scripts/tests、AI provider/tooling、assembler/concatenator），与本方案无关。

## 四、风险与回归观察

- `assembler/novel.ts` 把 branch-path filter 移到 `narrativeOrder` 重复检查之前；保证 `assembleNovel({ branchPath: selectRoute })` 不会因 route 过滤后被现有 `DUPLICATE_NARRATIVE_ORDER` 误判。
- `eventFileSchema.strict()` 拒绝 `branchPoint` / `target_event`，所以 `fixtures/most-dangerous-game/chapters/chapter_02/branches.yaml`（历史 fixture）从未被当前 mapper 加载，仍然是 unparsed legacy。
- 完整树渲染拒绝 `renderSurface` 与非 `main` discourse label，并在 pre-flight 提前 fail；不在 cache / prompt / provider 阶段做折扣。
- `ReplayEngine` 与 `compileStoryBoundaries` 仍是唯一 state 实现；transition event 与 `causalPredecessors` 是它们内部的添加，不引入 choice reducer 或 `WorldState.currentBranchPath`。
- DAG 校验对 `lanes: [a] writer` + `lanes: [b] reader` 仍抛 `DagProviderError`：验证覆盖 `tests/branch/game-dialogue-tree.test.ts:341-379`；不会被 event 自身可见而意外通过。

## 五、完整度结论

- Plan 5 阶段：100% 实施。
- 端到端 fixture + 真实 LLM（mock provider） smoke：✅ 退出 0、choice block 嵌入、dialogue tree 写盘、selected-route 渲染隔离、invalid path 不调 provider。
- 公共 API manifest、typecheck、build、非 E2E 全套 135 文件 / 2285 测试：✅。
- 文档与 fixture 已同步：CLI/API/wiring/yaml/state/competitive 全部更新；新增 `fixtures/game-dialogue-tree/` 是端到端 contract test。
