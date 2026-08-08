# 当前系统状态（源码核验）

**时间**：2026-08-08 CST
**当前实现检查点**：`main` 当前工作树（Workbench 产品收敛 Stage 1–9 已交付 + 2026-08-08 Author Mode 改造已交付：`kind` 仅剩 `'pi'`、托管根 `$WORKBENCH_HOME/projects/<id>`、3 步 Setup 向导（owner 可免密）、项目导入（拷贝）、Settings LLM 面板（pi-ai 预设 + 高级参数）、场景卡表单编辑（Yjs 写回）、UI 中文化；门禁状态诚实记录见下表——Node 26 下五包 typecheck 通过、bench 包受 b90d472 orphan 影响，Node 24 下 argon2 相关测试不可运行）
**权威顺序**：当前源码、package manifests、可复现门禁结果；本页优先于历史计划、阶段报告和归档设计。

> 本页描述已经由源码或门禁证明的现状，不把设计目标、未接线类型或历史测量当作已交付能力。历史文档应保留其当时的证据与日期，并链接到本页，而不应改写历史。

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（Node 26 / fnm 26.5.0，收敛会话记录） | core / node-host / cli / workbench-protocol / workbench 五包 `tsc -b` 通过；**bench 包不 clean（源码核验）**：b90d472 遗留的 closed-loop orphan 仍在——`packages/bench/src/closed-loop-runner.ts` 导入从未提交的 `./closed-loop.js`（按 NodeNext 解析即 TS2307），且该文件未从 `index.ts` 导出（孤儿文件，无调用方）；`dist/closed-loop.d.ts` 是陈旧构建产物 |
| Node 26 环境（2026-08-08 全量验证，fnm v26.7.0） | **全仓库测试全绿**：workbench host 744/744、client 175/175、core+node-host+protocol+cli 2924/2924（合计 3,843）。argon2 测试（`auth-password` / `auth-service` / `setup-api` / `launch` / `parity`）在 Node 26 全部通过。端到端（本轮新增核验）：`WORKBENCH_CONTROL_FD3=disabled` 直跑 `dist/host/host/main.js`，setup owner（空密码）→ project → provider → credential → finish 全流程 200 且 `projects/demo/nova.yaml` 骨架 + `config/workbench.yaml` 落盘；`POST /api/v1/projects/import`（拷贝、排除 `.git/.nova/output`、重复 409）；admin provider upsert 携带 `reasoning/contextWindow/maxTokens/headers` 四字段 round-trip；浏览器 3 步向导（Owner/Project/Provider）+ 工作区路径预览 `/tmp/.../projects/demo`。**bench 包 typecheck 仍不 clean**（b90d472 closed-loop 孤儿，见上行） |
| 2026-08-06 基线（收敛前，供参考） | `npm test` 根 3,197 + Host 716 + Client 156、`typecheck:dead-code`、`typecheck:e2e`、`build`、`bundle-check`、`check:public-api`（六包全部登记）、`test:e2e` 23/23、`lint` 0 errors / 0 warnings——均为收敛前记录，收敛后未全量重跑 |

## 2026-08-08 产品收敛记录（Stage 1–9 全部交付）

对应 `docs/todos/workbench-product-convergence-2026-08-07.md`：Stage 1–9 已全部交付（9 个 commit：`2ea7463` `999298b` `35932ff` `89a400b` `b8fe2e4` `9849d87` `695e9da` `71f04d3` `fe5c802` `792822d`）。已核验现状：

