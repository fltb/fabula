# IR 完整度审计 + zhu-fu 全链路真实 LLM 验证报告

> **时间**: 2026-07-26 20:42 CST
> **日期**: 2026-07-26
> **方法**: 直接源码校验（grep/read/git log），非文档信任；关键结论用真实 LLM 全链路运行交叉验证
> **背景**: 用户记忆中 IR 层未完成；请求确认项目相对 `docs/archive/PROJECT.md` 原始目标的完整度，并用 zhu-fu fixture + 其变种做全链路功能完整性验证（非质量评分）

---

## 一、IR 完整度 vs `docs/archive/PROJECT.md`

PROJECT.md 定义的流水线：`Idea IR → Story IR → Scene IR → Event IR → World State → Novel Text`。

| 层 | 状态 | 验证方式与证据 |
|---|---|---|
| Idea IR | ✅ 建成 + 接入 | `types/idea-ir.ts` + `schemas/idea-ir.ts` 存在；`schemas/project.ts:53` 已 import 挂载；`fixtures/zhu-fu/nova.yaml` 有真实 `thematicIntent`（"封建礼教吃掉个体"主题声明） |
| Story IR | ✅ 建成 + 接入 | `ThreadDefinition.structuralFunction`/`actantModel`（`types/thread.ts:100-103`）；zhu-fu fixture 的 4 条 Thread（T1-T4）有真实 Propp 功能标签（villainy/unfounded_claims/exposure/recognition） |
| Scene IR | ✅ 建成 + 接入 | `sceneType`/`discourseMode`/`arcPosition` 等元数据字段广泛使用；`CompiledSceneContract` 已编译 |
| Event IR（Fabula） | ✅ 完整 | 系统核心，10+ validator 覆盖 |
| World State | ✅ 完整 | Event Sourcing + Snapshot + DAG causal replay |
| Discourse/Syuzhet（PROJECT.md 未命名的第 6 层） | ⚠️ **类型齐全，零接入** | `types/discourse.ts`：`DiscourseState`/`NarratorProfile`/`PlannedDiscourseLedger` + 回放引擎 + 测试齐全；grep 全部 `fixtures/` 目录零命中，是死代码路径 |

**结论**：用户记忆准确反映的是 wave1 提交（2026-07-24 13:25，commit 附近 `349dd44`/`23f121b`/`18ce1ae`）之前的状态。`docs/TODO.md` 原有的"IR 层级缺口"分析和 `docs/reference/stage-3/ir-layer-narratology-mapping.md` 都写于该提交之前且从未随实现更新（后者 13:57 的"整理文档"提交是纯文件移动，0 行内容变更，可用 `git show --stat` 验证）。IR 目前唯一真实缺口是 Discourse/Syuzhet 层。

### 意外发现：base-narratology（S6，Genette 五维度）同样是"死类型"

`docs/report/stage-3-audit-2026-07-24.md` 声称 S6（Duration/Frequency/Mood/Voice/Order）"5/5 dimensions ✅"。**直接校验发现这个审计结论本身是错的**：

```
grep -rn "event\.duration|event\.frequency|event\.voice\b|event\.anachrony|event\.focalization" packages/core/src
→ No matches found
grep -rn "DurationValidator|FrequencyValidator|VoiceValidator|MoodValidator|OrderValidator|AnachronyValidator" packages/core/src/validator
→ No matches found
```

`duration`/`frequency`/`voice`/`anachrony`/`focalization` 字段确实存在于 `NarrativeEvent` 类型上，但没有任何 validator、context compiler 或 prompt assembler 读取它们——与 Discourse/Syuzhet 同一模式：类型齐全，运行时零消费。已在 `docs/todos/base-narratology-2026-07-26.md` 和 `docs/todos/stage-3-2026-07-27.md` 中改正状态并留下"不要信任该审计条目"的警告，避免下次再被这个过期结论误导。

这是本次审计过程中的一个重要方法论提醒：**同一份 `stage-3-audit.md` 里，S7（Idea/Story IR）的结论校验为真，S6 的结论校验为假**——不能因为审计报告某一部分可信就假设全篇可信，必须逐条对源码复核。

### 其余 MVP 项核对

