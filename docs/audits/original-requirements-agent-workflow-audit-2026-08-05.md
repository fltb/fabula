# 原始要求 / Agent-first 工作流符合度审计（2026-08-05）

**日期**：2026-08-05
**审计对象**：`docs/archive/PROJECT.md`（2025-07 原始设计）中的 Agent-first 要求 vs 当前工作树实现
**结论**：**部分满足（partial）** —— 外部 MCP Agent 主 authoring 通道与 Core 场景产能管线真实可达；Workbench Host 是 acceptance/运行基础设施；但最终成书组装、Review 生产侧、Plugin 激活、三个 MCP 工具 handler、status guidance、working-layer 验证与内置 Agent 的在场暂停问题均为生产接线缺口，且 `public-api` 门禁与 `test:e2e` 门禁在 2026-08-05 处于红态。
**权威顺序**：当前源码 > package manifests > 可复现门禁结果 > 历史文档。本审计是撰写时点（2026-08-05）的快照；`docs/archive/PROJECT.md` 是历史要求，**不改写**。

> 阅读约定：所有行号/符号均为 2026-08-05 工作树状态。门禁结果由主协调者统一执行（本审计任务按契约跳过全部测试/lint/format/build）；源码层面的 grep/结构核验由本审计完成。mock 测试不代表 live LLM 证据（见 §11）。

---

## 1. 范围与方法

### 1.1 审计问题

原始设计将"外部 AI chat/agent 是主要创作交互与产能来源，Workbench 只负责编辑、审阅、人工介入和管理"立为不变式（`docs/archive/PROJECT.md` 下称 PM）：

- **PM:29-39, 93, 345** —— Discovery Layer：任何能读写 YAML 的 AI 工具都可充当发现层，Core 只定义文件格式；
- **PM:100-101** —— 一期 UX = CLI + AI chat agent，agent 作为自然语言前端；
- **PM:94, 104-113, 289** —— Proposal → Validate → Commit 闭环，LLM 与人走同一条管线；
- **PM:77-88, 98** —— Review 是有状态一等对象，进入版本历史；
- **PM:273, 432-433, 97** —— Assembler（★ MUST HAVE）：已 committed Scene prose 按 narrativeOrder 拼接成 `output/novel.md`，"改完文件，书自动已存在"；
- **PM:102, 309, 337, 466-471** —— Web UI/可视化明确为二期 NOT NOW，Workbench 不得成为 authoring 必要依赖；
- **PM:317-321** —— 一期验收端到端：建项目 → 定义世界观 → LLM 写 Scene → 一致性检查 → 提交 → **Assembler 生成可读小说**，走通 Proposal → Validate → Commit → Assemble 闭环。

### 1.2 方法

1. **文档要求提取**：通读 `docs/archive/PROJECT.md`（2952 行），抽出一期验收矩阵（P0=一期门禁/核心不变式；P1=次级要求；P2=保留标记，不得误读为一期门禁）。
2. **源码核验**：对每个要求定位实现与**生产调用点**（grep 全工作区 `packages/*/src`，区分实现存在 vs 被接线）。
3. **三路 Agent 区分**：外部 MCP Agent、Workbench 内置 Agent、Core Pass1/Pass2 LLM 角色分别核验各自通道与产能来源。
4. **门禁**：2026-08-05 统一实测（主协调者执行），结果记入 §11，本报告不重跑。

### 1.3 工作区事实

- 工作区为**六包**：`@novalistically/bench`、`@novalistically/cli`、`@novalistically/core`、`@novalistically/node-host`、`@novalistically/workbench`、**`@novalistically/workbench-protocol`**（新增独立包，`packages/workbench-protocol/package.json`，仅 build/build:js/build:types 三个 script，无测试）。2026-08-04 基线 `docs/current-state.md` 仍写"五个包"——本次审计起为六包。

---

## 2. 总体结论（部分满足）

| 层 | 判定 | 一句话证据 |
|---|---|---|
| 外部 agent 主 authoring 通道（MCP） | **真实可达** | `/mcp/projects/:projectId` Streamable-HTTP 端点 + 59 工具目录注册 56，edit→submit→render 闭环可达（§6） |
| Core 场景产能管线（Pass1/Pass2 LLM） | **已接线** | `nova_render` → `render-service` → ContextCompiler → provider.complete（§4.3） |
| Proposal→Validate→Commit 接受链 | **已接线** | release gate + CAS accepted-scene revision + native revision exact-once（§8） |
| Workbench Host = acceptance/运行基础设施 | **成立** | ProjectSession 串行队列 + 能力门 + presence/vector CAS（§7） |
| Workbench Browser = 次要人工控制台 | **基本成立** | 无 document 生命周期、Review Hub/Publication 导航不渲染（§7） |
| Review 生产侧（producer） | **未接线** | `addReviewComment` 等零生产调用，无 `nova_review_*`（§9.2） |
| Assembler 最终成书 | **未接线（design-only）** | `canonicalAssemble/customAssemble` 仅测试调用，`buildPublication` 返回空（§9.1） |
| Plugin 运行时 | **未激活（design-only）** | `PluginHooksManager/PluginLoader` 仅测试构造（§9.3） |
| status guidance / ISS / next_actions | **未暴露** | `nova_status` 无 guidance/ISS/next_actions 字段；ISS 仅 `nova_validate` 返回（§9.5） |
| working-layer 验证 | **缺失** | `nova_validate` 只验证 accepted source（§9.6） |
| 内置 Agent 自主产能 | **不成立** | 单文档 proposal assistant；project-wide presence pause 自锁（§4.2, §9.7） |

**一句话结论**：外部 agent 驱动的场景生产（render+accept）是真实的、已接线的第一路径；但"审阅"与"成书"两半原始闭环在生产上不可达，Plugin 与内置 Agent 的自主产能未建立，因此原要求整体为**部分满足**。

---

## 3. 原始要求证据（docs/archive/PROJECT.md）

> `docs/archive/PROJECT.md` 页首自标"历史参考文档（2025 年 7 月），部分内容已过时，不代表当前实现"。以下为撰写时点提取的原始要求，作为符合度判定的基准，**不随后续实现改写**。

### 3.1 AI chat / Discovery Layer 要求