- **config `version:1` 单一契约 + renderPolicy**：`WorkbenchConfigurationV1`（`@novalistically/workbench-protocol`）是唯一规范配置源形状，owner 直接序列化、无迁移/归一化层；`renderPolicy`（`WorkbenchRenderPolicyV1`：pass1/pass2 温度、maxTokens、pass2 seed）统一应用于 Host 的每次 render。
- **依赖换核（替换 AI SDK）**：`@earendil-works/pi-ai`（node-host + workbench，`^0.84.1`）与 `@earendil-works/pi-agent-core`（workbench，`^0.84.1`）；生产 provider 为 `PiOpenAICompatibleProvider`（`createPiProviderStack`，`packages/node-host/src/providers/`）；内置 Agent 循环为 pi-agent-core `Agent`（`packages/workbench/src/host/agent/run-service.ts`），模型缝为 `createPiAgentModel`（`agent/pi-agent-model.ts`）。`createWorkbenchAgentModelAdapter` 与 `WorkbenchAgentModel` 已删除。
- **CLI 改名 `fabula`**：root `package.json` `name: "fabula"`、cli bin `fabula`；`nova.yaml` 项目文件、`nova_*` MCP 工具名与 `NOVALISTICALLY_*` env 契约不变。
- **`npm start` 产品入口**：build:host + `packages/workbench/scripts/start.mjs workbench`（loopback `http://127.0.0.1:8787`、自动开浏览器、首次引导；`WORKBENCH_OPEN_BROWSER=false` 关闭）。
- **agent 消息持久化 schema v8**：`packages/workbench/src/persistence/schema.ts` 迁移至 version 8（`agent_conversations` / `agent_conversation_messages` / `agent_runs` / `agent_tool_calls`；`newestBundled` = 8）。
- **内置 agent 换核后 production 默认仍 `agentReady=false`（隐藏）**：capability 门 = V3 `agent.enabled` && `supportsToolCalls`（`workbench-launch.ts` production 从不硬编码 true）；parity matrix（`agent-parity-matrix.test.ts`）与 e2e 是确定性证据；live conformance 是单独运行（`npm run smoke:workbench-agent:live`），不作为 CI 证据。
- **运行时边界（Stage 7 决策，2026-08-08）**：workbench 是 MCP server——外部 agent（任意 MCP client，包括 codex CLI / Claude Code）连入 `/mcp/projects/:projectId` 即获得与内置 agent 相同的工具面（按角色 scope 过滤）；内置 agent（pi-agent-core）是**唯一**的进程内 agent，不发现、不派生、不托管任何外部本地运行时；未预留未来运行时托管接口，真实需求按新需求单独评审。
- **FilePublicationWriter 已恢复并在位**：`packages/node-host/src/output/file-publication-writer.ts`（写 `output/novel.md`，`PUBLICATION_OUTPUT_DIRECTORY`）继续从 `@novalistically/node-host` 导出（`index.ts`），`refreshCanonical()` 在 accepted commit / gate 决议 / review-driven revise 后 best-effort 刷新。
- **References 全管理视图（Stage 9.1）**：`ReferencesView`（导入/删除/重试/搜索/详情/空态），browser 路由复用 `McpReferencePort`（import 三段式、delete、retry、get-by-id、bounded content read）；`referenceLimits.enabled` 门控；6 个路由测试。
- **Scene Map + Scene Inspector（Stage 9.2，用户核心诉求）**：`/scene-map`（章节分组 + per-scene summary + hash 链 + 跨章条带）、`/scenes/:eventId`（diff + 实体 + graph 边 + 边界 hashes + discourse）、`/scenes/:eventId/render`（复用 `nova_render` registry 路径）；9.2.5 **上下文指纹**——已采纳 scene 的 `scenes/<id>.md` frontmatter `context.sceneHash` 对比 execution sceneHash → `adopted_current`/`adopted_stale`（上下文变化必标 stale、绝不静默覆盖手改散文）；`SceneMap.tsx` + `SceneInspector.tsx`（内联 diff/实体/hash/render 按钮 + Adopt）；8 个路由测试。
- **错误恢复/空态分离/断连（Stage 9.3）**：review/publication/references/scene-adoption 均区分 error-state（带 Retry）与 empty-state；AgentChat run 失败内联 chip + 重试；Host 事件流断开 → 红点 + 「与 Host 的连接中断，正在重连…」banner；加载期 skeleton。
- **Onboarding 首访引导（Stage 9.4）**：localStorage 门控 4 步 mini tour（Agent Chat 入口 / Source Studio / Review Hub / Publication）；欢迎卡 icon+描述升级；Agent 未启用 banner（配置提示 + settings 钩子）。
- **Stage 9 交付门禁（9.6）**：`npm run build` 全绿（core/node-host/bench/workbench-protocol/cli/workbench host+client）；5 包 `tsc -b` 干净；Node 26 下全仓库 3,826 测试全绿（host 736 / client 168 / core+node-host+protocol+cli 2922）；`npm start` 冒烟启动 + 端点探测通过。**bench 包 typecheck 例外**（b90d472 closed-loop 孤儿，见门禁表）。

