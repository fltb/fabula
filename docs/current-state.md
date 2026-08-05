# 当前系统状态（源码核验）

**时间**：2026-08-05 CST
**当前实现检查点**：`main` 当前工作树（native revisions、project-scoped MCP reference packet、optional Git mirror、`@novalistically/workbench-protocol` 共享协议；门禁结果见下表，非全绿）
**权威顺序**：当前源码、package manifests、可复现门禁结果；本页优先于历史计划、阶段报告和归档设计。

> 本页描述已经由源码或门禁证明的现状，不把设计目标、未接线类型或历史测量当作已交付能力。历史文档应保留其当时的证据与日期，并链接到本页，而不应改写历史。

## 已核验的工程基线

| 门禁 | 结果 |
|---|---|
| `npm test` | 通过：根 Vitest 2,970 tests、Workbench Host 522 tests、Workbench Client 93 tests |
| `npm run typecheck` | 通过 |
| `npm run typecheck:dead-code` | 通过 |
| `npm run build` | 通过 |
| `npm run bundle-check` | 通过 |
| `node scripts/check-public-api.mjs` | **失败**：public-api manifest 与源码导出漂移，且 `@novalistically/workbench-protocol` 未登记（manifest `.packages` 不含该包） |
| `npm run test:e2e` | **失败**：根脚本委托 `npm run -w @novalistically/workbench test:e2e`，但 workbench package 没有 `test:e2e` script |
| `npm run lint -- --max-diagnostics=2000` | 通过：Biome 0 errors、0 warnings |


## 包与依赖边界

工作区有六个包：

| 包 | 已核验职责 |
|---|---|
| `@novalistically/core` | 纯叙事语义：不可变 source-snapshot 分析、实体/图/状态计算、上下文、render 编排、验证、组装意图；也定义 bounded non-authoritative reference packets。仅依赖 `yaml` 和 `zod`。 |
| `@novalistically/node-host` | Node 适配器：filesystem source loader/writer、execution/state/cache/report repositories、AI SDK provider、plugin runtime 和可移植 reference object store。 |
| `@novalistically/bench` | 通过 Core 与 Node Host 运行回归、变体和性能基准；不是 Core 依赖。 |
| `@novalistically/cli` | `commander` CLI 与 typed Workbench MCP client；standalone 写入受 Host authority lease 保护，via-workbench 操作只走项目 scoped 的 authenticated Host route。 |
| `@novalistically/workbench` | 私有 native Host + browser client。Host 持有本地认证、Yjs、SQLite worker、ProjectSession、native immutable revisions 和 project-scoped reference library；浏览器只消费 secret-free DTO。可选 Git 仅镜像已接受 revision，不参与 authoring acceptance。 |
| `@novalistically/workbench-protocol` | 共享协议契约包：MCP 工具目录（`nova_*` 名与 scopes）、typed client contracts、configuration、authoring/host/reference DTO 与 device credential 常量。被 Workbench Host 与 CLI client 消费；仅 build/build:js/build:types 三个 script，无测试。 |

包关系不是一个可推导的线性链。Core 不依赖工作区包；Node Host 提供适配器；Bench、CLI 和 Workbench 按各自 manifest 直接选择 Core/Node Host 能力；`@novalistically/workbench-protocol` 是共享协议契约，被 Workbench Host 与 CLI client 消费，不依赖其他工作区包。

## Source、状态与渲染边界

- Core 输入是 `ProjectSourceSnapshotV1` 和注入的语义端口；source hash 表示内容，不是 Git 历史。
- Node Host 与 Workbench Host 才拥有文件与持久化；Workbench Host 的 native immutable revisions 是 authoring acceptance model，可选 Git 仅镜像已接受 revision。Workbench 只接受显式 `AuthoringManifest`，不得把 `.nova/**`、缓存、responses、journals、Yjs、SQLite、output 或 derived 工件纳入 authoring bundle。
- canonical render runtime 先编译 story/discourse 边界，再生成场景契约。`StateManager` 的内存快照是 recovery primitive；当前 `getCurrentState()` / `getStateAt()` 仍通过 `ReplayEngine` 重放，不能宣传为已接入的快照恢复加速。
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

