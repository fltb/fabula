# CLI（命令行界面）

**源文件：** `packages/cli/src/index.ts`（命令定义）、`packages/cli/src/mcp-server.ts`（8 工具 Host-bound seam，**不是** Workbench 使用的 registry）、`packages/cli/src/workbench-client.ts`（typed via-workbench MCP 客户端）、`packages/cli/src/route.ts`（branch/discourse route 解析）
**包：** `@novalistically/cli`
**二进制命令：** `nova`

## 安装

```bash
git clone <repo>
cd novalistically
npm install
npm run build          # 构建全部工作区（core → node-host → bench → workbench-protocol → cli → workbench）
npx nova --help        # 或全局链接
```
`packages/cli/tests/bundle-boundary.test.ts` 验证：CLI/bench dist 无 dynamic-require wrapper、CLI dist 不内嵌 `@novalistically/core`（保持外部 import）、built CLI 的 `--help` 可启动、MCP bundle 不含 commander/`parseAsync`/`resolveRoute`。


## 命令

所有命令都使用 `commander` 库在 `packages/cli/src/index.ts` 中内联定义。

| 命令 | 描述 |
|---------|-------------|
| `project init <name>` | 在 `./<name>` 创建最小有效 authoring 拓扑：`nova.yaml`（`defaultModel: mock`）、`definitions/state_initial.yaml`、`definitions/entity-types.yaml`、`definitions/characters/narrator.yaml`、`definitions/discourse-ledger.yaml`、`chapters/chapter_01/_chapter.yaml` 与 `E1.yaml`。**不创建 Git 历史**，也不生成 scenes/、notes/、output/、reviews/ 或 .nova/ 目录。 |
| `validate` | 通过 `validateNovel()` 对当前目录 source snapshot 运行全部 28 个内置验证器 + ISS 计算。`--event <id>` 只过滤显示单个事件的结果（验证器仍对全项目运行，随后从 `results` 中取该事件的 `ValidationResult`）；`--json` 输出机器可读结果；未通过时退出码为 1。 |
| `status` | 显示项目状态摘要（事件数/已渲染/受阻、事件状态、线索进度），基于 `getProjectStatus()`；`--json`。 |
| `entity list [kind]` | 列出实体，可按 kind 筛选，返回 `EntitySummary[]`；`--json`。 |
| `entity show <id>` | 显示实体详情，返回 `EntityDetail \| null`；`--json`。 |
| `graph` | 导出因果边 DAG 可视化。`--format mermaid` 或 `--format dot`（默认），使用 `inspectProjectGraph()` + `exportDAGtoMermaid()` / `exportDAGtoDOT()`。 |
| `source list` | 列出当前 source snapshot 的文档（logicalPath、contentHash、diagnostics）。 |
| `source show <logicalPath>` | 打印指定源文档的原始内容。 |
| `source preview <logicalPath> <contentFile>` | 对候选内容运行 `previewSourceChange()`，返回 `SourceAnalysisV1`（affectedEventIds、diagnostics）。 |
| `source apply <logicalPath> <contentFile>` | 先预览；无 error 级诊断时经 `FileProjectSourceWriter.apply()`（source-hash CAS）写入变更。 |
| `render [eventId]` | 完整 LLM 渲染（`renderNovel()`）。选择器三选一：位置参数 `[eventId]` / `--all` / `--chapter <n>`；`--dry-run` 用 `previewEditorialRun()` 只编译上下文；`--provider ai-sdk\|mock-pass2`（默认 ai-sdk；mock-pass2 必须带 `--reference-dir`）；`--branch-path '<json>'` 必须是完整 leaf `BranchPath`（`{ "decisions": [...] }`）；`--discourse-branch <name>`；`--json` 输出核心 DTO。存在 editorial errors 或有 scene 未 release 时退出码为 1。 |
| `revise [eventId]` | 修订渲染（`renderNovel()` + `revision`）。选择器同 `render`；`--instruction <text>` 内联修订指令。 |
| `render-tree` | 通过 `renderGameDialogueTree()` 渲染所有 event-local game-tree node 一次，返回 `RenderGameDialogueTreeResult`（compiled tree、逐 scene 结果与 publication）。`--provider mock-pass2` 与 `--reference-dir` 必填；`--json`。有错误或有 scene 未 release 时退出码为 1。 |