## 2026-08-08 Author Mode 改造记录（托管根 + 极简向导 + LLM 面板 + 场景卡）

面向非程序员作者的 Workbench 开箱即用改造，已交付并核验：

- **`kind: 'ai-sdk'` 彻底移除（wire 清理）**：协议层 `WorkbenchProviderConfigurationV1.kind` 仅剩 `'pi'`；host/setup/admin/MCP 校验、registry、launch `WORKBENCH_PROVIDER`、CLI 分支、前端字面量全部收窄。凭据 key 前缀 `ai-sdk:<profileId>` 与 wire id `providerId: 'ai-sdk'` **保留不动**（内部契约）。`grep "kind: 'ai-sdk'"` 于三包源码零匹配。
- **托管根（root 字段删除）**：`WorkbenchProjectConfigurationV1` 不再有 `root`；所有项目根派生为 `$WORKBENCH_HOME/projects/<projectId>`（`managedProjectRoot`，launch 装配时挂到项目对象，14 个消费者不变）。`WORKBENCH_PROJECT_ROOT/PROJECT_ID/DISPLAY_NAME` env 预填删除；`validateConfigurationTopology` 死代码清空（托管根天然唯一）；未配置 Host 的 loopback-only 守卫移到 `startWorkbench`。launch 启动时 mkdir 托管项目根。setup status 新增 `hostHome` 字段（向导派生路径预览）。
- **3 步 Setup 向导（owner/project/provider）**：network/review/source-validation 步骤删除，provider 步骤直接 finish（默认 loopback 网络策略由 finish 应用）；owner 密码可选（空 = 免密，`bootstrapOwner` 落不可验证的 `DUMMY_PASSWORD_HASH`，LAN 登录仍需真密码）；project 步骤无路径输入，显示只读工作区路径预览。
- **托管项目骨架 + 导入**：`saveProjectHandler` 落盘 `projects/<id>/nova.yaml`（project/title/defaultModel: mock）+ 空 `definitions/`；新 `POST /api/v1/projects/import`（JSON `{sourcePath}`，owner 门控）：404 源缺失 / 400 nova.yaml 不可解析 / 409 目标已存在，拷贝排除 `.git/.nova/output`，经 `configuration.apply` 注册；前端 ProjectsPage 文件选择器入口。5 个路由测试。
- **Settings LLM 面板（`SettingsView.tsx` + `provider-presets.ts`）**：预设网格来自 pi-ai `getBuiltinProviders()`/`getBuiltinModels()`（**动态 `import('@earendil-works/pi-ai/providers/all')` 独立 chunk**，过滤 `api === 'openai-completions'` 且有 baseUrl 的供应商，点击只预填表单）+ 自定义 baseUrl/model/key + 测试凭据 + 可折叠高级区（reasoning/contextWindow/maxTokens/headers）。协议 `WorkbenchProviderConfigurationV1` 扩展这四个可选字段，file-store 校验/round-trip，provider-factory 透传。
- **无默认运行时（用户决策）**：`PI_DEFAULT_BASE_URL/PI_DEFAULT_MODEL` 常量全部删除（`grep` 零匹配）；baseUrl/model 缺失时 `createPiProviderStack` 抛错，provider-factory 显式 `HostProviderError('PROVIDER_NOT_CONFIGURED')`；CLI `'pi'` 分支显式读 `NOVALISTICALLY_AI_BASE_URL/MODEL` env。
- **场景卡编辑器**：`SceneDetailViewV1` 新增 `eventYaml`/`eventDocumentId`（detail 路由从 working 层 materialize）；SceneMap 行内「编辑」表单（标题/正文 sceneBrief+beats/情绪/时间/场景类型），保存 = 解析现有 YAML → 只合并这 6 个字段 → 重序列化 → 经 Yjs `getText('prose')` 写回（`replaceWorkingDocumentText`，触发现有提交门）。Source Studio 保留。
- **UI 中文化**：AgentChat 欢迎卡/工具 receipts（nova_render→渲染 等映射表）、ReviewHub（发布检查项、按钮/空态）、PublicationView、RuntimeStates（登录/项目选择）、SceneMap/Inspector（已收下/已过期、收下这版、技术详情折叠区）中文化；wire 契约（API 路径/错误码/`nova_*` 工具名）未动。
- **门禁**：host 744/744、client 175/175、core+node-host+protocol+cli 2924/2924（合计 3,843）全绿；五包 typecheck 干净；`npm run build`（types + esbuild 包）成功且 pi-ai 目录独立成 chunk；lint 仅剩 bench 孤儿与未触碰文件的既有漂移。