- **PM:29-39** 三层架构图 DISCOVERY LAYER：用户通过 AI Interface（opencode/claude/codex 等）自由聊天，AI 渐进式将讨论结果结构化（聊角色→character.yaml 等）；"技术手段：任何能读写文件的 AI 工具都可充当发现层，Core 定义了标准文件格式"。
- **PM:93** "Discovery Layer 与 Core 解耦：不写死 AI 工具"。
- **PM:345** "任何 AI 工具都可以是前端——系统不绑定 AI 工具"。
- **PM:1852-1854** §7.F 同语重复。
- **PM:460** "AI agent 只编辑 definitions/、chapters/、notes/"，thread/foreshadow/relationship/rule 声明在事件文件内，commit 后系统自动提取到 `.nova/derived/`。

### 3.2 Proposal-Commit 模式要求

- **PM:104-113** 核心理念流程图：Human/LLM → Proposal → Validator（一致性检查+规则验证）→ 通过 Commit（写入状态+记录事件）/ 失败 Reject（回退，给出冲突报告）；借鉴 PR → Code Review → CI checks → Merge。
- **PM:56** "LLM 和人提交的修改走同一条路径"。
- **PM:94** "LLM 写的东西 ≡ 人写的东西，都要通过 Validator"。
- **PM:289** "LLM 提案式接入｜Proposal → Validate → Commit/Rollback 完整闭环"。
- **PM:468, 2866-2869** Validator 两级分级：确定性硬错误 ERROR 阻断；其余 WARNING 不阻断；`validator_overrides: off|warning|error` 可覆盖。
- **PM:554, 435** 拒绝不丢弃用户编辑：存 `rejected_proposals/<timestamp>.yaml`，`nova commit --retry` 重提。
- **PM:556, 2871-2873** Circuit Breaker：Writer→Validator 循环最多 3 轮，超出升级人工仲裁（BLOCKED）。
- **PM:343** "Plugin 不能直接修改状态——只能通过 Proposal → Validate → Commit 路径"。

### 3.3 Review 层要求

- **PM:77-88** REVIEW LAYER：ReviewComment（关联 Scene/Chapter/Line，状态 open → addressed → resolved，严重度 nit/suggestion/blocking）→ Patch（用户或 LLM 根据 Review 生成，走 Proposal → Validate → Commit）→ 重新渲染/重新生成；"审阅评论本身也进入版本历史，可追溯"。
- **PM:98** "Review 是有状态的一等对象：不是临时的聊天记录，而是项目资产的一部分"。
- **PM:1816-1835** §7.E `ReviewComment` interface（author: human|llm、resolvedBy: PatchId、createdAt/resolvedAt）。
- **PM:1837-1844** `ReviewPatch extends Proposal`（sourceReviewIds、PatchChange: rewrite/insert/delete/attribute_change）。
- **PM:558, 2875-2877** Review 时效：blocking 默认 3 章降级 suggestion；`nova review summary` 近 5 章 blocking；`nova review history` 完整历史不阻断。

### 3.4 Assembler 要求

- **PM:273** MUST HAVE 表：Assembler（★）"将已 committed 的 Scene prose 按 narrativeOrder 拼接，输出完整可读的小说文件。纯机械操作。支持 BranchPath 过滤。输出 `output/novel.md`。用户不需要自己导出——改完文件，书自动已存在"。
- **PM:97** "最终产出是书，不是数据集……所有 YAML、Event、Validator、Context Compiler 都是手段"。
- **PM:432-433** 项目模板：`output/` "★ Assembler 自动生成 novel.md # 每次 commit 后更新"。
- **PM:319-321** 验收原型："……通过后提交 → Assembler 自动生成可读小说 `output/novel.md`。完整走通 Proposal → Validate → Commit → Assemble 闭环"。
- **PM:456-457** 目录表：`output/` 谁写=Assembler、谁读=人类阅读、可重建。

### 3.5 Status / 主循环要求

- **PM:100-101** 一期 UX = CLI + AI chat agent；反馈通过 PROJECT_STATUS.md + CLI `nova status`；agent 用人类语言报告验证结果。
- **PM:2328-2343** opencode 典型循环 5 步：`mcp_nova_status()` → 读 guidance 注入 system prompt → ISS<80 修 next_actions → `mcp_nova_validate()` → render.ready 选下一个 → `mcp_nova_render(event)` → 验证 → commit → 循环。
- **PM:2073-2086, 2130-2170** MCP StatusReport：机器可读（project/iss/validation/threads/render/blockers/next_actions）；RenderSnapshot ready/blocked/waiting/completed；Blocker 含 missing_preconditions。
- **PM:2231-2275** guidance：`mcp_nova_status()` 返回附加 guidance 字段，core 自动生成（ISS 优先 → 渲染 → 阻断 → 线程 → 不要做的事）。
- **PM:2100-2230** next_actions 排序（critical→high→medium→low），每条含 fix_action/fix_target/template。
- **PM:2885-2950** PROJECT_STATUS.md 人类语言状态文件（进度表/最近验证结果/待处理警告/Thread 状态/下一步）。
- **PM:557** CLI 结构化导航命令（status/scene list/entity search/review summary/review history），MCP 语义查询，不依赖直接浏览文件系统。

---

## 4. 三路区分：外部 MCP Agent / Workbench 内置 Agent / Core Pass1-Pass2 Agent

> 三者的本质差异：**外部 MCP Agent** 是主要 authoring 通道（自带文本，Host 只做验证与应用）；**Workbench 内置 Agent** 是单文档 proposal 助手（Host 跑 provider 生成 span-diff，人工显式 apply）；**Core Pass1/Pass2 Agent** 不是"agent 实体"，而是渲染管线内两次 LLM 角色调用，是真正场景产能来源，只经 `nova_render` 可达。

### 4.1 外部 MCP Agent —— 主要 authoring 通道（真实可达，但有三个洞）

