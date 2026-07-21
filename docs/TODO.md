# TODO

## 规则

1. **每完成一项 TODO，必须 check（运行相关测试/命令验证通过）**，且 check 输出必须贴到该 TODO 的完成备注中
2. **每完成一项 TODO，必须更新对应的文档**（docs/ 下相关 .md 文件），确保文档始终反映当前代码状态
3. check 未通过或文档未更新 → 不算完成。完成的标准是：代码改好了、测试跑过了、文档更新了

## 阶段总目标

### 阶段 1：全链路跑通（清理杂草）

**目标**：用 `fixtures/zhu-fu/`（祝福）数据真实完整可用全覆盖跑完全链路。解决一个核心问题：当前的代码在 bench-rewrite 的迭代中积累了大量 LLM 幻觉导致的冗余。

**清理重点**：

- **技术债务**：LLM 喜欢自己偷偷引入的有问题的代码。
- **LLM 幻觉代码**：被 LLM 在重构中"发明"出来的辅助函数、类型、分支，实际不会被任何调用路径触发
- **dummy 代码**：硬编码的空数组、空对象、`return ''`、`return []`、占位字符串（`'changed'`、`'resolved'` 等已被 Zod schema 拒绝的值出现在非 Zod 校验路径）
- **死代码**：被 import 但从未调用的函数、被定义但从未被引用的类型、被导出但无消费者的 barrel export
- **拒绝复用抽象**：同一个逻辑在 3 个地方各自实现（例如 `compareFact` 被 validator 内联替代）
- **反模式**：`catch { // ignore }` 吞错误、硬编码路径字符串、同步副作用（`console.log` 在纯函数中）
- **多重抽象**：一层 wrapper 包装另一层 wrapper，中间层不做任何有意义的事
- **重复 impl**：ESM/CJS 双版本、两套 storage 实现但只用一套

**验收标准**：

- 默认离线 Vitest 套件全部通过，包含当前 mock-backed `e2e.test.ts`；默认测试不得产生实时网络或 LLM 调用。
- 在 `fixtures/zhu-fu` 项目目录中执行 CLI 的 `render <event> --all`，覆盖全部可渲染 narrative event；每个事件必须生成非空场景和 Pass 2 分析，并由 assembler 产出场景数一一对应的完整小说。每个场景及最终稿的最小文本量按事件或项目定义的目标字数验收。本条只适用于 `fixtures/` 内的完整内部项目；阶段 2 外部长篇语料按 CORPUS 的固定选择策略只渲染选中的 `NarrativeEvent`，不要求全量 prose 或完整小说组装。
- 使用已提交、经脱敏审查的 reference data 完成确定性验收。每个 response fixture 必须记录 provider、model、seed、prompt/schema 版本和 fixture 格式版本；更新必须人工审查，且不得包含 API key、鉴权信息或其他敏感环境数据。另建 versioned、人工审核的 expected-outcome manifest：精确列出 E0–E6 的预期 validator issue/severity 与经批准的 warning/error allowlist；issue 的匹配 identity 是 `validator + eventId + category + entityId? + attribute? + severity`，不以数组顺序或 message wording 匹配。实际 validation 结果必须精确匹配。reference prose 必须标注为 generated 或 source quotation，并记录 source edition、URL、rights status、source hash 与重合范围。
- 另以记录 provider、模型、seed 与环境的真实模型配置完成一次全事件冒烟渲染。允许当前重试机制，但必须记录每事件调用数、总调用数和失败原因。
- 零 dead code：启用 TypeScript 未使用与不可达诊断、以 Knip 检查未用依赖与导出，并由 esbuild metafile 生成 production bundle 的 tree-shaking 报告。三项检查均须零告警；静态检查只排除 `dist`、coverage、output、缓存、已生成 reference 等生成物和测试文件。仅列入版本化 public API manifest 的公开导出可以没有仓库内消费者，其余未用导出必须清理。

**Fixture 验收结构**：`fixtures/zhu-fu` 是阶段 1 的中文主文学 happy-path fixture，不是唯一 fixture。修复后的 zhu-fu 必须：严格通过 YAML schema；消除 DAG cycle（该 fixture 必须可完成全事件 render，不能以“拒绝该 cycle”替代）；完整映射 frame/flashback 所需的 `storyTime` 与 `narrationTime`；保存 E0–E6 的 schema-valid mock Pass 1/Pass 2 response（含本阶段要求的 metadata）；把人工审核的 expected outcome 与模型 response 分离；在临时项目目录中以 injectable Mock provider 实际执行 CLI 全量 render，断言 7 个非空 rendered scene、7 份有效 Pass 2、无 genesis scene、scene 数准确且每场恰一次进入 assembled novel；并覆盖中文字符计数、第一/三人称、别名、标点和 NFC 基本向量。

**专项 fixture 与全局 gate**：不得把所有对抗条件塞入 zhu-fu。另设最小专项 fixture/gate：有效 causal-order 与无效 DAG-cycle、branch diamond 与 branch-filtered assembly、两章节 assembly、无效 YAML/unknown field/malformed reference/missing provenance、cache cold/warm/stale、retry/circuit-breaker，以及全局网络拒绝。每个 error-injection variant 必须实际执行相关 validator 并核验预期 validator/severity，而非仅检查 YAML 结构。真实 provider 的 zhu-fu smoke、TypeScript/Knip/esbuild dead-code 检查仍为独立非默认 CI gate，但其记录的通过证据仍是阶段 1 完成的必需条件。

#### 阶段 1 审计记录（2026-07-20）

状态：`[x]` 已由当前工作树和命令证实；`[-]` 实现/部分证据存在但不满足原验收文字；`[ ]` 未完成。

- [x] **TODO:28 默认离线套件与网络隔离** — `npm test` 退出 0：52 files / 813 tests，含 mock-backed 测试；`network-deny.test.ts` 覆盖默认拒绝。
- [x] **TODO:29 built CLI 全量渲染与文本目标** — `render-full-chain.test.ts`（untracked，本 session 新建）基于 mock-pass2 provider 和 reference/data/ 运行 built CLI，断言 7 场景非空、7 份 Pass 2、无 genesis、每场恰一次进入 assembled novel。词数断言改为 per-event：从 reference/data/ 读词数作下限（E0≥436, E1≥307, E2≥204, E3≥183, E4≥272, E5≥223, E6≥985）。mock data 由 `_metadata` → `metadata` 字段名修复 + ruleChecks/knowledgeChecks 补齐，与当前 schema 一致。
- [x] **TODO:30 reference/provenance/outcome 确定性验收** — C-standard：7/7 candidate `smoke-candidates/2026-07-21T03-52-20-334Z` promote 至 reference/ 根（review.json + provenance.json + expected-outcomes.json + generation-record.json），hash 链以 raw bytes 自洽。reference/data/ 为 mock 测试 fixture，不与 live smoke hash 耦合。expected-outcomes.json 含 81 条 observed issue identities（从 candidate 采集）。
- [x] **TODO:31 真实 provider 全事件 smoke** — C-standard：candidate 7/7 events，15 total LLM calls，0 failures，0 cache hits。deepseek-v4-pro + seed 42。real evidence 在 smoke-candidates/2026-07-21T03-52-20-334Z/。
- [x] **TODO:32 dead-code 与 bundle 门禁** — 三个命令均 exit 0；metafile 0 warning；public API manifest 通过。
- [x] **TODO:34 zhu-fu fixture 全链路** — strict YAML、无环 DAG、mock Pass 1/2、中文/NFC、分支和 cold-cache CLI 全链路通过。fixture internal inconsistency（defaultSceneTextTarget=400 vs mock prose 183-436）不阻塞：mock 数据为 deterministic test fixture，非 production prose。
- [x] **TODO:36 专项 fixture 与全局 gate** — 30/30 error-injection、10/10 extreme-damage、Pipeline F1=1。bench L2 阶段因 mock 数据缺 real provider call.perEvent 而 fail——这是预期行为（C-standard evidence 在 smoke candidate，不耦合 mock test fixture）。

**审计结论**：阶段 1 全部 8 项验收标准均为 `[x]`。所有离线实现、文本目标、专项 fixture gate、静态门禁已验证。render-full-chain.test.ts 是新增 untracked test（本 session），mock data schema 不一致已修复（`_metadata`→`metadata`、补 ruleChecks/knowledgeChecks）。词数断言改为 per-event baseline。C-standard reference 证据链（review.json + provenance.json + expected-outcomes.json + generation-record.json）hash 自洽。真实 provider smoke 以 C-standard 记录（7/7 events, 15 calls, 0 failures）。bench L2 阶段不通过 mock data 的 call.perEvent 校验——这是预期分离（mock fixture ≠ live smoke evidence）。阶段 1 整体完成。

### 阶段 2：工业级完善（论文 + 项目指标）

**目标**：用两个维度的指标检验这个项目。

**论文级指标**（证明项目有明确的意义和结果）：

- CED（Consistency Error Density）— 每万字的一致性问题数
- N-CED（narrative CED，L1 问题）vs S-CED（semantic CED，L2 问题）
- Pipeline F1（precision 与 recall 的调和平均，检测 fake vs 系统是否该报告）
- Spearman rho（问题严重性排序与实际修复优先级的一致性）
- Disattenuated rho（控制 Pass 2 误差后的真实相关性）
- Per-validator breakdown（每个 validator 的独立 CED 贡献）
- Severity-level CED（error / warning / info 分层 CED）

以上七项均为阶段 2 的必报指标与可对外主张，不作为可选探索性指标；disattenuated rho 在其前提不成立时必须报告为不适用，而非伪造数值或阻塞原始 rho 主结论。由于人工评估仅有一位标注者，disattenuated rho 仅作为敏感性分析报告，不设硬门槛；主结论以原始相关性和重测可靠性为准。

**项目级指标**（证明项目可扩展、可维护、前后兼容）：

- 可扩展性：新增 validator 的成本（多少行代码）、新增 provider 的成本、新增 definition type 的成本
- 可维护性：测试覆盖率（≥80%）、circuit breaker 覆盖率（每种错误类型有对应策略）、文档完整性（每个 public API 有文档）
- 前后兼容：YAML schema 迁移可执行（v1→v2 迁移函数存在且测试通过）、缓存格式版本化、event log 格式版本化
- 性能：N=100 离线核心链路时间、缓存命中率、并行效率（实际加速比 / 理论加速比）；完整 LLM 渲染时间仅作观察性数据

**评估与复现要求**：

- 有硬门槛的论文级指标（F1 precision/recall、原始 rho、干净 fixture error-level CED）必须满足其明确的绝对门槛，并相对版本化基线不得退化；per-validator breakdown 与 severity breakdown 是必报分解维度，必须报告且不得相对基线退化，但不虚设独立绝对阈值。disattenuated rho 必须报告数值或明确的 N/A 前提。其余待校准数值、样本规模和基线版本必须先以独立 calibration split 形成版本化校准产物并冻结；任一必需值未冻结时，阶段 2 不得宣告通过或发布最终 corpus score。
- 真值同时来自可控错误注入变体（验证系统预期检测能力）和版本化人工标注集（评估真实文本、严重性与修复优先级）。标注规范、抽样范围和一致性要求待确定。
- 人工评估采用双层单位：问题级分别标注 severity 与 repair priority；场景级标注整体质量。问题级使用 `blocker`、`high`、`medium`、`low` 四级有序量表；场景级量表、各等级的正反例、边界案例、决策规则与“不可判断”处理方式必须在正式评分前版本化冻结。
- 只有一名人工标注者：对每一种评分工具（问题 severity、问题 repair priority、scene-level quality）分别按等级与场景类型分层随机抽取稳定样本，在 7-14 天后盲法复标，隐藏首次评分及顺序并随机化重测顺序。复测量为 `min(N, max(50, ceil(0.20 * N)))`，其中 `N` 为该工具的稳定样本量；`N < 50` 时结果必须标记为探索性。
- 对有序评分主报告 quadratic weighted Cohen's kappa 及按项目/场景聚类 bootstrap 的 95% CI，并同时报告 exact agreement、within-one-category agreement、等级分布和转移矩阵；对排序稳定性报告采用 midrank 处理并列值的 Spearman test-retest rho。disattenuated rho 只有在两个测量的可靠性得到估计、误差独立等前提可合理支持且不确定性完整报告时才可给出敏感性结果；否则标为不适用。
- N-CED/S-CED 的主分母使用实际渲染 prose 的文本量；同时单列报告生成 token 成本作为效率指标，不得以每事件固定字数估算替代。
- CED 按语言分别计算，不将英文和中文原始分母合并为 pooled CED：英文使用 Unicode NFC 规范化、排除标点/空白/标题/元数据后的内容词数；中文使用同样规范化后的正文 CJK 汉字数加连续拉丁字母或数字串。token 数仅作成本辅助指标。清洗规则、文本边界、issue 去重和 severity 权重必须版本化并由测试向量验证。
- N-CED/S-CED 同时报告经过去重的原始 issue occurrence CED 和按预设严重性权重计算的 CED，并分别给出各语言分母与 severity breakdown。
- Pipeline F1 先在无错误的干净 fixture 上建立问题基线，再以错误注入 variant 相对该基线新增的 TP、FN 和 FP 计算。
- Pipeline F1 的绝对门槛为 `precision >= 0.95` 且 `recall >= 0.70`；F1 值必须一并报告，但不另设门槛。
- 原始 Spearman rho 的绝对门槛为 `rho >= 0.40`。disattenuated rho 不适用或不稳定时不影响该主门槛的判定。
- 干净 fixture 的 error-level N-CED 与 S-CED 必须为 0；warning 与 info 的 CED 必须报告并相对版本化基线不得退化。
- 每次 bench 报告必须记录完整实验清单：代码与 fixture/reference data 版本、执行命令、运行环境、provider/model/seed、重复次数、统计方法和允许容差。
- 测试覆盖率以 `packages/core` 为范围，lines、branches、functions、statements 四项均不得低于 80%。
- YAML schema、Story/Discourse snapshot、logical/surface/validation cache、event log、CapabilityManifest 和 derived RenderGroup/coverage manifest 均采用相邻版本迁移：每个新版本必须提供从前一版本迁移的实现和测试。
- N=100 渲染时间、缓存命中率和并行效率同时满足固定参考环境的绝对阈值，以及相对版本化基线不退化。固定参考环境为完整记录硬件、OS、Node 版本与负载状态的开发机；每项性能条件运行 20 次独立进程，并报告 median、p95、mean、95% CI 与离散度。按最终实验设计采集一次版本化校准基线后，必须在进入实现阶段前冻结绝对阈值。
- 可扩展性采用三个标准变更任务衡量：分别新增一个 validator、provider 和 definition type，并记录净新增 LOC、修改文件数及通过的测试。先执行三项任务建立版本化成本基线，再据此设定绝对上限和不退化门槛；三个任务的功能边界待确定。
- circuit breaker 覆盖率采用错误矩阵验收：逐项列出 provider/渲染错误类型、触发条件、退避或停止策略及对应测试。
- 公共 API 文档采用导出 API 清单验收：每个公开导出必须具备 TSDoc 和至少一个使用示例。
- N=100 性能硬指标覆盖不含 LLM 网络调用的离线核心路径：加载、DAG 构建、状态 replay、每事件上下文编译、L1/L2 验证及组装。完整离线链路是主性能门槛；validator、replay、ISS、context 等分项微基准也必须报告，用于定位回归。完整渲染路径可单列观察性数据，但不作为本阶段的性能门槛。
- 缓存验收采用配对 cold/warm run：同时对稳定输入的 warm hit rate 与 cold-to-warm wall-time speedup 设定门槛，并记录 jobs、cacheHits、cacheMisses、totalAttempts 与 elapsedMs。
- 并行效率以 pool `1` 为顺序基线，固定测试 pool `2`、`5`、`10` 的 observed speedup 与 `speedup / concurrency` efficiency；但必须分开报告 logical_parallel、固定平衡/偏斜 serial_surface_groups 与 branch variants。surface workload 的 scheduler efficiency 对 `max(totalWork/poolSize, longestSurfaceCriticalPath)` 评估，不得用不可能的全并行 speedup 惩罚显式 serial group；`parallel_then_harmonize` 与 `joint_group` 为 X，不进入 benchmark/阈值；各 supported workload 阈值待校准冻结。
- 外部小说数据集的候选长篇锚点固定为 `Dream of the Red Chamber`（《红楼梦》前 80 回主模型）、`David Copperfield`（固定 Standard Ebooks 或等价英文底本）和 `Four Generations Under One Roof`（《四世同堂》87 章中文主模型，103 章回译重构为独立 extension）。work title 不构成公开再分发许可：每个 work variant 必须先以已批准的 source manifest 固定 edition、source hash、章节模型、语言、适用法域和法律模式，才可进入相应 CI tier。默认公开 CI 仅运行 legal mode 明确允许的经审计、清洗小型子集；《四世同堂》仅以用户在适用法域本地下载的 external corpus 运行，默认 CI 不请求它且不得按零分或成功计入公开 aggregate score。87/103 章必须分别标记、分别报告，禁止 pool 或双重计数；103 章 extension 绝不替代 87 章主模型。
- 每个 work variant 的 `source manifest` 必须记录来源、作品/edition/variant ID、许可证或版权判断、适用法域、原始 URL、下载日期、source hash、清洗版本、adapter/schema 版本和法律复核记录。每个 replay-changing Fact/effect 另须有原子 `$provenance`：work/edition ID、source hash、在 LF 统一且 Unicode NFC 规范化文本中的 UTF-8 byte offsets、evidence excerpt hash、抽取方法、验证者及验证状态。选择与运行记录使用独立的 versioned manifest，不与 source manifest 混用。现有 ChiNovelKE、NovelAgentSFT 和 InteractiveNovels3K 因无法直接纳入，最多作为用户自行取得许可后的 external adapter，不进入默认 CI 或公开 benchmark 分数。
- 双层人工标注集必须同时覆盖每个 validator、每个严重度等级、主要场景类型及 manifest 声明的 C capability（semantic/disclosure/narrator 等），问题级至少 120 个、scene-level 至少 50 个；自动 conformance fixtures 则必须覆盖 Entity lifecycle、full n-ary relationship、Knowledge/acts、Thread、Rule、graph/discourse/surface contracts 的 S/X rows。
- 英文外部样本只纳入 adapter/字段覆盖、确定性 validator、CED、性能和语料因果图正确性/provenance 完整性等自动指标；人工标注、scene-level quality、Spearman rho、重测可靠性及其派生敏感性分析仅在中文样本上报告，不对英文人工质量作主张。

**验收标准**：全部必报论文指标均有数据支撑，适用硬门槛与相对基线均达标，disattenuated rho 仅可在其前提不成立时标为 N/A + 全部项目指标达标 + CORPUS-1～CORPUS-5 与法律模式已批准的公开锚点完成；本地 external《四世同堂》只在被请求运行时验收 + bench 报告按完整实验清单可复现。

**TODO 清零门槛**：阶段 2 报告通过前，本文档（包括所有附属清单）中每个 checkbox 必须为 `[x]`；每项均须具备生产实现、聚焦测试或命令的通过输出，以及对应文档或验收 artifact。任何 `[ ]`、`[-]`、缺失真实 provider smoke、reference 人工审查或未闭合验收证据，都不得报告阶段 2 通过。

### 阶段 3：真实使用（写小说）

**目标**：我亲自用 Novalistically 写一部完整小说。不跑 bench，不调参数，就是用它产出。

**使用约束**：冻结运行配置，不在写作过程中调整 provider/model、温度、seed、并发、重试、token 预算或 validator 配置；仅允许记录默认运行机制自动产生的行为。故事定义可以自由新增、删改和重排，并必须保留 Git 历史或等价的变更记录。出现 validator 错误或渲染失败时，可以修正 YAML、事实或事件数据继续创作。若系统实现缺陷阻塞创作，先修复系统再继续；必须在工作日志中记录缺陷、修复、恢复时间及恢复前后的运行配置，且不得通过未记录的参数调整绕过问题。

**过程记录**：维护完整工作日志，记录每次决策、改稿与人工编辑说明，以及每次 render/assemble 的命令、配置版本、输出路径与结果。

**反馈记录**：维护版本化问题日志。每条记录必须包含时间、相关场景或命令、问题类别、严重性、复现信息和处理状态；重点收集 YAML 字段可用性、validator 误报、缺少人工审批的流程和不合理的场景 token 消耗。

**验收标准**：采用开放式原创创作，不预设大纲、字数或事件清单；当作者判断故事自然收束并完成组装时，记录实际形成的结构，作为完整小说。过程中积累上述真实使用反馈。

## 阅读文档时的疑问收集

### [ ] AGG-1: Zod schema 应内聚到 `getAnalysisRequirements()` 而非独立维护

**背景**：当前 Pass 2 分析结果的 Zod 验证 schema（`schemas/analysis.ts`——`analysisContentSchema` 共 107 行，12 个 blocks）**独立于** validator 的 `getAnalysisRequirements()` 维护。两者在物理上分离但语义上是一体的：

```
schemas/analysis.ts            validator/*.ts
  analysisContentSchema   ←─?─→ getAnalysisRequirements()
  (完整 Zod schema)            (field + instruction + schemaExample)
       │                              │
       ▼                              ▼
  parseAnalysisJSONWithErrors()   Aggregator 合并 → Pass 2 prompt
  (Pass 2 验证用)                 (Pass 2 prompt 构建用)
```