## 包与依赖边界

工作区有六个包：

| 包 | 已核验职责 |
|---|---|
| `@novalistically/core` | 纯叙事语义：不可变 source-snapshot 分析、实体/图/状态计算、上下文、render 编排、验证、组装意图；也定义 bounded non-authoritative reference packets。仅依赖 `yaml` 和 `zod`。 |
| `@novalistically/node-host` | Node 适配器：filesystem source loader/writer、execution/state/cache/report repositories、pi-ai provider（`@earendil-works/pi-ai`，`PiOpenAICompatibleProvider`）、plugin runtime 和可移植 reference object store。 |
| `@novalistically/bench` | 通过 Core 与 Node Host 运行回归、变体和性能基准；不是 Core 依赖。 |
| `@novalistically/cli` | `fabula` CLI（`commander`）与 typed Workbench MCP client；standalone 写入受 Host authority lease 保护，via-workbench 操作只走项目 scoped 的 authenticated Host route。 |
| `@novalistically/workbench` | 私有 native Host + browser client。Host 持有本地认证、Yjs、SQLite worker、ProjectSession、native immutable revisions 和 project-scoped reference library；浏览器只消费 secret-free DTO。可选 Git 仅镜像已接受 revision，不参与 authoring acceptance。唯一的进程内 agent 跑在 `@earendil-works/pi-agent-core` 上（模型缝 `createPiAgentModel`）。 |
| `@novalistically/workbench-protocol` | 共享协议契约包：MCP 工具目录（`nova_*` 名与 scopes，当前 72 个）、typed client contracts、configuration、authoring/host/reference DTO 与 device credential 常量。被 Workbench Host 与 CLI client 消费；仅 build/build:js/build:types 三个 script，无测试。已登记进 `public-api.manifest.json`（六个包全部登记）。 |

包关系不是一个可推导的线性链。Core 不依赖工作区包；Node Host 提供适配器；Bench、CLI 和 Workbench 按各自 manifest 直接选择 Core/Node Host 能力；`@novalistically/workbench-protocol` 是共享协议契约，被 Workbench Host 与 CLI client 消费，不依赖其他工作区包。

## Source、状态与渲染边界

- Core 输入是 `ProjectSourceSnapshotV1` 和注入的语义端口；source hash 表示内容，不是 Git 历史。
- Node Host 与 Workbench Host 才拥有文件与持久化；Workbench Host 的 native immutable revisions 是 authoring acceptance model，可选 Git 仅镜像已接受 revision。Workbench 只接受显式 `AuthoringManifest`，不得把 `.nova/**`、缓存、responses、journals、Yjs、SQLite、output 或 derived 工件纳入 authoring bundle。
- canonical render runtime 先编译 story/discourse 边界，再生成场景契约。`StateManager` 的内存快照是 recovery primitive；当前 `getCurrentState()` / `getStateAt()` 仍通过 `ReplayEngine` 重放，不能宣传为已接入的快照恢复加速。Workbench 的 `CanonicalStateProjectionService` 是另一条派生快照流（按 source/route 缓存已验证快照，只作为读取加速，永不是第二权威），两者不互相替代。
- canonical release assembly 以 discourse scene sequence 为主；仍存在按 `narrativeOrder` 排序的 runtime/legacy 路径。因此“`narrativeOrder` 从不使用”是不准确的；它不能作为因果 replay 顺序才是已核验不变量。
- Pass 1 是散文生成，Pass 2 是结构化分析。当前 AnalysisResult envelope 包含 `eventId`、`protocol`、`observations` 与 `analysis`；解析会校验协议、active fields、observations/payload 配对和证据。Pass 2 无 regex fallback；反馈尝试耗尽时场景会记录错误并进入 review/release 决策路径，不能泛化为所有外层处理立即终止。
- 28 个 built-in validators 注册在默认集合中。`GreyLineValidator` 是已导出的**显式 opt-in** validator：调用方用 `[...createBuiltInValidators(), new GreyLineValidator()]` 选择启用；它不改变默认 28 项或 Pass 2 的 20 字段 static schema。

