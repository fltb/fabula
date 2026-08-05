# Workbench Host 运行、配置与作者提交

Workbench 是作者笔记本上的本机 Host。它拥有项目文件、SQLite、Yjs 工作层、提供商凭据和能力令牌；浏览器、MCP 客户端与 Agent 只使用版本化的无秘密 DTO。Native immutable revision 是 authoring acceptance model；可选 Git 仅镜像已接受 revision，不参与 acceptance、restore 或 recovery，Core 不读取这些资源。

## 启动边界

开发环境要求 Node `26.5.0`：

```bash
fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench dev
```

`dev` 会构建 Host、启动 Host 与 Vite。默认 Host 为 `127.0.0.1:8787`，Vite 为 `127.0.0.1:5173`。已有本地服务占用端口时，显式分开设置两者；`WORKBENCH_PORT` 始终是 Host 和 Vite proxy 的目标，`WORKBENCH_VITE_PORT` 只控制 Vite：

```bash
WORKBENCH_PORT=8790 WORKBENCH_VITE_PORT=5174 \
  WORKBENCH_PROJECT_ROOT=/absolute/path/to/project \
  fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench dev
```

`WORKBENCH_PROJECT_ROOT` 是兼容旧的单项目启动预填项，不是作者历史或多项目配置来源。未显式指定时，开发脚本会把演示 fixture 复制到临时外部目录；退出时清理该副本。配置验证要求 `nova.yaml.project` 与 configured `projectId` 完全一致。

生产先构建，再运行已打包的 Host：

```bash
fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench build
WORKBENCH_HOME=/var/lib/fabula/workbench \
WORKBENCH_ASSETS_ROOT="$PWD/packages/workbench/dist/client" \
fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench start:workbench
```

未配置的生产 Host 仍只绑定 loopback，并提供首次设置页面。LAN 必须由所有者显式配置允许的 Host 与 Origin。TLS 在反向代理终止；Workbench 自己不终止 TLS。`start:listener` 只有 `/health` 和 `/status` smoke listener，不提供 Workbench 工作流。

## 配置和凭据

`$WORKBENCH_HOME/config/workbench.yaml` 是多项目配置的唯一来源。首次设置、所有者管理页面、受权 MCP 管理工具和人工编辑都通过同一个 revision-CAS 配置服务。配置写入成功不等于运行时已切换：Host 在进程启动时固定 listener、提供商、项目根以及 MCP 默认项目，因此以下字段的任意改动都会持久化并返回 `restart-required`：

- `projects`、项目显示名和项目根；
- `defaultProjectId`；
- `provider` 的 endpoint 或 model；
- `network` listener policy。

收到 `restart-required` 后停止并重新启动 Host；不要假定浏览器、Yjs、MCP、Agent 或 Git mirror 会热切换到一半配置。外部 YAML 编辑若无效或删除 busy 项目，会保留最后一个有效运行配置并返回诊断。

提供商 API key **不在** `.env`、YAML、浏览器、MCP 工具输出或审计记录中。首次设置或所有者 Provider 页面将其写入 Host 的凭据存储；`HostProviderFactory` 从不回退读取 `NOVALISTICALLY_AI_API_KEY`。环境变量仅控制启动位置、listener 与显式开发 mock；不要把生产 key 放进 `.env.example`。

## 作者工作流与身份

四种身份不可互换：

| 身份 | 含义 | 用途 |
| --- | --- | --- |
| native revision id / accepted source hash | Host immutable revision 与 source 内容身份 | acceptance CAS、restore 与 recovery |
| workspace digest | 在线 Yjs 工作层摘要 | 工作编辑 CAS |
| observed filesystem hash | Host 观察到的手工文件候选 | 外部协调输入 |
| Git mirror commit | 可选 best-effort mirror 的外部 ID | 从不决定 acceptance 或 recovery |

浏览器、MCP 和 Agent 的写入顺序相同：

1. 服务器解析认证主体、project membership 与短期 capability；调用方不能提交 actor、路径或凭据。
2. 编辑进入共享 Yjs 工作层；它不是已接受 source。
3. `AuthoringCoordinator` 在 project session queue 中重新核对 accepted revision、source hash、workspace digest、文档向量与 capability。
4. Core 编译完整候选；通过后 native revision content store 与 revision-head CAS 接受完整 bundle。
5. 可选 Git mirror 仅在 acceptance 后导出；失败写入 mirror 状态但绝不撤销 revision。`.nova/**`、cache、responses、journals、Yjs、SQLite、output 与 derived 工件永不进入 authoring bundle。

Agent 先产生 Host 保存的提议，直到用户显式 apply 才会申请服务器能力并排入 session。人在编辑时，Agent 生成或应用会暂停；向量过期必须重新规划。

## 三种角色：外部 MCP Agent / 内置 Agent / Browser

