# Workbench 产品化补充调研 + 具体方案（Stage 9 候选）

调研对象：Open WebUI（/tmp/open-webui）、LibreChat（/tmp/LibreChat）、AnythingLLM（/tmp/anything-llm），以及本仓库现有 reference/agent-chat 代码。

**核心发现**：`packages/workbench/src/host/mcp/registry.ts` 注册了 72 个 `nova_*` MCP 工具给外部 agent。前端 browser 路由覆盖了其中约 40 个对应操作，但**参考资料管理（11 个工具）和渲染触发（3 个工具）是完整的功能域缺口**——前端能做的比外部 agent 少。这违反产品化原则：前端 UI 是完整产品，MCP 接口是能力的外部化，不应是降级版。

**修正记录**：本文件初版（08-07 会话内）曾把 reference 写操作规划为「导入/删除走 Agent Chat」。审计后修正——前端提供直接的导入/删除/搜索/查看操作，agent 聊天保留为补充入口而非唯一路径。

---

## 1. Reference 管理 UI（全管理视图）

### 现状（已核验）

- `GET /api/v1/projects/:projectId/references` 只读 API 存在（browser-api.ts:46，host/browser-read-api.ts:659-708），返回 `BrowserProjectReferenceListV1 { version, projectId, items: ReferenceItemV1[], nextCursor }`，支持 pageSize/cursor 分页。
- `ReferenceItemV1` 字段丰富：`referenceId / displayName / originalName / mediaType / contentHash / byteLength / title / authors / sourceUrl / license / tags / createdAt / updatedAt`。
- **没有任何前端消费**：grep `getReferences|references` 于 client/ 无命中（除注释）。
- 写操作（import/delete/retry/job）只有 MCP 工具 `nova_reference_*`（11 个），无 browser 路由。
- Host 内部已有完整 `McpReferencePort` 端口（reference-port.ts，list/get/search/chunkGet/contentRead/importBegin/importChunk/importCommit/jobGet/retry/delete），MCP 工具只是它的薄包装。

### 参考项目模式

- **AnythingLLM**：两栏转移隐喻（左目录树 + 右已嵌入文档），per-file SSE 状态生命周期（batch_starting → doc_starting → chunk_progress → doc_complete/failed），失败行持久显示，搜索 debounce 400ms + searchSeq 防过期响应。
- **Open WebUI Knowledge**：服务端搜索（300ms debounce）+ 无限滚动 + id-dedup，行内 ItemMenu（导出 / 删除），pending upload 轮询 5s 合并为 spinner 行。
- **LibreChat FileDashboard**：@tanstack/react-table 数据表，排序/过滤/分页。

### 方案（全管理视图，agent 聊天为补充入口而非替代）

**原则**：前端提供直接的导入/删除/搜索/查看操作。导入的 browser 路由复用 Host 内部 `McpReferencePort`（reference-port.ts），只是多一层 HTTP 包装，不重复实现导入逻辑。

**新增视图「References」**（`WorkbenchProjectFeatureV1` 加 `'references'`）：

1. **管理列表**（复用现有 `GET /references` + 新增 browser 写路由）：
   - 表格：名称（displayName + originalName 副行）、类型（mediaType badge）、大小（byteLength 人类可读）、作者/来源（authors / sourceUrl，有则显示）、添加时间（createdAt）。
   - 搜索：本地过滤 + 服务端 cursor 分页「加载更多」（已有 nextCursor）。
   - 每行操作：删除按钮（`DELETE /api/v1/projects/:projectId/references/:referenceId` → `McpReferencePort.delete`）。
2. **导入**：列表页顶部「导入文件」按钮 → 文件选择器（`<input type="file">`，多文件），或拖拽到列表区域。
   - 上传流程：`POST /api/v1/projects/:projectId/references/import`（multipart，`maxBytes = referenceLimits.maxFileBytes`）→ Host 调用 `McpReferencePort.importBegin/importChunk/importCommit`（与 MCP 工具同一实现）。
   - 上传进度条（乐观状态 + 服务端 job 轮询，仿 Open WebUI 5s polling）。
   - 导入失败 → 错误行持久显示 + 重试按钮（`McpReferencePort.retry`）。