- **传输真实**：`createMcpStreamableEndpoint`（`packages/workbench/src/host/mcp/transport.ts:145`）挂载于 `/mcp/projects/:projectId`，每次调用按 grant scope 重新授权（transport.ts:207-236）；由 `workbench-launch.ts:974-1037` 接线。外部 agent 用 Bearer device credential 访问 `http://127.0.0.1:8787/mcp/projects/<id>`（CLI `packages/cli/src/workbench-client.ts:167-170`）。
- **工具目录 59 个，registry 注册 56 个**：目录在 `packages/workbench-protocol/src/mcp.ts:904-996`（project/authoring/references/admin 四组，共 59 个唯一 `nova_*` 名）；实现注册在 `packages/workbench/src/host/mcp/registry.ts`。**3 个孤儿**：`nova_graph`、`nova_revise`、`nova_render_tree` 只在目录、CLI client 与 CLI 命令中，`packages/workbench/src` 下 **0 命中**（§9.4）。
- **产能来自外部 agent 自带文本**：`nova_authoring_document_edit` 由 caller 提供 `replacementText/edits`，Host 只做验证与应用（`mcp-adapter.ts` editDocument:202-247 → apply:331-427，presenceGeneration 原子复核 :392-394），Host **从不**为 MCP 通道运行 provider。外部 chat agent 能以显式逐次 tool 调用交付生产文本，但系统内不存在任何自主规划/后台迭代。
- **可达闭环**见 §6；**两个硬阻断**：① 首次接入必须 owner 配对 device credential（浏览器 admin 或 `nova_admin_device_pair_begin`，均需 owner/已有凭据，`device-pairing.ts:282-320`、`registry.ts:2510`）——设计上不可免的一个人工步骤；② revise 腿断裂（§9.4）。
- **无人工审批门**：持有 `mcp:author`+`mcp:submit` 的 device 可完全自主 edit→submit（`coordinator.ts:592-641` submit 自动 accept；冲突可经 `nova_conflict_resolve` 自解，`registry.ts:2183`）。"人工介入"只是角色策略，不是强制门。

### 4.2 Workbench 内置 Agent —— 单文档 proposal assistant（不构成自主产能）

- **真实接线（fail-closed）**：`workbench-launch.ts:721` `agentTasks = providerReady ? new AgentTaskService(...) : null`；`:781-793` 每项目接线 `createAgentCommandService` + `createAgentSuggestionService`（真实 Yjs documents + `session.hasHumanPresence`）；`browser-agent-api.ts` 注册 `BROWSER_AGENT_PROPOSAL_PATH/APPLY_PATH`（严格 64-hex baseVector 校验）。
- **proposal-only**：`AgentSuggestionService.generate()` 单次 provider 调用，解析为可审阅 span-diff proposal，生成期**零写入**（`suggestion-service.ts:385-554`，SYSTEM_PROMPT "Propose ONLY minimal, surgical text edits" `:226-240`）；`applySuggestion()` 重验 hash+span 后经 `AgentCommandService.applyEffect` 显式应用（`:560-616`），仅经受保护 POST 路由可达（`browser-agent-api.ts:222-344`）。
- **硬上限**：64k 文档字符 / 4k 指令 / 8,192 change-text / 256 changes（`suggestion-service.ts:31-41`）；不能创建文件、不能写 Git、不能触碰 Core accepted source（`edit-service.ts:22-36`）。"自主写小说 source/prose"不成立。
- **无 loop / 无后台**：唯一的 LLM 调用是每次同步 HTTP 请求的一次 `generate()`；`AgentQueuedResponseV1/AgentStreamingResponseV1` 与 `onStatus` 只在 client 契约（`agent-client.ts:60-91,124-133`），Host handler 从不返回 queued/streaming——design-only（`browser-agent-api.ts:200-221` 只回 proposed/paused/stale/failed）。
- **依赖浏览器会话**：proposal/apply 路由要求 browser-session 认证（`browser-agent-api.ts:121-142`），仅由 AgentDrawer 驱动；无 daemon/CLI/MCP 路径调用它。MCP authoring 工具完全绕过内置 Agent。
- **project-wide presence pause（§9.7）**：当前接线 `presence: { isHumanEditing: () => session.hasHumanPresence }`（`workbench-launch.ts:785,794`），而 `HUMAN_PRESENCE_SURFACES = ['browser','mcp','yjs']`（`project-session.ts:337`）——任何浏览器连接（含请求者自己的编辑器，AgentDrawer 必需）都使 generate/apply 返回 paused。内置 Agent 在自己设计的交互流中自我暂停。
- 附加：proposal 仅存内存 Map（`browser-agent-api.ts:113-117`），Host 重启即失效；`revertEffect` 有实现但无任何 route/UI（design-only）。

### 4.3 Core Pass1/Pass2 Agent —— 渲染管线内的 LLM 角色（真正产能来源）

- **接线**：`nova_render`（`registry.ts:1282-1417`）→ `session.enqueueOperation({kind:'render'})` → `renderNovel` → `render-service.ts`；`initialize()`（L141-160）→ `loadCanonicalProject`；stage 2（L1157-1166）→ `compileCanonicalRuntime`；`buildRenderJobs`（L223-387）解析 boundaries/discourseContexts/techniques。
- **Pass 1（散文）**：`RenderPipeline.renderScene`（`pipeline/render.ts:434+`）：PromptAssembler 组装 → `provider.complete`（temp 0.8, taskType 'pass1'，L752-775）；空散文重试、超时不盲目重试、PROVIDER_REQUIRED 硬失败（L776-874）。
- **Pass 2（分析）**：`buildAnalysisPrompt`（L993-1168，temp 0.3, seed 42, json_object，L107-112），至多 4 次子尝试带 Zod-parse 反馈；pass2_verify 双跑可选。
- **验证/重试/发布**：`aggregator.validatePost`（~L1290-1310）；circuit breaker maxRounds 3 / 2 attempts（L585-588）；`analyzeValidationErrors`+`decideRepairStrategy` 注入下轮 Pass 1（L1311-1347）；单 release gate `evaluateReleaseDecision`（`pipeline/release-decision.ts:31-107`，render-service.ts:1244 调用）；CAS 晋升 `promoteAccepted`（L708-787）。
- **生产 provider**：`AiSdkProvider`（`node-host/providers/ai-sdk.ts`），经 `HostProviderFactory`（`workbench/src/host/provider-factory.ts:202`）构造，默认 baseURL `https://opencode.ai/zen/v1`；`MockProvider/MockPass2Provider` 仅测试/bench（`ai/providers/mock*.ts`）。
- **revise 指令管线存在但无 agent 表面**：`buildEventRevisionStates→composeRevisionDirective→Pass 1 editorialRevisionInstructions`（render-service.ts:966-1007）真实实现，但只能由 `nova_render` 的受限字段到达（registry 拒绝 revision/instruction 字段，L1294-1299），`nova_revise` 无 handler（§9.4）。

---

## 5. 符合度矩阵（原始要求 vs 2026-08-05 实现）

判定：**met** = 生产已接线；**partial** = 一半接线/有条件成立；**design_only** = 实现存在但生产不可达；**missing** = 无实现/无表面。证据列给出 repo path:symbol 或命令。

