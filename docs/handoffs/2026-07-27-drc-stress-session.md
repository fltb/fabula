# Handoff — 技术债清偿 + 表达力接线 + Plugin 激活 + 红楼梦场景级压测（第一轮）

> **时间**: 2026-07-27 08:25 CST
> **计划**: 本 session 执行已批准计划《技术债清偿 + 架构表达力验证 + Plugin 接线 + 红楼梦场景级压测》（WS1-WS4）
> **本次提交**: `7c8e0f2`（WS1）→ `05d0a1f`（WS2）→ `f02cfe7`（WS3）→ WS4 fixture/脚本 commit（见 git log 尾部）

## 已完成（有门禁证据）

### WS1 — 基线测试债清零
- `bench.test.ts` / `integration.test.ts` 旧仓库绝对路径 → `__dirname` 相对；`debug.test.ts` 删除；`rainsford_whitney.yaml` 补 `id`。
- 门禁：非 e2e 全量 **15 failed → 0 failed**（提交时 118 文件/1995 用例，收尾复跑 120 文件/2001 用例全绿）。

### WS2 — 表达力接线（9 缺口 + 3 卫生 + 回归锁 + 审计）
- 9 个接线缺口全部修复：characterVoice、styleGuidance.avoid、emotionalValence、synopsis、emotionalArc beat、threadProgress.advancement、cast.onScreen 并入 snapshots、introduces 自动注册、新字段 `authorNotes: string[]`（纯透传）。
- Prompt 卫生：JSON blob 剔除重复 `markdown` 字段（~15-20% token）；恒空 `unknownFacts`/`unresolvedTensions` 类型级删除；Pass 1 增加 `## World Rules` 区块。
- 回归锁：`packages/core/tests/pipeline/expressiveness.test.ts`（每字段哨兵入 Pass 1 prompt + validator 消费表驱动断言）。
- 审计报告：`docs/report/expressiveness-audit.md`（字段去向矩阵 + 29 项叙事技巧表达路径矩阵）。
- Live 实证：zhu-fu 临时副本 E0 + authorNotes 指令"必须出现琉璃灯三字" → DeepSeek 渲染稿中 `琉璃灯` 出现 1 次（透传全链路打通）。mock-pass2 渲染 7/7 released 不回归。

### WS3 — Plugin 系统激活
- `PluginLoader.loadFromDirectory` 动态 ESM import（返回 `PluginHooks[]`）；`ProjectConfig.plugins` + zod schema；`api.ts initializePlugins()` 接入 renderNovel + validateNovel（冲突硬中止）；`validateNovel` 转 async（CLI/MCP 调用方全部 await，无同步别名）；CLI validate 非零退出码 + `[validator]` 归因。
- fixture `fixtures/zhu-fu-variants/plugin-check/`（valence-guard 插件 + E1 缺 emotionalValence 靶子）。
- 实证：CLI validate → `❌ ERROR [valence-guard] … E1`，退出码 1；补回 valence → 全过退出码 0（已还原缺失态）。
- 门禁：plugin 全套 + activation 测试 49 用例绿。

### WS4 — 红楼梦场景级压测（结构完成，live 第一轮已跑，指标未产出）
- 语料：Gutenberg #24264 → `bench-data/corpus/dream-of-red-chamber/source.txt`（80 回，fail-closed 不变量校验：1-80 各一次/升序/无重叠/表头逐字节匹配/最小字数）。修复了 acquire 脚本三处 bug：回目正则吞换行、邻接区间误判 overlap、标题与原文字节不一致。**manifest 已独立复核**（80 区间连续、编号与表头一致）。
- fixture 重建：旧 20 个回目级事件删除；36 个场景级事件（4 章）+ shuoshuren 说书人 narrator + 10 个补充角色 + `stone_myth: day -2000` 锚。S6 维度覆盖（E07/E08/E36 dream+prolepsis 等）、authorNotes ≥5 事件、E36 故意 narrativeOrder/storyTime 倒错。
- 36 个 `reference/original/*.txt` 均为 source.txt 逐字节子串（独立复核通过，890-1998 汉字）。
- 结构门禁：`validate` → **0 errors**（692 warnings 为 hint 前提软信号，符合设计）。
- 压测脚本 `scripts/drc-stress-report.mjs`（子串防伪 + bigram containment + --stability）。

## 关键发现（本压测的核心信号，未修复——按 review 裁定留作后续提案）

**Live 第一轮（deepseek-v4-flash，36 场景，约 40 分钟）：36/36 场景 Pass 1 均产出散文（962-5059 词），但 release gate 全部拒绝。**

- 根因链：36 事件的 hint 型 precondition（本 session 按 DAG provider 规则从确定性 value 转换而来，共 119 条）→ Pass 2 `narrativeChecks` 大量未覆盖 → `DeferredResolver`（`packages/core/src/validator/deferred-resolver.ts:51-58`）把 **absent/missing 一律记 error** → 每场景 6-9 个 error → 全部 unreleased。
- 链路本身工作正常的证据：E33 出现真实矛盾捕获（"前提要求探春对抄检浑然不觉，但散文显示她已提前得知"）——contradicted 判定有效。
- 连带观察：`.nova/responses/{id}.json`（"full raw LLM response"）实际只在 release 通过时由 `buildAndWriteOutputs` 写盘（`packages/core/src/api.ts` release gate 分支）→ 拒绝时散文不落盘 → 压测报告 containment 全 N/A。`.nova/dry-runs/{id}_prompt.md` 也是文档承诺但无写入者（MCP reader 读空）。
- 第一轮报告（36 行、EXCERPT_INVALID=0、渲染列全 N/A）：`fixtures/dream-of-red-chamber/output/stress-report.md`（output/ 被 gitignore，永久副本在 `docs/report/drc-stress-report-run1.md`）。