## Workbench authority mode

`--mode standalone`（默认）使用 Node Host adapters。写入 source 时它会先检查 Workbench authority lease，已运行的 Host 会拒绝直接写入。`--mode via-workbench --project <id> --host <url>` requires an opaque device credential and sends every operation to `/mcp/projects/<id>`; it does not load project files or provider credentials locally.

via-workbench 模式的命令经 typed `WorkbenchClient` 代理到 Host 的 project MCP registry：`source list/show/preview` 走只读工具，`source apply` 走 `nova_authoring_document_edit`，`render`/`revise`/`render-tree`/`graph` 走对应 `nova_*` 工具。**typed client/CLI 没有 submit 命令**：via-workbench 的 `source apply` 只写共享 working layer，不会发起 native revision acceptance（见下方缺口）。

Typed `WorkbenchClient.render()` may include `referenceChunks: readonly { referenceId; chunkId }[]`. These are selectors, not quotes or object paths. The Host requires `mcp:reference:read`, revalidates the queued capability, resolves the chunks inside the operation, and supplies Core a bounded non-authoritative packet.

## MCP 三个表面

仓库里的 “MCP” 出现在三个互不相同的表面，不要把三者混为一谈：

1. **独立 CLI（standalone）** — `nova` 直接读项目文件、调用 Core/Node Host adapters，不经任何 MCP 传输。
2. **typed WorkbenchClient（via-workbench）** — `packages/cli/src/workbench-client.ts` 的 JSON-RPC 2.0 over Streamable HTTP 客户端，把 CLI 命令代理到 Host 的 `/mcp/projects/<id>`；不含文件系统或 Core adapters，每个操作都经 Host 认证。
3. **真实 Workbench MCP registry** — Host 端 `packages/workbench/src/host/mcp/registry.ts` 的 `createProjectSessionMcpRegistry()`（project family）与 `createAdminMcpRegistry()`（admin family），挂载在 `/mcp/projects/:projectId` 与 `/mcp/admin`。外部 MCP 客户端实际连到的就是这一套工具。

### CLI 的 Host-bound seam（8 工具，不是 Workbench registry）

`packages/cli/src/mcp-server.ts#createHostBoundMcpTools(context)` 是 **8 工具的 Host-bound seam**（旧 `mcp-server` 的延续），**当前 Workbench Host 不使用它**：Workbench 自带 registry（`createProjectSessionMcpRegistry`）。调用方需注入 `HostBoundMcpContext`：

- `currentSource: () => ProjectSourceSnapshotV1` — 已打开的不可变 source projection
- `runtime: EditorialRuntime` — 显式语义运行时（含 `services`）
- `actorId: string` / `allocateOperationId: () => string` — 本地 mutation 身份，由 host 注入，**从不接受客户端提供的** actor/operationId
- `render?: typeof renderNovel` — 可选的 host 级渲染 seam，缺省用 Core `renderNovel`

seam 的 8 个工具（结构化 JSON 输出）：`nova_status`、`nova_validate`、`nova_source_list`、`nova_source_get`、`nova_source_preview`、`nova_entity_get`、`nova_entity_list`、`nova_render`（只接受 `sceneSelector` + `model`，其余字段按未知拒绝，fail closed）。不要把这一 seam 描述成 Workbench MCP 全貌。

### 真实 Workbench MCP registry 的工具（外部客户端实际可见）

project family 按 scope 分组：

- **只读（mcp:read）** — `nova_status`、`nova_validate`、`nova_source_list`、`nova_source_get`、`nova_source_preview`、`nova_entity_get`、`nova_entity_list`、`nova_revision_list`、`nova_revision_get`、`nova_revision_diff`
- **渲染（mcp:render）** — `nova_render`
- **reference（mcp:reference:read / write）** — `nova_reference_list`、`nova_reference_get`、`nova_reference_search`、`nova_reference_chunk_get`、`nova_reference_content_read`；`nova_reference_import_begin`、`nova_reference_import_chunk`、`nova_reference_import_commit`、`nova_reference_job_get`、`nova_reference_retry`、`nova_reference_delete`
- **authoring（mcp:author）** — `nova_authoring_document_list`、`nova_authoring_document_read`、`nova_authoring_document_edit`、`nova_authoring_document_create`、`nova_authoring_document_move`、`nova_authoring_document_delete`、`nova_authoring_status`
- **submit（mcp:submit）** — `nova_authoring_submit`、`nova_operation_get`、`nova_authoring_conflict_read`、`nova_conflict_resolve`、`nova_revision_restore`
- **admin family（仅 owner，mcp:admin）** — `nova_admin_config_*`、`nova_admin_project_*`、`nova_admin_membership_*`、`nova_admin_invite_*`、`nova_admin_device_*`、`nova_admin_operation_*`