| # | 原始要求（PM 出处） | 判定 | 证据（2026-08-05 源码） |
|---|---|---|---|
| 1 | [不变式] 外部 AI agent 为主要创作/产能来源（PM:29-39,93,345） | **partial** | MCP authoring+render 闭环可达（§6）；但 revise 腿断裂、无自主规划、成书不可达（§9.1,9.4） |
| 2 | [不变式] 一期 UX=CLI+AI chat agent；Workbench 二期（PM:100-101,102,309） | **partial** | Host-first 现实：Workbench Host 是 acceptance 权威；Browser 是次要控制台（§7）；无 chat 前端 |
| 3 | [主循环] status→guidance→修 ISS→validate→render→commit（PM:2328-2343） | **partial** | edit/submit/render 腿真实可达（§6）；但 guidance/next_actions 未暴露、working-layer 验证缺失、revise 与 assemble 腿断裂（§9.4,9.5,9.6）；无 commit 命令 |
| 4 | [Pipeline] Proposal→Validate→Commit 闭环（PM:104-113,56,94,289） | **partial** | 接受链已接线（release gate+CAS revision，§8）；working-layer 验证缺失（§9.6）；rejected_proposals/--retry 无对应物 |
| 5 | [Pipeline] Validator 两级分级+overrides（PM:468,2866-2869） | **partial** | 28 built-in validators 默认注册（current-state.md）；ERROR/WARNING 分级在 post-render gate 生效；`validator_overrides` 项目配置已在 validate/render 路径生效（`validateNovel` 与 `getProjectStatus` 均传入 `config.validatorOverrides`，api.ts:285-287）；仅 waiver consumption 未接线（warning 问题→pending_waiver→blocked，见 §9.8 G2） |
| 6 | [Pipeline] Circuit Breaker 3 轮→人工仲裁（PM:556,2871-2873） | **partial** | maxRounds 3/2 attempts 在 render 管线真实（render.ts:585-588）；仲裁升级语义不适用（无 InteractionManager） |
| 7 | [Pipeline] Plugin 不能直接改状态（PM:343） | **design_only** | 插件运行时从未激活（§9.3）；"不能直接改状态"因此无从谈起 |
| 8 | [Review] Review 一等对象+版本历史（PM:77-88,98,1816-1835） | **partial** | 存储与消费侧接线（CAS ledger + reviewIds→revision prompt，render-service.ts:1052,992-1010,1522-1525）；**producer 零调用**、不进版本历史（§9.2） |
| 9 | [Review] ReviewPatch 走 Proposal→Validate→Commit（PM:82-85,1837-1844） | **design_only** | `ReviewPatch`/`createPatch`/`applyComments` 仅测试（review-feedback.test.ts:399-467）；三个 apply 钩子是空 stub（render-service.ts:1009-1015） |
| 10 | [Review] 时效机制 review summary/history（PM:558,2875-2877） | **missing** | 无 review 命令/工具（CLI 命令表见 §6；registry 工具表无 nova_review_*） |
| 11 | [Status] PROJECT_STATUS.md 人类语言状态（PM:101,2885-2950） | **missing** | 无 PROJECT_STATUS.md 机制；`getProjectStatus` 返回结构状态（`core/src/api.ts:261`） |
| 12 | [Status] MCP StatusReport+guidance+next_actions（PM:2073-2086,2130-2170,2231-2275,2100-2230） | **missing** | workbench host/contracts 无 `guidance` 命中；`nova_status` 仅 `{projection, status}`（registry.ts:1175-1181），status=getProjectStatus（core/src/api.ts:261，无 ISS 字段）；ISS 仅由 `nova_validate` 返回（serializeValidation:502-509，calculateISS 在 core `validateNovel` api.ts:243）；guidance/next_actions 均未暴露，无 ISS 修复循环 |
| 13 | [Status] CLI 结构化导航命令（PM:557） | **partial** | CLI 有 validate/status/entity/graph/source/render/revise/render-tree/project（`cli/src/index.ts:133-489`）；无 review/assemble/commit |
| 14 | [Render] Scene 渲染流程+Output Contract（PM:198-228,1250-1266） | **met** | ContextCompiler→Pass1→Pass2→validatePost→release gate→CAS 晋升全接线（§4.3）；Zod 校验输出 |
| 15 | [Context] 不直接给 LLM 数据库，编译 Context Package（PM:198-228） | **met** | `ContextCompiler`（context/compiler.ts:20-85）→`ContextAssembler`（L1-L5+knowledge boundary+threads+rules，assembler.ts:25-98,323-418），render-service.ts:277 生产调用 |
| 16 | [Context] Relevance+token budget+必选项（PM:840-860,555） | **partial** | relevance 评分在 assembler 真实；无固定 token budget（architecture.md:100 明确"无 8000-token 预算"）；Context Inspector（context_package.json）未实现 |
| 17 | [Branch] 分支一期原生支持（PM:270,863-875,521） | **met** | BranchSet/BranchPath 完整（branch/set.ts,path.ts）；story+discourse graph 双编译（graph-adapter.ts:394）；BranchMergeValidator+ReachabilityValidator 注册（builtins.ts:51-52） |
| 18 | [Assembler] ★ 成书+自动更新（PM:273,97,432-433,319-321） | **design_only** | `canonicalAssemble/customAssemble`（assembler/release-assembly.ts:363-378）、`buildNovelDocument`（publication-model.ts:208）**零生产调用**；`buildPublication` 返回 `outputPath:''`、`novelHash:null`（render-service.ts:601-618）（§9.1） |
| 19 | [Acceptance] 端到端验收场景含成书（PM:317-321） | **partial** | 建项目→LLM 写 Scene→检查→提交 可达；**Assembler 生成可读小说**一步不可达（§9.1） |
| 20 | [Versioning] Git 原生集成（PM:269,485,1683-1700） | **partial** | native immutable revision CAS 是 acceptance model（met，§8）；Git 降级为可选 best-effort mirror（单 refs/heads/workbench，revision-mirror.ts:8-53,111-122），无 auto git commit、无 narrative diff 表面、无 branch/merge/rollback |
| 21 | [Versioning] 快照恢复加速（PM:483,1716-1744） | **design_only** | StateManager/SnapshotEngine 仅测试（state/manager.ts:33-56；snapshot.ts:26-61）；`getCurrentState()/getStateAt()` 仍全量重放；文档明示"不能宣传为已接入的快照恢复加速"（reference/state-management.md:49） |
| 22 | [Authority] 文件唯一权威接口（PM:95,344） | **partial** | filesystem observer 将外部编辑 staged 为候选、fail-closed（filesystem-observer.ts、coordinator.ts processExternalHint ~L350）；但 Host 独占时 standalone 写入被 lease 阻断（node-host/src/authority/project-write-coordinator.ts:312-323）——文件仍是权威，但必须经 Host 接受 |
| 23 | [Authority] 层 8：绝不轻信 LLM，人工确认（PM:1778,536） | **partial** | 能力门+CAS+presence 机制强（§8）；但 MCP device 可自主 submit 无人工门（§4.1）——"人工确认"只是策略不是架构 |
| 24 | [一期验收] CLI+agent 主路径（PM:100-101,317-321） | **partial** | 场景级成立（§6）；novel 级与审阅级不成立（§9.1,9.2） |