## 作者 YAML 的当前最小拓扑

标准 Host loader 的当前路径合同是：

```text
nova.yaml
definitions/state_initial.yaml
definitions/entity-types.yaml
definitions/thread-types.yaml
definitions/propositions.yaml
definitions/relationship-types.yaml
definitions/rule-types.yaml
definitions/relationships/*.yaml
definitions/rules/*.yaml
[optional] definitions/discourse-ledger.yaml
chapters/chapter_NN/[optional] _chapter.yaml
chapters/chapter_NN/E*.yaml
```

七个 root catalog/state 文档是 loader 所需输入；relationship/rule declaration 目录可以为空。`state_initial.yaml.threads` 是 thread declaration，`thread-types.yaml` 为 baseline 提供 phase、goals、milestones、reopen policy 与 time-domain metadata；mapper 将 event wire 的 scalar `threadProgress` 归一化为 runtime transaction。`propositions.yaml`、state-initial knowledge、relationship/rule declarations 都在 canonical baseline 中 materialize；后续 event transaction 经同一 replay path 变更状态。事件文件是 strict EventFile：`beats` 至少有一个非空条目；作者 YAML 的 wire Fact 与 runtime `Fact` 是不同表示，必须经 mapper 归一化。

## 当前用户与运行时入口

- 生产 provider 是 `PiOpenAICompatibleProvider`（`@novalistically/node-host`，基于 pi-ai 的 `createPiProviderStack`），默认 OpenAI-compatible base URL 为 `https://opencode.ai/zen/v1`，模型可由运行时配置或环境覆盖；CLI 不自动读取 `.env`。Workbench 内置 Agent 模型缝是 `createPiAgentModel`（`packages/workbench/src/host/agent/pi-agent-model.ts`，`@earendil-works/pi-ai` + pi-agent-core `StreamFn`），按 project profile 从 credential store 解析 key，不读 `process.env`。
- CLI 当前提供 validate/status/entity/graph/source/render/revise/render-tree/event-diff/operation/authoring/review/gate/publish/publication/project-init 这一组命令。本交付新增：`source validate --working`（校验 working authoring 层）、`source submit`、`operation get|wait|cancel`、`authoring conflict|resolve`、`event-diff`、`review list|add|update|history|revise`、`gate list|decide`、`publish`、`publication status|read`。不存在的历史命令或选项不能出现在使用指南中。
- Core 输出的是结构化 intents/records；文件写入由 Host repositories 负责。不要承诺 Core 直接写 `scenes/`、`.nova/responses/` 或 `.nova/derived/` 目录。

## 明确的产品与证据边界

- `SurfacePlanner` 只为已写场景规划 render groups / serial lanes；不会生成或写入 `NarrativeEvent`。这是 Core 不拥有 authoring 写入权的设计边界，不是移除后遗留的运行时承诺。
- `fixtures/zhu-fu/reference/` 是确定性的 mock/generated regression reference；live-provider 候选只能由凭据驱动的 `npm run smoke:stage1:live` 生成到独立 candidate 目录，并且仍需人工审阅后才可作为 live evidence。mock 参考不能被描述为人工或 live-LLM 证据。
- Dream of Red Chamber 当前 authored fixture 的可复现数量由 [`fixture-manifest.json`](../fixtures/dream-of-red-chamber/fixture-manifest.json) 定义。执行 `npm run count:drc -- fixtures/dream-of-red-chamber --check` 会核验四章、E01–E36（每章九个事件）和 source hash；80 章 corpus source 是独立 acquisition artifact，不能与该 fixture 混用。
- `npm run smoke:workbench-agent:live` 是内置 Agent 的真实模型端到端冒烟（需 `NOVALISTICALLY_AI_API_KEY`），需单独人工确认，**不作为确定性 CI 证据**。live LLM 的产出从不写入 reference 目录，也不被任何门禁引用。
- 内置 Agent（`agent-chat`）在 production Host **默认隐藏**：`agentReady=false`（parity matrix 是确定性测试产物，production 不硬编码 true），且 capability 门要求 V3 `agent.enabled` 与模型端口 `supportsToolCalls` 同时为真；live conformance 未跑。
- EPUB/DOCX/marketplace 未交付（plan 只承诺 Markdown 成书）；不要把这三者描述为已存在的能力。