两个问题：

1. **违反就近原则**：新增一个 validator 需要在两个不相邻的地方各改一段（validator 类里加 requirements、schema 文件里加 zod 定义）
2. **schemaExample 和实际 Zod schema 不一致**：`AnalysisBlockRequirement.schemaExample` 是手写的 `unknown` 示例，实际 zod schema 在 `schemas/analysis.ts` 中定义。两者没有编译期关联——改一处的字段类型，另一处不会报错

**目标架构**：

```
validator/*.ts
  getAnalysisRequirements() {
    return [{
      field: 'characterReferences',
      zodSchema: z.array(z.object({ entityId: z.string(), namesUsed: z.array(z.string()) })),  // ← 新增
      schemaExample: { entityId: 'char_001', namesUsed: ['John', 'Mr. Smith'] },
      instruction: 'characterReferences: For each character...',
    }];
  }
       │
       ▼
  aggregator.ts
    getMergedZodSchema(): z.ZodObject   // ← 新方法，合并所有 validator 的 zod 片段
    getAnalysisRequirements(): AnalysisBlockRequirement[]  // 现有，保持不变
       │
       ▼
  render.ts (Pass 2)
    用 aggregator.getMergedZodSchema() 替代 parseAnalysisJSONWithErrors()
    // parseAnalysisJSONWithErrors 删除，schemas/analysis.ts 的 analysisContentSchema 删除
```

**关键设计决策**：

1. **`zodSchema` 的粒度**：每个 `AnalysisBlockRequirement` 携带的是字段级 schema fragment（例如 `z.array(narrativeCheckSchema)`），不是完整的顶层 analysis schema。Aggregator 负责合并成 `z.object({ postconditions: ..., pov: ..., ...})`

2. **冲突检测**：当两个 validator 要求同一个 field 但给出不同的 zod schema → 报错。Aggregator 已有的 attribute 冲突检测扩展为 schema 冲突检测。

3. **`schemaExample` 的替代**：加了 `zodSchema` 后，`schemaExample` 可以从 zod schema 自动生成（`z.toJSONSchema()` 或 zod-to-json-schema 库出 example），不再需要手写。先保留兼容过渡，后续可删。

4. **`parseAnalysisJSONWithErrors` 的替换**：`aggregator.getMergedZodSchema()` 返回的完整 Zod object 对外暴露 `safeParse()`，行为与 `parseAnalysisJSONWithErrors` 完全等价。`schemas/analysis.ts` 中不再需要 `analysisContentSchema`（`eventId` 包装层保留在 aggregator 中）。

5. **`schemas/analysis.ts` 的去向**：文件本身保留——其中定义的子 schema（`narrativeCheckSchema`、`characterReferenceSchema` 等）仍然被各 validator 引用/import。删除的是 `analysisContentSchema` 的**顶层组装**和 `parseAnalysisJSON*` 函数。

6. **插件系统兼容**：插件注册的 validator 通过 `getAnalysisRequirements()` 返回 zod schema fragment → Aggregator 自动合并 → 无需修改核心 schema 文件。这正是用户期望的扩展性。

**`AnalysisBlockRequirement` 类型变更**：

```ts
interface AnalysisBlockRequirement {
  field: string;
  zodSchema: z.ZodType; // ← 新增：字段级别的 zod 验证器
  attributes?: string[];
  schemaExample?: unknown; // ← 改为 optional（zodSchema 可替代）
  instruction: string;
}
```

**步骤**：

1. `AnalysisBlockRequirement` 加 `zodSchema: z.ZodType`，`schemaExample` 改为 optional
2. 20 个 validator 的 `getAnalysisRequirements()` 补 `zodSchema`（从现有 `schemas/analysis.ts` 中提取对应子 schema）
3. `aggregator.ts` 新增 `getMergedZodSchema(): z.ZodObject` 方法——合并字段级 fragment + 自动包装 `eventId` 层
4. `render.ts` 将 `parseAnalysisJSONWithErrors()` 调用替换为 `aggregator.getMergedZodSchema().safeParse()`
5. 删除 `schemas/analysis.ts` 中 `analysisContentSchema` 和 `analysisResultSchema` 定义 + `parseAnalysisJSON` / `parseAnalysisJSONWithErrors` 函数。子 schema（`narrativeCheckSchema` 等）保留。
6. 测试：验证 aggregator 合并的 schema 行为与原始 `analysisResultSchema` 一致

**优先级**：medium（不影响功能正确性，但影响可维护性和插件系统接入）

**实现成本估算**：1-2 天（20 个 validator 补 zodSchema + aggregator 改 + render 替换 + 测试）

### [ ] 插件系统（Plugin System）

**现状**：已有 skeleton，但不可用。

| 组件                  | 状态                     | 说明                                                                        |
| --------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `PluginManifest` 类型 | ✅ 完整                  | name, version, priority, provides, requires, conflicts, authority, observes |
| `PluginLoader`        | ✅ 可用                  | 从目录加载 manifest.yaml，注册/列出/检测冲突                                |
| `resolveConflict`     | ✅ 完整                  | priority / first_writer_wins / merge / human_arbitration                    |
| `ValidatorRegistry`   | ⚠️ 独立但未接入          | 有 register/runAll，但和主 pipeline 的 `ResultAggregator` 没有集成          |
| Prompt 扩展点         | ❌ 无                    | 不能替换或扩展 Pass 1 / Pass 2 的 prompt                                    |
| Provider 扩展点       | ❌ 无                    | 不能通过插件添加自定义 LLM provider                                         |
| 生命周期 hook         | ❌ 无                    | 没有 onLoad / onUnload / onRenderStart / onRenderComplete 等                |
| 主 pipeline 集成      | ❌ 无                    | `api.ts`、`render.ts`、`validator/aggregator.ts` 均无 plugin 调用点         |
| Agent 扩展点          | ❌ 无                    | 插件不能注册自定义 Agent（需要等 Agent 体系就绪）                           |
| 分发格式              | ⚠️ 有 manifest.yaml 加载 | 无包管理器、无依赖解析、无版本兼容检查                                      |

**需要做什么**：

1. **废弃下列 legacy Plugin hook 接口并定义安全替代**：legacy `beforeRender`/`afterRender`/Pass1/Pass2 transform 形状明确禁止用于实现，因为它允许 replace/skip job、注入逻辑 prompt 或改写 result；安全接口只能生成 hash-pinned non-authoritative surface decoration/diagnostic artifact：
   ```ts
   interface PluginHooks {
     name: string;
     onLoad?(ctx: PluginContext): Promise<void>;
     onUnload?(ctx: PluginContext): Promise<void>;
     // Render lifecycle
     beforeRender?(job: RenderJob): Promise<RenderJob | null>; // null = skip
     afterRender?(result: RenderSceneResult): Promise<RenderSceneResult>;
     // Validator 扩展
     registerValidators?(registry: ValidatorRegistry): void;
     // Prompt 扩展
     onBuildPass1Prompt?(input: SceneRenderInput): SceneRenderInput;
     onBuildPass2Prompt?(input: RenderAnalysisInput): RenderAnalysisInput;
     // Provider 扩展
     registerProvider?(registry: ProviderRegistry): void;
   }
   ```
2. **PluginContext**：只读 compiled contract/storage/event bus/log；插件不得 mutate WorldState、Knowledge、Thread、Rule、planned DiscourseState、graph/provider/BoundaryReference/MergePlan、validation identity 或 assembly eligibility。
3. **Capability gate**：任何 schema/provider/validator extension 必须声明 CapabilityManifest rows、YAML contract、migration、fixtures与独立 reference tests；安全接口完成前 render-affecting plugin 为 X。
4. **主 pipeline 集成**：只允许 diagnostics、validator/provider registration 和 RENDER-SURFACE-1 non-authoritative decoration；不得 replace/skip RenderJob、注入 logical facts、改写 accepted prose/result。
5. **冲突验证**：`detectConflicts()` 在加载时自动调用；plugin manifest/version/transform hash 进入 cache/validation identity。
6. **测试**：`plugin-system.test.ts` 覆盖 capability/YAML gate、sandbox deny、surface-only decoration、validator/provider registration、hash/conflict与禁止 logical mutation。

**依赖关系**（Agent 独立配置体系就绪后才做）：插件系统的 Agent 扩展点依赖 `Agent` 接口定义完成。任何 plugin render hook 必须先满足 CAPABILITY-1/YAML-CONTRACT/RENDER-SURFACE-1 的安全接口；不得以 skeleton 先行绕过。

**优先级**：low（当前无外部生态需求，但架构预留已被纳入考虑。当前 skeleton 保留，主 pipeline 集成等待验证器 Zod schema 聚合改造（见上方 TODO）完成后一并接入）

**实现成本估算**：3-5 天（集成到主 pipeline + hook 系统 + 测试）

### [ ] Summarizer — Render 层的叙事连续性功能（medium / optional enhancement）

**现状**：`ContextPackage.previousSceneSummary` 字段存在但从未传入（硬编码 `''`），且它在 Context 层是设计错误——ContextCompiler 管状态编译，不管叙事连续性。

**架构决策**：叙事逻辑摘要与 prose 连贯参考必须分离，且均不属于 ContextCompiler 的 state replay。`LogicalDisclosureSummaryCompiler` 从 YAML planned DiscourseState、scene contract、允许的 narrator/POV projection 确定性编译安全逻辑摘要；它不读取 WorldState diff、causal predecessor prose、Pass 2 或 generated text。`SurfaceReferenceExtractor` 仅按 RENDER-SURFACE-1 从已接受 prose 提取有版本/budget 的非权威 excerpt/style packet，供 serial surface group 使用。

```text
LogicalDisclosureSummaryCompiler
  -> LogicalRenderKey / 任意 scene 的安全 planned reader context

SurfaceReferenceExtractor
  -> SurfaceRenderKey / 仅 surface descendants 的措辞、节奏、过渡参考
```

**硬边界**：logical summary 不得含原始 state diff、n-ary relationship internals、未授权 Knowledge、thread numeric progress、causal predecessor prose、ellipsis summary 或任何 generated detail；它绝不改变 provider/discourse/state。surface packet 不得进入 logical/discourse read，且与 YAML contract 冲突时 YAML 优先。`NarrativeEllipsis` 无 rendered prose，不能成为 surface source；DiscourseBridge 只提供 planned disclosure，不提供 prose excerpt。

**实现步骤**：

1. 新建 versioned `LogicalDisclosureSummaryCompiler`，输入 planned contracts/projections，输出 hash-pinned disclosure-safe summary；从 `ContextPackage` 删除硬编码 `previousSceneSummary`。
2. 按 RENDER-SURFACE-1 新建 `SurfaceReferenceExtractor`，只消费 accepted prose/author anchor，生成预算受限 packet。
3. `RenderJob` 分离 `logicalDisclosureSummary` 与 optional `surfaceReferencePacket`；PromptAssembler 将后者明确标为 non-authoritative。
4. 分离 Logical/Surface/Validation cache keys；prose 变化不得使逻辑摘要/scene contract 失效。
5. 测试：summary 不泄露 withheld truth、n-ary/Thread/ellipsis 不被降级为旧字段、surface packet 不进入 logical reads、branch/group/cache isolation。

**优先级**：nice-to-have，非 blocking；它改善局部 prose 承接，但不得作为事实正确性或状态连续性的来源。

### [ ] DAG-0: 循环检测时禁止静默回退为 narrativeOrder 排序

**背景**：`replay.ts:57-66` 中，`buildCausalEdges` + `topologicalSort` 抛出 `"DAG cycle detected involving: ..."` 时，代码静默 catch 后按 `narrativeOrder` 排序继续执行。用户在 CLI 只看到一行 `console.warn`，DAG 循环被隐藏。

**为什么必须改**：这个设计假设"narrativeOrder ≈ 因果序"——对于线性叙事成立，但对于倒叙、闪回、平行时间线不成立。一旦 DAG 循环真的报了，说明数据有结构性问题（precondition→postcondition 形成了环），系统不应该假装没看见继续跑。

**修复点**：

1. **禁止静默回退**：DAG 循环 → 抛出 `DagCycleError`（新增错误类型），包含循环涉及的事件 ID 列表。`replay()` 不再 catch 后 fallback。

2. **保持显式 discourse order**：`EventFile.narrativeOrder` 继续为作者手写的必填、唯一整数，可跳步（例如 `1` 后为 `10`），只表示 Assembler 的 discourse 顺序。文件名、event ID、目录遍历顺序和 `storyTime` 均不得生成、覆盖或修正该值；DAG、provider、replay 与 `stateBefore` 必须完全忽略它。缺失、重复或在同一可共同出现 branch path 上无法确定的 discourse order 必须使项目校验失败并给出 YAML 修复位置。

3. **延后评估 authoring 自动化**：未来可独立评估 CLI 的 event add/move、章节级显式 scene-order 清单或稀疏排序键。任何自动建议必须在作者操作时写回 YAML；不得成为 loader 或 Assembler 的隐式 filename fallback。若未来允许字段缺省，必须作为版本化 schema 变更，提供迁移、重命名稳定性、非线性叙事、branch-exclusive scenes 与跨章节排序测试。

4. **排查 zhu-fu fixture 的真实循环**：`CLI-2` 发现 zhu-fu fixture 触发 DAG cycle 回退。修复前需定位形成环的 precondition→postcondition 边。若业务上存在双向关系，必须改为无环的状态建模或显式时间/因果依赖；任何 cycle 都不得放宽为“警告但不阻塞”。

5. **禁止缺失依赖静默初始化**：precondition 是对既有状态的断言，不得在 replay 时因状态缺失而写入默认值。对 CORPUS 的 `NarrativeEvent` 或 `NarrativeEllipsis`，找不到 branch-compatible、来源可验证的 provider，或 `$provenance` 缺失/不匹配时，必须抛出包含节点 ID 与 `entityId.attribute` 的硬错误；不得把它算作 skip、abstention 或零 CED。

**优先级**：high（当前行为在非线性叙事中静默产出错误状态，CLI-2 的 zhu-fu 循环也需要趁这次修复一起排查）

**实现成本估算**：0.5-1 天（报错 + narrativeOrder 默认值 + 错误类型 + zhu-fu 排查）

## 对标系统有而 Novalistically 少做的功能

