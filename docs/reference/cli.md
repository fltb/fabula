# CLI（命令行界面）

**源文件：** `packages/cli/src/index.ts`（命令定义）、`packages/cli/src/mcp-server.ts`（Host-bound MCP 工具注册）、`packages/cli/src/route.ts`（branch/discourse route 解析）
**包：** `@novalistically/cli`
**二进制命令：** `nova`

## 安装

```bash
git clone <repo>
cd novalistically
npm install
npm run build          # 构建全部工作区（core → node-host → bench → cli → workbench）
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

Typed `WorkbenchClient.render()` may include `referenceChunks: readonly { referenceId; chunkId }[]`. These are selectors, not quotes or object paths. The Host requires `mcp:reference:read`, revalidates the queued capability, resolves the chunks inside the operation, and supplies Core a bounded non-authoritative packet.

## MCP 服务器

`packages/cli/src/mcp-server.ts` 提供 **Host-bound 的 MCP 工具注册**：`createHostBoundMcpTools(context)` 返回 8 个显式工具（`readonly HostBoundMcpTool[]`）。CLI 侧注册不拥有路径、存储、凭据或传输；调用方（Host，如 Workbench）注入 `HostBoundMcpContext` 并负责提供已认证的传输：

- `currentSource: () => ProjectSourceSnapshotV1` — 已打开的不可变 source projection
- `runtime: EditorialRuntime` — 显式语义运行时（含 `services`）
- `actorId: string` / `allocateOperationId: () => string` — 本地 mutation 身份，由 host 注入，**从不接受客户端提供的** actor/operationId
- `render?: typeof renderNovel` — 可选的 host 级渲染 seam，缺省用 Core `renderNovel`

工具清单（全部结构化 JSON 输出）：

- `nova_status` — 完整项目状态：`getProjectStatus()` 结果 + ISS 快照（内部先运行 `validateNovel()`）
- `nova_validate` — 运行验证器，返回 `NovelValidationResult`
- `nova_source_list` — 列出源文档（`listSourceDocuments()`）
- `nova_source_get` — 按 `logicalPath` 取源文档（`getSourceDocument()`）
- `nova_source_preview` — 预览 `changes`（`previewSourceChange()`）
- `nova_entity_get` — 按 `entityId` 显示实体（`showEntity()`）
- `nova_entity_list` — 列出实体，可选 `kind`（`listEntities()`）
- `nova_render` — 渲染指定 scene；只接受 `sceneSelector` + `model`，其余字段按未知拒绝（fail closed），mutation 身份来自注入的 `actorId`/`allocateOperationId`

旧的 32 工具清单（`nova_iss`、`nova_read_state`、`nova_thread_status`、`nova_render_scene`、`nova_render_tree`、`nova_render_batch`、`nova_assemble`、`nova_review_*`、`nova_scene_*`、`nova_operation_get` 等）已从当前实现移除，不得再出现在使用指南中。

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