## 下一步（需要决策，按序建议）

1. **观测性修复（建议先做，非语义变更）**：`.nova/responses` 改为无论 release 与否都写盘（或新增 `.nova/rejected/`），使压测在 gate 拒绝时仍可测 containment。同时补上 `.nova/dry-runs/{id}_prompt.md` 的缺失写入者。
2. **DeferredResolver 严重度提案（需批准，全局语义变更）**：precondition 的 hint 检查 `contradicted` 保持 error；`absent`/缺失降为 warning（前提是"先前语境"，散文无义务复述）。postcondition/narrativeChecks 语义不变。附带更新 `deferred-resolver.test.ts` 两处 error 期望。
3. 以上任一落地后重跑 live（约 80 次调用）+ 稳定性 3×3（E05/E21/E25）→ 报告补齐 containment 与稳定性节。
4. `docs/todos/stage-3.md` 的 C1（live drc run）在 gate 语义决策后才能真正闭环。

## 验证命令

```bash
npm run typecheck                              # 干净
npx vitest run --exclude '**/e2e.test.ts'      # 120 files / 2001 tests 全绿
cd fixtures/dream-of-red-chamber && node ../../packages/cli/dist/index.js validate   # 0 errors
cd fixtures/zhu-fu-variants/plugin-check && node ../../../packages/cli/dist/index.js validate; echo $?  # valence-guard error, exit 1
node scripts/acquire-dream-of-red-chamber.mjs  # 用 bench-data/corpus/.cache 断点，全不变量 PASS
node scripts/drc-stress-report.mjs fixtures/dream-of-red-chamber
```

## 边界与未动项

- 第一轮未改 validator 语义；continuation 已批准并落地 DeferredResolver 校准（`contradicted`=error，`absent`/missing precondition hints=warning），见下文。
- `docs/todos/annotation.md`（C2/C3 人工标注）未动。
- `bench-data/`、`fixtures/*/output/`、`.nova/` 均 gitignore，不入库；语料由 acquire 脚本可重现（含 .cache 断点）。

## Continuation — 2026-07-27 13:51 CST

### Approved calibration and observability changes

- `DeferredResolver` now preserves `contradicted` as an error while treating `absent` and missing Pass-2 coverage for **precondition** `narrativeHint` as warnings. This distinguishes an active prose contradiction from a scene not restating prior context.
- Raw response persistence now happens inside `RenderPipeline.renderScene()` for both fresh and cache-hit results, before return. Payloads carry `validation`、`needsReview`、`attempts`、`released` and `pass2Rejection`; API/output writers preserve the same shape rather than overwriting it.
- Dry-run writes the actual Pass-1 prompt to `.nova/dry-runs/{eventId}_prompt.md`.
- `drc-stress-report.mjs` supports absolute fixture/stability paths, actual nested scene output (`scenes/chapter-NN/`), response fallback, conservative release reporting, and stability fallback. New deterministic tests cover all of these paths.

### Measured rerun

 - Full DRC cache-resume/replay produced 36 complete response payloads: **35 released**, E01 rejected (`released=false`, `needsReview=true`, `attempts=6`). **Pre-fix caveat:** This rejection was the conflict resolution-type validation bug — `resolutionType: setup` (E01 is `person_vs_fate` with opening-setup prose, `resolutionAchieved: false`) was incorrectly classified by ConflictValidator as requiring resolution. The prose was appropriate for its role; the rejection was a false-positive bug, not a genuine prose conflict failure. Metrics below are pre-fix evidence.
- Stability samples: E05/E21/E25 × 3, every logged `cache=false` after its event cache was explicitly removed. Nine payload hashes differ; the combined stability report records **9 pairwise comparisons**, mean containment **37.7%**: `docs/report/drc-stress-report-final.md`.
- Intermediate stability scene artifacts were isolated before regenerating the canonical output; final batch metrics are response-backed (`With render(scene)=0`, `With response fallback=36`), not contaminated by single-event smoke outputs.

### Final verification

```bash
npm run typecheck
npx vitest run --exclude '**/e2e.test.ts' # 122 files / 2003 tests
cd fixtures/dream-of-red-chamber && node ../../packages/cli/dist/index.js validate # 0 errors
node scripts/drc-stress-report.mjs fixtures/dream-of-red-chamber \
  --stability fixtures/dream-of-red-chamber/output/stability/all/run1,fixtures/dream-of-red-chamber/output/stability/all/run2,fixtures/dream-of-red-chamber/output/stability/all/run3
```

### Operating rule

No unchanged timeout retry. Before any retry after timeout/failure, make and record a material change to code, configuration, input, or recovery strategy. Stability samples are distinct measurements: they clear the corresponding event cache and write to unique run directories.

### Post-fix complete assembly — 2026-07-27 14:15 CST

- `ConflictValidator` 已将 `setup` 与 `ongoing` 归入非收束类型；E01 的 Pass 2 `primaryType: person_vs_fate` / `resolutionAchieved: false` 现被正确接受。
- 完整命令 `node ../../packages/cli/dist/index.js render E01 --all --model deepseek-v4-flash` 退出码 0：36 个场景全部 materialize（36 `.md`、36 metadata、36 render request），并生成 `fixtures/dream-of-red-chamber/output/novel.md`（236,081 bytes，2,022 lines）。
- 后修复报告 `docs/report/drc-stress-report-final.md`：36 scene-backed prose、36 release、`EXCERPT_INVALID=0`；历史 run2/stability 报告已标记为 pre-fix，不再表达最终 E01 release 状态。

