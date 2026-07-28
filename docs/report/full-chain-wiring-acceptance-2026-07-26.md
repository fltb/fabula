# 全链路接线完成报告 — 死类型缺口闭合

> **时间**: 2026-07-26 22:21 CST
> **时间**: 2026-07-26 22:07 CST
> **前置**: `docs/report/ir-completeness-and-fullchain-verification-2026-07-26.md`（上一会话审计发现的两类"死类型"模式 + `api.ts:406` 硬回退 bug）
> **目标**: YAML → EntityMapper/StateManager → ContextCompiler → RenderPipeline Pass1+Pass2 → validators → Assembler 全链路真实接通。质量评分（C2/C3 人工标注、dream-of-red-chamber 20 事件实测）明确不在本次范围。
> **改动规模**: 18 个文件修改（+237/-21）、17 个新文件（6 validator + 8 测试文件 + 4 fixture YAML，其中 1 个新目录内含 2 个 assertion 文件）

---

## 一、逐阶段交付与证据

### Phase 0 — 模型解析硬回退修复（用户直接点名）

`api.ts` 的 `renderNovel()` 原本在 `--model`、`nova.yaml defaultModel`、`NOVALISTICALLY_AI_MODEL` 三个来源全部为空时静默回退到一个不存在的 Claude 模型名（上一会话 "1 words, cache=false" 故障的根因）。现改为硬错误，模式与 5 行之后的 missing-API-key 分支完全一致。

**证据**: zhu-fu 临时副本删除 `defaultModel` 后运行 → `❌ No model configured. Set --model, nova.yaml "defaultModel", or the NOVALISTICALLY_AI_MODEL environment variable.`，exit 1，零网络调用。

### Phase 1 — `render --all` 实时逐事件进度

- `EventMap` 的 `pipeline:render:after` 载荷扩为 `{ eventId, durationMs, wordCount, cacheHit, success, errorCount }`（`event-bus.ts:14`）。
- `renderScene()` 冷路径与**缓存命中路径都发射**该事件（`render.ts:233-240` 缓存命中提前返回处、`render.ts:558-565` 正常完成处）——缓存路径是验证时补上的：载荷里有 `cacheHit` 字段但热跑一行不打，等于设计意图没兑现。
- `RenderNovelOptions.eventBus?` 穿透到 `RenderPipeline`；CLI 注册监听器把 `✓/·` 行打到 **stderr**（`console.error`），stdout 的 `✅/❌` 汇总一字未动。

**证据**:
- 冷跑（mock-pass2）：stderr 7 行 `✓ E0: 436 words, cache=false` …；stdout `✅ E` 计数仍恰好 7（`render-full-chain.test.ts` 的 `toHaveLength(7)` 断言绿）。
- 热跑（同目录二次运行）：stderr 7 行 `cache=true`，stdout 计数不变。
- 真实 LLM 跑：`✓`/`·` 实时出现（E1 因有错误正确打 `·` 而非 `✓`）。

### Phase 1b — 常开 warn/error 日志（用户直接点名："修日志系统本身"）

根因有二，都已修：
1. `Logger` 只在 `--trace` 时构造 → 现**无条件构造**，无 `--trace` 时套 `LevelFilterTransport`（warn 以上直通 stderr，info/debug 静默；`--trace` 行为与旧版逐字节一致）。
2. 真实失败点从不调用 `.warn()/.error()` → 现四处全补：Pass 1 空散文（warn）、Pass 1 catch（error）、Pass 2 exhausted 分支（warn，日志文本与推给 CLI 的 `errors[]` 逐字相同）、Pass 2 catch（error）。`permittedField` 白名单补入 `phase`/`rejection`。

**证据**（即 Bug-1 场景复演）: 不带 `--trace`，故意传错模型名 →
```json
{"level":"error","message":"ai-sdk error: The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed nonexistent-model-xyz.","context":{"module":"render","eventId":"E0","attempts":1,"phase":"pass1"}}
```
真实失败原因结构化可见，不再需要手改 `ai-sdk.ts` 加临时 `console.error`。真实 LLM 跑中还顺带实时捕获了 E1 两次空散文重试的 warn 行——非人为构造的自然验证。

