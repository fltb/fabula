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
| `project init <name>` | 创建 definitions/、`chapters/chapter_01/E1.yaml`、scenes/、.nova/ 和启动配置。E1 comments 展示 event-local `choices`；不再生成 `branches/branch_points.yaml`。 |
| `validate` | 通过 `ResultAggregator.validateAll()` + ISS 计算运行全部 18 个验证器。`--strict` 强制执行 ISS 阈值；`--event <id>` 验证单个事件 |
| `render <event>` | 完整的两轮 LLM 渲染。`--all` 渲染 selected route 的 authored EventFile；`--branch-path '<json>'` 必须是完整 leaf `BranchPath`。decision scene 的 accepted `.md` 由系统追加 deterministic `FABULA:PLAYER_CHOICES:v1` YAML block；raw prose、Pass 2 和 response artifact 不含该 block。`--dry-run` 只编译上下文；`--model` 覆盖模型。离线 deterministic run 必须显式传 `--provider mock-pass2 --reference-dir <approved-reference-data>`。 |
| `render-tree` | 通过 `renderGameDialogueTree()` 渲染所有 event-local game-tree node 一次；拒绝 surface scheduling 和非 `main` discourse ledger。只有所有节点 accepted 时写 `output/dialogue-tree.md`，从不写 `output/novel.md`。支持 `--model`、`--provider`、`--reference-dir`、`--trace`、`--concurrency`。 |
| `assemble` | 通过 `assembleNovel()` 将线性项目或 `--branch-path '<json>'` 选择的完整 leaf route 组装到 `output/novel.md`；`--output` 指定自定义路径。 |
| `entity list [kind]` | 按类型筛选列出实体；`--status` 按渲染状态筛选事件 |
| `entity show <id>` | 显示实体详情、状态和定义文件路径 |
| `diff <event>` | 通过 `diffEvent()` 显示某事件的世界状态变化（前后对比） |
| `diff --project <path>` | 通过 `analyzeProjectImpact()` 比较当前项目 YAML 与另一版本，按影响等级（Red/Yellow/Green）分类事件变更。`--json` 输出机器可读格式 |
| `commit` | 通过 StateManager 提交当前状态（遍历所有事件） |
| `graph` | 导出因果边 DAG 可视化。`--format mermaid` 或 `--format dot`（默认），使用 `exportDAGtoMermaid()` / `exportDAGtoDOT()` |
| `review <action>` | 管理已渲染场景的审阅评论。Actions: `list`、`add`、`resolve`、`reopen`、`escalate`。重新打开会使渲染缓存失效 |
| `bench` | 通过 `@novalistically/bench` 运行回归和性能基准测试。`--regression` / `--performance` 运行子集 |

## MCP 服务器

`packages/cli/src/mcp-server.ts` 提供了一个 Model Context Protocol 服务器，用于在 Cursor、Windsurf 等代码助手内集成 AI 代理。`createMCPServer(projectPath)` 函数返回兼容 MCP 的工具：

- `nova_status` — 完整项目状态报告，包含 ISS、验证错误、线索快照、渲染队列、阻碍因素和按优先级排序的下一步行动
- `nova_validate` — 运行验证器，可选择仅针对单个事件
- `nova_iss` — 获取 ISS 评分维度
- `nova_read_state` — 读取当前世界状态（实体级别或项目级别）
- `nova_thread_status` — 线索进度，可选择按 ID 筛选
- `nova_render` — 预演：编译 context；可选完整 story `BranchPath`
- `nova_render_scene` — 完整的 LLM 渲染 + 输出写入；可选完整 story `BranchPath`
- `nova_render_tree` — 渲染所有 event-local game-tree node，返回 compiled tree、YAML-derived choices 与 dialogue-tree artifact
- `nova_assemble` — 从已渲染场景组装线性或 selected-route novel；可选完整 story `BranchPath`

所有 MCP 工具的结果以结构化 JSON 格式输出，并包含面向 LLM 代理的中文引导文本。

## 使用示例

```bash
# 创建新项目
nova project init my-novel

# 验证
cd my-novel
nova validate

# 渲染场景
nova render E1

# 检查状态
nova status

# 查看 DAG
nova graph --format mermaid
```
