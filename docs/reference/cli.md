# CLI（命令行界面）

**源文件：** `packages/cli/src/index.ts`（命令定义）、`packages/cli/src/mcp-server.ts`（MCP 服务器）
**包：** `@novalistically/cli`
**二进制命令：** `nova`

## 安装

```bash
git clone <repo>
cd novalistically
npm install
npm run build          # 先构建 core，再构建 cli
npx nova --help        # 或全局链接
```
构建产物保持 YAML 依赖在 ESM bundle 外部；`packages/cli/tests/bundle-boundary.test.ts` 验证没有 dynamic-require wrapper，且 built CLI 的 `--help` 可启动。


## 命令

所有命令都使用 `commander` 库在 `packages/cli/src/index.ts` 中内联定义。

| 命令 | 描述 |
|---------|-------------|
| `project init <name>` | 创建 definitions/{characters,relationships,rules,locations,items,factions}、`chapters/chapter_01/E1.yaml`、scenes/、notes/、reference/、output/、reviews/、rejected_proposals/、.nova/{responses,derived,snapshots}，并写入 nova.yaml、state_initial.yaml（含 `day_0` 时间锚点）、PROJECT_STATUS.md 并 `git init`。E1 comments 展示 event-local `choices`；不再生成 `branches/branch_points.yaml`。 |
| `validate` | 通过 `validateNovel()` 运行全部 28 个内置验证器 + ISS 计算。`--strict` 打印 ISS gaps；`--event <id>` 只过滤显示单个事件的结果（验证器仍对全项目运行，随后从 `results` 中取该事件的 `ValidationResult`） |
| `status` | 显示项目状态摘要（事件数/已渲染/受阻、事件状态、线索进度），基于 `getProjectStatus()` |
| `migrate` | 通过 `migrateProjectFile()` 将 `nova.yaml` 迁移到最新 schema 版本 |
| `render [event]` | 完整 LLM 渲染（`renderNovel()`）。选择器三选一：位置参数 `[event]` / 可重复 `--scene <event>`、`--chapter <n>` 或 `--all`。`--dry-run` 用 `previewEditorialRun()` 只编译上下文；`--model` 覆盖模型；`--provider ai-sdk\|mock-pass2`（mock-pass2 必须带 `--reference-dir`）；`--trace` 在 `.nova/traces/` 写 JSONL；`--concurrency` 限制并发；`--branch-path '<json>'` 必须是完整 leaf `BranchPath`（`{ "decisions": [{ atEventId, choiceId, narrativeOrder }] }`）；`--discourse-branch`（默认 main）；`--actor`（默认 local-cli）；`--json` 输出核心 DTO。decision scene 的 accepted prose 由系统追加 deterministic `<!-- FABULA:PLAYER_CHOICES:v1 -->` + yaml 代码块；raw prose、Pass 2 和 response artifact 不含该 block。 |
| `revise [event]` | 基于 open review 反馈修订 accepted prose（`renderNovel()` + `revision`）。选择器同 `render`；`--review <id>` 应用指定 open review（可重复）；`--instruction <text>` 内联修订指令 |
| `render-tree` | 通过 `renderGameDialogueTree()` 渲染所有 event-local game-tree node 一次；拒绝 surface scheduling（render-tree 不支持 renderSurface 调度）。只有所有节点 accepted 时写 `output/dialogue-tree.md`（publication scope 固定为 main discourse ledger），从不写 `output/novel.md`。支持 `--model`、`--provider`、`--reference-dir`、`--trace`、`--concurrency`、`--actor`。注意：虽然 Commander 声明了 `--discourse-branch`，但处理函数从不读取它（`RenderGameDialogueTreeRequestV1` 也不含该字段），树发布被刻意哈希到 main discourse scope——该选项实际是无效的 |
| `assemble` | 将线性项目或 `--branch-path '<json>'` 选择的完整 leaf route 组装到 `output/novel.md`：无 `--output` 时用 `assembleCanonicalNovel()`，有 `--output <path>` 时用 `assembleCustomNovel()`；`--discourse-branch` 选择话语分支。游戏树项目必须传完整 leaf branch path。 |
| `entity list [kind]` | 按类型筛选列出实体；`--status` 按渲染状态（draft\|rendered\|blocked\|needs_review）筛选事件 |
| `entity show <id>` | 显示实体详情、状态和定义文件路径 |
| `scene list` | 列出所有 scene 的检查状态；`--status`（missing\|current\|stale\|manual_change_untracked\|legacy_unverified）、`--chapter <n>`、`--json` |
| `scene show <eventId>` | 显示单个 scene 的详细检查结果 |
| `scene history <eventId>` | 显示 scene 的修订历史 |
| `scene adopt <eventId>` | 评估并采纳替换/工作副本散文；`--file <path>` / `--prose <text>`、`--lock`、`--note`、`--model`、`--provider`、`--reference-dir`、`--branch-path`、`--discourse-branch` |
| `scene lock <eventId>` / `scene unlock <eventId>` | 锁定/解锁 scene 以防止编辑 |
| `scene rollback <eventId> <revisionId>` | 回滚到指定修订版本 |
| `review <action> [targetId] [message]` | 管理已渲染场景的审阅评论。Actions: `list`、`add`、`replace`、`resolve`、`wontfix`、`reopen`、`escalate`。`--severity`（add 用：info\|warning\|blocking，默认 warning）、`--category`（默认 style）、`--actor`、`--json`。 |
| `trace event <eventId>` / `trace stats` | 检查 `.nova/traces/` 中的管道 trace：单事件 trace 或聚合统计 |
| `diff [event]` | 通过 `diffEvent()` 显示某事件的世界状态变化（前后对比） |
| `diff --project <path>` | 通过 `analyzeProjectImpact()` 比较当前项目 YAML 与另一版本，按影响等级（Red/Yellow/Green）分类事件变更。`--json` 输出机器可读格式 |
| `verify` | 验证所有缓存 scene 的证据链（evidence chain），`--json` 输出 |
| `commit` | 仅调用 `initializeProject()` 加载项目（返回的临时 `StateManager` 被丢弃）：`StateManager.initialize()` 只把事件载入内存 `EventStore`，不提交事件、不写快照、不持久化任何状态 |
| `graph` | 导出因果边 DAG 可视化。`--format mermaid` 或 `--format dot`（默认），使用 `exportDAGtoMermaid()` / `exportDAGtoDOT()` |
| `source list` / `source show <path>` / `source preview <path>` | 管理项目源文档：列出、显示、预览替换（`--file <path>` 必填，返回 `SourceChangePreviewV1`） |
| `source apply <preview>` | 应用 `SourceChangePreviewV1` JSON 文件 |
| `source reconcile` | 对外部工作副本的合法编辑做版本化（version） |
| `operation list` / `operation show <operationId>` | 检查编辑化操作日志；`--limit`（默认 20）、`--json` |
| `bench` | 通过 `@novalistically/bench` 运行基准测试。`--regression` / `--performance` 只运行对应子集；两者都不传时运行 `runAll()`（回归 + 变体 + 外部数据集 + 性能）并写盘 |