| 模块 | 状态 |
|---|---|
| 10 种一致性检查器 | ✅ 超额完成，现有 18 个 validator |
| Context Compiler | ✅ 5 层优先级 + 8 维评分 |
| Assembler | ✅ 完整，本次真实 LLM 全链路跑通中亲眼验证 |
| Plugin 系统（Genre/Technique/Agent） | ✅ 真实实现（`plugin/loader.ts`、`hooks-manager.ts`、`conflicts.ts`、冲突仲裁），未确认是否已挂到 render 主管线运行时 |
| Review Layer（ReviewComment/Patch） | ✅ 建成 + CLI 接入（`nova review list\|add\|resolve\|reopen\|escalate`） |
| Discovery Layer（聊天→YAML） | ❌ 未建，但这是**设计上刻意排除**的（Core 只定义文件格式，任何读写文件的 AI 工具都可充当发现层），不是遗漏 |
| S8 Planner | 按 784c802 设计决策主动移除（本系统建模已完成的小说，不存在"下一步"） |
| C2/C3（人工标注 F1/kappa） | ❌ 需要人工标注，无 agent 可执行路径，脚手架就绪待人审 |

---

## 二、zhu-fu + 5 个变种全链路真实 LLM 验证

### 方法

`.env` 提供了真实 DeepSeek API key（`NOVALISTICALLY_AI_API_KEY`，`NOVALISTICALLY_AI_BASE_URL=https://api.deepseek.com`，`NOVALISTICALLY_AI_MODEL=deepseek-v4-flash`）。用 CLI `nova render E0 --all --model deepseek-v4-flash` 对每个 fixture 的**新鲜临时副本**跑真实 Pass1+Pass2+validator+assembler 全链路，只验证功能完整性（是否跑通、验证器是否正确生效），不做 prose 质量评分——因为 zhu-fu（鲁迅《祝福》）已被模型训练记忆，最好的结果本就是复述原文，质量分没有意义。

### 结果

| Fixture | 结果 | 备注 |
|---|---|---|
| **zhu-fu**（基准） | ✅ 全通过 | 复用仓库已有的 `render-full-chain.test.ts`（用真实历史录制的 `reference/data/`），7 事件、Pass2 schema 校验、novel.md 正确装配 |
| **layer-minimal** | ✅ 7/7 | 真实生成，142s |
| **branch-A** | ✅ 7/7 | 真实生成，109s。此前用"复用 zhu-fu 参考数据"做 mock-pass2 回放时 E2/E3 曾被拒绝——这是内容不匹配导致的假阳性，**真实生成后完全消失**，证明先前的拒绝是回放数据问题，不是管线缺陷 |
| **pov-switch** | ✅ 7/7 | 真实生成，142s（含一次 180s 超时后台恢复，见下） |
| **discourse-reorder** | ✅ 7/7 | 真实生成，141s，E3 先于 E2 渲染，证实话语重排机制真实生效 |
| **branch-B** | ⚠️ 6/7 committed | E0-E4/E6 成功；**E5 被正确拒绝**：`PronounValidator` 检测到"叙述者应为第一人称，但散文未使用任何第一人称代词"，`ConflictAnalysis` 交叉校验同时检测到声明的 `resolutionType: ongoing` 与 Pass 2 分析的实际结果不符。6 次重试（retry→prompt_fix→abort 三级策略）后 release gate 正确拒绝提交。这是**真实内容上的验证器正确捕获**，不是管线故障——但也说明单个事件被拒绝会阻塞整批的 `output/novel.md` 装配（E0-E4/E6 都成功却没有产出小说文件），这是一个值得注意的行为特征 |

**结论**：zhu-fu + 5 个变种的全链路（YAML → EntityMapper → StateManager → ContextCompiler → RenderPipeline Pass1+Pass2 → PostRenderValidation → Assembler）在真实 LLM 下功能完整、可靠。release gate 在真实生成内容上确实生效（branch-B/E5 案例），不只是理论机制或对 mock 数据的反应。

### 过程中发现并修复的 2 个真实 bug

**Bug 1 — `packages/core/src/api.ts:406` 模型解析从不读取 `NOVALISTICALLY_AI_MODEL` 环境变量**

```ts
// 修复前
const resolvedModel = model ?? data.config?.defaultModel ?? 'claude-sonnet-4-20250514';
// 修复后
const resolvedModel = model ?? data.config?.defaultModel ?? process.env['NOVALISTICALLY_AI_MODEL'] ?? 'claude-sonnet-4-20250514';
```

