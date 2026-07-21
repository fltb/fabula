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
| `project init <name>` | 创建新的项目目录，包含 definitions/、chapters/、scenes/、.nova/ 目录结构、branch_points.yaml 模板、nova.yaml 配置和 state_initial.yaml |
| `validate` | 通过 `ResultAggregator.validateAll()` + ISS 计算运行全部 18 个验证器。`--strict` 强制执行 ISS 阈值；`--event <id>` 验证单个事件 |
| `render <event>` | 完整的 LLM 渲染管道（两轮：Pass 1 prose → Pass 2 结构化分析）。每轮输出分别写入 `scenes/chapter-NN/{eventId}.md`（prose）、`scenes/chapter-NN/{eventId}.yaml`（元数据）、`scenes/chapter-NN/{eventId}_render_request.yaml`（上下文）、`.nova/responses/{eventId}.json`（Pass 2 原始响应含 prose + 分析 artifact）。`--all` 渲染全部 authored event；`--dry-run` 只编译上下文；`--model` 覆盖模型。离线 deterministic run 必须显式传 `--provider mock-pass2 --reference-dir <approved-reference-data>`。mock 无 reference dir、未知 provider 或任一场未通过 release gate 都以非零退出。Release gate 要求：prose 非空、Pass 2 分析符合 schema、全部 18 个 validator 通过。全链验收使用项目配置的 `defaultSceneTextTarget`（默认无阈值；在 `nova.yaml` 中显式配置即生效，如祝福项目设为 400 narrative units），绝不允许低于该目标的烟雾阈值。当 `--all` 渲染所有 authored event 时，自动调用 assembleNovel() 生成 `output/novel.md`，每个场景恰好出现一次，验证文本计数完整性。`system:genesis` 从不参与 narrative 输出。 |
| `assemble` | 通过 `assembleNovel()` 将已提交的场景组装到 `output/novel.md`；`--output` 指定自定义路径 |
| `entity list [kind]` | 按类型筛选列出实体；`--status` 按渲染状态筛选事件 |
| `entity show <id>` | 显示实体详情、状态和定义文件路径 |
| `diff <event>` | 通过 `diffEvent()` 显示某事件的世界状态变化（前后对比） |
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
- `nova_render` — 预演：编译上下文但不调用 LLM
- `nova_render_scene` — 完整的 LLM 渲染 + 输出写入
- `nova_assemble` — 从已渲染场景组装小说
- `nova_review_*` — 列出、添加、解决、重新打开和升级审阅评论

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