### Phase 2 — S6 Genette 五维度 validator（上次审计判死的"5/5 ✅"假结论，本次真做）

新增 5 个 validator（并行 subagent 产出，模板复制 `tense-consistency.ts`）：

| 维度 | 文件 | Pass 2 字段 | validatePre 检查 |
|---|---|---|---|
| Duration | `validator/duration-consistency.ts` | `durationDetected` (5 枚举) | ellipsis 必须带 `ellipsisClarity` |
| Frequency | `validator/frequency-consistency.ts` | `frequencyDetected` (3 枚举) | repeating/iterative 必须带 `iterationScope` |
| Voice | `validator/voice-consistency.ts` | `voiceDetected` {level, relation} | 无（逐子字段各报一条 issue） |
| Anachrony | `validator/anachrony-consistency.ts` | `anachronyDetected` (含新增 `'none'` 字面量) | analepsis/prolepsis 必须带 `distance` |
| Focalization | `validator/focalization-consistency.ts` | `focalizationDetected` (3 枚举) | internal+multiple 必须 `characterSequence≥2` |

全部 `category: 'narrative_style'`、`name: '{dimension}_consistency'`，注册于 `validator/index.ts`（barrel + `analysisContentSchema`）、`aggregator.ts` 构造器（validator 总数 20→26）、core barrel `index.ts`。每个 validator 配套独立测试文件（match/mismatch/analysis-null 三段式）。

### Phase 3 — Idea IR `thematicIntent` 抵达 Pass 1 prompt

`SystemContext.thematicIntent?: ThematicIntent`（复用 `types/idea-ir.ts` 类型，非内联复制）→ `api.ts` 从 `data.config?.ideaIR?.thematicIntent` 填充 → `prompt-assembler.ts` 渲染 `## Thematic Intent` 区块（主题 + 子题列表，presence-guard，无 ideaIR 时零泄漏）。zhu-fu 的"封建礼教吃掉个体"主题声明自此真实进入每次 Pass 1 请求。

### Phase 4 — Discourse/Syuzhet 层接线（已建成引擎第一次通电）

范围决策照计划：**纯确定性结构检查**（`replayDiscourseState()` 是否抛约束违例），不做 LLM 评判的"散文里真披露了吗"——那是质量评分领域。

- `ProjectData` 新增 `narratorProfiles`（原本困在 `EntityMapper` 私有字段里从未返回）、`discourseLedger`、`narratorAssertions`；mapper 从 `definitions/discourse-ledger.yaml`（`optional: true`）和 `definitions/assertions/` 加载。
- `ContextPackage` 新增 `narratorProfile?`/`discourseReplayError?`；`ContextCompiler.compile()` 解析 `narratorProfileRef` 并对事件位置回放 ledger（位置钳制到 `entries.length`，分支标签经 `discourseBranch?` 选项、默认 `'main'`）。
- `PostRenderInput.context?: ContextPackage` + `validateRender()` 第 8 参穿透（render.ts 两处调用点同步）。
- `## Narrator` prompt 区块（type/fidelity/sincerity）。
- 新 `DiscourseValidator`：narratorProfileRef 解析失败 → error；`discourseReplayError` → error。
- fixture：`narrators/narrator_wo.yaml`（retrospective_entity，"我"）、`discourse-ledger.yaml`（E0 的 reveal 死讯 + claim 灵魂存疑，直接编码原文既有内容）、两个 assertion 文件、E0 加 `narratorProfileRef: narrator_wo`。

**证据**: `tests/entity/discourse-wiring.test.ts` 全绿——真实 fixture 经 `EntityMapper.loadProject()` → `compile()`，narrator 解析成功、回放零错误；坏 ledger（重复 discoursePosition）正确浮出 `DuplicateDiscoursePositionError`。回放引擎从"只有自己的测试文件可达"变为"真实加载路径可达"。

---