3. **只读详情**：点击行 → 展开面板显示 `title/authors/sourceUrl/license/tags` + 内容预览（`McpReferencePort.contentRead`，bounded）。
4. **空态**：「还没有参考资料。点击「导入文件」添加，或让 Agent 用 `nova_reference_import_*` 帮你导入。」（保留 agent 入口，但不作为唯一路径。）
5. **gate**：`references` feature 在 `referenceLimits.enabled` 时由 launch 派生（与 Stage 3.8 reference port 同 gate）。view 目录序放在 publication 后。

### 新增 browser 路由

```typescript
// contracts/browser-api.ts
export const BROWSER_PROJECT_REFERENCES_IMPORT_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/import`;
export const BROWSER_PROJECT_REFERENCE_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/:referenceId`;
export const BROWSER_PROJECT_REFERENCE_DELETE_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/:referenceId`;
export const BROWSER_PROJECT_REFERENCE_CONTENT_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/references/:referenceId/content`;
```

`BrowserApiErrorCode` 新增 `'REFERENCE_IMPORT_FAILED'` / `'REFERENCE_SIZE_EXCEEDED'`。

### 后端改动

- `host/browser-read-api.ts`：`GET /references/:referenceId` → `McpReferencePort.get`；`GET /references/:referenceId/content` → `McpReferencePort.contentRead`（bounded）。
- 新建 `host/browser-reference-api.ts`：`POST /references/import`（multipart）→ `McpReferencePort.importBegin/importChunk/importCommit`；`DELETE /references/:referenceId` → `McpReferencePort.delete`。
- `server.ts` 注册路由，`workbench-launch.ts` 在 `referenceLimits.enabled` 时派生 `references` feature + 挂载路由。

### 工作量：~3d（browser 路由 + 前端组件 + 测试）

---

## 2. Render 触发入口（新增缺口）

### 现状（已核验）

- 外部 agent 有 `nova_render` / `nova_revise` / `nova_render_tree`（registry.ts:3003/3022/3072）。
- 前端**无任何渲染触发 UI**：SourceStudio 编辑源、SceneAdoption 只能「采纳已渲染的 revision」，但没有「发起一次渲染」的按钮。
- AgentChat 欢迎卡计划（5.1）有「渲染第 1 章并发布」示例卡，但那是聊天代劳，不是直接 UI。

### 方案

1. **Scene Adoption 视图加「渲染」按钮**：`scene-canvas.tsx` 头部加「Render scene」按钮 → `POST /api/v1/projects/:projectId/scenes/:eventId/render`（browser 路由 → Host 内部调用与 `nova_render` 相同的 registry handler）。渲染完成后刷新 adoption preview。
2. **SourceStudio 加「Validate + Render」入口**：`source-studio.tsx` 提交区旁加「Render」按钮（触发 `nova_render` 等价操作），渲染结果走 SceneAdoption 展示。
3. **权限**：render 需要 `mcp:render` scope（`PROJECT_ACCESS_ROLE_GRANTS` 已有），author+ 可用。

### 工作量：~1d（browser 路由 + 按钮 + 测试）

---

## 3. 附件 / 文件上传

### 现状（已核验）

- 计划 5.8 已有机制设计：`POST /api/v1/projects/:projectId/agent/attachments`（multipart，maxBytes = referenceLimits.maxFileBytes），Host 存 `$WORKBENCH_HOME/agent-attachments/<projectId>/<sha256>`，返回 `{ attachmentId }`；`SendAgentMessageRequestV1` 加 `attachmentIds`；文本文件拼进 user message，图片用 pi-ai `ImageContent`（需视觉模型）。
- AgentChat.tsx 当前是单行 text input（`<input>`），无附件能力。

### 参考项目模式

- **LibreChat**：56px 圆角 chip（icon + 截断文件名 + 类型 label + 进度 + 移除按钮），图片 56x56 缩略图 + 进度圈 + hover 放大 + 全屏 dialog；拖拽全屏 overlay + 类型选择 modal；PASTE/REMOVE/CLEAR window CustomEvent 协调，attachment processing 期间 gating send。
- **Open WebUI**：整聊天面板 dropzone + 自定义 MIME `application/x-open-webui-drag` 区分文件/侧栏拖拽；乐观 files 数组（`{status:'uploading'}` → 'uploaded' 或移除），send 在 uploadPending 时禁用；非图片用 FileItem + spinner，图片缩略图 + vision 能力警告。
- **AnythingLLM**：附件 chip 按状态着色（uploading/embedded/failed），上传失败持久显示 + 重试；token-count 守卫 + FileUploadWarningModal（Close/Continue/Embed）。