## MCP 服务器

`packages/cli/src/mcp-server.ts` 提供了一个 Model Context Protocol 服务器，用于在 Cursor、Windsurf 等代码助手内集成 AI 代理。`createMCPServer(projectPath)` 返回兼容 MCP 的工具字典（当前 **32 个工具**），分为三组：

**保留的位置参数工具（10）：**

- `nova_status` — 完整项目状态报告，包含 ISS、验证错误、线索快照、渲染队列、阻碍因素和按优先级排序的下一步行动
- `nova_validate` — 运行验证器；可选 `eventId` 仅过滤显示该事件的结果（验证仍对全项目执行，随后从 `results` 中取该事件）
- `nova_iss` — 获取 ISS 评分维度
- `nova_read_state` — 读取当前世界状态的摘要（非回放后的 `WorldState`）：实体级别返回 `showEntity()` 的注册表/定义状态加硬编码的空 knowledge 列表；项目级别返回实体元数据、线索计数器和事件状态
- `nova_thread_status` — 线索进度，可选择按 ID 筛选
- `nova_render` — 预演：编译 context；可选完整 story `BranchPath` 与 discourse branch
- `nova_render_scene` — 完整的 LLM 渲染 + 输出写入；可选 `model`、`BranchPath`、discourse branch
- `nova_render_tree` — 渲染所有 event-local game-tree node，返回 compiled tree、YAML-derived choices 与 dialogue-tree artifact
- `nova_render_batch` — 批量渲染（`MCPBatchRenderInput`：eventIds、operationId/actorId、model、profile、batchSize/windowSize、branchPath）
- `nova_assemble` — 从已渲染场景组装线性或 selected-route novel；可选 `outputPath`、`BranchPath`、discourse branch

**审阅工具（5，向后兼容）：**

- `nova_review_list` — 列出审阅评论，可按 status/severity/eventId 过滤
- `nova_review_add` — 添加评论（位置参数或对象输入）
- `nova_review_resolve` / `nova_review_reopen` / `nova_review_escalate` — 按 commentId 解析/重开/升级评论

**对象输入工具（17）：**

- `nova_workspace_get` — 获取编辑化工作区快照
- `nova_source_list` / `nova_source_get` / `nova_source_preview` / `nova_source_apply` — 源文档管理
- `nova_review_replace` — 替换评论内容；`nova_review_status` — 按 action 更新评论状态
- `nova_batch_render` — 批量渲染（与 `nova_render_batch` 等效的对象输入形式）
- `nova_revise` / `nova_batch_revise` — 基于 open review / 指令的修订渲染
- `nova_scene_list` / `nova_scene_show` / `nova_scene_adopt` / `nova_scene_set_lock` / `nova_scene_history` / `nova_scene_rollback` — scene 检查与修订管理
- `nova_operation_get` — 查询编辑化操作

所有 MCP 工具的结果以结构化 JSON 格式输出。只有 `nova_status` 的结果包含面向 LLM 代理的中文引导文本（`ReportWriter.toStatusReport()` 的 `guidance` 字段）；其余工具直接返回各自的 DTO。旧名称 `nova_render`、`nova_render_scene`、`nova_render_tree` 保持不变。

## 使用示例

```bash
# 创建新项目
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
```