---

## 6. 真实可达的 external MCP workflow（2026-08-05 逐工具实测可达路径）

> 以下闭环每一步都有 registry handler（`packages/workbench/src/host/mcp/registry.ts`，工具名+行号），经 `/mcp/projects/:projectId` 单次授权调用。59 目录工具中注册 56 个；下列为 56 个内的真实可达序列。

```text
前置：owner 在浏览器 admin（AccessDevicesPage.tsx:138 createPairing, :150 claimDevice）
      或 nova_admin_device_pair_begin（registry.ts:2510，需既有 admin device）配对 device credential。
      agent 以 NOVALISTICALLY_WORKBENCH_DEVICE_CREDENTIAL 启动（workbench-protocol/src/configuration.ts:182）。

发现   nova_status            registry.ts:1175   → {projection, status(getProjectStatus)}
       nova_validate          1185                → validateNovel(accepted source)
       nova_source_list/get   1193/1201
       nova_source_preview    1227                → 相对 accepted snapshot 的 dry-run（working 变更预演的唯一途径）
       nova_entity_list/get   1250/1264
       nova_authoring_status  1898                → phase/workspaceDigest/acceptedSourceHash/conflicts
       nova_authoring_document_list/read 1887/1915
       nova_revision_list/get/diff 2211/2229/2244

提案   nova_authoring_document_edit 1944 → mcp-adapter.ts editDocument:41-141 → apply:316-427
       三重 CAS：accepted-hash + workspace-digest + state-vector；presenceGeneration 原子复核
       （document-store.ts:708,791；mcp-adapter.ts:391-392）；create/move/delete 2029/2064/2098

提交   nova_authoring_submit 2128 → mcp-adapter.ts:431-466 → coordinator.ts submit:592-641
       物化 working layer → 验证（CANDIDATE_INVALID 618-623）→ native revision CAS → 自动 accept
       （acceptSubmission:520-546 → adoptSourceWithinOperation，project-runtime.ts:505-511）

渲染   nova_render 1282 → enqueueOperation({kind:'render'}) → renderNovel → 返回逐场景 prose
       （core/types/editorial.ts:218-221；渲染管线 §4.3）

冲突/恢复 nova_operation_get 2155；nova_authoring_conflict_read 2171；
       nova_conflict_resolve 2183；nova_revision_restore 2262（native port project-runtime.ts:438-442）
```

**该闭环的三个洞**：
1. **revise 腿断裂**：`nova_revise`/`nova_render_tree`/`nova_graph` 无 handler（§9.4）——渲染后无法经 Host 请求修订；唯一替代 `nova revise`（CLI standalone）在 Host 运行时被 lease 阻断（project-write-coordinator.ts:312-323）。
2. **无 proposal 级验证**：无法在 commit 前验证 working-layer 变更（§9.6）。
3. **CLI via-workbench 无 commit 路径**：`nova source apply`（index.ts:300-350）只做 working-layer 编辑，`WorkbenchClient` 止于 `authoringDocumentEdit`（workbench-client.ts:300），无 submit 方法、无 authoring 命令组——CLI 用户改完无法提交；standalone `nova source apply` 只在 Host 停止时可用（且绕过 native revision 体系）。

---

## 7. Workbench Host vs Browser 定位（2026-08-05）

**原设计要求**（PM:102,309,337,466-471）：Workbench/Web UI 是二期 NOT NOW；Workbench 只负责编辑、审阅、人工介入和管理，不得成为 authoring 必要依赖。

### 7.1 Workbench Host = acceptance/运行基础设施（成立）

- **单一权威**：`ProjectSession` 是唯一 source 门（`#evaluateCandidate` ≈L433；`isCompilableSource` ≈L318 要求全部文档可解析、零 error 诊断、accepted snapshot deepFreeze 永不变更）；`refreshSource` 与 coordinator 的 `adopt` 在队列外 fail-closed（`adoption.outside_queue` ≈L414）。
- **串行能力门队列**：`enqueueOperation`（≈L499）严格串行；render、MCP mutation、coordinator submit/reconcile、内置 agent apply 全部走它；`busy`/`hasHumanPresence`/`presenceGeneration` 表面状态；document mutation 在 `applyScopedUpdate` 内原子重检 presenceGeneration（document-store.ts）。
- **native immutable revision CAS**：`AuthoringRevisionPort.submit` exact-once（`project-runtime.ts:172-266`：createSourceRevision → casSourceHead → checkpointSourceRevisionOperation，operationId 重放去重），write-once bundle store（native-revision-content-store.ts），forward-only restore（:267-330）；可选 Git 仅 best-effort 镜像已接受 revision（revision-mirror.ts，`project-runtime.ts:450-456` 唯一接线，失败绝不回滚 acceptance）。
- **能力门**：不透明 `fc_` token + 持久 hash-only 校验行；每次 `checkGrant`/`validate` 重载持久 grant（版本/吊销/过期/项目/scope，capability-service.ts:363-384）；session `#execute`（≈L521）在串行槽内重验并审计每次 effect/denial。
- 结论：外部写入（MCP/文件系统/内置 agent）全部汇入 Host 的串行能力门队列，浏览器对任何 authoring 操作都不是必需的（MCP 单独覆盖 create/edit/move/delete/submit/reconcile/restore/admin）。

### 7.2 Workbench Browser = 次要人工控制台（基本成立，两处诚实缺口）