### 方案（MVP 对齐 5.8 机制）

1. **输入区**：多行 textarea（5.1 已有）下方附件栏——chip 列表（文件名 + 大小 + 移除按钮，仿 LibreChat 56px 样式）。
2. **拖拽**：textarea 容器整块 dropzone；dragenter 显示全屏 overlay（「松手上传附件」）；支持粘贴图片（PASTE 事件）。
3. **上传流程**：
   - 乐观 chip：`{status:'uploading', progress}` → 上传完成 `{status:'uploaded', attachmentId}` → 失败 `{status:'failed'}` + 移除/重试。
   - 发送按钮：有附件上传中 → 禁用（Open WebUI 模式）。
   - 成功后发送消息，`SendAgentMessageRequestV1.attachmentIds` 带上。
4. **消息渲染**：user 消息内附件渲染为 chip（点击 → 新 tab 打开 Host 读取路由，或详情 modal）。
5. **视觉模型 gate**：图片附件仅在模型 `input` 含 `'image'` 时允许（5.8 已有前提），否则上传即报「当前模型不支持图片，请用文本」。
6. **browser 路由**：`POST /api/v1/projects/:projectId/agent/attachments` + `GET /api/v1/projects/:projectId/agent/attachments/:attachmentId`（读取用，bounded）。

### 工作量：~2.5d（browser 路由 + client + 组件 + 测试）

---

## 4. Onboarding 引导

### 现状（已核验）

- SetupWizard 6 步完整（owner 设置 → 项目 → provider → key → 网络），finish 后进 login。
- AgentChat 空态是单句「Send a message to start an Agent run…」，无欢迎卡（计划 5.1 将加三张示例卡）。
- 无「首次进入 workspace」引导，无配置错误恢复路径。

### 参考项目模式

- **AnythingLLM**：5 步 onboarding（home → llm-preference → user-setup → data-handling → survey），每步注入自己的 header/nav chrome（setHeader/setForwardBtn/setBackBtn），可搜索 provider 网格，privacy 步骤，完成 gate（System.isOnboardingComplete + localStorage last-visited workspace）。
- **Open WebUI OnBoarding**：全屏 welcome hero + Get started / Read the docs CTA；ChatPlaceholder 模型头像簇 + 「Hello, name」；Suggestions 模糊搜索建议卡 + 瀑布动画。
- **LibreChat Landing**：时间问候 + SplitText 动画 + 实体 avatar/name/description + 可配置 HTML welcome。

### 方案（不新建 onboarding 流程，做「首次引导」）

1. **workspace 首访 banner**（localStorage `workbench.onboardingSeen` gate，仿 AnythingLLM last-visited）：
   - 首个可见视图为 agent-chat 且无历史会话时，AgentChat 内显示「欢迎」引导卡——不是新流程，而是 **4 步迷你 tour**（Solid 轻量实现，无库）：① Agent Chat 是入口，直接说人话 ② 左侧 Source Studio 编辑源文件 ③ Review Hub 看评审门禁 ④ Publication 发布产物。每步「下一步/跳过」，末尾「开始使用」。
2. **AgentChat 欢迎卡升级**（合并 5.1 三张示例卡）：三张示例卡 + 一行「不知道从哪开始？试试这些」+ 每条卡有 icon + 描述 + 点击填入。
3. **配置错误恢复路径**（与第 5 节合并）：
   - `hostStatus === 'error'` 或 agent 不可用时，agent-chat 视图内显示内联 banner：「Agent 未启用（配置：agent.enabled / provider key / parity）」，带「打开设置」按钮（→ admin ProviderPage）。
   - `AGENT_CHAT_UNAVAILABLE` 错误 → 同一 banner 而非裸错误。

### 工作量：~1.5d（banner + tour + 欢迎卡升级 + 测试）

---

## 5. 质量 / 错误恢复 / 稳定性

### 现状（已核验）

- RuntimeStatePanel 已覆盖 setup/loading/unauthorized/fatal 等启动态（main.tsx）。
- Workspace 内各视图 `.catch(() => null)` → 空态，但**空态与错误态不分**（load 失败显示「没有数据」而非「加载失败，重试」）。
- 无整体错误聚合，无操作失败后的恢复引导。

### 参考项目模式