## 二、计划外的实质发现（全部由验证门捕获，非文档推断）

1. **mapper 静默丢弃所有 S6 字段 + S1/S4 字段（根因级缺口，计划没写）**。`mapToNarrativeEvent()` 逐字段显式复制，`duration`/`frequency`/`voice`/`anachrony`/`focalization`/`narratorProfileRef` **以及 `narrativeChecklist`/`sourceContext`** 全部没在返回对象里——类型齐全、schema 齐全、运行时零传递，正是"死类型"模式的第三处实例。已全部补上（`mapper.ts:268-277`）。这意味着上次报告"S1/S4 已接通"实际只在合成事件测试里成立，真实 YAML 路径此前从未通过。
2. **E1 早已声明 `duration/frequency/voice/anachrony`**（上一会话 fixture wiring 提交），计划让我再加会造成 YAML 重复键解析失败——验证门当场抓住，撤销了重复块。Phase 2 的 fixture 佐证要求由既有声明满足（比计划的单字段更强）。
3. **5 个新 Pass 2 块必须 `.optional()`**。`getCombinedValidationSchema()` 对 validator 贡献的块一律 required；照计划做 required 会让所有既有 mock reference data 验证失败、整个 mock 测试面崩掉（违反计划自己的"回归基线逐字一致"验收）。两层（静态 `analysisContentSchema` + 各 validator requirement）都取 optional，消费端对缺失块优雅降级。
4. **回放位置越界**。`replayDiscourseState` 对 `position > entries.length` 抛错，2 条 ledger 会让 E2+ 全部误报 → 位置钳制到 ledger 长度（语义="到此为止的全部披露"）。
5. **`narrativeLength` 是 number（字数）**，计划里的 `"one paragraph"` 字符串会被 Zod 拒绝。
6. 计划的 `'narrative_structure'` category 不存在于 `Validator['category']` 联合类型，6 个新 validator 统一 `'narrative_style'`。

伴随契约更新的测试修正（非放松）：`schema-unification.test.ts`（15→20 块）、`dynamic-schema.test.ts`（原 14 块保持 required、仅 S6 块 optional 的精确断言）、`validator.test.ts`（20→26 个 validator 的完整名单）。

---

## 三、最终验证矩阵

| 门 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 干净 |
| `npm run build` | ✅ 干净 |
| Phase 0 CLI 无模型硬错误 | ✅ exit 1，无网络调用 |
| Phase 1 stdout 计数回归（`render-full-chain.test.ts`） | ✅ `toHaveLength(7)` 不变 |
| Phase 1 实时进度（冷/热） | ✅ stderr 各 7 行，`cache=false`/`cache=true` 正确 |
| Phase 1b 无 `--trace` 错误可见性 | ✅ 结构化 JSONL error 行，含真实失败文本 + phase 字段 |
| 6 个新 validator 测试 + 集成测试 + prompt 测试 | ✅ 55 tests 全绿（8 个新测试文件） |
| 全量非 e2e 回归 | ✅ **15 failed / 3 files——与上次报告记录的既有基线（bench/debug/integration 的过期硬编码路径）逐字一致，零新增失败**；1975 passed |
| 真实 LLM 全链路 smoke（DeepSeek, `render E0 --all`） | ✅ 7/7 事件 committed，`output/novel.md` 49.8KB 装配成功，exit 0；实时 `✓/·` 行与 JSONL warn 行同屏出现；接线后的 narrator/ledger/duration fixture 无 validator 异常 |

## 四、遗留（均为明确范围外，非未完成）

- 上述 15 个基线失败（3 个测试文件的过期 `novalistically` 硬编码路径）——先于本次工作存在，未触碰。
- 质量评分阶段：C2/C3 人工标注、`fixtures/dream-of-red-chamber/` 20 事件实测——用户明确 deferred。
- Plugin 系统运行时挂载、`ModernNovelConfig` B 类字段、`ProjectConfig` 运维字段——计划明确排除，理由见计划"Out of scope"节。
- 变更未提交（未收到 commit 指令）。