- 客户端只消费 secret-free DTO；渲染 surface = project-home/graph-route/source-studio/scene-canvas（App.tsx:301-337）。
- **缺口 A——文档生命周期 agent-owned**：浏览器无 document create/move/delete 路由（browser-authoring-api.ts 无对应 handler；MCP 有 2029/2064/2098）——纯浏览器用户无法新建/删除文档。
- **缺口 B——Review Hub / Publication 是死导航**：App.tsx:36-39 两个 nav item **从不渲染**；客户端仅 3 个 UI 组件（SetupWizard/AgentDrawer/RuntimeStates）。"审阅"目前 = revision diff + 验证诊断 + operation 回执 + Source Studio 内的 proposal 审阅，而非一等 Review 对象。
- **人工作用**：仅在 AgentDrawer 路径强制人工 apply；MCP device 可自主 edit→submit（§4.1）。
- **产能中心化风险**：render 与 authoring 共用同一串行队列——长 LLM render job 会阻塞 authoring mutation（`busy`），在"AI 为主要产能"设定下是主要吞吐瓶颈（仅文档承认，无结构性缓解）。

### 7.3 结论

"Workbench 只负责编辑、审阅、人工介入"的架构级陈述基本成立（Host 权威合法、浏览器非必需前端）；但产品级有三处未兑现：①审阅不是一等表面；②浏览器不自足（文档生命周期在 MCP）；③人工 apply 只在 AgentDrawer 路径强制，MCP 路径是纯角色策略。

---

## 8. 内部实现优点（本审计认可的已接线部分）

1. **确定性核心真实接线**：`loadCanonicalProject` → `compileCanonicalRuntime` → `compileNarrativeRuntime` → `compileNarrativeGraphs`（story+discourse 双图，graph-adapter.ts:394）→ boundaries/discourse contexts → render-service——不是类型壳，是运行时路径。
2. **严格 schema + 可操作错误**：`eventFileSchema` 等 `.strict()`（schemas/event.ts），mapper 对目录违规抛带 path+phase 的 ConfigError（mapper.ts:20）——给外部 agent 精确、可修复的反馈。
3. **CAS 并发安全贯穿**：accepted-scene head CAS（render-service.ts:733-767）、native revision exact-once（project-runtime.ts:172-266）、workspaceDigest/state-vector/presenceGeneration 三重原子复核（mcp-adapter.ts:316-427）——冲突永不静默覆盖。
4. **能力门重验**：每次 apply 在串行槽内重载持久 grant（capability-service checkGrant），fresh `mcp:author` 每次签发（workbench-launch.ts:796-801）。
5. **审计**：session 内所有 effect/denial 经 durable audit sink 落盘（durable-audit.ts createSink :227-247；workbench-launch.ts:671,743）。
6. **分支叙事完整**：BranchSet/BranchPath/`evaluateCondition`（equals/not_equals/gt/lt/contains/and/or）+ BranchMergeValidator + ReachabilityValidator 注册。
7. **确定性/mock 边界纪律**：core e2e 只用 MockProvider 且页首声明（packages/core/tests/e2e.test.ts:10-12）；agent 测试用真实服务+真实 SQLite，只替 provider/document port（agent-suggestion-service.test.ts）；current-state.md 明确"mock 参考不能被描述为人工或 live-LLM 证据"。
8. **pass2 修复反馈循环**：最多 4 次子尝试带 Zod-parse 反馈、repair strategy 注入下轮 Pass 1、provider 缺位 fail-closed（requiresProviderByEventId，render-service.ts:162-173）。

---

## 9. 生产接线缺口（硬事实，按严重度排序）

### 9.1 [P0] assembly 无生产 caller —— 最终成书不可达

- `canonicalAssemble`/`customAssemble`（`packages/core/src/assembler/release-assembly.ts:363-378`）、`buildNovelDocument`（`publication-model.ts:208`）、legacy `assembleNovel`（`assembler/novel.ts:9`）、`buildAndWriteOutputs`（`pipeline/output.ts:270`）的**全部调用点只在测试**（`packages/core/tests/editorial/release-assembly.test.ts:122-228`）；生产 `buildPublication()` 只返回状态摘要——`outputPath: ''`、`novelHash: null`（`render-service.ts:601-618`）。
- 无 assemble/publish MCP 工具、无 CLI 命令（CLI 命令表：validate/status/entity/graph/source/render/revise/render-tree/project，`cli/src/index.ts:133-489`）；Workbench "Publication" nav 不渲染（§7.2）。
- **文档漂移（审计开始时发现，现由本次同步修订）**：`docs/architecture.md:159` 声称 `assembleCanonicalNovel()/assembleCustomNovel()` 在 `editorial/facade.ts`——`facade.ts` 无任何 assemble 符号，`editorial/index.ts` 也未导出；`docs/reference/wiring.md:489` 将 release-assembly 列为生产接线。→ 原始 ★"改完文件，书自动已存在"在生产上不成立（截至审计撰写时点）。

### 9.2 [P0] review 无 producer —— 审阅闭环 inert

- `addReviewComment`/`replaceReviewComment`/`updateReviewComment`（`review-facade.ts:75-146`）从 core barrel 导出（editorial/index.ts:54-59），但 **workbench/cli/node-host 零调用**（grep 0 命中）；无 `nova_review_*` MCP 工具（registry 工具表全列无 review）；CLI 无 review 命令。
- 消费侧已真实接线：`renderNovel` 经 `new ReviewManager(execution, projectId).getComments()` 装载（render-service.ts:1052,1522-1525），`preflightRevision` 校验 reviewIds（compiler.ts:225-254），`composeRevisionDirective` 把 `[reviewId]` 注入 LLM revision prompt（render-service.ts:992-1010），feedbackHashes 进 cache identity（:476-493）——**但没有任何人类或 agent 表面能创建一条评论**，整环 inert。
- `applyComments`/`createPatch` 仅测试；`persistInlineInstructionReview`/`applySceneLineReviews`/`applyChapterNovelReviews` 是**空 no-op stub**（render-service.ts:1009-1015）。
- 偏离原要求："评论进入版本历史"未兑现——ledger 是单个可变 CAS JSON 文档（manager.ts:307-317），非 append-only 历史，且 review 被排除在 git mirror bundle 外。

### 9.3 [P0] plugin 无 Host activation —— 整个 plugin 要求 design-only