- **AnythingLLM**：processor-offline 作为一等 disabled 态（dropzone 变灰 + 解释）；inline chat error chip（「Could not respond… Reason: …」）；workspace-not-found modal + return CTA；SSE reconnect/abort self-healing；localStorage-gated 一次性教育 banner。
- **Open WebUI**：结构化错误 unwrap（string → error.message → detail → message → JSON）渲染为 muted inline box；操作前 proactive permission/capability toast；空态「No knowledge found / Try adjusting your search」替代裸错误。
- **LibreChat**：错误消息内联 chip + 重试按钮。

### 方案

1. **错误/空态分离**：各视图 load 失败 → 区分「空（正常）」与「错误（重试按钮）」。最小实现：每个数据 prop 旁加 `*Error` 信号，`catch` 时置错误而非 null，视图渲染 `empty-state` vs `error-state`（带 Retry 按钮 → 调 onRefresh*）。
2. **Agent run 错误内联**：AgentChat run 失败（errorCode）→ 消息区内联 chip +「重试」按钮（retry 已有，补 UI 入口）。
3. **Host 断连**：SSE/事件流断开 → 非静默——顶部 status dot 变红 + 内联 banner「与 Host 的连接中断，正在重连…」（ProjectEventClient 已有 reconnect 逻辑，补 UI 反馈）。
4. **大项目性能**：graph layout 已是 deterministic 分层布局；补一个可测的 guard——`loadWorkspace` 总时长 > 阈值时 console.warn + 视图级骨架屏（skeleton，避免空白）。
5. **移动端**：布局已有 desktop/tablet/mobile 三档 + ResponsiveDrawer；补实测验证（Playwright viewport 375px 冒烟）。

### 工作量：~2d（错误态组件 + 断连 banner + 骨架屏 + e2e 补测）

---

## 6. 前端能力对齐审计（72 个 MCP 工具 → 前端映射）

| MCP 域 | 工具数 | 前端覆盖 | 缺口 |
|--------|--------|----------|------|
| status/entity/graph/source | 10 | ✅ ProjectHome/GraphRoute/SourceStudio | — |
| authoring（文档 CRUD/submit/validate/conflict） | 10 | ✅ SourceStudio + Reconcile | — |
| operation（get/cancel） | 2 | ✅ OperationCenter | — |
| revision（list/get/diff/restore） | 4 | ✅ SourceStudio | — |
| review + gate | 6 | ✅ ReviewHub | — |
| publication | 3 | ✅ PublicationView | — |
| admin | 23 | ✅ Admin 页面 | — |
| **reference**（list/get/search/chunk/content/import×3/job/retry/delete） | **11** | ❌ 仅 1 个只读 `GET /references` | **第 1 节全管理视图** |
| **render/revise/render_tree** | **3** | ❌ 无触发入口 | **第 2 节 Render 按钮** |
| validate / event_state_diff | 2 | ⚠️ validate 走提交隐式，event_state_diff 无 UI | 低优先（event_state_diff 是 agent 专用诊断） |

**结论**：前端补齐 reference 管理 + render 触发后，与外部 agent 接口能力对齐；剩余缺口（event_state_diff）是诊断性工具，agent 专用合理。

---

## 汇总

| 提案 | 参考来源 | 后端改动 | 前端改动 | 工作量 |
|------|----------|----------|----------|--------|
| References 全管理视图 | AnythingLLM/OpenWebUI/LibreChat | browser 路由（复用 McpReferencePort） | 新视图 + 导入/删除/搜索 | ~3d |
| Render 触发入口 | —（本仓库缺口） | browser 路由 | SceneAdoption/SourceStudio 按钮 | ~1d |
| 附件上传 | LibreChat/OpenWebUI | browser 路由（5.8 机制） | 拖拽 + chip + 渲染 | ~2.5d |
| Onboarding 引导 | AnythingLLM/OpenWebUI | 零 | 首访 banner + mini tour + 欢迎卡 | ~1.5d |
| 错误恢复/质量 | AnythingLLM/LibreChat | 零 | 错误态分离 + 断连 banner + 骨架屏 | ~2d |
| **合计** | | | | **~10d** |

**建议**：References 全管理视图 + Render 触发 + Onboarding + 错误恢复 = 交付前必做（~7.5d）；附件上传 = 5.8 已 defer 的机制，可延后到 v1.1（~2.5d）。