不要把三者当成同一个“Agent”。**外部 MCP Agent** 是主要 authoring 通道（自带文本，Host 只验证与应用）；**内置 Agent** 是单文档 proposal 助手（Host 跑 provider 生成 span-diff，人工显式 apply）；**Browser** 是次要人工控制台。真正场景产能来自 Core 渲染管线（`nova_render` 的 Pass1/Pass2）与外部 Agent 自带文本——**Browser 与内置 Agent 都不是主产能**。

Host 对外使用自己的 MCP registry（`createProjectSessionMcpRegistry` / `createAdminMcpRegistry`，挂载于 `/mcp/projects/:projectId` 与 `/mcp/admin`），**不是** `packages/cli/src/mcp-server.ts` 的 8 工具 Host-bound seam（`createHostBoundMcpTools`，当前仅 CLI 测试消费）——不要把 seam 描述成 Workbench MCP 全貌。

### 外部 MCP Agent —— 主要 authoring 通道（真实可达，三个缺口）

- 连接 `/mcp/projects/:projectId`（Streamable HTTP），Bearer device credential（owner 配对，`wbd_`）或 browser-session capability token。Host **从不为 MCP 通道运行 provider**：`nova_authoring_document_edit` 的 `replacementText/edits` 由 caller 自带，Host 只做三重 CAS 验证（accepted-hash + workspace-digest + state-vector）并写入 Yjs working layer。
- 闭环：edit（working layer）→ `nova_authoring_submit`（native revision acceptance）→ `nova_render`（场景产能）；冲突/恢复经 `nova_operation_get`、`nova_authoring_conflict_read`、`nova_conflict_resolve`、`nova_revision_restore`。
- **MCP submit 不强制人审**：持有 `mcp:author` + `mcp:submit` scope 的 device 可完全自主 edit→submit（submit 门 = `submitBlockReason` + accepted-hash/workspace-digest CAS + capability scope，无人工审批门）；冲突也可经 `nova_conflict_resolve` 自解。“人工介入”只是角色策略（submit 要求 maintainer scope），不是架构强制门。
- 三个缺口（真实 registry vs typed client/CLI）：
  - 协议 catalog（`MCP_TOOL_CATALOG_V1`）仍声明 `nova_graph` / `nova_revise` / `nova_render_tree`（含 input schema），但 Host registry **没有这三个 handler**——外部客户端调用返回 `TOOL_NOT_FOUND`；typed `WorkbenchClient.graph()/revise()/renderTree()` 与 via-workbench 模式的 CLI `nova graph/revise/render-tree` 同样没有宿主实现。
  - via-workbench CLI 没有 submit：`nova source apply` 只经 `nova_authoring_document_edit` 写 **working layer**，typed client 止于 `authoringDocumentEdit`，无 submit 方法、无 authoring 命令组——改完无法发起 acceptance。
  - `nova_validate` 只校验 **accepted source**（无 accepted source 时返回 `NO_ACCEPTED_SOURCE`），ISS 只在 `nova_validate` 返回（`{ passed, iss, results }`）；`nova_status` 只返回 `{ projection, status: getProjectStatus(...) }`，不含 ISS、guidance、nextActions——后两者在 ReportWriter 侧存在但未暴露，agent 主循环没有机器可读指令层。

### 内置 Agent —— 单文档 proposal 助手（不构成自主产能）

- 经 `browser-agent-api.ts` 的 proposal/apply 两个 POST 路由（browser-session 认证，无 daemon/CLI/MCP 路径）。一次请求 = **单次 provider 调用**，产出绑定 baseVector 的**单文档 span-diff proposal**（文档 ≤ 64k 字符、指令 ≤ 4k、单 change ≤ 8,192 字符、≤ 256 changes），生成期零写入。
- **proposal → explicit apply**：proposal 只存 Host 内存 Map（重启失效）；用户显式 Apply 时才签发 capability，经 `AgentCommandService`（capability gate + presence generation 原子复核 + vector CAS）写入 Yjs working layer——不写 accepted source、不写 Git。
- **无自主 loop**：唯一 LLM 调用是同步 HTTP 请求内的一次 `generate()`；client 契约中的 queued/streaming 状态 Host 从不返回（design-only）。
- **project-wide presence pause 风险**：生产接线 `presence: { isHumanEditing: () => session.hasHumanPresence }`，而 `HUMAN_PRESENCE_SURFACES = ['browser', 'mcp', 'yjs']`——任何已连接表面（含请求者自己的编辑器）都会让 generate/apply 返回 `paused`。AgentDrawer 本身要求一个已连接文档的选中，因此内置 Agent 在其唯一设计的交互流中**自我暂停**；`edit-service` 提供文档/场景粒度的 presence tracker 注入点，但无人接线（design-only）。

### Browser —— 次要人工控制台