- 机制完整：`PluginManifest`（types/plugin.ts）、`PluginLoader`（plugin/loader.ts）、冲突检测（plugin/conflicts.ts）、四种 `ArbitrationStrategy`、`PluginHooksManager`（plugin/hooks-manager.ts，完整生命周期 + decoration 校验）；Core render 管线**确实**在传入 manager 时调用 hooks（render.ts:529-536,673-677,954-968,1355-1359；plugin identity 进 cache key :465-467）。
- **阻断**：`buildPipeline`（render-service.ts:1442-1465）的 `RenderPipelineOptions` 不含 `pluginHooksManager`；`NodePluginCatalog`（node-host/src/plugins/node-plugin-catalog.ts:189）只被 `node-host/index.ts:27` export，实例化仅出现在测试（node-host/tests/node-plugin-catalog.test.ts:41）。`new PluginHooksManager`/`new PluginLoader` 只出现在 core tests。生产运行中 `plugins/` 目录**永不发现、永不激活**。
- 原 MVP 要求的"Schema 扩展"不存在：`eventFileSchema` 静态 `.strict()`，插件只能加 validator/provider/decoration。

### 9.4 [P0] nova_graph / nova_revise / nova_render_tree 无 handler

- 目录声明：`workbench-protocol/src/mcp.ts:904-926`（含 scopes 标注 :912-915）；client 方法：`workbench-client.ts:236/240/244`；CLI 命令：`cli/src/index.ts:216(graph)/443(revise)/461(render-tree)`。
- `packages/workbench/src` 下三个名字 **0 命中**（grep 全量）→ 每次调用返回 TOOL_NOT_FOUND。59 目录工具注册 56。
- 无 catalog↔registry parity 测试（`assertMcpToolCatalogParity` mcp.ts:1019 只查目录内部一致性；mcp-auth-registry.test.ts 不断言 catalog⊆registry）——缺口因此未被任何测试拦截。
- 附带：`nova_render` 本身拒绝 revision/instruction 字段（registry.ts:1294-1299），revise 语义经任何途径都不可达（CLI standalone `nova revise` 在 Host 运行时被 lease 阻断）。

### 9.5 [P0] status guidance 未暴露 —— agent 主循环缺失指令层

- workbench host 与 contracts、workbench-protocol 下 `guidance` **0 命中**；`nova_status` 仅返回 `{projection, status}`（registry.ts:1175-1181），`status` = `getProjectStatus(source)`（core/src/api.ts:261，无 ISS 字段，含 rendered 推导）；ISS 仅由 `nova_validate` 返回（serializeValidation registry.ts:502-509，calculateISS 位于 core `validateNovel` api.ts:243）——status 表面不暴露 ISS。
- 原始设计的 `guidance` 注入、`next_actions` 排序（critical→high→medium→low + fix_action/fix_target/template）、`render.ready|blocked|waiting|completed` 快照与 `missing_preconditions` blocker **均未实现**；agent 无从获得"先修什么、按什么顺序"的机器可读指令（只能从 validate 诊断自行推断）。
- 附加误导：`getProjectStatus.rendered` 由 accepted snapshot 中 `scenes/<chapter>/<id>.md` 文件推导（api.ts:229-260 附近正则），但渲染管线从不写 scene 文件（只写 execution repository）——完整 render 后 renderedCount 仍为 0，除非人工 adoption（scene-adoption.ts:90-92）。

### 9.6 [P0] working validate 缺失

- `nova_validate`（registry.ts:1185-1191）跑 `validateNovel(session.source)` = **accepted source**，不是 Yjs working layer。
- working 变更只能 (a) 用 `nova_source_preview` 对 accepted snapshot 做 dry-run 重构，或 (b) 在 `nova_authoring_submit` 时隐式验证（materialize→validate→CANDIDATE_INVALID，coordinator.ts:618-623，且发生在 working docs 冻结**之后**）。不存在"提交前验证未提交提案"的工具。

### 9.7 [P0] built-in agent project-wide presence pause

- 接线：`presence: { isHumanEditing: () => session.hasHumanPresence }`（workbench-launch.ts:785,794）；`HUMAN_PRESENCE_SURFACES = ['browser','mcp','yjs']`（project-session.ts:337）；Yjs gateway 为每个连接的浏览器编辑器加入 'yjs' presence（gateway.ts:672-689）。
- 而 AgentDrawer 要求一个**已连接文档**的选中（App.tsx:626-633）→ 请求者自己的连接使 `hasHumanPresence === true` → generate()/applyEffect() 返回 `paused`。内置 Agent 在它唯一被设计的交互流中**自我暂停**。MCP 通道不受此 pause（但 vector 漂移整体拒绝）。
- `edit-service.ts:352-353` 承认可注入文档/场景粒度的 presence tracker，但**无人接线**——该 seam design-only。

### 9.8 其他已核验缺口

- **G2 warning 死锁**：`evaluateReleaseDecision` 调用时**不传 InteractionManager**（render-service.ts:1244）→ warning-only issue → `pending_waiver` → candidate blocked，无 waiver 机制（release-decision.ts:100-101）；`request.waivers` 只进 planHash（compiler.ts:475）。`InteractionManager`（pipeline/interaction-gate.ts）无生产调用者。
- **快照恢复 design-only**：StateManager/SnapshotEngine/StateLog/StateSnapshotRepository 生产零调用（§5 #21）。
- **无 narrative diff 表面**：core `diffEvent`（api.ts:311-340）未暴露；native revision diff 仅 hash 级路径变化（types.ts:239）。
- **render/authoring 共用串行队列**：长 render 阻塞 authoring（§7.2）。
- **proposal 不持久**：内置 agent proposal 在内存 Map（§4.2）。
- **CLI via-workbench 死胡同**：无 submit（§6 洞 3）。
- **测试纪律缺口**：agent 的 provider 输出是严格 JSON edit 数组（parseSuggestionChanges 拒绝任何偏差），**零真实模型一致性证据**；authoring-coordinator-recovery.test.ts 仅 2 个 fail-closed 用例，coordinator ≥10 条恢复分支未测。

---

## 10. P0/P1 建议

### P0（直接决定"外部 agent 主路径"与"最终产出是书"是否成立）

