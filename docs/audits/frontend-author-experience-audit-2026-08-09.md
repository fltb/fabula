# 前端作者体验审计（2026-08-09）

**时间**：2026-08-09 CST
**方法**：源码核验 + dev 环境（`dev.mjs`，127.0.0.1:5173 / :8787，项目 skeleton-demo）实测复现；所有结论附 `file:line` 证据。
**范围**：用户从作者视角报告的 7 项前端问题。本页只记录根因与数据流，不实现修复。修复项经评审后另行实施。

## 总览

| # | 现象 | 根因类型 | 一句话结论 |
|---|---|---|---|
| 1 | 「文稿」完全是编程视角 | 视图定位错位 | SourceStudio 是 authoring/VCS 协议控制台，被直接挂到作者导航下 |
| 2 | 「图谱 / 路线」没有说明意义 | 缺解释层 + 数据缺口 + 本地化遗漏 | Core 编译器产物逐字投影，节点只有 id 无名称，整文件 100% 英文 |
| 3 | 场景图「情绪」栏目来源不明 | 数据来源误解（schema 字段，非 LLM） | `emotionalValence` 是作者手写的事件 YAML 字段，fixtures 全量填写致条带全量渲染，UI 直接用原始 schema 字段名做标签 |
| 4 | 场景画布 Adoption preview 报错 | **写入方/校验方契约漂移（真 bug）** | 当前代码写出的 revision envelope 过不了当前 strict 校验 schema → 503 → 客户端碾成笼统 FATAL 文案 |
| 5 | 发布页看不到文章、却有下载 | 数据陈旧 + 无正文预览 | 下载按钮与空列表在源码中不可能共存；「看不到文章」= 视图只展示元数据 + 目录不自动刷新 |
| 6 | 设置未分开渲染写作/agent 模型 | 数据模型缺失（单共享 profile） | 写作与 agent 复用同一 provider profile，无独立 agent-model 字段；agent 路径还忽略 advanced 字段 |
| 7 | agent 回复「状态接口返回哈希」 | **harness 级结果截断（真 bug）** | run-service 把所有 MCP 工具结果截断为 `ok:<16位sha256>`，status 的可读字段永远到不了模型 |

---

## 1. 「文稿」视图（SourceStudio）——编程视角

**根因**：`source-studio.tsx` 是 authoring 协议控制台（accepted identity vs workspace digest、CAS 提交、external candidate 协调、native revision vs Git mirror、诊断 code、Yjs 文档身份），本地化只覆盖句子层，身份/状态/诊断 token 保持英文或裸哈希。

**作者视角不可用元素（证据）**：
- 已接受源哈希 / 投影修订 HashChip（`source-studio.tsx:488-531`）——裸哈希 + 「工作摘要」概念
- 工作层文档列表显示 `documentId`（Yjs id）+ 裸英文状态 `idle/connecting/connected/disconnected/unavailable`（`:533-777`、`:187-188`）
- 新建/移动文稿要求「清单相对逻辑路径」（`:558-611`、`:682-773`）——文件系统概念
- 散文文稿也用 CodeMirror + 行号 + YAML 语法高亮编辑（`yjs-editor.tsx:278-294`，`WORKING_TEXT_TYPE='prose'` 是 Yjs 文本类型名）
- 诊断列表渲染裸 `diagnostic.code`（`:464-482`、`:809-833`）
- 外部候选/双重冲突：裸哈希 + 「应用建议的不相交合并」合并算法概念（`:835-915`）
- 修订历史说明「即使配置了 Git 镜像，也不会用于接受或恢复决策」——纯 DevOps 内部信息（`:952-1097`）

**判定**：面向技术用户的视图被直接暴露给作者——VCS/CRDT/CI 控制台，中文只覆盖句子层。

## 2. 「图谱 / 路线」视图（GraphRoute）——没有说明意义

**根因**：`projection-views.tsx` 是 `inspectCanonicalGraphRuntime` 的逐字投影，三点叠加：
- **缺解释层**：全视图零解释性文案（`graph-toolbar-note` 字符串在仓库中不存在）
- **数据缺口**：node/edge 列表只有 id（`node.id` / `edge.predecessor → dependent`），无可读名称
- **本地化遗漏**：整文件 100% 英文——本地化提交 `1cea1e8` 漏掉了 `projection-views.tsx`

**判定**：编译器输出的原始投影，无任何「这是什么、为什么有用」的说明。

## 3. 场景图「情绪」——数据来源调查

**数据来源（已核验）**：`emotionalValence` 是事件 YAML 的 schema 可选字段（`packages/core/src/schemas/event.ts:74`），**作者手写，不是 LLM/Pass 2 输出**。数据流：