- 只消费 secret-free DTO；渲染 surface 为 project-home / graph-route / source-studio / scene-canvas。
- 文档生命周期 agent-owned：浏览器无 document create/move/delete 路由（MCP 有）；Review Hub / Publication 导航不渲染。
- 人工作用：AgentDrawer 路径强制人工 apply；MCP device 路径无此强制。内置 Agent 依赖浏览器会话，MCP authoring 工具完全绕过内置 Agent。

### ReviewComment 无 producer

Core 的 `addReviewComment` / `replaceReviewComment` / `updateReviewComment` 已导出且消费侧已接线（`renderNovel` 装载 review comments、`reviewIds` 注入 revision prompt、feedbackHashes 进 cache identity），但 **workbench / cli / node-host 零调用**：无 `nova_review_*` MCP 工具、无 CLI review 命令、无 UI 表面——没有任何人类或 agent 表面能创建一条 ReviewComment。ledger 是单个可变 CAS JSON 文档（非 append-only 历史），且 review 不进 Git mirror bundle。

## 外部文件协调与冲突处理

当 Host 观察到项目根上的手工编辑时，它将完整候选存入 Host 私有 staging，不会直接改写 accepted revision。只有下列条件同时满足，才能执行 external reconciliation：

- 候选 manifest 完整且有效；
- 每个 authoring 路径的字节与候选完全一致；
- 候选遗漏的 baseline authoring 路径显式删除；
- 接受前再次核验候选、working digest 与 native revision-head CAS。

否则 Host 保留手工内容并报告 conflict；它绝不 reset、覆盖或部分接纳 primary 工作树。恢复步骤：

1. 在 Browser Source Studio 或 MCP 读取当前 accepted revision/source hash、workspace digest、operation receipt 和 external candidate 状态。
2. 保留需要的手工文本到新的 working 编辑，或在项目外备份；不要绕过运行中的 Host 修改 accepted revision。
3. 修复 YAML/source 诊断并基于最新 accepted identity 提交 reconcile；CAS stale 时先重新读取再重试。
4. Git mirror 可在 Host 停止时人工检查，但它不是 recovery 前提。

## 操作错误参考

| 代码 / 状态 | 含义 | 操作 |
| --- | --- | --- |
| `WORKSPACE_STALE` | Yjs 工作层、文档向量或候选摘要已变 | 重新读取，重新应用编辑或重新生成提议。 |
| `ACCEPTED_HASH_MISMATCH` | 另一个提交已改变 accepted source | 刷新 source 与工作层，再基于新 hash 提交。 |
| `CANDIDATE_INVALID` | 完整候选未通过 Core/source 验证 | 修复返回的 YAML/source 诊断；不要绕过 Host 的 native revision acceptance。 |
| `CONFLICT_REQUIRES_RESOLUTION` | 外部文件候选无法与当前 accepted/working identity 精确协调 | 按上一节清理并显式 reconcile。 |
| `SUBMIT_BLOCKED` | 能力被撤销、过期、权限不足或 session gate 拒绝 | 重新认证/授权；不要复用 token。 |
| `DOCUMENT_NOT_FOUND` | 文档不在允许的作者 catalog | 先刷新 catalog；不能用原始路径代替 document id。 |
| `PROJECT_NOT_READY` | 项目 bundle 尚未开放或刚关闭 | 打开已配置项目，或按 `restart-required` 重启。 |
| `INVALID_INPUT` / `UNKNOWN_FIELD` | API version、CAS 字段或严格请求 shape 无效 | 只发送当前 contract 定义的字段。 |
| `restart-required` | 新 YAML 已保存，但当前进程捕获的运行配置仍旧 | 受控停止并重启 Host。 |

所有 operation/audit 读取都是无秘密的。出现 `INTERNAL` 时保留 operationId 和时间，检查 Host 日志与恢复 journal；不要把 token、credential、Git temporary index 或项目根粘贴到 issue。

## 验证清单

- Host：`npm run -w @novalistically/workbench test:host` 与 `typecheck:host`。
- Client：`npm run -w @novalistically/workbench test:client` 与 `typecheck:client`。
- Native revision、restore 与 recovery：`tests/authoring-coordinator-recovery.test.ts`、`tests/host-startup.test.ts`。
- Optional Git mirror boundary：`tests/git-runner.test.ts`、`tests/git-manifest.test.ts`。
- Browser 与 MCP/Agent authoring boundary：`tests/browser-agent-api.test.ts`、`tests/mcp-auth-registry.test.ts`。
- 根 `npm run test:e2e` **当前不可运行**：根 script 转发到 `npm run -w @novalistically/workbench test:e2e`，但 workbench 的 package.json **没有 `test:e2e` script**，也没有 `playwright.config.ts` 与 `tests/e2e/` harness（`tsconfig.e2e.json` include 的 `tests/e2e/**` 与 `playwright.config.ts` 均不存在，`typecheck:e2e` 实际是静默 no-op）；`@playwright/test` 仅是 devDep。

这些检查验证 Host 合约；live provider 输出仍需由部署环境的凭据和项目 source 决定。