## 当前产品接线边界（Agent-first 工作流）

2026-08-05 的[原始要求 / Agent-first 工作流符合度审计](./audits/original-requirements-agent-workflow-audit-2026-08-05.md)对 `docs/archive/PROJECT.md`（历史要求，不改写）做了源码核验，总体判定为**部分满足**并列出接线缺口（撰写时点快照）。2026-08-06 的 Agent-first 完整交付关闭了全部缺口，以下接线边界已核验成立（一句话证据；细节与行号见审计报告与源码）：

| 边界 | 状态 | 一句话证据 |
|---|---|---|
| 外部 MCP Agent authoring | **可达** | `/mcp/projects/:projectId` Streamable-HTTP 端点 + `MCP_TOOL_CATALOG_V1` 72 个工具；edit→submit→render 闭环可达；产能来自 agent 自带文本，Host 不为 MCP 通道运行 provider |
| `nova_graph` / `nova_revise` / `nova_render_tree` Host handler | **已实现** | `packages/workbench/src/host/mcp/registry.ts` 三个 handler + 共享 render 输入解析与两阶段 lane；`mcp-catalog-parity.test.ts` 断言 registry 与目录双向一致、`KNOWN_ORPHAN_TOOLS = []` |
| `nova_status` guidance / nextActions / ISS | **已实现** | Core `buildWorkflowStatus()` 产出完整 `WorkflowStatusV1`；Host `buildWorkflowStatusForSession()` 组合 review（append-only stream）与 publication（durable store）的 live projections；Node Host `FileProjectStatusReporter` 写派生 `PROJECT_STATUS.md` |
| working-layer 验证 | **已实现** | `nova_authoring_validate`（`mcp:author`）验证未提交的 working layer；CLI `source validate --working`；`nova_validate` 仍只验证 accepted 层，两套语义不混 |
| assembly 生产 caller | **已存在** | Workbench `ProjectPublicationService` 经 Core `assembleRelease`（`@novalistically/core/editorial`）装配；Node Host `FilePublicationWriter` 写 `output/novel.md`；`refreshCanonical()` 在 accepted commit / release-gate 决议 / review-driven revise 后自动刷新 |
| review producer | **已存在** | Host `review-service.ts` 的 append-only review stream；`nova_review_list/get/add/update`、`nova_release_gate_list/decide`（`resolveReleaseGate` 零 provider 调用）+ CLI `review`/`gate` 命令；gate identity 是 `computeReleaseGateId` 的 sha256（自 envelope 捕获，多 gate 不漂移） |
| plugin Host activation | **已激活** | launch 经 `activateNodePlugins` 激活受信任本机插件（`trustedPlugins` manifest/index.js hash 身份）；`PluginExtensionSchemaRegistrar` 接入 accepted/working 验证路径（未知/禁用 namespace = source error）；`plugin-snapshot.spec.ts` e2e 6 tests 为证据 |
| 内置 Agent project-wide presence pause | **已解除** | 内置 Agent 与外部 device 共享 `ProjectToolExecutor` + pi-agent-core `Agent` 循环（`createPiAgentModel`，pi-ai tool-calling）；`agent-chat` capability 门 = V3 `agent.enabled` && `supportsToolCalls` && parity matrix 4/4（确定性测试）；production 默认 `agentReady=false` → 隐藏 |
| 持久化 operation 队列 | **已实现** | `project_operations` 表 + `ProjectOperationService`：两阶段 detached render（lane 内 prepare/commit、lane 外 execute）、cancel、重启 interrupted sweep 不自动重放；Operation Center 统一 SSE |
| canonical-world 快照 | **已实现** | `CanonicalStateProjectionService` 按 source/route 派生快照流；等价门禁 `state-projection-equivalence.test.ts`（14 fixtures / 19 tests）断言逐事件 stateBefore/stateAfter hash 与 `compileProject().boundaries` 一致 |

## 本交付新增的能力（Workbench / Core / Node Host）

以下能力均由源码 + handler + 确定性测试证明（live LLM 不作为证据）：