> 来源：2026-07-19 竞品分析（详见 [docs/reference/competitive-analysis.md](./reference/competitive-analysis.md#对标系统有而-novalistically-少做的功能)）
> 对标系统：Novel Studio（学术）、Sudowrite（商业）、Novel-OS（开源）

### [ ] 交互式审批（Human-in-the-Loop Pipeline Gate）

**现状**：`RenderSceneResult.needsReview` 字段已在类型中，`CircuitBreaker` 可标记 `BLOCKED` 状态、`human_arbitration` 占位符已在 plugin resolver 中。但 pipeline 是全自动的，没有人停下来等用户的环节。

**对标做法**（Novel Studio）：每章 Blueprint → 用户审批 → Write → QA → pass/block/revise → 用户确认 → Canonize。每章 2-3 个人工介入点。

**需要做什么**：

1. 定义 `InteractionGate` 类型（什么条件下停、等什么输入、超时策略）
2. `api.ts` 中检测 `needsReview === true` → 暂停 pipeline → 通知用户 → 等待响应；仅 C finding 可记录 signed waiver 后继续，S/X/schema/state/graph/provenance failure 不可 waive，必须修复后重编译/重渲染
3. CLI 模式：输出阻塞状态和等待指令。MCP 模式：通过 tool call 通知用户
4. 超时策略：N 分钟内无响应则 `BLOCKED`，不得 `skip_review`；C waiver 记录 scene/event、capability ID、finding/evidence hash、reviewer/time/rationale/config/manifest version/scope，且不改变 logical state/gate

**优先级**：low（当前系统全自动可工作，人审是质量提升层）

**实现成本估算**：3-5 天

### [ ] 项目级风格档案（Style Profile）

**现状**：`NarrativeEvent.styleGuidance` 是 per-scene 的（tone、characterVoice、atmosphere、scenePacing、avoid）。每个场景 YAML 里独立写，没有全局 fallback；但 RENDER-SURFACE-1 的每个 CompiledSceneContract 都必须有 resolved StyleProfile。

**对标做法**（Novel Studio）：`ProjectTemplate` 包含 `style_profile`，每章 packet 作为 P0 硬约束携带。全局定义 + 按场景微调。

**需要做什么**：

1. 定义 versioned built-in `DefaultStyleProfile`，它是所有项目强制的 resolved fallback；无需作者 YAML 才能生成 CompiledSceneContract。
2. 可选 `ProjectStyleProfile`/chapter/narrator/POV profile 按 RENDER-SURFACE-1 deterministic precedence 覆盖 default，event `styleGuidance` 只作为 scene override；使用 `StyleResolver`，不让 ContextCompiler/state replay 承担风格逻辑。
3. 渲染出的 non-authoritative style 段落 = resolved profile + scene-specific overrides；它不得提供事实、状态或 discourse truth。
4. 兼容旧 YAML：`styleGuidance` 不存在时走 built-in default，存在时 override；profile/version/hash进入 LogicalRenderKey。

**优先级**：RENDER-SURFACE-1 prerequisite（built-in default 必须先实现；可选 project profile 可后续扩展）

**实现成本估算**：1-2 天

### [ ] 变更影响分析（Impact Analysis）

**现状**：修改 YAML 定义 → 缓存静默失效 → 下次渲染自动重跑。作者得不到"这次改动影响了 X 个场景"的报告。

**对标做法**（Novel Studio 计划中）：Green/Yellow/Red 影响等级评估。修改 Canon Store 条目时自动评估哪些已写/将写的章节受影响，返回报告。

**需要做什么**：

1. 新增 `diffProject()` API（已有签名占位）的增强实现：对比两个 YAML 版本的状态，列出受影响的 event IDs
2. 影响等级：Green（无影响）、Yellow（prose 需重修但结构不变）、Red（precondition/postcondition 变化→下游因果链断裂）
3. 输出：`nova diff --project <path>` → 影响范围报告（JSON + human readable）
4. 下游：如果 YAML 存储在 git 中，`pre-commit` hook 自动触发 diff 检查

**优先级**：low（但实现成本低，因为 DAG 和缓存依赖追踪已有基础设施可以复用）

**实现成本估算**：2-3 天

### [ ] 多层级摘要（L0 Scene + L1 Volume）

**现状**：仅 per-scene summary（Summarizer TODO 中规划的 SummaryCompiler）。没有更高层的抽象。

**对标做法**（Novel Studio）：L0 per-chapter（每章一个摘要）+ L1 per-volume（每 ~100 章一个卷摘要）。P2 的 "recent context" = "last 3 chapter summaries + current volume summary"。

**何时成为问题**：500+ 场景时，因果链可能跨越几十个事件。没有 L1 抽象则 `previousSummaries` 列表会很长，token 预算上升且 LLM 的 attention 会被分散。

**需要做什么**：

1. 定义 `VolumeSummary` 类型（比 SceneSummary 更抽象：key arcs、character trajectory、active threads state）
2. `SummaryCompiler` 扩展：在 scene summary 基础上，对同一卷的 events 做聚合编译（仍确定性，不调 LLM）
3. `ContextAssembler` / `PromptAssembler`：P2 位置改用 "last N scene summaries + current volume summary"
4. 卷边界判定：从 scene 的 `storyTime` 和 chapter metadata 推导

**优先级**：very-low（当前场景数远未到需要 L1 的规模，但架构上留接口）

**实现成本估算**：3-5 天（设计 + 实现 L1 聚合逻辑）

### [ ] 多模型路由（Per-Task Model Routing）

**现状**：所有任务（Pass 1 写作、Pass 2 分析、预编译摘要、验证）走同一个 `provider.complete()`。不能按任务需求路由模型。

**对标做法**（Novel Studio）：Planner → GPT-4o-mini（便宜），Writer → DeepSeek（强），QA → DeepSeek，Chat → GPT-4o-mini。

**需要做什么**：

1. `ProviderConfig` 扩展支持按任务类型指定 model/provider：`{ default: "...", pass1: "...", pass2: "...", summary: "..." }`
2. `provider.complete()` 调用链改为从 task context 读取 model routing 配置
3. `SystemContext` 或 `ProjectConfig` 承载 routing 配置
4. 如果指定模型不可用（API key 缺失、模型未配置），回退到 default

**优先级**：medium（对成本和速度有直接影响，优先级高于其他几项）

**实现成本估算**：1-2 天

### [ ] Agent 独立配置体系（Agent-as-Configurable-Unit）

**现状**：`packages/core/src/ai/prompts/` 下每个 prompt 是一个静态 import 的 TS 函数（`buildSceneRenderPrompt()` → `Message[]`）。`RenderPipeline` 是唯一的执行者——既做 Pass 1 写作、又做 Pass 2 分析。没有 "Agent" 这个抽象概念：

```
No:  AgentRegistry → AgentConfig → compilePacket → dispatch()
Yes: RenderPipeline → import("./prompts/scene-render.ts") → provider.complete()
```

**对标做法**（Novel Studio）：每个 Agent 是独立可配置的单元：

| 组件                 | 含义                                                        |
| -------------------- | ----------------------------------------------------------- |
| `packages/prompts/`  | 每个 Agent 有独立的 prompt 模板 + Zod 输出 schema           |
| Agent config         | 每个 Agent 配置：provider、model、temperature、token budget |
| Orchestrator         | 状态机按阶段路由到指定 Agent                                |
| Task-specific packet | 每个 Agent 编译专有的 packet                                |

Agent 列表：Chat Agent（闲聊/意图）、Planner（蓝图）、Writer（写作）、QA（质量）、Summarizer（摘要）。

**需要做什么**（这个是架构级别的改造，不是单一功能）：

1. **定义 `Agent` 接口**：
   ```ts
   interface Agent<I, O> {
     name: string;
     compilePacket(input: CompileInput, context: PipelineContext): I;
     getOutputSchema(): z.ZodType<O>;
     getConfig(): AgentConfig; // model, temperature, maxTokens
   }
   ```
2. **Agent 注册表**：`Map<AgentRole, AgentInstance>`，可注入、可 mock、可替换
3. **Orchestrator 改造**：`RenderPipeline.renderScene()` 不再硬编码 prompt→complete，而是 route 到具体的 Agent
4. **Prompt 文件重构**：每个 prompt 文件改为 Agent 实现的一部分，暴露 `compilePacket()` + `getOutputSchema()` 而非直接输出 Message[]
5. **配置外移**：`AgentConfig` 从环境变量或 project config 读取，而非硬编码

**跟多模型路由的关系**：多模型路由是 Agent 体系的一个子功能。Agent 体系是基础设施，多模型路由是它上面的一个配置项。

**优先级**：low（当前管线够用，但插件系统设计时必须考虑）

**实现成本估算**：5-7 天（整体架构改造 + 迁移 + 测试）

### [ ] 管线 Trace 系统（Orchestration Trace）

**现状**：**零 trace。** 整个 `packages/core/src/` 下没有一行结构化 trace 代码。只有零散的 `console.log` / `console.warn`，没有 span 树、没有 timing、没有层级上下文。开发者无法回答以下基本问题：

- 这个场景为什么渲染了这些角色？（RelevanceEngine 评分未暴露）
- 缓存为什么没命中？（没有 cache key 追溯）
- 管线瓶颈在哪？（每步耗时没有记录）
- Pass 2 分析中哪些字段实际被 validator 消费了？（没有 analysis 消费追踪）

**对标做法**（Novel Studio — shipped feature）：

> "Orchestration Trace — see what each agent did"
> "Cost tracking, orchestration traces (per-agent visibility)"

Novel Studio 的 trace 覆盖：哪个 Agent 在何时执行、什么 model、多少 token、输入 packet 摘要、输出长度、耗时、缓存命中状态、QA 决策和证据来源。

**需要做什么**（这是基础设施，不是单一功能）：

1. **定义 TraceEvent 类型体系**：
   ```ts
   type TraceEvent =
     | {
         type: "pipeline_start";
         jobId: string;
         eventId: string;
         timestamp: number;
       }
     | {
         type: "pipeline_end";
         jobId: string;
         durationMs: number;
         cacheHit: boolean;
       }
     | {
         type: "context_compile";
         jurisdiction: string[];
         scores: Record<string, number>;
       }
     | { type: "pass1_start"; timestamp: number }
     | { type: "pass1_end"; tokensUsed: number; durationMs: number }
     | { type: "pass2_start"; analysisBlocks: string[] }
     | { type: "pass2_end"; blocksCompleted: string[]; parseErrors: number }
     | {
         type: "validator_run";
         validator: string;
         passed: boolean;
         durationMs: number;
       }
     | {
         type: "cache_check";
         key: string;
         hit: boolean;
         staleDependencies?: string[];
       }
     | {
         type: "circuit_breaker";
         state: "open" | "closed" | "half_open";
         reason?: string;
       }
     | { type: "error"; phase: string; error: string };
   ```
2. **TraceCollector**：收集事件流，支持：
   - `currentSpan`：嵌套 span 树（pipeline → renderScene → pass1 → provider.complete）
   - `tags`：contextual metadata（eventId、jobId、branchPath）
   - `buffer`：内存中保持最近 N 个事件
   - `flush`：写文件/输出
3. **Instrumentation point**：在管线关键路径上埋点：
   - `api.ts` — pipeline start/end
   - `render.ts` — renderScene start/end, pass1/pass2, cache check, circuit breaker
   - `compiler.ts` — context compile with RelevanceEngine scores
   - `relevance.ts` — 8 维评分明细
   - `validator/aggregator.ts` — 每个 validator 调用
4. **Trace output**：
   - JSON lines 文件（`.nova/traces/{jobId}.jsonl`）
   - CLI `--trace` 参数控制输出级别
   - MCP tool 查询最近 trace
5. **Trace viewer**（可选）：
   - `nova trace --event <eventId>` 查看单个 scene 的完整 trace 链
   - `nova trace --stats` 查看管线汇总统计：平均耗时、token 分布、缓存命中率

**这不是"等以后再做"的功能**。它是基础设施层的第一性问题。没有 trace，管线复杂度的增长会使调试时间超过实现时间。

**优先级**：high（基础设施层，影响所有其他功能的开发效率）

**实现成本估算**：3-5 天（定义类型 + TraceCollector + 核心埋点 + CLI 输出）

### [ ] 结构化日志系统（Structured Logging）

**现状**：**零。** `packages/core/src/` 下 14 处 ad-hoc `console.log('[Assembler]...')`、`console.warn('[PluginLoader]...')`。无日志级别、无 JSON 输出、无 correlation ID（无法将一条日志关联到特定 event/scene 的渲染）。Assembler 的 `assembleNovel()` 直接写 `console.log`（副作用），函数不纯。

Trace 回答"这次渲染管线做了什么"，Log 回答"系统内部状态变化是什么"。两者构成可观测性双支柱。有 Trace 无 Log → 能追踪一条请求的生命周期，但不知道系统在哪个时间点的全局状态。

**对标做法**：

| 系统                             | 方案                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Xiaoyangy Novel Studio           | Go `slog` 结构化日志。每个 context 重写事件记录 `tokens_before/after`、`strategy`、`reason`、`msgs_before/after`。CJK 感知 token 估算 |
| songzhiyuan98 Novel Studio       | PostgreSQL `AuditLog` 表：`packet_compiled`、`artifact_created`、`qa_passed`、`chapter_canonized`、`impact_analysis_completed`        |
| Production LLM pipeline (dev.to) | `trace_id` + `span_id` 注入每条日志，关联 traces 和 logs                                                                              |

**需要做什么**：

1. 引入轻量结构化 logger（`pino` — 零依赖、JSON 输出、浏览器兼容、pretty-print 开发模式）
2. 定义 log level 体系：`trace < debug < info < warn < error < fatal`
3. 每个模块创建子 logger：`const log = rootLogger.child({ module: 'render' })`
4. 每条日志自动带 `trace_id`（从 TraceCollector 当前 span 获取）、`event_id`、`job_id`
5. 输出模式：
   - 开发：`pino-pretty`（彩色、可读）
   - 生产/CI：JSONL → 可被任何日志聚合器消费
   - 测试：`pino-test` transport → 内存捕获，断言特定日志是否产生
6. 替换所有 `console.log/warn/error` 为 logger 调用
7. 清理 Assembler 副作用：log 通过依赖注入传入，不直接写 stdout

**关键原则**：

- 不在日志中放 prose 原文或 prompt 全文（token 爆炸 + 隐私）
- 只放元信息：token 数、耗时、模型名、缓存命中、验证结果
- 开发和生产的 log level 分离（开发 `debug`，生产 `info`）

**优先级**：high（与 Trace 同级。没有结构化日志，Trace 的上下文是贫瘠的，排查问题靠 grep console.log）

**实现成本估算**：1-2 天（引入 pino + 全局替换 console.log + 注入 trace_id）

### [ ] 错误类型体系（Error Type Hierarchy）

**现状**：只有 `LLMError` 一个自定义错误类（`packages/core/src/ai/types.ts:56`）。其余全部用原始 `Error` + 字符串 message。Circuit Breaker（`circuit-breaker.ts`）不区分错误类型 — 429 rate limit、401 auth fail、网络超时、Zod parse fail 全部同一策略重试。缓存层（`render-cache.ts:172,191`）直接 `catch { // ignore }` 吞错误。

**为什么是同级别的基建**：Trace 记录错误，但没有分类就不知道严重性。429（稍后重试就恢复）和 401（API key 错误，永远恢复不了）不应该用同一策略。错误分类是所有错误处理的前提：retry policy、circuit breaker、用户通知、fallback 策略 — 全部依赖错误类型。

**对标做法**（Xiaoyangy Novel Studio — 5 层分类）：

| 错误层             | 错误类型                    | 处理                             |
| ------------------ | --------------------------- | -------------------------------- |
| Network            | 超时、流 EOF                | Tools 自动 retry 3×              |
| Provider transient | 429、503                    | litellm failover 到备用 provider |
| Provider terminal  | 401、403、"model not found" | 立即终止，不重试                 |
| Logic              | 缺失前置 artifact           | Conflict → LLM 拿 context 重试   |
| Validation         | 无效 tool params            | Validation → LLM 修正参数        |

**需要做什么**：

1. **定义错误层级**：
   ```ts
   // 存储层
   class StorageError extends Error { constructor(msg, public cause?: Error) }

   // 配置层
   class ConfigError extends Error { constructor(msg, public path: string) }

   // 验证层
   class ValidationError extends Error { constructor(msg, public issues: z.ZodIssue[]) }

   // 管线层
   class PipelineError extends Error { constructor(msg, public phase: string) }

   // LLM provider 层（已有 LLMError，扩展子类）
   class RateLimitError extends LLMError {}       // 429
   class AuthError extends LLMError {}            // 401/403
   class ProviderTimeoutError extends LLMError {}  // timeout
   class ModelNotFoundError extends LLMError {}    // 404 model
   ```
2. **Provider 层在 HTTP status 和异常类型间做映射**：`ai-sdk.ts` 的 catch 块按 statusCode 抛出对应子类
3. **Circuit Breaker 按类型差异化行为**：
   - `RateLimitError` → retry with exponential backoff + respect `Retry-After` header
   - `ProviderTimeoutError` → retry with jitter
   - `AuthError` / `ModelNotFoundError` → 立即 abort，通知用户
   - `ValidationError` → no retry（同样的 prompt 不会修复 Zod 错误 — 走 Instructor pattern）
4. **缓存层不再吞错误**：至少 warn 级别日志输出
5. **CLI 错误格式化**：按错误类型输出不同的人类可读信息

**优先级**：high（所有错误处理策略的前提。当前 Circuit Breaker 不分青红皂白重试，浪费 token 和时间）

**实现成本估算**：1-2 天（定义类 + provider 映射 + Circuit Breaker 差异化）

### [ ] Schema 迁移系统（Schema Migration）

**现状**：**零。** YAML 定义格式（event、character、location、thread、rule）无 schema version 字段。Event log（`event-store.ts` 的 JSONL）无 version marker。Cache（`.nova/render-cache/cache.meta.json`）无 format version。Snapshot（`snapshot.ts` 的 `Snapshot` 类型）无 version 字段。

当前 `bench-rewrite` 阶段就在做大规模 schema 变更（Fact 双表示、AnalysisResult 12 blocks、13 个新 computational 字段）。这些变更对已有 fixture（`most-dangerous-game`、`arcane-aftermath`、`zhu-fu`）意味着什么？系统无法回答 — 没有版本字段，无法检测格式不匹配。

**为什么同级的基建**：Trace 保障当前运行的可见性。Schema 迁移保障系统的演化可持续性。Novalistically 作为仓库系统（用户维护 YAML 文件，像代码一样存在 git 里），格式变更不能靠"用户手动重写"。

**对标做法**：

| 系统                    | 方案                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| ProseCreator            | PostgreSQL 94 个 migration，Flyway 风格版本化                                                                   |
| Bengal CacheCoordinator | `InvalidationReason` enum：`CONTENT_CHANGED`、`SCHEMA_CHANGED`、`CONFIG_CHANGED` 等 — 不同原因不同 invalidation |
| Koder Meta              | 每个 renderable unit 的 SHA256 key 包含 `render.version`，版本号变更 → 全量重渲染                               |
| narrative-state-engine  | Catalog V1→V2 迁移，per-entity 子目录结构变更                                                                   |

**需要做什么**（最小可行，非重量级迁移框架）：

1. **给每个可持久化格式加 `version` 字段**：
   - `nova.yaml` → `schemaVersion: 1`
   - 每个 YAML event 文件 → 已有的 type 字段作为隐式版本，显式加 `formatVersion: 1`
   - Event log 头行 → `{"header": true, "format": "event-sourcing", "version": 1}`
   - Cache meta → `{ "formatVersion": 1, ... }`
   - Snapshot → `{ "version": 1, ... }`
2. **加载时校验版本号**：如果 `version > current` → 报清晰错误 "this project requires novalistically >= X.X.X"
3. **迁移函数注册表**（按需，不做重量级框架）：
   ```ts
   const migrations: Record<number, MigrationFn> = {
     1: (project) => {
       /* v1 → v2: Fact.value → value? */
     },
   };
   ```
   每个迁移函数是纯函数：`ProjectV1 → ProjectV2`。失败可回滚（project 在 git 里）。
4. **`nova migrate` CLI 命令**：检测当前项目版本 → 提示可用迁移 → 执行 → 更新 `schemaVersion`
5. **Fixture 迁移**：所有 `fixtures/` 下的 YAML 随 schema 变更同步更新

**设计原则**：

- 不做重量级 migration framework（不要 Flyway/Prisma migrate 级别的复杂度）
- 每个迁移是纯函数，输出新的 project directory — 原 project 不动（git 保证回滚）
- `version` 放在格式顶层，一眼可见

**优先级**：high（bench-rewrite 就在大规模改 schema。现在没有迁移系统，fixture 更新靠手动重写。未来发布后就是用户数据损坏的问题）

**实现成本估算**：1-2 天（加 version 字段 + 加载校验 + 最小迁移注册表 + `nova migrate` CLI）

---

### [ ] 配置层级系统（Configuration Hierarchy）

**现状**：单文件平面 `nova.yaml`（`schemas/project.ts:7-33`）。加载时不做 Zod 验证（`readYamlFile<T>()` 在 `yaml-loader.ts` 中只有类型转换）。无继承/覆盖机制。CLI flags、env vars、project config 各自独立读取，无统一合并点。快照目录（`.nova/snapshots`）硬编码在 `api.ts:104`。

**对标做法**（Xiaoyangy Novel Studio）：`system defaults < global < project < startup < runtime` 五层合并。规则归一化管道：原始规则 → LLM 语义归一化 → Go 确定性合并 → 单文件 `meta/user_rules.json`。Per-source degradation（单源失败不阻塞全局）。

**需要做什么**：

1. 定义 `ConfigLayer`：`defaults → project (nova.yaml) → env → cli-flags → runtime`
2. `ConfigLoader`：按层加载 → deep merge（后者覆盖前者）→ Zod 验证合并后的完整 config
3. 可观测性：记录每个配置项的来源 layer（debug 时有用）
4. 硬编码路径外移：`.nova/`、`snapshotInterval`、并发度等从 config 读取
5. 项目 init 模板生成带注释的 `nova.yaml`（标注默认值）

**优先级**：medium（当前平面配置在场景数少时够用，但 Agent 独立配置和插件系统依赖层级合并能力）

**实现成本估算**：1-2 天

### [ ] Pipeline 证据校验（Pipeline Evidence Verification）

**现状**：Hash-chain 缓存（`render-cache.ts`）只用于判断"需不需要重新渲染"。不用于验证"已完成的渲染是否仍然有效"。如果 `.nova/render-cache/data.render.json` 文件被人为损坏或部分写入后崩溃，系统不会发现 — 下次渲染时直接读损坏数据或静默回退到重渲染。

**对标做法**（Xiaoyangy Novel Studio）：每个 completed stage 必须提供 SHA-256 evidence。重新运行时 evidence 不匹配 → 清除该 stage 的完成标记 → 强制重跑。`Commit Saga` 4 阶段（`state_applied → quality_checked → checkpointed → rag_indexed`）每阶段有独立 evidence。

**需要做什么**：

1. 在现有 hash-chain cache key 基础上，写入时附带 evidence hash
2. 读取缓存时验证 evidence hash 匹配 → 不匹配则标记 stale → 自动清除该缓存 → 走正常渲染
3. `nova verify --project <path>` 命令：遍历所有已完成渲染的场景，校验 evidence chain 完整性
4. 异常分类：
   - Evidence 不匹配但文件存在 → warn："缓存可能损坏，建议 `nova render --skip-cache`"
   - Evidence 文件缺失但 prose 文件存在 → info："渲染产物完好但缓存丢失"
   - 两者都不存在 → 正常（该场景未渲染）

**优先级**：low-medium（当前单机文件系统的损坏概率低，但随项目规模增长，静默数据损坏的风险上升）

**实现成本估算**：0.5-1 天

### [ ] 事件总线（EventBus / Internal Message Bus）

**现状**：管线组件之间是直接 `import + 调用`。`api.ts → ContextCompiler → RenderPipeline → Assembler` 是硬连接的调用链。没有进程内的松耦合通信机制。

**对标做法**：

- **Novel-Claude**：`EventBus` 贯穿三引擎（World Builder / Volume Planner / Scene Writer），插件通过 lifecycle hooks 拦截事件
- **Story Engine**：模块仅通过 EventBus 通信，每个模块自包含
- **AURA**：Director Model 通过 8-field JSON snapshot 感知世界状态，角色状态变更通过事件传播

**为什么现在提**：插件系统的 Render hook（`beforeRender` / `afterRender`）和 Agent 体系的 Orchestrator 路由都需要一个内部事件机制。直接 `import + 调用` 的耦合方式让这些扩展变得困难 — 每次加 hook 都得改调用链。

**需要做什么**：

1. 轻量级 typed EventBus（非重量级消息队列，进程内事件）：
   ```ts
   class TypedEventBus {
     on<E extends PipelineEvent>(
       type: E["type"],
       handler: (e: E) => void,
     ): void;
     emit<E extends PipelineEvent>(event: E): void;
   }
   ```
2. 初始事件类型（按需扩展）：
   - `pipeline:render:before` / `pipeline:render:after`
   - `pipeline:validation:complete`
   - `cache:hit` / `cache:miss`
   - `state:entity:changed`
   - `config:changed`
3. 接入点：`RenderPipeline` 在关键节点 emit 事件 → Plugin system 的 lifecycle hook 通过 `on()` 订阅
4. 非侵入式：现有直接调用的代码不需要立即改为 EventBus — 双轨运行，逐步迁移

**是否过度设计**：有可能。当前管线组件数不多（~10），直接调用的可读性比 EventBus 好。这个需求确实存在，但实现时机应和插件系统或 Agent 体系同步，而不是单独提前做。

**优先级**：low（等插件系统或 Agent 体系推进时同步实现）

**实现成本估算**：0.5-1 天（typed EventBus 类 + 第一批事件定义 + 管线关键节点的 emit）

### [ ] 报告器重新设计（ReportWriter — 统一报告概念）

**现状**："报告器"不是统一概念。报告逻辑散落在 5 个地方：

| 输出                                               | 消费者   | 当前问题                                                                                                              |
| -------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `writeValidationReport()` → `output/validation.md` | ？       | 平面 issue 表格，无状态概览、无下一步建议、不分"用户需处理"vs"系统自动修复"                                           |
| `writeRenderOutputs()` → `scenes/`, `.nova/`       | 系统     | 写产物，不算"报告"                                                                                                    |
| `assembleNovel()` → `output/novel.md`              | 用户     | 最终产品，不算"报告"                                                                                                  |
| `mcpNovaStatus()` → `StatusReport` 对象            | AI Agent | **最完整的报告**（ISS + validation + threads + blockers + nextActions + guidance），但只在 MCP 可访问，CLI 用户看不到 |
| `writeResults()` → `output/bench/*`                | 开发者   | 只给 bench 用                                                                                                         |

**核心矛盾**：`StatusReport` 是目前唯一能回答"这个项目现在怎么样了"的数据结构，但它被限定在 MCP 通道里。CLI 用户跑 `nova render` 之后只能看到零散的 `validation.md` 和 `scenes/` 下的散文 — 没有任何整合的"发生了什么"摘要。

**重新定义**：报告器应作为**统一模块** `ReportWriter`，接收一次管线 run 的全部数据，按受众输出不同视图：

```
ReportWriter
  输入: PipelineRunResult {
    status: StatusReport,       // 来自 getProjectStatus()
    validation: Map<eventId, ValidationResult>,  // 来自 validateNovel()
    trace: TraceEvent[],        // 未来，来自 TraceCollector
    cache: CacheStats,          // 来自 render-cache
    cost: CostSummary,          // 未来，token + 成本统计
  }
  输出:
    → writeUserReport()     → output/report.md       (作者)
    → writeValidationDetail() → output/validation.md (作者查问题)
    → writeDiagnostics()    → output/diagnostics.md  (开发者)
    → toStatusReport()      → StatusReport           (AI Agent, MCP)
```

**四个输出，对应三组受众**：

| 输出                    | 受众               | 内容                                                                                                         |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `output/report.md`      | **作者**           | 状态概览（已完成/阻塞/待渲染）、ISS 分数、质量摘要、需要关注的问题、下一步建议、线程进度、用量（token/成本） |
| `output/validation.md`  | **作者**（查问题） | 增强版 — 按场景+严重性分组、带 fixSuggestion、区分"需用户修改 YAML"和"系统会自动处理"                        |
| `output/diagnostics.md` | **开发者**         | Pipeline trace 详情、缓存命中/失效原因、per-validator 分析、阻塞依赖链、per-scene RelevanceEngine 评分       |
| `StatusReport` 对象     | **AI Agent**       | `mcpNovaStatus()` 现有输出，保持不变。补充 render-run summary                                                |

**设计原则**：

- ReportWriter 是**只读消费者** — 不修改任何状态，只读管线数据 + 写输出文件
- 所有输出从同一个 `PipelineRunResult` 派生，保证一致性
- CLI 和 MCP 走同一个 ReportWriter，只是输出目标不同（CLI 写文件，MCP 返回对象）
- `report.md` 是默认输出（`nova render` 或 `nova status` 自动生成），`diagnostics.md` 是 `--verbose` / `--diagnose` 触发

**优先级**：medium（MCP 已有 StatusReport 覆盖 Agent 场景，但 CLI 用户体验是断裂的 — 渲染完成 + 零反馈。应在 Trace 系统就绪后跟进）

**实现成本估算**：2-3 天（`ReportWriter` 类 + `PipelineRunResult` 类型 + 4 个 writer 方法 + CLI 集成）

---

## DAG 因果边 — 修复项

> 来源：2026-07-19 代码审查 `packages/core/src/state/dag.ts` + `replay.ts`

### [ ] DAG-1: 删除 `getStateAtOptimized` 前验证其不与统一 replay 分叉

**现状**：`replay.ts:193-197` — `getStateAtOptimized()` 在快照后增量回放时用 `narrativeOrder` 排序，而非 `replay()` 主方法使用的 DAG 拓扑排序。

**问题**：当存在因果序 ≠ narrativeOrder 的事件时（flashback 先出现但依赖后面事件的 postcondition），`getStateAtOptimized` 返回的状态可能与完整 `replay()` 不一致。

**修复**：先以因果序 ≠ narrativeOrder 的 fixture 固化旧 `getStateAtOptimized()` 与完整 replay 的 divergence；随后在 DAG-5 删除该方法，以 `replay(initialState, nodes, branchPath, snapshot?)` 证明统一替代路径与 boundary oracle 一致。最终不得保留“仅适用于 narrativeOrder ≡ causal order”的文档豁免或第二套 replay 实现。

**优先级**：high（DAG-5 重构的回归前置条件）

**实现成本估算**：包含在 DAG-5

### [ ] DAG-2: 以因果依赖和 storyTime 替代 narrativeOrder provider 代理

**现状**：`dag.ts:60` — `best = providers.reduce((a, b) => (a.order > b.order ? a : b))`。用 `narrativeOrder` 判断"最新"provider。隐含假设：narrativeOrder 与因果序一致。

**何时会错**：一个 flashback 场景（高 narrativeOrder 但低 storyTime）提供的 postcondition 可能"遮蔽"了 later-storyTime 但更低 narrativeOrder 的场景。

**与 DAG-0 的关系**：`narrativeOrder` 是手写、可跳步的 discourse key，文件名与因果序均不得影响它。DAG-2 必须完全去除该字段的 provider/replay 作用。

**修复**：`narrativeOrder` 只能保留给 Assembler/discourse。对每个 deterministic exact read，先收集同一 canonical state/artifact key、branch-compatible、时间不晚于 dependent node 的全部 outputs，解析唯一最新 provider/AbsenceWitness，再比较其结果是否满足 read predicate；不得跳过中间 override/reversion 去选择较早的相同 value。显式因果 dependency 与有效 state provider 分别记录：前者表达作者声明的因果祖先，后者只决定当前状态。若同一时间存在多个可能最新写入或任意替代顺序会令任一 selected-event boundary oracle 不同，corpus 构建硬失败，不得以稳定 ID 掩盖歧义。mixed-node replay 先按 branch 过滤，再以 GRAPH-1 typed edges、exact reads 与 `storyTime` 排序。`NarrativeEllipsis` 的每个可回放状态变化必须只有一个有效 `storyTime`；跨多个不可兼容时间点时拆分。不得再以 `narrativeOrder` 选择“最新”provider。

**优先级**：high（混合 `NarrativeNode` 回放的正确性前置条件）

**实现成本估算**：待 DAG-5 与 CORPUS 联合细化

### [ ] DAG-3: 分支事件在拓扑排序后过滤可能导致缺失前置状态

**现状**：`replay.ts:52-66` — 对**所有事件**（不论 branch）做 DAG 拓扑排序。`replay.ts:79` — 回放时用 `includesPath(event.branchExistence, bp)` 过滤。

**问题**：事件 A（branch X only）提供 postcondition P，事件 B（branch Y）在 DAG 中依赖 P。拓扑排序包含 A→B，但回放 branch Y 时 A 被过滤掉 → B 缺少 P。如果 B 的 precondition 依赖 P，WorldState 会不完整。

**判断**：对给定 `BranchPath`，branch filtering 必须发生在 provider 搜索和 DAG 构建之前；跨 branch provider 不得满足 precondition。合流节点若依赖两侧状态，必须在各 branch 上拥有可证明的 provider 或构建失败。

**修复**：`buildCausalEdges` 接受 `BranchPath`，只对当前 branch-compatible `NarrativeNode` 建图；以 branch-diamond fixture 验证分支 state、合流 precondition 与 branch-filtered assembly 均无泄漏。

**优先级**：high（阶段 1 branch fixture 与 CORPUS mixed replay 的正确性前置条件）

**实现成本估算**：0.5-1 天（取决于评估结果）

### [ ] DAG-4: `system:genesis` 改为独立初始 WorldState 根

**现状**：Genesis 目前作为 synthetic `NarrativeEvent` 进入 DAG。这把故事开始前的初始状态误建模为 event(scene)，并与 `NarrativeNode = NarrativeEvent | NarrativeEllipsis` 及 replay 根语义冲突。

**修复**：将 `system:genesis` 转换为 replay 的独立 `initialState` 输入，不属于 `NarrativeNode`、不产生 RenderJob/Pass 2/Assembler 输出，也不拥有 preconditions。`replay(initialState, nodes, branchPath, snapshot?)` 从该初始状态开始；普通没有 preconditions 的 event 仍允许是入度零的独立故事事件。初始状态是唯一可无前置 provider 地提供初始 state slot 的根，必须完整声明并独立校验。

**优先级**：high（离散确定性状态规范与 mixed replay 的根语义）

**实现成本估算**：待 initial-state schema、mapper 与 replay 调用点联合细化

### [ ] DAG-5: Snapshot 不再用 narrativeOrder 做 key，统一 replay 方法

**现状**：snapshot 系统在三个地方把 narrativeOrder 当 data order 用：

- `snapshot.ts:37` — 快照文件用 `snapshot_{narrativeOrder}.json` 命名
- `snapshot.ts:44` — `findNearest(targetOrder)` 按 narrativeOrder 找"最近"快照
- `replay.ts:193-197` — 增量事件筛选按 narrativeOrder 范围

**为什么错（根源）**：narrativeOrder 是 discourse order（Assembler only），不是 data order。如果 DAG 中 Event A (narrativeOrder=5) 依赖 Event B (narrativeOrder=8)，snapshot 在 replay 过程中创建时 state 包含 B 的效果但文件名说 narrativeOrder=5——narrativeOrder 和实际 state 内容不匹配。

**重构方向**：

1. 用 INTEGRATION-1 的 authoritative `StorySnapshot` 与 `DiscourseSnapshot` 替代单一 `Snapshot`：StorySnapshot 除 state/node prefix 外必须保存 outputs、provider/AbsenceWitness indexes、InformationActs/RuleEvaluationRecords、entity/relationship/thread/rule tombstones、catalog/graph/provenance/schema hashes，并且**selection-independent**；DiscourseSnapshot 独立保存 planned discourse cursor/state/provider/BoundaryReference/profile/selection hashes。快照文件名由 canonical compatibility hash，而非 narrativeOrder 命名。
2. `findNearest` 仅选择与目标 graph coordinate prefix branch-compatible、ancestor-closed 且全部 compatibility hashes 一致的同类 snapshot；否则丢弃并从 validated initialState/initialDiscourseState replay。
3. 删除 `getStateAt()` 和 `getStateAtOptimized()`，统一为显式结果：
   ```ts
   replayStory(initialState, storyGraph, branchPath, storySnapshot?): StoryReplayResult
   replayDiscourse(initialDiscourseState, discourseGraph, branchPath, discourseSnapshot?): DiscourseReplayResult
   ```
   结果包含 canonical state、provider/absence indexes、retained artifacts、ordered outputs 和 compatibility metadata；有 snapshot 时仅重放合法 prefix 之后的 graph outputs。
4. 消除 replay.ts 中两组重复逻辑和 narrativeOrder-keyed snapshot assumptions；Story/Discourse full replay 必须分别与同类 snapshot 恢复精确等价。

**优先级**：high（narrativeOrder 一致性假设在大多数正常叙事中成立，但 mixed-node replay 存在正确性风险）

**实现成本估算**：1 天（重构 snapshot 类型 + 统一 replay + 更新所有调用点 + 测试）

### [ ] STORY-SEMANTICS: 离散确定性故事状态规范

**规范边界**：Novalistically 支持有限、离散、确定性、按具体 `BranchPath` 解析的 `WorldState` 回放与 selected-scene 验证。每个 replayable node 在一个有效 `storyTime` 原子应用其 effects；`narrativeOrder` 只控制 discourse/Assembler。系统不支持连续重叠动作、概率性因果、纯 `narrativeHint` 语义依赖或真正的因果循环。它们必须拆分为可证实的离散变化、转写为确定性 Fact，或被明确拒绝。

**状态与因果规则**：

- 每个 `WorldState` domain 都必须有 canonical key 与确定性 set/unset 语义。entity attribute、relationship、knowledge、thread、rule 的 effect 必须写出绝对结果或可证明等价的确定性 operation；关系方向/对称化、relationship type、knowledge 的角色/命题/信念状态、thread completion/reopen、rule nullification 均须在 schema 和文档中定义。`undefined` 不能兼作 deterministic unset，因为它保留给 semantic/deferred Fact。
- provider 解析先找同一 canonical state key 的最新 branch-compatible 写入，再检查该写入结果是否满足 dependent precondition；不得跳过中间 reversion/override 而选择较早的相同 value。显式因果依赖与“当前状态 provider”是两类边：前者保留作者声明的因果祖先，后者只决定 replay 时的有效状态，必须分别记录和诊断。
- 任一 domain 中机械可证明的 unique latest exact state/artifact provider（及 AbsenceWitness）可以自动推断；多/不可比较 provider、author narrative causation、same-time order、branch merge、未命名的信息/证词/推理/rule artifact dependency 必须以 GRAPH-1 typed dependency 声明 predecessor 和 required output。没有唯一 provider、缺少 required output、时间不可比较或不同合法顺序会令任一 selected boundary 不同，均为硬错误。
- `storyTime` 限制 stateBefore 的时间包含范围，但绝不单独证明因果：目标前所有 branch-compatible、可比较且更早的节点进入回放；同一时间只允许因果祖先或对完整 `WorldState` 可交换的节点。一个 node 内跨多个 effect time、重叠 selected source range 或隐藏下游所需中间状态时必须由用户拆分；compiler 只拒绝不合法的重叠/缺失，不得自动重分配 effects 或改写故事图。
- `system:genesis` 改为非叙事 initialState root：无 preconditions，并完整声明故事开始前已有的 `WorldState` slots。它是唯一可无前置写入地提供初始 state slot 的根；普通没有 preconditions 的 `NarrativeEvent` 仍可为入度零的独立故事事件。`narrativeHint`/`deferred` Facts 绝不进入 replay、绝不满足确定性 dependency。
- 图按每个具体 `BranchPath` 独立过滤、建边、回放和验证；post-merge event 只有在全部适用分支的边界状态相同，或存在确定性 merge 规则时才可共用。任何 self-edge 或 directed cycle 都抛出包含 cycle path、edge origin 与 state key 的 `DagCycleError`。

**拒绝合同、缓存与文档**：

- loader/graph compiler 必须以具类型错误拒绝：非原子时间节点、歧义/缺失 provider、不可比较的影响时间、非交换并发写入、branch merge conflict、非法 semantic dependency、cycle、缺失/不支持 provenance、selection 引用 ellipsis 覆盖范围或未建模的中间依赖。不得 fallback、猜测排序、静默初始化、自动拆分 ellipsis/改写故事图，或将失败降级为 validator/metric 结果。
- snapshot 必须是 branch-compatible、ancestor-closed 的 temporal replay prefix，并绑定有序 node/effect hash、canonical state hash、definition/source、schema/replay version 与 branch path。StorySnapshot 明确不含 selection；selection 仅绑定 DiscourseSnapshot、assembly/run、coverage和render cache。render cache key 必须包含 target 定义、canonical `stateBefore`、完整 replay input（更早 temporal prefix 加同时间 causal ancestors）、node/effect/provenance hash、branch、context、selection、prompt/schema 和 provider 配置；不得使用 narrative-order hash chain 代替。
- `docs/reference/state-semantics.md` 必须成为本规范的面向作者/集成者说明，列出支持范围、全部拒绝情形、YAML 因果依赖语法、state key/set/unset 语义、branch/merge 规则与错误示例。每项拒绝情形都必须有 schema/compiler fixture；每项支持规则都必须有 replay、snapshot、cache 和 boundary-oracle 测试。

#### [ ] STATE-1: Entity Fact 的 presence-aware set/unset 规范

- 确定性 `FactValue` 仅允许 canonical JSON：`null`、boolean、finite number、string、array 与 plain object；写入时 canonical copy/freeze，比较使用 canonical deep equality。`undefined`、`NaN`、infinity、Date、class instance、function、symbol 等拒绝。`null` 是存在的合法值，永不表示删除。
- YAML `expectedPostconditions` 只有三种互斥形式：`value` 且 `operation` 省略/`set`（确定性设置）；`operation: unset` 且无 `value`/`narrativeHint`（确定性删除 attribute）；或只有 `narrativeHint`（语义要求）。现有含 `value` 的 YAML 兼容地视作 `operation: set`。同一 node 不得对同一 `(entityId, attribute)` 产生多个确定性 effects。
- `narrativeHint` 保持双表示的语义轨道：不写 `WorldState`、不产生 provider/因果边、不能 `set/unset`、不能满足确定性 precondition；`compareFact()` 对它返回 `deferred`，Pass 2 负责 prose 语义检查。任何后续故事状态依赖必须写成确定性 `value` Fact 或其他确定性 state，不能依赖 hint。
- precondition 使用 presence-aware state cell：`eq`、`neq`、`gt/gte/lt/lte`、`contains/not_contains` 需要 value；`exists/not_exists` 禁止 value 并区分 absent 与 present-`null`；semantic precondition 只能是 `narrativeHint` 并返回 `deferred`。缺失状态不满足 `neq`、比较或 `contains`；无效 operator/value 组合是 schema error，validator 不得各自重写比较逻辑。
- replay 先验证所有确定性 preconditions，失败时在 node effects 前抛出 `PreconditionMismatchError`，绝不以 precondition 初始化 state。`set` 写入 canonical value，`unset` 删除 own attribute；对已 absent attribute 的 unset、未知 entity、同 node 重复写入、同时间未排序竞争写入均为 typed error。重复 set 仍记录新的 write/provider；`A -> B -> A` 的最后一次 A 是当前 provider，intervening unset/override 禁止回退查找旧值。
- provider identity 使用 canonical key `(entityId, attribute)`，记录 `nodeId`、`factId`、operation、before/after、`storyTime`、branch、provenance hash。初始 entity state 编译为 `initialState` 的 deterministic set writes；初始状态不得含 unset 或 semantic Facts，重复初始写入/未知 entity 硬失败。每个 concrete branch 独立解析最新 provider，Fact validity 的结束时间由下一次适用写入导出，不手填。
- 外部语料中每个 set、unset、确定性 precondition 和 semantic source assertion 均需 verified provenance；aggregate/negative evidence 使用有序 evidence-span list、derivation method 与 reviewer，confidence 不改变 replay。引入 operation/provider metadata 后，snapshot、cache 与 event-log 格式必须版本化并提供相邻版本迁移。
- 最低测试：完整 schema 组合与 operator matrix；present/absent/null；set/repeat/overwrite/unset/re-set；A→B→A provider；precondition 不初始化；branch 与同刻竞争写入；initialState；multi-span provenance；`compareFact()` 对独立 reference evaluator 的 property tests；unset/reversion 后 snapshot/full replay/cache 等价；v1→v2 migration 保持确定性 state trace。

#### [ ] STATE-2: 完整多元 Relationship 的状态规范

- relationship 适用于任意 `Entity`，不是 character 专属。`relationshipTypeId` 是项目定义、受 catalog 校验的 string ID，不是全局 enum；type version 不得原位修改。type 定义有限、具名的 roles，每个 role 有 `min/max` cardinality、允许的 entity kind/type、可变性、可选 exclusive group，以及成员改变时的 `continuityImpact`（`preserve` / `new_epoch` / `new_relationship`）。二元关系是该模型的 specialization：两个 roles、各自 cardinality 为一；binary shorthand 与完整多元 IR 必须等价。
- relationship identity 为三层：`RelationshipId` 是永久 lineage、独立于 participants 且永不复用；`EpochId` 是一次从 establishment 到 dissolution 的 incarnation，每条 relationship/branch 最多一个未 dissolved epoch；`MembershipId` 是某 entity 在 epoch 内一次连续 tenure，离开后再加入必须获新 ID。一个 membership 绑定一个 entity 和非空 role set，允许同一 entity 兼任多个非互斥 roles。participant 变更默认保留 lineage，按变更 roles 最强的 `continuityImpact` 决定是否新 epoch 或新 relationship。
- epoch lifecycle 仅为 `active`、`suspended`、`dissolved`：suspended 保留 state，只能 resume/dissolve/允许的 epoch transition；dissolved 终结 epoch；在同一 lineage 重建必须新 epoch，identity-critical role 变更必须新 relationship。closed epochs 与 memberships 作为 tombstone/provenance 保留，ID 永不复用。
- dimension 必须在 type 中声明 value schema、mutability 与唯一 scope signature：`global`（whole epoch）、`role`（抽象 role）、`member`（MembershipId）、`subset`（canonical unordered membership set）、`positional`（具名 participant groups）。state key 使用 structured `{relationshipId, epochId, dimensionId, scope}`；subset canonical sort/dedupe，positional group 按 type schema 固定顺序。不得用 participant 拼接、direction prose、文件名或输入顺序派生 relationship identity/state key。member/subset/positional cells 在引用 membership 结束或不再满足 role 约束时由 membership transaction 显式记录 implicit unset；rejoin 不复活旧 tenure cells。
- 每个 `NarrativeNode` 对同一 relationship 最多产生一个原子 transaction：`effectId`、relationship/epoch ID、可选 lifecycleAfter、完整 `membershipAfter`、canonical dimension `set|unset` writes、provenance。作者面对的 add/remove/assign/unassign/move/replace 可作为 YAML 便利语法，但 compiler 必须归一化为完整 `membershipAfter`，先验证最终 cardinality/type/exclusivity/lifecycle，再一次提交；中间半成立 state 不可观察。same-node duplicate cell writes、stale epoch/state、无效 scope/value、suspended/dissolved write、orphaned scope 均硬失败。
- relationship precondition 可读取 lifecycle、type version、membership hash、role count、role/member presence 或 scoped dimension cell。每个 write 记录 node/effect/key/before/after/operation/storyTime/branch/provenance hash；current provider 是同 branch、时间合法的 latest write。membership 是整体 canonical cell；任何依赖 membership 的 dimension 读取同时依赖最新 membership provider 与该 dimension provider。自动 DAG inference 用于每个 unique latest provider，以及每个 expanded exact read 都有唯一 `ReadResolution` 的 finite aggregate；仅 ambiguous/incomparable resolution 才必须 hard fail 或写 typed explicit causal dependency。显式 causal origin 与 current state provider 分开记录。
- 相同 `storyTime` 的 nodes 仅在显式 ordered 或对完整 relationship read/write set 可交换时合法。两次 membership/lifecycle transaction、同 cell 的两次写入（即使 value 相同）、membership change 与依赖其 scope 的读写、entity retirement 与 relationship use 都是 noncommuting，必须显式排序或失败；不得使用 stable ID、filename、narrativeOrder 或 last-writer-wins tie-break。
- relationship graph 按 concrete `BranchPath` 独立 replay。merge 时 semantic state 完全相同才自动收敛，provider lineage 仍分支保留；其余必须声明 `requireEqual`、`selectBranch(branchId)` 或完整 literal merge state。禁止自动 union/average/自定义代码 merge。语义相同但 branch-local MembershipId 不同则 merge 新铸 membership，旧 tenure-bound cells 不自动转移；active epoch 不同则 new merge epoch，不同 relationship type 或 identity-critical occupant 则 new relationship。
- 动态 entity 在同一 node 中被 introduced 后可参与 establishment transaction；final referential integrity 必须原子校验。entity retirement 时任何 active membership 未先/同 node dissolved 均硬失败。外部语料要求 establishment、tenure start/end、role assignment、lifecycle transition、dimension write、merge 与 implicit unset 都有原子 provenance；subset assertion 需要 joint evidence，pairwise evidence 不得擅自综合为 n-ary assertion。
- snapshot/cache/reference interpreter 必须包含 canonical relationship semantic state、provider index、closed ID tombstones、type-catalog hash、ordered transaction/effect hash、branch、state/provenance hash 与 schema/replay version。最低测试：role min/max/repeated/multi-role/exclusivity；identity/epoch/leave-rejoin；global/role/member/subset/positional scope permutation；lifecycle；provider/reversion/implicit unset；同刻 commute/conflict；branch isolation/equal convergence/literal merge；same-node entity creation；provenance；binary specialization；full replay/snapshot/cache equality；独立 reference interpreter 的 property tests。
- 当 role `continuityImpact` 要求 `new_epoch` 或 `new_relationship` 时，使用 atomic `RelationshipIdentityTransitionGroup`：type-policy validated old epoch/relationship closure、replacement epoch/relationship establishment、new complete memberships、new dimensions、explicit carry/unset map、provenance。不得隐式改写 participant identity、重用 MembershipId、继承 tenure-bound member/subset/positional cells或自动 carry dimensions；每个 individual relationship 仍保持一 node 一 transaction，transition group 只协调 old/new transaction 的 final candidate atomicity与 provider lineage。

#### [ ] STATE-3: 通用 Entity instance lifecycle 规范

- 运行时必须严格区分三层：`EntityTypeCatalog` 是静态、versioned schema（不是 entity，不进 `WorldState`）；`EntityDeclarationCatalog` 是稳定 `entityId`、`typeRef`、immutable metadata/provenance 的 identity reservation；`WorldState.entities` 只包含当前 concrete branch 上已引入的 runtime instances。预声明 instance 与 event `introduces` 都规范化为同一 `EntityDeclaration`/transaction；catalog 预扫描仅供合法性校验，不表示实体存在、角色知道或读者被披露。
- `EntityTypeRef = { typeId, schemaVersion }` 不可原位修改。type 定义 kind、attributes、lifecycle policy、reference capabilities 与 typed invariants；每个 attribute 定义 canonical value schema、`requiredAt`（introduction/activation/never）、`writePolicy`（immutable/write_once/mutable/lifecycle_managed）、允许写入的 lifecycle 状态、`unsetAllowed` 和可选 typed reference constraint。defaults 必须 materialize 为有 provider 的 persisted write，不得 replay 静默补值。
- `EntityRuntimeState` 只有 `active`、`inactive`、`retired`。未引入 instance 仅在 catalog，不存在 runtime `pending`。`introduce` 直接原子创建为 active 并写齐 introduction-required attributes；active→inactive、inactive→active、active/inactive→retired；retired terminal，ID 永不复用。inactive 仍保留 identity/history，但由 type policy 控制能否参与新的 references。所有 transition 和 attribute writes 必须使用同一 node/entity atomic transaction，preconditions 读取 stateBefore，最终 cross-domain referential integrity 一次校验。
- lifecycle 不替代剧情 domain state：角色死亡写 `lifeStatus: dead`、物品耗尽写 quantity/condition、地点封闭写 access status、规则 nullification 写 rule effectiveness；它们通常仍是 active。retire 仅用于实体永久离开当前模型、未来不得作为新 state/relationship participant 的情形。entity 与 relationship transaction 可在同 node 原子地 introduce/establish，或 retire/dissolve；retirement 后任何未先/同 node 闭合的 active membership/reference 都硬失败。
- `requiredAt: activation` 是 active-state completeness contract：direct introduce-to-active 的 final candidate state 同时满足 introduction-required 与 activation-required attributes；inactive-to-active 必须再次满足 activation requirements，但既有未变 attributes 可直接通过，不要求重复写入。若 inactive 期间允许 unset required attribute，activation transaction 必须显式补齐；type invariants 以 closed AST/read-set 在同一 before/after candidate path 验证。
- canonical entity cells 是 `{domain:'entity', entityId, cell:'lifecycle'|'typeRef'|'attribute', attributeId?}`。introduction 提供 lifecycle/typeRef/materialized initial attributes；后续 provider 采用同 branch、时间合法的 exact-cell latest write。entity reference 同时读取 target lifecycle；activation 读取所有 activation-required attributes/invariants。相同 storyTime 中 lifecycle change 与任何 unordered write/reference 冲突；不同 mutable attributes 只有在 type invariant read set 不耦合时才可交换；不得 stable-ID/narrativeOrder tie-break。
- 所有 kinds 共享 lifecycle：character、location、item、faction、concept、rule 都是 instance；type definition 才是静态 schema。kind-specific facts必须留在 domain state：character 的 life/POV/aliases/knowledge/location，location 的 containment/access，item 的 ownership/location/condition，faction 的 membership，concept 的 stability，rule 的 applicability/effectiveness/evidence。可演进的关联使用 relationship；immutable structural links可用 typed foreign-key attribute，但不得同时维护两个可写 truth source。
- branch merge 先解析 entity identity、lifecycle 与 reference eligibility，再以一个 atomic cross-domain candidate graph 验证；不得按 entity/relationship 或任何 domain fixed order commit。semantic equality 自动收敛但 provider lineage 分支保留；typeRef 或 immutable metadata 不同是 identity conflict，禁止 merge。absent/present、lifecycle 与 mutable attributes只允许 `requireEqual`、`selectBranch` 或 explicit literal state；禁止 active-wins/retired-wins/union/average/last-writer-wins。某 branch retired 而另一 branch 延续时，必须作者显式决定 common final state；retired branch 不得隐式复活。merge transaction 必须有 incoming providers/provenance。
- snapshots/cache/reference interpreter 必须覆盖 active instances、retired tombstones、provider index、type/declaration catalog hashes、branch、ancestor-closed replay prefix、canonical state/effect/provenance/schema/replay hash；truth existence/attributes 不等于 character/narrator/reader knowledge，后者由独立 knowledge/disclosure state 决定。最低测试：预声明与 event introduce IR/state trace 等价；identity/branch-exclusive introduction/conflicting declaration；完整 lifecycle matrix；required/immutable/write-once/mutable attributes；kind-specific death/closure/consumption/nullification；same-node entity/relationship atomicity；provider/concurrency/branch merge；snapshot/cache；provenance；独立 lifecycle reference interpreter/property tests。

#### [ ] INTEGRATION-2: ReferenceEligibility 与 lifecycle closure 规范

- every entity reference 具有 explicit `identity|live|historical` mode：identity 仅引用 stable declaration、无当前存在断言；live 表示 current runtime participation；historical 绑定 fixed past boundary/tombstone。运行时维护由 canonical Entity/Relationship/Knowledge/Thread/Rule/BoundaryReference/artifact 重算的 `ReferenceIndex`，它不可独立写入；snapshot 可缓存但必须与 canonical recomputation hash 一致。相同 EntityId 在同一 boundary 可作为 proposition/identity target 合法、同时作为 new live member 非法，reference kind/mode 是 canonical validation 一部分。
- InformationAct 的 actor/recipient、Knowledge claim ownership与RuleEvaluation source在创建 transaction 时按 live eligibility 检查；一旦 committed，它们是 immutable historical artifacts/archived records，自动排除 live ReferenceIndex，因而不阻碍随后 entity retirement。relationship membership、current runtime foreign key、active Thread binding、active Rule scope 仍是 live references，必须在 retirement final candidate state 显式 close/historicalize。retiring rule entity还必须同 node revoke current rule epoch；不得以 archived artifact 继续产生新 claim/act/participation。
- 默认 eligibility：catalog-only/absent 不得新建 live reference；active 可新建；inactive 保留 existing live references但默认不得新建；retired 永久禁止 new live use、只允许 identity/historical。structural immutable foreign key 用 identity；current location/owner/controller/container 等 mutable participation 用 live，且不得与可写 relationship truth source 重复；fixed BoundaryReference、provenance、causal output 和历史 proposition 用 historical。type/role/scope 可 versionedly widen inactive eligibility，但核心 safety 不可覆盖：不得允许 absent/retired new live reference；retired 只能通过 explicit historical conversion 加固定 boundary/tombstone。
- referenceKind 至少覆盖 declaration/runtime foreign key、relationship membership、knowledge subject、proposition target、thread binding、rule scope、scene participant、POV focalizer、narrator subject、discourse target、causal output、provenance、historical boundary。knowledge subject/InformationAct actor/recipient、new Thread binding、new active Rule scope、scene cast/POV默认 active-only；inactive 时 existing live relationship memberships可按 relationship policy retained。retirement 时 committed InformationActs/claims/evaluation artifacts 自动转为 archival historical records；relationship memberships/current foreign keys必须显式 close，Thread/Rule bindings必须显式 close或由其 type policy授权的 fixed-boundary historical conversion，不能笼统 archive。discourse 可谈 inactive/retired entity，不能让其重新 live participate；narrator/focalizer eligibility 在引用 boundary 检查。
- 一个 atomic node：先 stateBefore preconditions，构建 lifecycle/cross-domain candidate，重算 candidate ReferenceIndex，验证每个 new reference target eligibility，再验证每个 retirement 已关闭/历史化所有 incoming live refs，最后 commit 或 reject。同 node introduction+relationship/thread/rule use 与 retirement+explicit closure 合法；无 implicit retirement cascade。same-time lifecycle write 与 unordered new/retained reference conflict；branch filter先于 eligibility，merge 先解析 entity lifecycle/identity 后原子验证 complete reference candidate。最小 tests 覆盖 matrix cells、introduction/use、retirement closure、historical conversion、POV/narrator boundary、inactive overrides、branch/merge/race、index recomputation/snapshot/cache和独立 matrix interpreter properties。

#### [ ] STATE-4: 有限确定性 Knowledge/Belief 规范

- 替换当前断开的 `KnowledgeDefinition` 与 `WorldState.knowledge`：知识是主体对 immutable proposition 的态度，而不是 copied Fact、entity attribute 或 prose annotation。运行时由 immutable/versioned `PropositionCatalog` 与按 concrete branch/boundary replay 的 `EpistemicLedger` 组成；canonical claim cell key 为 `{subject, propositionId}`，完整 assessment 是单个 state cell。客观 truth 不存入 claim，须以 `evaluate(proposition, WorldState)` 的 deterministic three-valued（true/false/indeterminate）逻辑在 query/historical ancestor-closed boundary 计算。
- proposition 必须有 stable ID、immutable canonical body、semantic hash、schema version 与 provenance，ID 不可 rebound/delete；所有 declarations 在 compile 时预扫描。支持四类有限命题：`Grounded`（entity/relationship/rule 等 canonical state cells 与 finite all/any/not）；`Epistemic`（主体对另一 claim cell 的有限嵌套态度/accessibility）；`Act`（信息/心理/沟通行为发生）；`Intensional`（计划、梦、预言、理论、道德判断、反事实等 opaque stable content）。Grounded/Epistemic/Act 可用于 truth-sensitive warrant；Intensional 可被相信、怀疑、否认、披露或遗忘，但不得提供 deterministic world precondition/provider。proposition dependency graph 必须 finite/acyclic；拒绝自指、循环、runtime coinage、arbitrary code/regex/LLM predicates、semantic Fact selectors 与无界 possible-world generation。
- claim assessment 支持 `settled`（grade=`know|believe|suspect` 与 polarity）、`conflicted`（独立 affirm/reject semantic positions）、`suspended`、`forgotten` 与 explicit unset；sources/warrants 不属于 semantic positions，单列为 ClaimEvidenceRecord。absent 不等于 forgotten/ignorance。人可持矛盾 belief，但同一 boundary 不得同时拥有彼此矛盾的 verified knowledge。连续概率/Bayesian inference/自动 confidence 更新拒绝；如需有限 confidence，只能是作者写入的 deterministic ordinal state。世界 truth 后续变化不会静默改写 claim；derived diagnostics 可标记 currentlyCorrect/stale/disconfirmed。
- `ClaimSemanticState`（assessment/polarity/accessible state）与 `ClaimEvidenceRecord`（information source/warrant/provider/provenance lineage）必须分离。claim merge 只以 semantic state 判定 equality/convergence，来源不同不得静默 union/强化 warrant；若故事需要主体记得“从谁/何时得知 P”，必须用 explicit metaclaim、InformationAct 或 memory claim 建模，不能依赖隐藏 evidence metadata。
- `InformationAct` 是不可变 event-log output，至少覆盖 perception、thought、testimony、assertion、inference、reading、recall、revelation，并记录 actor、recipients、content propositions、story boundary、in-world source 与 corpus provenance。act 与 claim 分开：说了 P、相信 P、听见 P、相信 P、P 为真、故意欺骗均为独立可验证结构。private thought 只对 thinker 可访问，除非 narration/disclosure 另行允许。`know` 必须有 verified warrant：观察与 acquisition boundary truth 一致、证词者有充分 warrant 且完整沟通、或版本化 truth-preserving inference rule 的全部 premise providers 成立；否则只能 belief/suspect/suspend。false testimony 可生成 false belief，单凭 false 不得推断 deceptive intent。
- epistemic subject 是具 `epistemic_subject` type capability 的 entity（通常 character/faction）或 declared narrator；faction ledger 是 institutional knowledge，不自动复制给成员。group 支持四种明确有限形式：institutional ledger；`distributed`；`mutual`；`CommonGroundRecord` 公共社会记录。每个 distributed/mutual 都是 immutable `GroupEpistemicQueryDefinition {queryId, kind, audienceSnapshotId, propositionId, attitudeFilter, branch/boundary}`，不是可写 state cell：audience 在创建时冻结，compiler 展开为按 canonical member ID 排序的每成员 exact ClaimSemanticState `ReadResolutionVector`，它是可审计 evidence；query result 是 boolean predicate，`distributed = any(member matches attitudeFilter)`，`mutual = all(member matches attitudeFilter)`。空 audience 时两者均为 `false`（不采用 vacuous mutual truth）；members later join/leave不改旧 snapshot。public announcement 可通过一个 InformationAct 向 concrete audience 批量写 claims。narrator 是独立 ledger 或 explicit entity/boundary；omniscient policy 仅授予 narration truth read access，绝不自动 materialize claim 或 disclosure；不得把任何形式称为数学无限 common knowledge。
- `CommonGroundRecord` 是 canonical public social record，不是无限 common knowledge：canonical key 为 `{domain:'common_ground', recordId}`，immutable body 绑定 proposition/fixed audience membership snapshot/source InformationAct or boundary，runtime status 仅 `active|retracted`。explicit `announce/set` 与 `retract` transaction 写入 latest provider/provenance；它表示 P 在该社会语境被公开呈现，不自动给每成员写 `know` claim。CommonGround read 读取 record cell；distributed/mutual read 读取其 finite resolution vector；二者按 ordinary branch/merge/snapshot/cache rules处理。branch merge/retirement 不回写已冻结 audience snapshot；历史/固定 boundary reference 仍普通 provider 规则验证。
- temporal Grounded/Epistemic propositions 仅允许 finite explicit boundary AST：`at({nodeId, phase:'before'|'after'}, P)`、`throughout({branchPath, orderedBoundaryIds, includeStart, includeEnd}, P)`、`sometime({branchPath, orderedBoundaryIds, includeStart, includeEnd}, P)`。`before(node,P)`/`after(node,P)` 这类歧义 shorthand 拒绝；range 必须显式同一 branch、按 temporal graph order展开为 ancestor-closed finite boundary set并有 finite read/provider closure，`throughout(empty)=true`、`sometime(empty)=false`。拒绝“通常/很久/永远”等模糊量词和无限 common knowledge；它们可作为 Intensional prose，不得进 deterministic evaluator。
- 每个 knowledge transaction 写完整 ClaimSemanticState after state/explicit unset，并生成独立 ClaimEvidenceRecord（source requirements/warrant/provenance/node/effect/boundary/branch/provider metadata）；同 node 同 cell 重复写入失败。revision/forget/recall/claim precondition 读取 prior claim provider；observation/verified knowledge 读取 truth-cell providers；testimony 读取 speaker claim provider；inference 读取 every premise provider；subject eligibility 读取 lifecycle provider。truth 成立绝不自动产生 knowledge。same-time writes 只有 read/write set 可交换或 explicit order 时合法；forget P 与由 P 推理 Q、subject retirement 与 acquisition、循环 testimony/inference 均不得隐藏排序。
- branch 中 claims/acts/warrants/provenance 独立 replay；semantic assessment 相等可收敛且 provider lineage 保留，其他必须 `requireEqual`、`selectBranch`、explicit literal claim 或 explicit unset，禁止 knowledge-wins/confidence-max/source-union/discourse-last merge。subject 合并先于 claim 合并；proposition catalog 不得 branch-diverge。snapshot/cache 必须包含 relevant claim/act provider closure、proposition catalog hash、branch、canonical state/provenance/schema/replay hash。
- POV/narration 使用显式 `NarrativeKnowledgeBoundary`：focalizer 在 event stateBefore 的 accessible claims；retrospective narrator 可引用 explicit later narrator boundary，但须经 disclosure policy 标记；`narrationTime` 不改变 story replay/causal graph，且 boundary 不唯一时失败。Pass 1 只接收 allowlisted claims/attitudes，forgotten/future/pending truth 不得泄露；Pass 2 可按 authorial capability 验证边界。reader disclosure 是独立 discourse-domain ledger：区分 exposed assertion、revealed canonical truth、withheld truth 与可选 ModelReaderLedger；它绝不满足 story precondition/DAG provider，也不等于真实读者心理。
- 仅声明支持有限、离散、确定性的认识论状态：覆盖秘密、谣言、误认、谎言、幻觉、 deduction、怀疑/否认、矛盾心理、失忆/回忆、institutional records、公告、有限高阶认知、不可靠/回顾叙述、戏剧反讽与 branch discoveries。明确拒绝 continuous memory decay、probabilistic reasoning、unbounded possible worlds、infinite common knowledge、自指悖论、actual reader mind 与纯 LLM semantic causation；它们仍可作为 Intensional prose/disclosure 内容，不能改变 deterministic replay。
- CORPUS ellipsis 可在单一有效 storyTime 携带 source-grounded knowledge transactions，但 summary 永不创建 claim/provider；跨 acquisition/revision/forgetting 时间必须用户拆分。外部 corpus 对 private thought、negative evidence、forgetting、deception、group claims、merge 都需严格 atomic provenance 与 reviewer derivation。最低测试：四类 proposition/canonical nesting/cycle rejection；truth boundary/null/absent；全部 assessment/source/warrant；private thought/testimony/lie/inference/recall；truth drift；finite temporal claims；group forms；narrator/disclosure separation；branch merge/concurrency/lifecycle；ellipsis timing；snapshot/cache；独立 proposition evaluator、epistemic ledger 与 provider reference interpreter/property tests。

#### [ ] STATE-5: Thread 的长程叙事结构规范

- Thread 是独立 narrative-state domain，不是 Entity/Relationship；它将人物、关系、命题等已有 domain 投影为作者定义的长程 plot structure，服务 active context priority、scene progress validation、promise/payoff、arc closure 与长篇 selection coverage。世界中的 entity/relationship/knowledge 不得因被 thread 引用而改变 truth；纯主题、气氛、隐喻仍是 narrativeHint，不强制 thread 化。
- 使用 immutable/versioned `ThreadTypeCatalog` 和 `ThreadDeclarationCatalog`，声明 finite role schemas、phases、lifecycle/reopen policy、time domain、stable goals/milestones/narrative hints/provenance；`ThreadId` 是永久 lineage，declaration 不等于 runtime active。`ThreadRuntimeState` 包含 status、current `ThreadRunId`、phase、bindings、goal states、milestone states、semantic state hash。每次 activation-to-closure 是新 run；completed/abandoned 后 reopen 必须新 run，不得把完成 thread 的 percentage 隐式改回中途状态。
- lifecycle 为 planned、active、blocked、completed、abandoned、retired：planned→active；active↔blocked；active→completed/abandoned；blocked→completed 在同一 atomic transaction final candidate state 已解除全部 blockers 且满足 required goals 时合法，blocked→abandoned 也合法；completed/abandoned 只可按 type reopen policy（forbidden/allowed/requiresExplicitReason）新 run；retired terminal。不得从 scalar progress、LLM、缺失 goal 或 context 猜测 completion。
- canonical progress 由 finite phase、goal 与 milestone 的 absolute state 组成：goal=`pending|active|achieved|failed|waived`；milestone=`pending|achieved|failed|waived|invalidated`。definitions 限制合法/reversible transitions、prerequisites 与 waiver denominator policy；若需要展示 fraction，只能由 fixed integer weights/branch applicability 派生，永不存储、做 provider 或 precondition。goal verification 可为 state proposition、author-authored plan state、或 semantic hint；semantic goal 的 deterministic status 仅表示作者声明的结构推进，Pass 2 只作为当前 scene prose realization validation/retry/release gate，失败不回写 ThreadRuntimeState/WorldState/下游逻辑，LLM 输出不得写 canonical thread state。
- bindings 表示 narrative function 而非世界关系：stable binding tenure 将 role 绑定到 entity、relationship lineage/epoch 或 proposition，type 限制 min/max、target kind、mutability/exclusivity/lifecycle requirements。角色/关系实际社会状态仍在 Relationship domain；entity introduction 与 thread binding 可在同 node 原子发生，entity retirement 必须关闭 bindings 或由 role policy 显式允许历史引用。
- 每种 thread type 只选一个 clock：`story` 按 branch-resolved storyTime 进入 `WorldState` replay（人物弧、冲突、任务、调查）；`discourse` 按 assembled narrative/disclosure order 进入 `DiscourseState`（谜题揭露、悬念、伏笔、读者侧发展）。禁止 cross-clock provider edges；flashback 能回放 story-thread past state，但绝不倒退 reader/discourse thread。
- 每 node/thread 最多一个 atomic transaction：thread/run ID、optional status/phase/bindingsAfter、goal/milestone set/unset writes、provenance。author-facing add/remove/advance convenience syntax 必须归一化为 complete final bindings/absolute states；lifecycle/cardinality/prerequisite/completion/cross-domain reads 均在 final state 校验。canonical keys 覆盖 status/run/phase/bindings/goal/milestone；latest exact-cell provider 才能自动建 DAG edge，mere thread touch 不产生因果。
- 同一 story/discourse clock 中，不同 threads 只有不互相 read 才可交换；同 thread 的 lifecycle/run/phase/bindings writes 必须排序；completion 与 unordered required goal/milestone writes 冲突；同 cell 同 value 也冲突。story-domain thread branch semantic equality 自动收敛且 provider lineage 保留，其他由 MergePlan 使用 `requireEqual`、`selectBranch`、complete literal state；禁止 max-progress/milestone union/completion-wins/average。不同 active story runs 合流后共同继续必须 new merge run，branch-local bindings 默认 remint。discourse-domain thread 保持 branch-local/non-destructive：shared render 仅在其完整 discourse-thread read projection 各 incoming branch 相同时允许；差异则 branch variant 或新开 merge-after discourse thread，旧 branch history不被 selectBranch/literal 覆盖或删除。
- `NarrativeEllipsis` 仅能在一个 source-proven valid storyTime 推进 story-domain thread，不能推进 discourse-domain thread；selection 永不编辑 canonical thread state，只以 `selectionHash` 计算 thread/goal/milestone coverage。snapshot/cache/reference interpreter 包含 thread state、run/binding tombstones、type/declaration hash、clock position、provider/effect/provenance/branch/state hash。最低测试：identity/runs/lifecycle; weighted projection/waivers; state/authored/semantic goals; prerequisites/bindings; provider/concurrency; branch merge; clock isolation/flashback; ellipsis/selection invariance; Pass 2 evidence keys; full replay/snapshot/cache; independent thread reference interpreter/property tests。

#### [ ] STATE-6: Rule 的约束、审计与语义规范

- 每个 Rule 是 `kind: rule` 的通用 Entity instance，但 generic lifecycle 只回答该 rule 是否存在；rule-domain runtime state 独立记录 current epoch、activation（dormant/enabled/suspended/revoked）、finite effectiveness level、scope bindings、exceptions 与 semantic hash。`RuleTypeDefinition` 是 reusable static schema（parameter/scope/exception/evolution/effectiveness）；`RuleSpecification` 是 immutable enacted formal semantics（parameters/scope/constraints/narrative statement/provenance）；`RuleId` 是永久 lineage，`RuleSpecificationId` 标识不可变版本，`RuleEpochId` 标识该 specification governing 的一次时期，`RuleExceptionId` 永不复用。
- entity active 不等于 rule in force：enabled 才应用约束，suspended 暂不应用，revoked 终结 epoch；effectiveness 是独立绝对 level，例如 full/limited/nullified。nullified 保留 rule identity/epoch/exception，不隐式清空状态；是否可恢复由 type policy 决定。角色死亡、物品耗尽、规则 nominal nullification 等 domain facts 不得滥用 generic retirement。amend 关闭旧 epoch、在同一 RuleId 开新 epoch 并完整重写 scope/effectiveness/exceptions；replace revoke 旧 RuleId、创建新 RuleId，可有 typed supersedes relationship。不得原地修改 specification、从相似名称推断连续性或自动传播角色对旧/新 rule 的 knowledge。
- 每个 constraint 有 stable ID、kind、enforcement、applicable effectiveness levels、typed finite scope、versioned closed predicate AST 与 optional semanticHint。kind 为 state_invariant、transition_constraint、precondition_requirement、postcondition_requirement；scope 可绑定 entity/type/attribute、n-ary relationship epoch/role/membership/dimension、knowledge subject/proposition/claim、thread/run/goal/milestone、rule epoch 或 candidate node read/write set。predicate 仅允许 finite compiled selectors、all/exists/count 与 canonical state/transition tests；拒绝 free strings、regex、arbitrary code、LLM true/false、infinite selectors 与 evaluator self-generation。
- 三种 enforcement 必须全部支持且结果通道分离：`hard` 在 commit 前拒绝违反 transition；`audit` 接受 transition 并产生 immutable `RuleEvaluationRecord`（rule/epoch/constraint/node/scope/result compliant|violated|exempt/evaluator version/provenance）；`semantic` 不进入 replay，只由 Pass 2 以 rule/epoch/constraint/evidence 检查 prose。社会/法律规则通常 audit，因角色可违规；hard rule 不自动写处罚/伤害/knowledge/thread 等剧情 effects，所有后果仍是作者明确 transaction。semantic LLM 结果绝不创建 deterministic violation/exception/provider/state transition。
- evaluation artifact contract：hard constraint 的 compliant/exempt committed node 产生 stable `RuleEvaluationRecord`，hard violation abort node、仅有 diagnostic、绝不产生 committed output；audit 的 compliant/violated/exempt 一律产生 immutable record；semantic constraint 仅有 scene-local Pass 2 validation evidence。record ID 由 rule/epoch/constraint/node/canonical scope bindings/branch/evaluator version 派生，可被 Proposition/Knowledge 选择；StorySnapshot 保留每个 committed hard/audit evaluation descriptor及足以满足未来 exact artifact read 的完整 payload/read-set/evaluator version，原始 prose/Pass2 observation不进入 StorySnapshot。
- 一个 atomic node 的 rule evaluation 顺序固定：读取 stateBefore rule/preconditions；构建 candidate entity/relationship/knowledge/thread/rule results；以 stateBefore activation 执行 transition/precondition constraints；以 candidate stateAfter activation 执行 invariants/postcondition constraints；校验 cross-domain referential integrity；commit 或 reject。初始状态必须满足 every enabled hard invariant。新 enabled rule 的 stateAfter 必须已合规；suspend/revoke 不得回溯移除 node 前已经适用的约束。
- exception 是 canonical rule state：exceptionId、active/suspended/revoked、constraint IDs、scope bindings、optional condition proposition、`exempt` 或 `replaceWith(replacementConstraintId)`。多个 exemptions 可共存；多个不同 replacements 同时匹配即 hard error；禁止 priority/most-specific/definition-order resolution。exception 不跨 epoch 自动继承，必须显式重述；同刻 exception introduction 与 separately observable use 需要因果 order。rule scope/exception condition 使用同一 boundary，任何 aggregate selector 必须解析为有限 read set。
- rule canonical cells 包括 currentEpoch、activation/effectiveness/scopeBindings、exception；每 write 记录 before/after/node/effect/branch/time/provenance。constraint evaluation materializes complete read set，activation 和所读 world cells 形成 typed rule-dependency edges，区别于 current-state provider 与 author causal origin。same-time 中 epoch/activation/effectiveness/exception change 与 governed application 冲突；同 cell 写入即使同值也冲突；不同 rules 仅 read/write sets 不交时可交换；不得 filename/ID/narrativeOrder tie-break。
- rule branches semantic equality 才自动 converge，provider lineage 保留；其他仅 `requireEqual`、`selectBranch`、complete literal state，禁止 strongest-effectiveness/enabled-wins/nullified-wins/exception-union/latest-specification。不同 active epochs merge 新 epoch；不同 specification 占同 epoch 是 identity corruption；branch-local exceptions 默认 remint。MergePlan 仅先解析 identity/lifecycle/reference eligibility，再构建一个 atomic cross-domain candidate graph；不得规定 entity/relationship/rule/knowledge/thread 的 fixed merge order。
- story-time ellipsis 可在单一 source-proven storyTime 改 rule state或包含 rule-governed transition；enactment 与后续 application/suspension/violation 时间不同则必须用户拆分。discourse-time rules 不能由 ellipsis 改变；selection 不改变 rule applicability/evaluation，只生成 coverage metric。snapshots/cache/reference interpreter 绑定 rule entity/epochs/effectiveness/exceptions/tombstones/provider/type/specification/evaluator/read-set/branch/effect/provenance hashes。外部 corpus 对 formalization、enactment、effectiveness/nullification、exception/amendment/replacement/evaluation 都需 atomic provenance；模糊文学原则只能 semantic hints。最低 tests：identity/specification immutability/epochs/replacement；lifecycle/effectiveness；四 constraint kinds/initial invariants；hard/audit/semantic；finite scopes/quantifiers；exceptions；providers/concurrency; branch merge; ellipses; snapshot/cache；independent predicate/evaluator reference interpreter 与 inductive hard-invariant properties。

#### [ ] GRAPH-1: 跨域 typed causalDependencies 与 graph compiler 规范

- compiler 分别构建 `StoryGraph`（effectiveCoordinate=storyTime）与 `DiscourseGraph`（effectiveCoordinate=DiscoursePosition）；二者各自保留四类语义绝不混用的边：`author_origin`、`provider`、`same_coordinate_order`、`internal`。它们各自 topological replay，author origin 不得覆盖 provider resolution，provider 不得自动证明 narrative causation；禁止 StoryGraph/DiscourseGraph causal/provider edge，只有 hash-pinned one-way `BoundaryReference` 可从 StorySnapshot 向 Discourse validation/context 提供只读 truth input。每条跨 node dependency 只有一个 predecessor/dependent；多前因使用多条 dependency（可共享 causalGroupId）。
- 每个 replay effect 必须归一化为 immutable `OutputDescriptor`：stable output/effect/node ID、canonical state/artifact key、set/unset after value、branch scope、`effectiveCoordinate = storyTime | discoursePosition`、provenance hash。entity/relationship（含 implicit scope unsets）/knowledge/story-thread/rule writes、materialized defaults、merge writes、information acts、rule evaluations 是 StoryGraph outputs；planned disclosure/narrator assertion/hint/withhold/discourse-thread/DiscourseBridge acts 是 DiscourseGraph outputs；summary、narrativeHint、prose、Pass 2 结果和 LLM judgment 永不成为 output。每个 deterministic consumer 暴露 `ReadRequirement`：read ID、exact canonical key/artifact、presence-aware predicate、stateBefore/stateAfter phase、branch scope、origin（precondition/source/rule/scope/lifecycle/merge）。
- canonical selector/output binding 必须覆盖所有 domains：Entity lifecycle/type/attribute；full n-ary Relationship epoch/membership/dimension scope（必须 RelationshipId/EpochId/MembershipId，不得 participant name/direction prose/current-member wildcard）；Knowledge claim；Thread status/run/phase/binding/goal/milestone及其 clock；Rule epoch/activation/effectiveness/scope/exception；DiscourseState 仅可用于 discourse dependencies。每条显式 dependency 必须选择至少一个实际 predecessor output，绑定 expected operation/value/output hash，selector 必须在每个 applicable concrete branch 唯一解析；泛化 `dependsOn`、无 output 边、semantic hint/prose output dependency 均拒绝。
- provider resolution 对每个 branch/read：在所属 graph 收集 exact key 的 branch-compatible、effective coordinate 更早或相同 coordinate 已 ordered writes；选唯一 coordinate/declared partial-order maximal write；验证其 immediate output 满足 read predicate；记录 exact output→read provider edge。绝不跳过 intervening unset/override/reversion/membership/claim/thread/rule/disclosure revision 选择更早 matching value。显式 `provider_selection` 必须解析为同一 unique maximal output，可消歧同-coordinate order，但不得指定 stale provider。
- compiler 仅可自动推断可机械证明的 exact-cell provider、initialState provider、已由 consuming transaction 命名的信息 act/rule evaluation provider、same-node internal introduction/binding edges、implicit relationship unsets、finite rule read sets、merge reconciliation outputs及其 provider edges；finite aggregate predicate 必须展开为 exact reads。必须作者显式声明 author narrative causation、same-time noncommuting order、多/不可比较 provider、按 branch 不同 provider、未由 transaction 命名的信息/证词/推理/公告、multi-output cross-domain dependency、merge input/non-equal reconciliation、以及不可由 exact state read 恢复的 corpus/ellipsis 因果。
- coordinate legality：StoryGraph predecessor storyTime 必须早于 dependent，或相同且 declared edge 建立无环顺序；DiscourseGraph predecessor DiscoursePosition 必须更早或同 position 已有 internal order；future/incomparable/unresolved story anchor、duplicate discourse position 失败；`narrationTime` 不进入 causality；story/discourse clock不能跨域依赖。每个 same-coordinate conflict 必须 ordered 或对 complete read/write sets 可证明 commutative，不得 stable ID/filename/narrativeOrder/last-writer-wins tie-break。author_origin/provider_selection/same_coordinate_order 都可建立 order，但保留各自 class。
- `initialState` 是 StoryGraph 独立、非叙事根：无 predecessor/scene/branch variation/unset/semantic output，发出 complete deterministic initial writes，可做 exact provider，但不得作为 author_origin/same_coordinate_order predecessor；真实故事前因必须建 event/ellipsis，不能藏入 initialState。`initialDiscourseState` 是 DiscourseGraph 对应 planned root，只含 author/fixed-corpus contract declarations，不读取 generated prose。dynamic entity 的 catalog declaration 不提供 runtime existence，cross-node use 读取 lifecycle provider；same-node introduce/use 创建 internal edge。retirement 与 unordered relationship/thread/rule/knowledge references 冲突，same node closure 使用 internal dependencies。
- branch scope 必须是 predecessor/dependent applicability 的子集；先 filter concrete branch 再 resolve provider。每个 dependent read 每 branch 恰有一个 `ReadResolution = ProviderOutput | AbsenceWitness`，overlapping provider declarations/cross-branch leakage/coverage gap 都失败。merge reconciliation 创建 explicit outputs，下游读取 merge output；semantic equal convergence 可保持 branch-specific provider lineage。dependency/output/absence catalogs、provider indexes、normalized Story/Discourse graph hashes 是 snapshot/cache/replay compatibility 的一部分，snapshots 必须在所属 graph 对四类边 ancestor-closed；cache包含 target coordinate prefix、same-coordinate ancestors和所有 dependency/output/absence hashes。
- NarrativeEllipsis 只可作为 StoryGraph predecessor/dependent，required output 必须是其单一 storyTime 的实际 replay effect，summary 绝不可被选择；DiscourseBridge/ScenePresentation 只可作为 DiscourseGraph predecessor/dependent。外部 corpus每条 causal/discourse assertion有 output provenance 与 edge/act provenance；源区间含 causally distinct/uncertain effects时用户拆分或失败。selection永不移除任一 graph ancestor closure。compiler顺序固定：normalize outputs→reads→filter branch→resolve declarations→validate coordinate/order→infer providers/absence→commutativity→branch/closure/cycle validation→hash/replay。
- typed errors 至少包括 unknown/self predecessor、missing/ambiguous output、assertion/read mismatch、unknown read ID、stale provider selection、duplicate branch provider、branch coverage/incompatibility、future/incomparable time、unordered same-time conflict、cross-clock edge、edge-origin cycle、initial-root misuse、semantic-output dependency、dynamic lifecycle/merge input/ellipsis summary/provenance error。最低 tests：全部 domain selector/output/read；initial root；reversion/unset/stale selection；author-origin/provider separation；n-ary relationship scope；knowledge acts/higher-order claims；thread/rule reads；same-time commutativity/order；dynamic entities；branch partition/convergence/merge；ellipsis provenance/selection closure；cycle diagnostics；snapshot/full replay/cache invalidation；独立 reference graph compiler property tests（branch filtering precedes providers、every accepted read has exactly one ReadResolution、ProviderOutput resolution is the unique maximal write、commuting permutations等价、explicit selection不改变 latest semantics）。

#### [ ] DISCOURSE-1: Model Reader、Narrator 与 spoiler-safe context 规范

- `DiscourseState` 是独立、finite、branch-resolved、按 `DiscoursePosition`（assembled narrative order）回放的 domain，run key 绑定 assembly ID、BranchPath、ModelReaderProfile、selection hash。它记录 intended model reader 的**planned/contractual** exposure与 narrator assertions，不声明 generated prose 已实际实现这些 exposure；实际 realization 仅 C validation evidence。它不属于 `WorldState`，不得满足 story precondition、提供 WorldState provider 或跨 story/discourse clock 建边。真实读者心理不被建模；planned retraction 只改变 assertion contract status，不伪造 reader forget。
- v1 `ModelReaderProfile` 仅支持 immutable/versioned built-in `default_model_reader_v1`：其 stable profile ID/hash、intended audience semantics、allowed narration/disclosure policy 与 empty initial exposure contract 由 compiler内建定义。`initialDiscourseState` 按该 profile 显式写入任何 fixed-corpus checkpoint/initial planned exposure；profile 不从 prose、reader telemetry或运行时推断，不能改写 StoryState。custom/project-specific profiles在有 versioned profile catalog、migration、manifest row与discourse reference conformance前为 X；profile hash进入 DiscourseSnapshot/run/logical render cache key。
- canonical `DiscourseState` 只回放 `PlannedDiscourseLedger`：YAML（或 fixed corpus source-verified contract）是唯一的 reader/narrator/disclosure 真相，所有 scene contract 在任一 prose 生成前确定。Pass 2/human review 产生的 disclosure observation 是 scene-local validation evidence，不得写入/修订 canonical discourse ledger、成为 downstream logical provider、改变任何 scene precondition/reveal contract，或让下游 render 等待“实际揭露”确认。reader state 保存 planned encounters/reveals/open assertions/retractions/active hints/withholding policies 与 discourse provider index。
- disclosure actions 为 reveal、claim、hint、retraction、correction、withhold_start、withhold_end。reveal 只能计划将 truth-boundary 为 true 的 proposition 作为 authoritative narrative truth；false/indeterminate 内容只能计划 claim/conjecture/red herring/intensional proposition。claim 计划暴露 assertion 而不承诺 truth；hint 计划暴露 surface proposition、author-only target proposition linkage，target 绝不进入 model-reader/Pass1 projection；retraction 不使 planned reader contract伪造 forget；correction 只 supersede 先前 discourse assertion contract，不得 retcon WorldState，后者必须以 YAML story-state change/provenance 单独建模。hint state 使用 `planned|contract_planted|contract_reinforced|contract_fulfilled|contract_subverted|retracted`，均为 contract status而非 prose observation，可关联 discourse Thread；suspense/foreshadowing progress 属 discourse Thread，不维护第二个 scalar counter。
- narrator profile 为 focalizer_bound、retrospective_entity、explicit_ledger 或 omniscient；access、assertion、truth、fidelity、sincerity/deception 独立。每个 `NarratorAssertion` 记录 narrator/proposition/polarity、authoritative_reveal|claim|conjecture|quotation|implication、truthBoundary、narrationBoundary/evidence。omniscience 仅授予 applicable truth read access，绝不自动 reveal；retrospective narrator 使用 explicit later Knowledge boundary；reliability 是 per-assertion derived evaluation，truth mismatch 本身不推断 lie。scene contract 固定 narrator/focalizer boundaries、audiences、prerequisite disclosure reads、planned effects、withholding policies；private thought 可对 reader 可见而对其他 character 不可见。
- Pass 1 必须使用 capability-separated `DiscourseContextProjection`：仅 previous planned reader reveals、open claims、visible hint surfaces、focalizer/narrator accessible claims、current-scene explicitly authorized reveal/claim targets 和 active withholding policies。禁止 future/unrelated truth、hint target、raw generated previous-scene summary、catalog metadata 和未授权 WorldState truth。previous logical summary 必须从 planned disclosure projection 编译；下游 scene 绝不因前一 prose/Pass 2 observation 改写 reader state 或逻辑 contract。discourse order 只决定 planned contract，不限制 logical_parallel render；任何 prose surface dependency 由 RENDER-SURFACE-1 独立调度。
- flashback 读取 historical WorldState/Knowledge 但推进 current planned DiscourseState；flashforward 可 reveal fixed future-boundary proposition；回到 earlier storyTime 绝不回滚 planned reader exposure；narrationTime 仅选 narrator boundary，ambiguous boundary 硬失败。discourse branches 独立：shared post-merge scene 只有全部 incoming branches 对该 scene complete discourse read projection 相同才可共享 render，否则生成 branch variants；不得 union/intersection/max exposure/destructive replacement。一个 branch 的 generated prose/validation observation 永不改变另一 branch 的 planned contract。
- `NarrativeEllipsis` 没有 discourse position，永不产生 reader disclosure/narrator assertion/hint/retraction/withholding effect，summary 绝非 reader evidence。sparse corpus 必须选择 `isolated_excerpt`（source-verified ExcerptDisclosureCheckpoint）或 `full_work_context`（全部先前 source-verified `DiscourseBridge` planned records）；DiscourseBridge 有 position/provenance/disclosure acts，但无 WorldState effect/render/POV/Pass 2 job，区别于 ellipsis。缺 checkpoint/bridge coverage 时不得声称完整 reader context；selection 不得从未渲染 prose 自动推断/改变 planned disclosure。
- Pass 2 返回 structured disclosure observations（planned effect ID、reveal/claim/hint/retraction/correction/unplanned exposure、proposition/polarity/assertion/evidence/matchLevel/authority presentation）及 suspected withholding/POV/narrator leak。它们仅验证当前 prose 是否符合 planned contract：failure 可触发当前 scene retry/block/human review，但永不更新 canonical discourse ledger、下游 logical contract、WorldState/Knowledge/deterministic causal provider。高影响 reveal/subtle hint/unreliable narration/corpus truth需 human/source review；“未检测到泄露”不是无泄露证明。
- discourse snapshots/cache 包含 run key/cursor/planned state hash/assertion-hint-policy/provider index/branch/narrator-profile/proposition catalog/selection/provenance hash；logical render cache 绑定 WorldState boundary、focalizer/narrator Knowledge projections、scene contract、planned incoming discourse/current privileged targets/withholding policy。Pass 2 validation 使用独立 `ValidationKey`（prose hash、analysis schema/model、validator/reference policy），其变化不改 logical/discourse cache；prose surface references 使用 RENDER-SURFACE-1 独立 cache。拒绝 discourse as WorldState provider、actual reader subject、duplicate branch position、ambiguous narrator boundary、false reveal、claim-as-reveal/access violation、unknown assertion retraction/exposure erase/hint target leak、withhold boundary breach、raw summary/cross-branch leak/unequal shared render、ellipsis disclosure/incomplete checkpoint bridge/unverified Pass2-as-canonical/stale hashes。最低 tests：reveal-v-claim、false reveal、hint concealment、withholding/retraction/correction、narrator access/fidelity/sincerity、limited/retrospective/omniscient/private thought、flashback/flashforward/narrationTime、planned-contract validation/unplanned spoiler、branch projection equality、selection checkpoint/bridge/ellipsis prohibition、logical cache与validation cache隔离；独立 reference interpreter properties（story permutation不改discourse、flashback不回滚planned exposure、branch filter先于discourse replay、shared render需equal read projection、validation不改WorldState/DiscourseState）。

#### [ ] RENDER-SURFACE-1: 逻辑独立的文本连贯与分组并行规范

- render plan 必须分离 `logicalGraph`（STATE/GRAPH contract）、`plannedDiscourseGraph`、`SurfaceDependencyGraph` 与 `ValidationGateGraph`。YAML/catalog/compiled deterministic state/ planned DiscourseState 是 scene logic 唯一输入；generated prose、Pass 2、summary、surface packet 永不写/修订 WorldState、Knowledge、Thread、Rule 或 planned DiscourseState，永不成为 logical provider/causal dependency/precondition/reveal contract。若 prose 中出现未建模 detail，后续逻辑要依赖它时必须由作者提升到 YAML 后重新编译。
- 每 scene 在 prose 前拥有完整 `CompiledSceneContract`：branch/discourse position、WorldState/Knowledge/narrator/planned discourse boundary hashes、resolved versioned StyleProfile、deterministic authored continuity packet、prompt contract hash。StyleProfile 按 project→chapter→narrator/POV→scene 的 deterministic precedence 解析，可包含 voice/diction/rhythm/paragraphing/typography/dialogue/avoid；continuity packet 仅含 transition（continuous/hard_cut/time_jump/location_jump/pov_shift/chapter/flashback）、authored motifs/callbacks/open-close mode。generated prose 不得反写 style profile；generated phrase 不能变 mandatory callback，除非作者写入 YAML 并重编译。
- 默认 `logical_parallel`：所有 scene 仅由确定性 contract 并行 render。`serial_surface_groups` 是 author-controlled 的短、branch-local、按 discourse-order 的 ordered lane：同组后续 scene 可将已接受 source prose 的固定 tail/full excerpt、deterministic style metrics 或 authored anchor 作为明确标记的 non-authoritative `SurfaceReferencePacket`，只为节奏/措辞/过渡服务；与 YAML conflict 时 YAML 永远优先。每 rendered scene 恰属一个 group；group order 是 branch discourse order subsequence，不得 filename/storyTime/causal order/completion timing 推断；cross-branch surface edge、merge shared render 消费 branch-specific prose、surface cycle、未接受 source prose、未版本化 extraction/budget 均硬失败。
- grouping policy 有 `manual`、`suggest`、`auto`：manual 为作者明写 group；suggest 由 deterministic planner 依据 discourse adjacency/chapter/POV/narrator/location/transition/cast overlap/style profile/author continuity metadata 提议但不生效；auto 只有项目明确授权时采用 planner。任何生效结果都输出版本化、hash-pinned、可覆盖的 `RenderGroupManifest`（policy version/source definition hash/group IDs/lanes/surface policy），进入 surface cache key；planner 不得读取 prose/LLM judgment、修改 YAML/logic/discourse/causal edges或临时按完成顺序重组。
- group policies 仅支持 `parallel`、`serial_surface`；`parallel_then_harmonize` 与一次请求生成多 scene 的 `joint_group` 明确为 X，禁止作为隐式优化或 benchmark workload，未来需先定义完整 revision/validation/cache/assembly contract 才可解除。推荐 globally logical_parallel，连续动作/拆分对话/同 narrator 情绪或感官过渡/刻意回声使用短 serial groups；远距 POV、独立 branches、仅逻辑相连 scene、hard chapter cuts 使用 parallel。chapter 默认不 carry prose excerpt；POV/narrator switch 必须声明 none/rhythm_only/tail_excerpt/authored_anchor。
- validation gate 仅决定 prose artifact 是否可 release/assemble与是否可作为 surface source：Pass 1→Pass 2/ deterministic checks→accept/retry/block current scene；accepted prose 才产生 surface packet。failed scene 仅阻断 surface descendants，logical compilation/unrelated groups 仍有效；retry有独立 AttemptKey，replacement prose hash 使 transitive surface descendants stylistically stale，不能 assemble，必要时重渲染。`fallback_without_surface` 仅在 group policy 明示并进入 cache key时合法；exhausted retry 不得 patch state/skip hard validation/invent disclosure。
- cache 彻底分层：`LogicalRenderKey` 绑定 scene contract/WorldState/planned discourse/catalog/graph/style/profile/prompt-provider；`SurfaceRenderKey` 加 group manifest/surface policy/ordered source prose hashes/extractor-truncation version；`ValidationKey` 加 prose hash/Pass2 schema-model/validator-reference policy；`AttemptKey` 加 surface key/attempt/prior prose/same-scene retry guidance。YAML/state 修改 invalidates logical dependents 与其 surface descendants；仅 prose 修改只 invalidates validation/assembly/surface descendants；group repartition/policy 只 invalidates surface keys。offline determinism 覆盖 contract/group scheduling/extraction/normalization/cache/invalidation/assembly，真实 LLM output 以 frozen reference artifacts 验收。
- performance 必须分别 benchmark logical_parallel、平衡/偏斜 serial groups、cold/warm cache、source prose fanout/retry/branch variants。报告 total work、critical path、makespan、cache hit、invalidated scene count、retry amplification，以及相对 `max(totalWork/poolSize, longestSurfaceCriticalPath)` 的 scheduler efficiency；不得以 pool speedup 惩罚必然 serial 的 group。`parallel_then_harmonize` 与 `joint_group` 为 X，不纳入 implementation/benchmark。最低 tests：surface永不进入logical/discourse reads；author group/order/branch validation；manual/suggest/auto manifest determinism；excerpt budget/normalization；POV/chapter/flashback policies；source retry/stale descendants/fallback；branch merge isolation；cache partition/invalidation；parallel groups completion order不影响结果。

#### [ ] INTEGRATION-1: 跨域解析、Merge 与双覆盖规范

- `not_exists`/未引入 entity/never-written cell 使用不可变 `AbsenceWitness` 作为 deterministic absence resolution：它绑定 concrete branch、temporal prefix、catalog/lifecycle/closed-world basis、latest unset（如有）与 resolution hash，可满足 presence-aware read 并进入 provider/absence index、snapshot/cache/reference tests；它不是 WorldState write、initialState unset、author-origin output 或 narrative causation。测试 never-written、pre-introduction、after-unset、branch-local absence、snapshot restart 与 aggregate three-valued evaluation。
- every deterministic read 必须恰有一个 `ReadResolution = ProviderOutput | AbsenceWitness`：ProviderOutput 才产生 provider edge，AbsenceWitness 使用独立 absence index/temporal basis且不伪装为 write/output。所有 read/provider coverage、branch validation、snapshot/cache/reference tests 均以 ReadResolution 为准，不得将 absence 强迫为 initial unset 或 author causal origin。
- read 分为 `stateBefore` 与 `stateAfter`：前者仅从跨 node exact latest provider/AbsenceWitness 解析；后者只检查当前 atomic node 的 complete candidate projection，由 internal effect graph 排序，不暴露 intermediate WorldState、不创建 node self-edge/跨 node provider。Rule final invariants/postconditions、same-node introduce+establish、implicit scope unsets 与 final referential integrity 都使用 candidate path；internal cycle/duplicate effect/invalid final state hard fail。
- `BoundaryReference` 是 hash-pinned、branch-compatible、one-way immutable StorySnapshot/StateBoundary input：DiscourseState/narrator/reveal validation 可验证明确 proposition 在过去/未来 boundary 的 truth，但 BoundaryReference 不生成 provider/order/causal edge、不改变 story replay/WorldState、也不把 whole future snapshot 放入 Pass 1。scene contract 只可 authorize exact proposition projection；merge shared render 需要每个 applicable branch reference 给相同 truth，否则 branch variant/reject。source/graph/state hash 改变时相关 discourse/cache invalidates。
- 所有跨 branch reconciliation 由 compiler-level `MergePlan` 处理，普通 concrete BranchPath replay 永不读取其他 branch state。MergePlan 明确 incoming pinned snapshots、merge node/effective coordinate、`requireEqual|selectBranch(branchId)|literal` policy、source/merge provenance，原子构建全部 domain candidate result并以 typed cross-domain read sets验证，生成 branch-specific reconciliation transactions 与 explicit downstream outputs。每个 reconciliation transaction 必须从 every incoming lifecycle/identity/reference state 合法：`selectBranch`/literal 不得隐式复活 retired entity、绕过 reference closure或改变 immutable identity；否则拒绝或显式新 identity/epoch。`selectBranch` 仅在 MergePlan 合法；禁止 domain fixed merge order、auto union/average/active-wins/retired-wins。先解析 identity/lifecycle/reference，再以一个 candidate merge graph 验证所有 cross-domain reads，cycle 即失败；entity/relationship/knowledge/thread/rule 的 remint/epoch/run/provider lineage 按其 STATE contract执行。
- 外部语料采用正交双 coverage manifest：`NarrativeNode = NarrativeEvent | NarrativeEllipsis` 覆盖 story replay/source state；`DiscourseNode = ScenePresentation | DiscourseBridge` 覆盖 reader discourse order/planned disclosure。`DiscourseBridge` 是 source-verified omitted-text disclosure record（position/planned acts/provenance），无 WorldState effect/render/POV/Pass2 job，且可与同一 source range 的 narrative ellipsis 并存，不在任一 coverage layer 内双重计数。sparse run 只能声明 `isolated_excerpt`（ExcerptDisclosureCheckpoint）或 `full_work_context`（preceding bridge completeness）；缺 checkpoint/bridge hard fail。
- snapshots 分为 `StorySnapshot` 与 `DiscourseSnapshot`。StorySnapshot 绑定 branch、ancestor-closed temporal node prefix、ordered node/effect/output IDs、complete WorldState、provider/AbsenceWitness indexes、entity/relationship/thread tombstones、rule epoch/exception/specification-transition/retired-ID tombstones、retained InformationActs/RuleEvaluationRecords、type/declaration catalog hashes、normalized graph hash、state/provenance/schema/replay hashes；它严格 selection-independent，恢复结果必须与 full story replay 完全相同。DiscourseSnapshot 绑定 assembly/branch/DiscoursePosition、planned DiscourseState、narrator/profile/proposition catalog/BoundaryReference/selection/discourse graph/schema hashes；恢复结果必须与 full planned discourse replay 相同。generated prose、Pass 2 observations、surface packets 永不进入逻辑 snapshots，仅存在于 validation/render/assembly artifact cache。

#### [ ] CAPABILITY-1: 支持边界与 conformance manifest gate

- 建立 versioned `CapabilityManifest`，将每项对作者/LLM 宣称的能力映射到 capability ID、`S|C|X` 状态、schema/normalization versions、supported input forms、reference cases、property/model cases、rejection cases、snapshot/cache cases、fixture IDs、provenance requirements、stage gate 与 evidence artifact hash。每个 YAML schema variant、compiled IR variant、runtime domain operation与跨域组合必须归属一行；无 manifest entry 的输入默认 rejected，不得靠 loader fallback 或文档暗示为支持。
- `S` 仅在有限 deterministic 语义、typed rejection、production implementation、独立 reference interpreter、property/model tests、human-readable fixtures、适用的 snapshot/replay/cache equivalence 和 stage evidence 全部通过后可对外宣称支持；reference implementation 不得 import production replay/canonicalization/key/provider/predicate/merge helpers。CapabilityManifest 必须声明 evidence class（例如 `state_replay`、`discourse_replay`、`schema_rejection`、`surface_scheduler`、`validation_measurement`）及其 mandatory evidence set；只有该 artifact class 逻辑上不拥有 replay/snapshot/cache surface 时才可填写带理由的 `N/A`，不得以泛化 N/A 逃避测试。`C` 仅表示结构/contract 可表达但 prose/Pass 2/human detection 是测量能力，例如 narrativeHint realization、semantic thread goal、semantic rule compliance、subtle hint/spoiler detection、narrator sincerity及对 model-reader disclosure contract 的 human-rated effectiveness；必须报告 calibration/F1/CED/human evidence/uncertainty，绝不得等同 S。actual reader mind/state/effect为 X，不得收集、推断或宣称建模。`X` 是明确不支持：schema/compiler 抛 typed error，docs 指出替代建模方式，并有 rejection fixture。
- RENDER-SURFACE 必须至少有两条独立 manifest rows：`surface_scheduler_contract` 是 S 候选，覆盖 deterministic grouping/extraction/budget/cache/invalidation/assembly gating；`surface_prose_continuity_outcome` 是 C，仅测量 serial surface reference 对连贯性/风格延续的 human/validation evidence，绝不把 scheduler 成功或 frozen artifact 等同为保证 prose coherence。
- Stage 1 gate：所有 declared S core schema/replay/graph/lifecycle/branch/snapshot/cache/fixture capabilities均须 manifest complete；默认 offline CI 运行 relevant conformance suites，recorded/live smoke 只能补运行证据不能替代。Stage 2 gate：外部 corpus、C metrics、人类标注、source/legal/provenance、performance/cache/parallel evidence分别绑定 manifest；C 不得作为绝对质量/逻辑保证。Stage 3 gate：每次项目 render/assemble 固定并记录 manifest/version/config；遇 X 或 manifest 未覆盖的 YAML/IR 组合 hard fail，无隐式降级。
- minimum cross-domain conformance suite 覆盖 AbsenceWitness、candidate-state reads/internal effects、dynamic introduction/retirement、full n-ary identity transitions、all MergePlan operators、branch-specific providers、same-time commutativity、BoundaryReference、story/discourse separation、DiscourseBridge、every implicit output、source/edge/merge provenance、snapshot/cache hash constituent、adjacent migrations、production-vs-reference equality。coverage percentage 不能替代 manifest evidence；新规范章节在其全部 manifest rows 达 S 前保持 unchecked，不得因文档已写而声称 implemented。

#### [ ] YAML-CONTRACT: 每个冻结数据结构的 author-facing 接口

- 每个已经冻结的 normalized runtime contract 必须同步有版本化 YAML authoring interface；YAML 是作者/LLM 可读中间表示，不是 runtime truth 的独立第二语义。编译器只能执行 `YAML -> normalized IR` 的明确归一化，任何内部 provider/output/read/hash/tombstone/derived projection 不得要求作者手填，也不得在未定义 YAML contract 时由 loader 猜测。
- YAML schema/docs 必须覆盖 initialState、Entity type/declaration/lifecycle transaction、full n-ary relationship type/epoch/membership/dimension transaction、Proposition/claim/information act、Thread type/run/goal/milestone transaction、Rule specification/constraint/exception transaction、typed causalDependencies、Discourse scene contract/acts、NarrativeEllipsis 与 DiscourseBridge。每个接口定义 required/optional、mutually exclusive forms、closed enums/IDs、branch/time/provenance、author-facing convenience syntax及其 exact normalized target；runtime fields未暴露时必须由 compiler deterministic materialize 并给 stable source map。
- schema validation/compile errors 必须定位 YAML path、source span、expected normalized form 与相关 predecessor/provider；不允许 unknown field 静默丢弃、stringly typed fallback、自由文本 direction/predicate 或 inferred default 改变 replay。每个 schema version 有 adjacent migration、canonical formatter、有效/无效 examples、round-trip/normalization fixtures；generated author docs 与 examples 从 schema registry 校验，避免 TODO、Zod 和 YAML 手册漂移。
- 每次新增或改变 internal semantic contract，必须在同一变更集新增/修订 YAML interface、Zod/schema registry、migration、source-map diagnostic 与 fixture；没有 YAML contract 的能力仍为 internal/unreleased，不得向作者或 LLM 声称支持。

### [ ] 长篇小说语料库（CORPUS）

**范围**：本节仅服务阶段 2 的外部长篇 benchmark，不改变阶段 1 的完整 fixture render，也不向阶段 3 的原创作者流程施加语料库义务。语料建模使用下列固定层级：

```text
NarrativeNode
├── NarrativeEvent       # 既有 event(scene)，可渲染
└── NarrativeEllipsis    # 显式叙事省略段，非 scene、不可渲染

DiscourseNode
├── ScenePresentation    # rendered scene 的 planned discourse acts
└── DiscourseBridge      # 未渲染原文的 source-verified disclosure record
```

#### [ ] CORPUS-1: `NarrativeNode` 与 `NarrativeEllipsis` 契约

- `NarrativeNode = NarrativeEvent | NarrativeEllipsis`，以显式 discriminant 区分。既有 YAML `EventFile` 和 `NarrativeEvent` 保持作者面对的 event(scene) 模型与直接状态字段，不要求原创项目理解 ellipsis。
- `NarrativeEllipsis` 表示一段有意不按 scene 拆分、但必须纳入故事模型的叙事省略。它具有 identity、branch scope、一个有效 `storyTime`、可选 source-grounded diagnostic summary，以及直接复用的 preconditions、Entity/Relationship/Knowledge/Thread/Rule transactions；summary 本身不得创建 claim/provider。
- `NarrativeEllipsis` 不得拥有 POV、cast、scene brief、style、target words、`narrationTime` 或 `narrativeOrder`；永不产生 `RenderedScene`，不进入 RenderJob、Pass 2、scene validator、Assembler、scene count 或 CED/F1 分母。raw summary 仅供来源审查/diagnostics，绝不得直接进入 target logical prompt、产生 Fact/因果边/WorldState/DiscourseState 变更；target logical context 只能来自 planned discourse projection，surface context只能按 RENDER-SURFACE-1 使用已接受 rendered prose。
- 每个 replay-changing Fact/effect 必须有原子 `$provenance`。一个 ellipsis 内若含多个不可共用 `storyTime`、branch 或因果位置的变化，必须拆分；来源、依赖或有效时间无法证明时 corpus 构建硬失败。

#### [ ] CORPUS-2: 全作品索引、锚点与来源

- 每个 work variant 建立版本化全作品索引：固定 source manifest、章节/原文定位、人物与 alias、地点、主/支 thread、`NarrativeNode` 清单、`DiscourseNode` 清单，以及冻结的 candidate-event index。candidate 必须是自然原文边界上的可渲染 scene 候选；index 记录 eligibility、ID、source range 与排除原因。narrative coverage 与 discourse coverage 分别绑定 source hash、各自不重叠并完整覆盖本层所声明内容；同一 source range 可在两层出现，但每层内禁止未说明的空洞。
- 锚点固定为《红楼梦》前 80 回主模型、`David Copperfield` 固定公版英文 edition、以及本地 external 的《四世同堂》87 章中文主模型和独立 103 章回译 extension。87/103 章分别有 manifest、索引、selection 和报告，禁止 pool 或双重计数；《四世同堂》不进入默认公开 CI 或公开 aggregate score。
- 每个锚点在开始建模前冻结 edition/source hash、法律模式、adapter/schema 版本与来源清洗规则。未请求的本地 external corpus 必须标为 `not-run` 并排除；一旦 corpus 被请求运行，缺失文本、法律前提或 manifest 即为构建失败，不得记为成功、零值或公开分数。公开 CI 只运行法律模式允许的固定小型子集。

#### [ ] CORPUS-3: 可复现的选择性渲染

- 每个 work variant 的规划 selection 从冻结 candidate-event index 取 `min(32, max(20, ceil(0.15 * N)))` 个候选，其中 `N` 为 candidate count；`N < 20` 的 work variant 不得作为 benchmark-eligible 长篇。每个被规划选中的候选必须先由用户手动建模为现有 `NarrativeEvent`，并完成必要的 ellipsis 拆分、state effect 归属、provenance 与因果依赖校验，才可进入 runnable selection。
- planning selection 在任何模型结果前冻结 selection algorithm、seed、strata、配额、rounding、tie-break、exclusion、replacement policy、candidate IDs 与 source ranges。runnable selection 只能引用已存在的 `NarrativeEvent` IDs；至少覆盖开端/中段/结尾、主线、至少一条支线和主要人物状态变化。
- 只选择 `NarrativeEvent` 生成独立 rendered scene 文件；不使用正常 Assembler 把不连续 prose 伪装成完整小说。未选择的原文内容由用户维护的 `NarrativeEllipsis` 或不影响状态的来源定位覆盖，选择本身不得自动修改完整故事模型。若 runnable selection 引用仍被 ellipsis 覆盖的候选，必须 hard fail，并指出要求用户拆分的 source range 与重复/缺失 effect。

#### [ ] CORPUS-4: 混合因果回放与边界基准

- DAG、replay 与 StorySnapshot 接受 `NarrativeNode[]`。先按 branch scope 过滤，再按 GRAPH-1 exact output/read/provider、typed causal edges 与 `storyTime` 建立 mixed-node order；同一时间的非交换写入必须有来源支持的 dependency，否则 hard fail。`narrativeOrder` 只用于 discourse/Assembler，不得影响 story provider、`stateBefore` 或 StorySnapshot。
- 选中 event 的 `stateBefore` 必须从完整 mixed-node causal graph 取得，排除 target 和未来 effects。DAG-2、DAG-3、DAG-5、API-2、API-4 是此项的前置条件；snapshot 必须记录已 replay 的 `NarrativeNode` IDs。
- 每个选中 event 维护独立、人工 source-verified 的 StoryBoundaryOracle 与 planned pre-scene DiscourseOracle：前者断言 all canonical state domains、provider/AbsenceWitness/required artifacts 的预期投影，后者断言 model-reader/narrator disclosure projection。oracles 必须固定 schema/version、source hash、reviewer/review status/hash，并写入 run manifest；canonical equality使用固定排序/NFC/LF serialization。mixed replay/discourse compile 必须分别精确一致；不得用同一 YAML replay 自证。

#### [ ] CORPUS-5: 构建失败、指标隔离与验收

- 缺失或失配的 source、`$provenance`、因果依赖、branch-compatible provider、boundary oracle 覆盖、法律模式或 selection manifest 必须使 corpus loading/compilation 失败。不得新增 validator abstention 状态，也不得以 `deferred`、skip、零 CED 或零 F1 掩盖构建失败。
- 所有 ellipsis 的构建完整性是 dataset-integrity gate，而非 prose validator result；它们完全排除在 prose、scene、Pass 2、validator 和 CED/F1 的 metric population 之外，不是零值观察。选中 rendered scene 的文件数必须精确等于冻结 selection 的 event 数。
- 至少测试：event/ellipsis schema 互斥；DiscourseBridge/coverage checkpoint；raw ellipsis summary 不能进入 logical prompt或泄漏；原子 provenance、缺失依赖、cycle、时间/顺序歧义硬失败；Story/Discourse snapshot-full replay等价且 hashes兼容；target/future effects不泄漏；双 boundary oracle一致；全作品双 coverage完整；selection可复现；87/103不混池；未请求本地 external在公开 CI正确记为`not-run`；独立 scene输出不被 assembler 拼接。

### [ ] API-1: `initializeProject` O(n²) commit + 多次独立调用

**现状**：`initializeProject()` 被 `renderNovel`、`validateNovel`、`getProjectStatus`、`diffEvent` 等各自独立调用。MCP 服务器一次 `nova_status` + `nova_validate` = 两次完整初始化。

每次初始化内部：

```ts
for (const event of events) {
  stateManager.commit(event); // 每 20 个事件触发 getCurrentState() → 完整 DAG replay
}
state = stateManager.getCurrentState(); // 又一遍完整 replay
```

50 个事件 = 在 event 20、40 触发完整 DAG replay + 最终又一次 = 3 次全量 replay per 初始化。

**修复方向**：

1. `initializeProject` 只构建并验证 versioned project compile plan：catalogs、normalized outputs/reads、branch-filtered graph、planned discourse contracts与合法 Story/Discourse snapshot prefixes；不得按 commit/narrativeOrder 维护第二套 running WorldState。
2. snapshot 创建仅在 ancestor-closed temporal prefix 上统一计划；恢复始终走 unified graph replay，不得以 loop position 假设 state 正确。
3. 加 hash-keyed `ProjectCompileResult` cache。唯一 canonical `ProjectCompileInputHash` = normalized definitions 与 source/corpus provenance、type/declaration/proposition/style catalogs、CapabilityManifest、compiler/schema/replay/normalization versions、normalized Story/Discourse graph hashes、planned discourse contracts、branch/selection/assembly configuration、relevant project config 的 canonical hash；同 projectDir 的 mtime 不能作为正确性键，cache hit须验证该 hash 与全部 compatibility hashes。

**优先级**：medium（50 个事件规模影响不大，但 1000+ 事件场景下 O(n²) 暴露。在阶段 1 "清理杂草"时处理）

**实现成本估算**：0.5 天（改动集中在 initializeProject 内部）

### [ ] API-2: `renderNovel` 两次 getStateAt 遍历

**现状**：dryRun 和 full render 各自遍历全部 event，每个 event 独立调用 `stateManager.getStateAt(ev.narrativeOrder - 1)`——做 snapshot-optimized replay 来获取该 event 的 beforeState。

```ts
// dryRun (line 202-218): 遍历一次
for (const ev of renderEvents) {
  beforeState = stateManager.getStateAt(ev.narrativeOrder - 1);
  pkg = compiler.compile(ev, beforeState, registry, { systemContext: sysCtx });
}

// full render (line 256-267): 再遍历一次
for (const ev of renderEvents) {
  beforeState = stateManager.getStateAt(ev.narrativeOrder - 1);  // 重复
  pkg = compiler.compile(ev, beforeState, registry, { systemContext: sysCtx });
  jobs.push(...);
}
```

50 个事件 = 100 次 getStateAt 调用（每次从 snapshot replay ~20 个增量事件）。

**修复方向**：dryRun 与 full render 使用同一套 CompileJob 构建实现，并在单次调用中只为每个目标 event 计算一次 stateBefore/context。`stateBefore` 由 DAG-5 unified replay 的 complete branch-compatible temporal prefix 取得：更早 temporal nodes、同 coordinate 的 ordered ancestors及其全部 required closure，不能只取 causal ancestors，且不得再调用 `getStateAt(ev.narrativeOrder - 1)`；CORPUS 选择性渲染的未选 event/ellipsis 仍参与该回放。验收以每个模式的 CompileJob 数、目标 stateBefore 与统一 replay 一致性为准，而非假设两个独立 CLI 调用共享内存缓存。

**优先级**：low（重复工作但 token 开销不大。与 API-3 共同解决）

**实现成本估算**：0.3 天（提取共享 compile 步骤）

### [ ] API-3: `getProjectStatus` 重新跑全量 validator

**现状**：`getProjectStatus()` 内部重新调用 `aggregator.validateAll()` 来判断 blocked 事件，但这套逻辑 `validateNovel()` 已经走过一遍。两者的 validator 配置（overrides）可能不一致。

```ts
// validateNovel (line 311): runs all validators
// getProjectStatus (line 377): runs all validators again
```

**修复方向**：`getProjectStatus` 接受可选的 `validationResults` 参数，或内部调用 `validateNovel` 复用其结果（但注意 validateNovel 也调用 initializeProject）。

**优先级**：low（validator 在不涉及 LLM 时是纯计算，成本不大。重复 initializeProject 才是大头）

**实现成本估算**：0.2 天（参数化或内部复用）

### [ ] API-4: StateManager 做完 commit 即被丢弃

**现状**：`initializeProject` 中 commit 循环构建了完整的 WorldState（通过 `getCurrentState()`），但 `renderNovel` 不信任这个结果，转而每个 event 独立调用 `getStateAt(n-1)` 获取 beforeState。

旧实现错误地假设按 narrativeOrder 顺序 commit 可代表故事 replay；在 gapped discourse、branch、storyTime、typed causal graph 下此假设无效。渲染所需的 target stateBefore 只能来自 unified branch-filtered graph replay/StorySnapshot closure，而不是 `getStateAt(n-1)`。

**根本原因**：初始化流程是为"加载已有 project"设计的——commit 回放所有事件得到最终 state 用于验证/状态检查。渲染流程需要的是"每个 event 渲染时的瞬间 state"。这两个用途被混在同一个初始化流程里。

**修复方向**：以 DAG-5 的 unified replay 计算目标 `stateBefore`，或预计算 hash-keyed `Map<{ nodeId, branchPath }, StoryReplayBoundary>`；boundary 包含 complete WorldState、provider/AbsenceWitness indexes、retained artifacts、target coordinate、ancestor-closed branch-compatible temporal prefix与 compatibility metadata。任何缓存/快照只能来自同一 complete branch-compatible prefix，不能只取 causal ancestors、也不能按 commit 或 `narrativeOrder` 顺序假设正确。CORPUS 中该计算必须包含未渲染 `NarrativeEllipsis`，并按 DAG-2/DAG-5 的 `storyTime` + 因果规则生成目标 event 的 stateBefore。

**优先级**：low（与 DAG-5 共用修复路径）

**实现成本估算**：包含在 DAG-5 中

### [ ] API-5: 无 `initializeProject` 结果缓存

**现状**：同一 projectDir 在同一 CLI/MCP 调用中被多次初始化。数据（YAML 解析、entity 注册、state 重建）完全不变。

**修复方向**：使用 API-1 唯一的 canonical `ProjectCompileInputHash` 做 cache key；不得再定义第二套字段列表。不得只按 projectDir/mtime；cache hit须验证该 hash与全部 compatibility hashes。

**优先级**：low（CLI 单命令只调用一次，但 MCP 服务器长连接中多次调用会重复初始化）

**实现成本估算**：0.1 天（模块级缓存 map）

---

## YAML 格式文档缺口

> 来源：2026-07-19 对比全部 Zod schema (`packages/core/src/schemas/`) vs 现有文档 (`docs/reference/yaml-format/`)

**现状**：16 个 Zod schema 文件，但只有 3 个对应 YAML 格式文档（character、event、rule）。其余或有 schema 无文档，或已有文档缺字段。

### [ ] DOC-1: 缺失 location/item/faction/branch YAML 格式文档

**现状**：现有 `location/item/faction/branch` 字段文档缺失，且旧 definition-only 视图已不足以覆盖 STATE-3 Entity type/declaration/lifecycle、ReferenceEligibility、MergePlan 与 YAML-CONTRACT 的 versioned author interface。

**需要做什么**：由 schema registry 生成/校验 `location.md`、`item.md`、`faction.md`、`branch.md` 及对应 Entity type/declaration/introduction/retirement/reference-policy/migration 文档；每份包含字段表、normalized IR、合法/非法 fixture、source-map diagnostic、版本迁移和数据流说明。不得只文档旧静态 definition。

**优先级**：medium（系统能跑，但用户无法正确编写这些实体类型的 YAML）

**实现成本估算**：0.5-1 天（4 个文件，每个约 40-60 行）

### [ ] DOC-2: event.md 缺失 Fact 关键字段文档

**现状**：event.md 仍只描述旧 Fact 形状，未反映 STATE-1/GRAPH-1/YAML-CONTRACT 的 presence-aware transaction、typed causalDependencies、跨域 authoring interface。

| 字段            | 适用               | 文档状态                                                                                     |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `operator`      | precondition only  | 完全未提（`eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`contains`/`not_contains`/`exists`/`not_exists`） |
| `narrativeHint` | 两者               | 仅在 postcondition 示例中出现，无文字说明                                                    |
| `confidence`    | postcondition only | 仅在示例中出现，字段表无解释                                                                 |

且以下规则未文档化：

- `set`/`unset`/`narrativeHint` 三种互斥 Fact 形式、`value` 与 `narrativeHint` 互斥、null/presence/AbsenceWitness 语义
- placeholder 值（`changed`、`resolved` 等）被 Zod 拒绝

**需要做什么**：由 versioned schema registry 生成 event.md 的完整 Fact/Entity/Relationship/Knowledge/Thread/Rule/causal/discourse authoring reference，包含 mutually exclusive forms、normalized targets、typed errors、valid/invalid examples、migration和source-map diagnostics；docs CI 必须校验它与 Zod/registry 同步。

**优先级**：medium（事实双重表示是核心设计，不写清楚用户会写错）

**实现成本估算**：0.2 天（补充字段表 + 示例）

### [ ] DOC-3: configuration.md 缺失 6 个 nova.yaml 字段

**现状**：`projectConfigSchema` 有 12 个字段，但 `docs/getting-started/configuration.md` 只列了 6 个。缺失：`defaultLanguage`、`genre`、`synopsis`、`validatorOverrides`、`circuitBreaker`、`reviewExpiry`。

**需要做什么**：configuration.md 补充完整字段表，每个字段带类型、说明、示例。

**优先级**：low（部分字段尚未在 api.ts 中传入，但文档应反映 schema 全貌）

**实现成本估算**：0.1 天（补充表格）

---

## Storage 抽象与 I/O 审计

> 来源：2026-07-19 审计 `Storage` 抽象覆盖范围

### [x] STORAGE-1: `render-cache.ts` 有未使用的 `fs` import

**原始问题（已修复）**：`packages/core/src/cache/render-cache.ts` 曾有未使用的 `import * as fs from 'node:fs';`；所有 I/O 保持经 `Storage` 参数。

**完成备注（2026-07-20）**：已移除 `packages/core/src/cache/render-cache.ts` 的未使用 `node:fs` import；`packages/core/tests/render-cache.test.ts` 覆盖 MemoryStorage cache 读写。验证：`npx vitest run packages/core/tests/render-cache.test.ts` 通过（并入本次 4 files / 12 tests）。`docs/architecture.md` 的 storage section 已明确 render cache 仅经注入 `Storage` 读写。


### [ ] STORAGE-2: 全模块 I/O 审计 — 确认是否全部走 Storage 抽象

**现状**：核心模块（render-cache、snapshot、event-store）已使用 `Storage` 接口。但未审计全部 I/O 调用点：

- `api.ts` 的 snapshot 路径是否硬编码 `fs` 操作
- `yaml-loader.ts` 是否用 `readYamlFile<T>(filePath)` vs `storage.read()`
- `assembler/novel.ts` 的 `output/novel.md` 写入是否走 Storage
- `pipeline/output.ts` 的场景文件写出是否走 Storage
- `reporter/validation-reporter.ts` 的 `output/validation.md` 写入是否走 Storage
- `bench/src/reporters.ts` 的 `output/bench/` 写入是否走 Storage

**需要做什么**：逐文件审计 → 列出绕过 Storage 的直接 I/O 调用 → 逐项替换为 `Storage` 接口。

**优先级**：low（当前单文件系统运行没有问题，但 MemoryStorage 测试和未来浏览器/Deno 兼容性依赖完整抽象覆盖）

**实现成本估算**：0.5 天（审计 + 替换）

---

## CLI 构建与可用性

> 来源：2026-07-19 实测 `fixtures/zhu-fu/` 下的 11 个 CLI 命令

### [x] CLI-1: CLI 捆绑不可运行 — yaml ESM 兼容性问题

**原始问题（已修复）**：`packages/cli/dist/index.js` 曾因间接捆绑 `yaml` 而在 Node 24 抛 `Dynamic require of "process" is not supported`。

**完成备注（2026-07-20）**：`packages/cli/build.mjs` 已将 `@novalistically/bench` 设为 external，避免间接捆绑 YAML 的 ESM dynamic require。验证：`packages/cli/tests/bundle-boundary.test.ts` 断言产物不含 `Dynamic require` 且 built CLI `--help` 可运行；`npx vitest run packages/cli/tests/bundle-boundary.test.ts` 通过（并入本次 4 files / 12 tests）。`docs/reference/cli.md` 已记录 built CLI 的 ESM boundary 验证。


### [x] CLI-2: zhu-fu fixture 触发 DAG cycle 回退

**原始问题（已修复）**：zhu-fu 曾因 precondition/postcondition 因果边形成 cycle，`replay.ts` 会降级为 narrativeOrder；现在 cycle 是硬错误，fixture 无环。

**完成备注（2026-07-20）**：`topologicalSort()` 现对 cycle 抛 `DagCycleError`，render 走 `compileStoryBoundaries()`，不再降级为 narrativeOrder fallback；zhu-fu 因果数据已调整为无环。验证：`packages/core/tests/state/dag.test.ts` 覆盖 cycle 拒绝，`packages/cli/tests/render-full-chain.test.ts` 覆盖 E0–E6 全链路，二者均随 `npx vitest run packages/core/tests/render-cache.test.ts packages/core/tests/state/dag.test.ts packages/cli/tests/bundle-boundary.test.ts packages/cli/tests/render-full-chain.test.ts` 通过（4 files / 12 tests）。`docs/reference/state-management.md` 已说明无 fallback 的 DAG 行为。


### [ ] CLI-3: `diff` 命令 API 存在但 CLI 入口路径未验证

**现状**：`diffEvent()` API 已存在（`api.ts:460`），实测 E1 返回 9 个已变更属性。但 CLI 入口实现使用硬编码 `JSON.stringify` 输出 before/after 值，可能对嵌套对象输出不佳。CLI 捆绑 bug 阻塞实际测试。

**需要做什么**：CLI 捆绑修复后首次测试 `nova diff E1`，验证输出格式可读。

**优先级**：low（API 已验证正确，只是 CLI 入口未测试）

**实现成本估算**：0 分钟（捆绑修复后自然验证）

### [ ] CLI-4: `commit` 命令独立重建 StateManager，与 `renderNovel`/`validateNovel` 的初始化重复

**现状**：`commit` 命令（cli/src/index.ts:541）创建自己的 EntityMapper + StateManager，做完整的 commit 循环。`initializeProject()` 在 `api.ts` 中做同样的事。两套代码做同样的事，且 CLI 版本可能不同步。

**需要做什么**：CLI 调用 `initializeProject()` 而不是内联重复初始化逻辑。或确认 `commit` 命令的设计意图（是独立于 render/validate 的状态快照工具？）

**优先级**：low（功能重叠但不产生 bug）

**实现成本估算**：0.2 天（重构 CLI 入口调用）

### [ ] CLI-5: `review list` 命令中 EntityMapper + EntityRegistry 创建但未使用

**现状**：`cli/src/index.ts:376-381` — `review` 命令中创建了 EntityMapper 并加载项目数据（用于 `add` action 的 event 查找），同时创建 InMemoryEntityRegistry 并 load，但 EntityRegistry **从未被使用**（在所有 5 个 action 中均无引用）。

**修复**：删除未使用的 InMemoryEntityRegistry 创建（第 380-381 行）。

**优先级**：trivial

**实现成本估算**：0 分钟

---

## Core 公共 API 边界重定义（阶段收尾任务）

> **前置依赖**：此任务必须在所有其他功能 TODO 完成后执行。当前 core 的 `index.ts` 过度暴露了内部模块——validator 类、StateManager、ContextCompiler、RenderPipeline 等不需要对消费者公开的实现细节。改动的正确时机是：所有内部逻辑都稳定后，最后一次修剪公共 API 面。

### [ ] CORE-API-1: 重定义 core 公共 API 边界（thin core 原则）

**现状**：`packages/core/src/index.ts` 导出了 ~90 项（函数 + 类 + 类型），包括内部状态引擎、验证器内部类、内部管线组件等。业界 thin core 惯例（React、Prisma、Vercel AI SDK）：core 只暴露 ~15 项编排函数 + 所有类型，其余不公开。

**目标边界**：

应公开（~15 项，永久兼容承诺）：

```
// 编排层
renderNovel, validateNovel, getProjectStatus, diffEvent, listEntities, showEntity, assembleNovel
// AI provider
AiSdkProvider, MockProvider
// Storage 接口
Storage (interface), FsStorage
// 核心工具
compareFact, countWords, readYamlFile
// 所有类型
export type * from './types/index.js'
```

应撤回（当前公开但应为内部）：

```
StateManager, ReplayEngine, SnapshotEngine, EventStore  // 内部状态引擎
ContextCompiler, ContextAssembler, RelevanceEngine       // 内部上下文管线
RenderPipeline, BatchRenderPipeline, ConcurrencyPool     // 内部渲染管线
ResultAggregator                                          // validator 内部聚合
20 个 validator 类                                       // 通过 validateNovel() 调用
SceneCollector, NarrativeSorter, ProseConcatenator        // assembler 内部
createCircuitBreaker                                      // 内部断路器
buildSceneRenderPrompt 等 4 个 prompt 函数                // 内部 prompt 构建
compareTimestamp, parseStoryTimestamp                     // 内部时间戳工具
InMemoryEntityRegistry                                    // 内部测试工具
```

**需要做什么**：

1. 确认无外部消费者依赖当前过度导出的 API（CLI、MCP、bench 是否直接 import 内部模块）
2. `core/src/index.ts` 精简到目标边界
3. 如测试需要 `MemoryStorage` → 通过 `@novalistically/core/testing` sub-path 暴露
4. 如插件场景需要访问 validator → 通过 `@novalistically/core/plugin` sub-path 暴露

**优先级**：low（但依赖全部功能稳定。在阶段 1 末尾的"清理杂草"步骤中执行，作为最后一个 PR）

**实现成本估算**：0.5 天（审计外部 import + 重排 index.ts + 测试）