1. **接通 assembly**：新增 `nova_assemble` MCP tool + CLI `nova assemble`（调 `canonicalAssemble` + execution repository 的 manifest 与 accepted heads）；或至少在 `buildPublication` 返回真实产物路径与 novelHash。（`docs/architecture.md:159` 与 `docs/reference/wiring.md:489` 的漂移已在本次文档同步中修订。）
2. **实现 review producer**：`nova_review_comment_add/update/resolve`（或 CLI `nova review`）+ 实现三个空 stub（`persistInlineInstructionReview` 等）+ Review Hub 视图；消费侧已接线，补上 producer 即可闭环。
3. **注册三个孤儿 handler**：`nova_graph`（读 session.source 走 `inspectProjectGraph`，对齐 CLI index.ts:216-231）；`nova_revise`（复用 `nova_render` 的 enqueue 模式 + 有界 `revision` instruction 字段，registry.ts:1282 的 rejectUnknownKeys allowlist 放行）；`nova_render_tree`（对齐 CLI render-tree）。无需协议改动。
4. **working-layer 验证表面**：`nova_authoring_document_validate`（物化→buildSnapshot→validate，不 commit；复用 coordinator.ts:614-623 逻辑）或扩展 `nova_source_preview` 接受 working basis。
5. **plugin Host activation**：`workbench-launch` 经 `NodePluginCatalog` 加载 `plugins/` → 构建 `PluginHooksManager` → 传入 `buildPipeline` options（加 CLI flag/配置）；或显式声明 plugin 为 design-only 并停止在文档中暗示可用。
6. **内置 agent 在场粒度**：接入已存在的 document/scene-scoped presence tracker 注入点，使请求者自身空闲连接不再 self-pause。

### P1（门禁与表面完整性）

7. **修 `test:e2e` 门禁**：给 `@novalistically/workbench` 补 `test:e2e` script + playwright.config.ts + smoke suite（@playwright/test 已是 devDep），或删除 dangling 根 script；`docs/architecture.md` 中旧 E2E 声称已在本次同步移除。
8. **修 `check-public-api.mjs` 红态**：登记 `@novalistically/workbench-protocol` 到 `public-api.manifest.json`（当前 `.packages` 只有 bench/cli/core/node-host/workbench），并修复 manifest/export 漂移；补充 catalog↔registry parity 测试（防 3 孤儿复发）。
9. **CLI via-workbench 补 submit**：`WorkbenchClient.authoringSubmit()` + `nova authoring` 命令组（submit/status/conflict-read/resolve），消除"改完无法提交"死胡同。
10. **live-model conformance run**：`npm run smoke:stage1:live`（凭据驱动，产物需人工审阅）验证 AgentSuggestionService JSON edit 数组与 Pass1/Pass2 输出在真实模型下的形态；在此之前不得声称内置 agent 生产可用。
11. **文档同步（本次文档同步已完成）**：current-state（六包、check-public-api 与 test:e2e 红门禁）、architecture（移除旧 E2E 声称）、INDEX、AGENTS、cli（`createHostBoundMcpTools` 标为未接线 seam）、workbench-host、pipeline、wiring（assembly 标为未接线）、api 已全部同步。

---

## 11. 2026-08-05 门禁证据与证据边界

### 11.1 门禁实测（主协调者统一执行，本审计未重跑）

| 门禁 | 结果 | 备注 |
|---|---|---|
| `npm test` | **通过** | 根 Vitest **2,970**；Workbench Host **522**；Workbench Client **93**（root package.json `test` → vitest run + `test:workbench`；`packages/workbench/vitest.host.config.ts` / `vitest.client.config.ts`）。更新前记录的 2026-08-04 基线为 2,902/521/93。 |
| `npm run typecheck` | 通过 | 含 workbench-protocol 的 `tsc -b` 各包步骤 |
| `npm run typecheck:dead-code` | 通过 | 仅覆盖 core/bench/cli 三包（workbench/node-host/workbench-protocol 不在列）：`tsc -b packages/core/tsconfig.dead-code.json packages/bench/tsconfig.dead-code.json packages/cli/tsconfig.dead-code.json`（noUnusedLocals/noUnusedParameters） |
| `npm run build` | 通过 | clean-build-output + 各包 build.mjs + workbench build:host/build:client |
| `npm run bundle-check` | 通过 | `scripts/bundle-check.mjs` |
| `npm run lint -- --max-diagnostics=2000` | 通过 | Biome |
| `node scripts/check-public-api.mjs` | **失败（红）** | manifest/export 漂移，且 `@novalistically/workbench-protocol` **未登记**：`public-api.manifest.json` `.packages` 仅 bench/cli/core/node-host/workbench（`jq '.packages\|keys'` 核验，`has("@novalistically/workbench-protocol") === false`）。注意该脚本挂在根 script `dead-code:knip` 名下（package.json:41），knip CLI 本身无任何 script 执行它。 |
| `npm run test:e2e` | **失败（红）** | 根 package.json:25 `test:e2e` → `npm run -w @novalistically/workbench test:e2e`，但 `packages/workbench/package.json` scripts **无 `test:e2e`**（只有 dev/build:*/start:*/test:host/test:client/typecheck:*）。`@playwright/test`/`@axe-core/playwright` 为 devDep 但无 playwright.config.ts、无 tests/e2e/ 目录；`tsconfig.e2e.json` include 的 `tests/e2e/**` 与 `playwright.config.ts` 不存在，`typecheck:e2e` 实际只编译 vite.config.ts（静默 no-op）。 |

### 11.2 证据边界（本报告的可信区间）

- **时点性**：全部结论是 2026-08-05 工作树快照。行号/工具注册/接线为撰写时状态，后续演进后须以 `docs/current-state.md` 为准。
- **门禁数字来自主协调者统一执行**（本审计任务按契约跳过测试/lint/format/build）；源码结构、grep 计数、manifest 内容、package.json scripts 为本审计直接核验。
- **mock ≠ live LLM 证据**：core e2e 只用 MockProvider（e2e.test.ts:10-12 页首声明，网络禁止 setup 在 vitest.config.ts）；workbench agent 测试用 FakeTaskProvider 脚本化字符串 + FakeDocumentPort，真实服务/SQLite；全部 5 个目标测试套件**零 live provider 输出断言**。`npm run smoke:stage1:live` 生成的候选需人工审阅后才可作 live 证据（current-state.md 同规则）。
- **不算数/不改写**：`docs/archive/PROJECT.md` 是历史要求文档，本审计只引用不改写；测试计数与门禁断言不得外推为行为正确性。
- **未覆盖**：live 真实模型质量、真实 Yjs adapter 与 suggestion 管线端到端整合、coordinator 全恢复分支、bundle 之外的包表面（如 README 对外承诺）——不在本审计范围。