- **两阶段 detached render**：`ProjectOperationService` + `project_operations` 持久表；prepare/commit 在序列化 lane 内、候选计算在 lane 外（可中断），cancel 经 AbortController 贯穿，重启把 queued/running 扫为 `interrupted` 且**不自动重放**（显式 retry 才重放）。
- **Operation Center 统一 SSE**：浏览器事件流统一广播 authoring / review / gate / operation / publication 事件（此前只广播 authoring 操作）。
- **review stream + release gate**：append-only review 事件流（comment 与 gate 记录同一流）；gate identity 为 `computeReleaseGateId` 的 sha256（projectId/sourceHash/eventId/proseHash/scopeHash/validationIdentity/warnings），自归档 envelope 捕获 → 多 gate 独立决策、identity 漂移即 supersede；`resolveReleaseGate` 重跑唯一 release evaluator 且零 provider 调用。
- **publication 自动刷新**：`FilePublicationWriter`（Node Host）写 `output/novel.md`（`PUBLICATION_OUTPUT_DIRECTORY`）；`refreshCanonical()` 在 accepted commit / gate 决议 / review-driven revise 后 best-effort 刷新，全集未就绪时只降级为 `stale`、绝不写部分小说。
- **受信任本机插件**：`activateNodePlugins` 以 `trustedPlugins` 的 manifest + index.js 的 SHA-256 身份校验后激活；`PluginExtensionSchemaRegistrar` 把 EventFile `extensions` 命名空间接入 accepted/working 验证（未知/禁用 namespace = source error）；plugin identity（manifest/module hash）进入 validationIdentity 与渲染 cache key。
- **canonical-world 快照投影**：`CanonicalStateProjectionService`（workbench host）按不可变 source/route 派生快照流；等价门禁 14 fixtures / 19 tests 与完整 canonical compile 逐事件一致。
- **内置 Agent**：`ProjectToolExecutor`（workbench host）把内置 principal 接到与外部 device 相同的 MCP 工具表面；`createPiAgentModel`（`agent/pi-agent-model.ts`）是 pi-ai tool-calling 模型缝（Node Host 侧 provider 为 `PiOpenAICompatibleProvider`）；`agent-chat` capability 门 = V3 `agent.enabled` && `supportsToolCalls` && parity matrix 4/4；production 默认隐藏（`agentReady=false`）。
- **确定性 mock provider**：`createDeterministicMockProvider`（Node Host）按项目配置构造 Pass-2-aware 确定性 mock，launch 与 parity/e2e 均用它，保证无网络、可复现。

## 已修复的产品 bug（均有回归测试）

- browser submit 400：submit CAS 字段 allowlist 收紧，浏览器只提交 secret-free 白名单字段。
- device-mode render DENIED：device grant 现在持久化到 durable capability 行，重启后不再丢。
- mock provider Pass 2 非 JSON：launch 改用 per-project Pass-2-aware 确定性 mock，不再依赖旧的非 JSON mock 响应。
- multi-gate supersede 漂移：gate identity 从已归档 envelope 捕获而非现场重算，source/candidate/validator identity 变化才 supersede。
- review-hub capability 无浏览器路由：补齐 `browser-review-api` 路由（`createBrowserReviewApi`）。
- extensions registrar 未接入验证路径：`PluginExtensionSchemaRegistrar` 已接入 accepted/working 两套验证。
- Operation Center 只广播 authoring 操作：事件流统一为全操作类型（见上）。

## 文档解释规则

- **current reference**：本页、`docs/architecture.md` 与 `docs/reference/` 中被标为当前的页面；必须与当前源码同步。
- **historical record**：`docs/archive/`、有日期的 audits/reports、阶段测量与竞品快照；保留原结论和日期，增加到本页的指针并显式标记不代表当前实现。
- **design-only / unverified**：未来协议、未接线 schema 或未经 live LLM 复核的宣称；必须明确为设计或未验证，不能写成运行时保证。

相关入口：[`架构`](./architecture.md)、[`完整接线图`](./reference/wiring.md)、[`API`](./reference/api.md)、[`YAML 合同`](./reference/yaml-contract/README.md)、[`历史归档`](./archive/README.md)、[`Agent-first 工作流审计 2026-08-05`](./audits/original-requirements-agent-workflow-audit-2026-08-05.md)（撰写时点快照，其中的接线缺口已在本交付关闭，见上表）。