未传 `--model` 且项目无 `defaultModel` 配置时，硬编码回退到一个 Claude 模型名，对 DeepSeek 端点发起必然失败的请求（模型不存在）。`.env` 里配置的 `NOVALISTICALLY_AI_MODEL` 实际上从未生效——它只是 `AiSdkProvider` 构造函数自己的内部默认值注释，从未被这条调用链读取过。修复后优先级为：CLI `--model` 标志 > 项目 `nova.yaml` 的 `defaultModel` > `.env` 的 `NOVALISTICALLY_AI_MODEL` > 硬编码兜底。

**Bug 2 — `packages/core/src/pipeline/render.ts` Pass 1 catch 块吞掉真实失败原因**

Pass 2 的 catch 块正确地把 `sanitizeError(err)` 写入本地 `errors[]` 数组（会显示在 CLI 输出里）；Pass 1 的对应 catch 块却只写入 `providerCalls[].failureReason`（藏在 `.nova/responses/{id}.json` 里，CLI 默认不显示），从不写入 `errors[]`。结果是：模型解析错误（Bug 1）发生时，CLI 只显示 `❌ E0: 1 words, cache=false` 加一句笼统的 "Release gate rejected"，看不到真实原因文本，逼得我不得不手动加 `console.error` 诊断、重新构建、逐步排查，才发现是 Bug 1。修复后 Pass 1 失败会像 Pass 2 一样在 CLI 输出里打印具体错误信息（如 "The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed mock."），大幅缩短未来同类问题的排查时间。

两处修复均已跑 `npm run typecheck` + 全量非 e2e 测试套件验证零回归（用 `git stash` 对照，改动前后失败测试集合完全一致，均为已知的、与本改动无关的预置问题——见下）。

### 观测到但未修复的可观测性缺口

`render --all` 在多事件批量渲染时**没有任何增量进度输出**——CLI 只在整批结束后打印结果，`hub logs`/stdout 在运行期间完全静默（Node 对非 TTY pipe 的 stdout 是块缓冲，短小的逐事件打印行不会实时 flush）。中途唯一能看到进度的办法是轮询 `.nova/render-cache/` 目录内容，这也是本次诊断 pov-switch/branch-B 是否卡死时实际采用的方法。建议后续给 `render --all` 加一行 per-event 的实时进度输出（不需要等到整批结束）。未在本次修复，因为不在用户明确要求的范围内，仅记录供后续排期。

---

## 三、TODO 台账同步

`docs/todos/stage-3-2026-07-27.md` 的分组索引表和以下子计划文件已按上述校验结果同步（每条都标注了具体证据来源，不是无依据的勾选）：

- `validator-bugs.md`：VB-1/2/3 → `[x]`（早前会话已确认修复）
- `upper-ir.md`：S7a/S7b → `[x]`
- `thread-tracking.md`：S2 → `[x]`（GreyLineValidator 真实消费 `event.greyLines`）
- `generation-pipeline.md`：S4/S5 → `[x]`（S4 是本次会话修的接线缺口）
- `narrative-checklist.md`：S1 → `[x]`；C1 保持 `[ ]`（需要红楼梦 20 事件真实 LLM 覆盖率报告，本次未做，需要单独排期）
- `modern-novel.md`：S3 → `[x]`
- `base-narratology.md`：**保持 `[ ]`**，改正为"type-only，零消费者"，并标注不要信任 `stage-3-audit.md` 该行结论
- `annotation.md`：保持 `[ ]`（C2/C3 需人工标注，agent 不可执行）
- `planner.md`：已是 `[x]`（设计移除，无需改动）

`docs/TODO.md` 的"IR 层级缺口"分析段落保留原文（历史记录），后面追加 2026-07-26 校正说明，指出该分析已过期及真实现状。

---

## 四、未做的事（明确排除，非遗漏）

- **dream-of-red-chamber 20 事件全量验证**：需要真实 LLM 跑 20 个事件 + 人工撰写 S1/S4/S6 元数据（文学判断任务，非机械任务），规模远超本次会话，需单独立项
- **C2/C3 人工标注**：无 agent 可执行路径
- **Discourse/Syuzhet 层接线**：需要设计一个使用 `NarratorProfile`/`DiscourseState` 的新 fixture 或改造现有 fixture，属于较大的功能开发任务，本次只做审计确认，未做接线
- **base-narratology（S6）接线**：同上，需要新增至少一个 validator 消费这 5 个字段，属于开发任务不是校验任务
- **`render --all` 增量进度输出**：已记录为观察项，未修复