1. 事件 YAML `emotionalValence: <string>`（如 `fixtures/zhu-fu/chapters/chapter_01/E0_encounter.yaml:10`）
2. Core 编译：`EntityMapper.loadAllEvents` 映射进 `NarrativeEvent`（`entity/mapper.ts:772`）——全程无 provider
3. Host `loadSceneMap` 只收集声明了非空 `emotionalValence` 的事件（`scene-map-service.ts:344-345`）→ `strips.emotionalValence`（契约 `SceneMapStripsV1`，`contracts/scene.ts:106-110`）
4. 客户端渲染「情感弧线」条带（`SceneMap.tsx:776-808`），**仅当 `emotionalValence.length > 0` 时显示**（`:733-739`、`:776`）——无数据时整节隐藏，无空 chip

**为何用户觉得「它不应该出现」**：
- UI 标签直接用原始 schema 字段名「**emotionalValence 全书序列**」（`SceneMap.tsx:780`）——不是「情绪」
- fixtures（zhu-fu 全部 E0-E6、david-copperfield 全部 E01-E20）为 P0 字段测试逐事件填写，故即便 mock provider / 无 live LLM 条带也全量渲染
- 行级 `tone` chips（已发布/草稿/未渲染，`SceneMap.tsx:43-62`、`577-585`）是 **render 状态**（`RowRenderTone`），不是情绪——两处「tone」同屏易混淆
- 编辑表单的「情绪」select（`:633-652`）是编辑控件，默认「（不指定）」，与条带无关

**判定**：schema 支撑 + 渲染管线消费的**有效作者数据**（Pass 1 还把它注入为 "Emotional keynote"：`prompt-assembler.ts:125`），不是死字段；「不应出现」是**产品决策**问题（标签命名、条带价值解释、是否默认隐藏），不是数据缺陷。编辑器的 `VALENCE_OPTIONS` 词表是「从 fixtures 提炼的 schema-free 字符串」（`SceneMap.tsx:64-85`）。

## 4. 场景画布 Adoption preview 报错——**真 bug（契约漂移）**

**复现**（dev host 实测）：点击场景行 → `GET /api/v1/projects/skeleton-demo/scene-adoption?eventId=E001&revisionId=scene_revision_…` → **HTTP 503** `{"code":"SCENE_ADOPTION_UNAVAILABLE","message":"The stored scene revision is invalid."}`。bogus revisionId 则正确返回 404。

**根因**：`prepareSceneAdoption`（`host/scene-adoption.ts:42-107`）对持久化 envelope 跑 `sceneRevisionEnvelopeV1Schema.safeParse`（strict，`schemas/editorial.ts:198-235`），当前代码写出的 envelope **必然不过**：

1. `revisionId: Invalid uuid` —— 写入方 `ids.next({kind:'scene_revision'})`（`render-service.ts:687`）+ node-host 默认 `(kind) => `${kind}_${randomUUID()}``（`node-host/src/runtime.ts:98`）产出 `scene_revision_<uuid>`；schema 的 `uuidSchema = z.string().uuid()`（`editorial.ts:13,201`）只接受裸 UUID
2. `releaseDecision: Unrecognized key(s) 'gateId','releasePolicy','warningFingerprints'` —— 渲染时嵌入完整 `ReleaseDecision`（`render-service.ts:716`；`types/render-surface.ts:306-324`），而 `releaseDecisionSchema` 是 strict 五键对象（`editorial.ts:114-122`），从未包含这些键

即**写入方与校验方契约漂移**：任何项目、任何已渲染 revision 走 adoption preview 都会 503，不是偶发数据问题。

**错误文案两层碾平**：
- Host 把 4 类失败（REVISION_INVALID/UNRELEASED/PROSE_HASH_MISMATCH + catch-all）都映射为 `SCENE_ADOPTION_UNAVAILABLE`→**503**（`browser-read-api.ts:924-931,978-983`）
- 客户端 `runtimeErrorMessage` 只看 HTTP status，503 → `FATAL` →「The Workbench Host returned an unexpected error.」（`runtime-client.ts:150,158,166-168`），Host 的 code/message 被完全丢弃
- 视图层显示「Adoption preview could not be loaded」（`scene-canvas.tsx:39-42`）

## 5. 发布页——看不到文章、却有下载

**根因（结构核验）**：「下载」按钮在源码中**不可能**与空列表共存——按钮只在 `PublicationCard` 内，卡片只在 `publications.length > 0` 的 `<Show>`/`<For>` 内（`PublicationView.tsx:467-475`），按钮再受 `onRead !== undefined` 门控（`:233-260`）；有测试锁定（`publication-view.test.tsx:111,118`）。用户「看不到文章」的真实成因为二：