这是外部 MCP agent 的主要 authoring 闭环：

1. `nova_authoring_document_list` → `nova_authoring_document_read` → `nova_authoring_document_edit` / `create` / `move` / `delete` 写入共享 Yjs working layer；每个写工具都带 `expectedWorkspaceDigest` / `expectedAcceptedSourceHash` / `expectedStateVectorHash` CAS，写的是 **working layer**，不是 accepted source。
2. `nova_authoring_status` 观察 `canSubmit` / `submitBlockReason`。
3. `nova_authoring_submit` 经 `AuthoringCoordinator` 发起 native revision acceptance。
4. `nova_operation_get`（operation receipt）、`nova_authoring_conflict_read` / `nova_conflict_resolve`（冲突）、`nova_revision_list` / `get` / `diff` / `restore`（revision）处理提交后的跟踪与恢复。

参考工具（`nova_reference_*`）用于外部语料导入与 `nova_render` 的 `referenceChunks` 引用选择。

### 能力 / credential bootstrap

两种认证（`packages/workbench/src/host/mcp/auth.ts`）：

- **browser mode** — live session（`x-fabula-session`）+ AgentCapabilityService 签发的 opaque capability token（Bearer）。token 必须与 session 用户、项目、scope 精确匹配，否则 `USER_MISMATCH` / `SCOPE_MISMATCH`。
- **device mode** — owner 配对的 one-time device credential（`wbd_` 前缀；先经 `wbp_` pairing code 一次性兑换，TTL ≤ 90 天，持久层只存 SHA-256 hash，Host 重启不失效）。credential 自带 scope grant，actor 恒为 issuing owner，仅 owner 可配对。

Scope → 项目角色：`mcp:read` / `mcp:render` → reader；`mcp:author` → author；`mcp:submit` → maintainer；`mcp:admin` → owner（仅 device / admin route）。

### 已知缺口（2026-08-05 审计确认）

- 协议 catalog（`MCP_TOOL_CATALOG_V1`）仍声明 `nova_graph`、`nova_revise`、`nova_render_tree`（含 input schema），但 **Workbench registry 没有这三个 handler**：via-workbench 模式下 `nova graph`、`revise`、`render-tree` 会收到 `TOOL_NOT_FOUND`。typed `WorkbenchClient.graph() / revise() / renderTree()` 同样没有宿主实现。
- via-workbench 的 `source apply` 只经 `nova_authoring_document_edit` 写 **working layer**，不发起 acceptance；typed client 与 CLI 都没有 submit 命令。
- Workbench registry 的 `nova_validate` 只校验 **accepted source**（无 accepted source 时返回 `NO_ACCEPTED_SOURCE`），ISS 只在 `nova_validate` 返回（`{ passed, iss, results }`）；`nova_status` 只返回 `{ projection, status: getProjectStatus(...) }`，**不含 ISS**，也不含 ReportWriter 的 guidance / nextActions（两者均未暴露）。

旧的 32 工具清单（`nova_iss`、`nova_read_state`、`nova_thread_status`、`nova_render_scene`、`nova_render_batch`、`nova_assemble`、`nova_review_*`、`nova_scene_*` 等）已从 CLI seam 与 Workbench registry 双双移除，不得再出现在使用指南中。

## 使用示例

```bash
# 创建新项目（不创建 Git 历史）
nova project init my-novel

# 验证
cd my-novel
nova validate

# 渲染场景
nova render E1

# 渲染整章 / 全部分支所需事件
nova render --chapter 1
nova render --all

# 检查状态
nova status

# 查看 DAG
nova graph --format mermaid

# 源文档预览与应用（source-hash CAS 写入）
nova source preview definitions/characters/narrator.yaml draft.yaml
nova source apply definitions/characters/narrator.yaml draft.yaml
```