- 生产 `AiSdkProvider` 在 `@novalistically/node-host`，默认 OpenAI-compatible base URL 为 `https://opencode.ai/zen/v1`，模型可由运行时配置或环境覆盖；CLI 不自动读取 `.env`。
- CLI 当前提供 validate/status/entity/graph/source/render/revise/render-tree/project-init 这一组 Host-bound 命令。不存在的历史命令或选项不能出现在使用指南中。
- Core 输出的是结构化 intents/records；文件写入由 Host repositories 负责。不要承诺 Core 直接写 `scenes/`、`.nova/responses/` 或 `.nova/derived/` 目录。

## 明确的产品与证据边界

- `SurfacePlanner` 只为已写场景规划 render groups / serial lanes；不会生成或写入 `NarrativeEvent`。这是 Core 不拥有 authoring 写入权的设计边界，不是移除后遗留的运行时承诺。
- `fixtures/zhu-fu/reference/` 是确定性的 mock/generated regression reference；live-provider 候选只能由凭据驱动的 `npm run smoke:stage1:live` 生成到独立 candidate 目录，并且仍需人工审阅后才可作为 live evidence。mock 参考不能被描述为人工或 live-LLM 证据。
- Dream of Red Chamber 当前 authored fixture 的可复现数量由 [`fixture-manifest.json`](../fixtures/dream-of-red-chamber/fixture-manifest.json) 定义。执行 `npm run count:drc -- fixtures/dream-of-red-chamber --check` 会核验四章、E01–E36（每章九个事件）和 source hash；80 章 corpus source 是独立 acquisition artifact，不能与该 fixture 混用。

## 当前产品接线边界（Agent-first 工作流）

2026-08-05 的[原始要求 / Agent-first 工作流符合度审计](./audits/original-requirements-agent-workflow-audit-2026-08-05.md)对 `docs/archive/PROJECT.md`（历史要求，不改写）做了源码核验，总体判定为**部分满足**：外部 MCP Agent 驱动的场景生产（render+accept）是真实可达的第一路径，但以下接线边界已核验成立（一句话证据；细节与行号见审计报告）：

| 边界 | 状态 | 一句话证据 |
|---|---|---|
| 外部 MCP Agent authoring | **可达** | `/mcp/projects/:projectId` Streamable-HTTP 端点 + 59 工具目录注册 56；edit→submit→render 闭环可达；产能来自 agent 自带文本，Host 不为 MCP 通道运行 provider |
| `nova_graph` / `nova_revise` / `nova_render_tree` Host handler | **缺失** | 三个名字只在工具目录、CLI client 与 CLI 命令中，`packages/workbench/src` 下 0 命中 → 每次调用返回 TOOL_NOT_FOUND |
| `nova_status` guidance / nextActions / ISS | **未暴露** | 仅返回 `{projection, status}`；workbench host/contracts 无 `guidance` 命中，无 next_actions 排序，ISS 无修复循环 |
| working-layer 验证 | **缺失** | `nova_validate` 只验证 accepted source；不存在“提交前验证未提交提案”的工具 |
| assembly 生产 caller | **无** | `canonicalAssemble`/`customAssemble`/`buildNovelDocument` 的全部调用点只在测试；生产 `buildPublication()` 返回 `outputPath:''`、`novelHash:null` |
| review producer | **无** | `addReviewComment` 等从 core barrel 导出但 workbench/cli/node-host 零调用；无 `nova_review_*` 工具，CLI 无 review 命令 |
| plugin Host activation | **未激活** | `PluginHooksManager`/`PluginLoader` 仅测试构造；生产运行中 `plugins/` 目录永不发现、永不激活 |
| 内置 Agent project-wide presence pause | **自锁** | `HUMAN_PRESENCE_SURFACES=['browser','mcp','yjs']`，AgentDrawer 要求的已连接文档使请求者自身 presence → generate/apply 返回 paused |

## 文档解释规则

- **current reference**：本页、`docs/architecture.md` 与 `docs/reference/` 中被标为当前的页面；必须与当前源码同步。
- **historical record**：`docs/archive/`、有日期的 audits/reports、阶段测量与竞品快照；保留原结论和日期，增加到本页的指针并显式标记不代表当前实现。
- **design-only / unverified**：未来协议、未接线 schema 或未经 live LLM 复核的宣称；必须明确为设计或未验证，不能写成运行时保证。

相关入口：[`架构`](./architecture.md)、[`完整接线图`](./reference/wiring.md)、[`API`](./reference/api.md)、[`YAML 合同`](./reference/yaml-contract/README.md)、[`历史归档`](./archive/README.md)、[`Agent-first 工作流审计 2026-08-05`](./audits/original-requirements-agent-workflow-audit-2026-08-05.md)。