1. **无正文预览（by-design）**：视图只展示元数据（哈希/路径/字数/场景数），正文唯一读取途径就是「下载」——产物即下载对象（`output/novel.md`，`file-publication-writer.ts:9-12`）。「看不到文章」= 没有内联预览，而非没有下载。
2. **发布目录陈旧**：客户端只在工作区加载时抓一次目录（`main.tsx:641-643`），切视图不重取（`App.tsx chooseView` 只 setActiveView）；SSE `operation-updated` 只刷新 Operation Center（`project-event-client.ts:114-117`）不刷新发布目录。Agent 发布成功后进发布页仍显示「还没有发布产物」，直到手点「刷新」。`refreshCanonical` 失败还被静默吞掉（`workbench-launch.ts:1242-1243,1315-1317`）。

**判定**：数据链路正确（下载按钮只在有产物时出现，产物=下载对象）；缺口是元数据式视图 + 目录无自动刷新 + 失败静默。

## 6. 设置——未分开渲染写作模型与 agent 模型

**根因**：**单一共享 profile**。`WorkbenchProviderConfigurationV1` 只有 kind/baseUrl/model/advanced（`workbench-protocol/src/configuration.ts:58-67`），`WorkbenchAgentConfigurationV1` 只有 enabled/maxTurns/maxToolCalls（`:47-51`）——**不存在任何独立 agent-model 字段**；项目经 `providerProfile` 绑定到恰好一个 profile（`:19`）。

- 写作侧：`workbench-launch.ts:1124-1129` 取 `providers[profileId]` 构造 `PiOpenAICompatibleProvider`
- Agent 侧：`workbench-launch.ts:1325-1343` **复用同一 profileId + 同一把凭据键** `ai-sdk:<profileId>`（`credential-store.ts:92-94`）→ `createPiAgentModel({baseURL, apiKey, modelId})`
- **附加 bug**：agent 路径只传 baseURL/apiKey/modelId 三项（`pi-agent-model.ts:11-18`），profile 的 `reasoning/contextWindow/maxTokens/headers` 对 agent **无效**，agent 恒用默认值（`pi-provider.ts:56-61`）
- UI 侧：`SettingsView` 把 profile id **硬编码 `'default'`**（`SettingsView.tsx:15,79,142-162`），不读取项目实际绑定的 `providerProfile`；admin `ProviderPage` 支持多 profile 与项目改绑（`ProviderPage.tsx:68-76,173-183`），advanced 设置表单（`AdvancedPage.tsx:329-403`）只有 enablement/limits

**判定**：不是「两个配置 UI 没分开」，而是「单 profile 被写作与 agent 无条件共享、UI 只渲染一次」；分开渲染需要数据面先新增 agent-model 字段 + agent 路径透传 advanced 字段。

## 7. agent 回复「状态接口返回哈希」——**真 bug（harness 级结果截断）**

**根因**：agent 的回复是对 harness 行为的如实描述。run loop 把**每个 MCP 工具结果**（不止 status）都经 `resultSummaryOf()` 截断为 `ok:<SHA-256(canonicalJSON(data)).slice(0,16)>`（`run-service.ts:224-235`），这是模型看到的**唯一文本**（`run-service.ts:413-421`；pi-agent-core `createToolResultMessage` 只取 content）。

- 系统提示把 agent 导向 status-first（`run-service.ts:210`）→ agent 调 `nova_status` → 收到字面 `ok:<16hex>` → 如实报告「状态接口返回的是摘要哈希」
- `WorkflowStatusV1` 本身**不是哈希-only**：携带可读的 validation messages、ISS 分数/缺口、blockers、nextActions、guidance（`core/src/status/workflow-status.ts:135-166`）——但全部被摘要丢弃
- 即使 agent 去调 `nova_source_get`/`nova_authoring_document_read`（可读内容工具，`registry.ts:2911-2943,3564-3619`），同样只拿到摘要
- 同一摘要被持久化并显示在客户端 UI：`成功 <digest>`（`AgentChat.tsx:190`）

**判定**：不是 status DTO 数据缺口，也不是 agent tool-choice 失败——是 harness 级结果截断设计（secret-free、record-bounded）让模型对一切工具输出失明。可读内容工具存在且在 scope 内，但同样被摘要化。

---

## 附：2026-08-09 UI 重构核验（current-state 刷新）

2026-08-09 完成 Workbench 浏览器端 Tailwind v4 + Kobalte 重构（`styles.css` 2640→107 行，全部视图类转工具类，`ui/primitives.tsx` + `ui/controls.tsx` 为共享源）。核验数：

- 客户端测试 **187/187 通过（25 文件）**（重构前 175/175）
- `tsc -p packages/workbench/tsconfig.client.json --noEmit` 干净
- `npm run lint` exit 0（仅剩 biome.json schema 2.5.5 vs CLI 2.5.7 的既有 info；已清理 gitignored 的 `test-results/.last-run.json` 陈迹）
- 浏览器 1600/1000/700 三宽度 shell 布局断言通过；9 视图走查零 console 错误
- Host 侧代码本次未动（重构仅 client 文件 + styles.css），2026-08-08 的 Host 744/744 记录保持
