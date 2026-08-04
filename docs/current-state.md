# 当前系统状态（源码核验）

**时间**：2026-08-04 CST
**当前实现检查点**：`main` 的 `5c73aab`（native revisions、project-scoped MCP reference packet 与 optional Git mirror；全量门禁需在后续基线重跑）
**权威顺序**：当前源码、package manifests、可复现门禁结果；本页优先于历史计划、阶段报告和归档设计。

> 本页描述已经由源码或门禁证明的现状，不把设计目标、未接线类型或历史测量当作已交付能力。历史文档应保留其当时的证据与日期，并链接到本页，而不应改写历史。

## 已核验的工程基线

| 门禁 | 结果 |
|---|---|
| `npm test` | 通过：根 Vitest 2,881 tests、Workbench Host 367 tests、Workbench Client 36 tests |
| `npm run typecheck` | 通过 |
| `npm run typecheck:dead-code` | 通过 |
| `npm run build` | 通过 |
| `npm run bundle-check` | 通过 |
| `node scripts/check-public-api.mjs` | 通过 |
| `npm run lint -- --max-diagnostics=2000` | 已执行；当前工作树基线仍有 232 errors，未以全仓格式化掩盖。受影响的 MCP/CLI/协议文件已通过定向 Biome 检查。 |

Lint 基线需要独立修复；它不是已通过门禁，不能宣传为零错误。

## 包与依赖边界

工作区有五个包：

| 包 | 已核验职责 |
|---|---|
| `@novalistically/core` | 纯叙事语义：不可变 source-snapshot 分析、实体/图/状态计算、上下文、render 编排、验证、组装意图；也定义 bounded non-authoritative reference packets。仅依赖 `yaml` 和 `zod`。 |
| `@novalistically/node-host` | Node 适配器：filesystem source loader/writer、execution/state/cache/report repositories、AI SDK provider、plugin runtime 和可移植 reference object store。 |
| `@novalistically/bench` | 通过 Core 与 Node Host 运行回归、变体和性能基准；不是 Core 依赖。 |
| `@novalistically/cli` | `commander` CLI 与 typed Workbench MCP client；standalone 写入受 Host authority lease 保护，via-workbench 操作只走项目 scoped 的 authenticated Host route。 |
| `@novalistically/workbench` | 私有 native Host + browser client。Host 持有本地认证、Yjs、SQLite worker、ProjectSession、native immutable revisions 和 project-scoped reference library；浏览器只消费 secret-free DTO。可选 Git 仅镜像已接受 revision，不参与 authoring acceptance。 |

包关系不是一个可推导的线性链。Core 不依赖工作区包；Node Host 提供适配器；Bench、CLI 和 Workbench 按各自 manifest 直接选择 Core/Node Host 能力。

## Source、状态与渲染边界

- Core 输入是 `ProjectSourceSnapshotV1` 和注入的语义端口；source hash 表示内容，不是 Git 历史。
- Node Host 与 Workbench Host 才拥有文件、持久化和 authoring Git。Workbench 只提交显式 `AuthoringManifest`，不得把 `.nova/**`、缓存、responses、journals、Yjs、SQLite、output 或 derived 工件纳入作者提交。
- canonical render runtime 先编译 story/discourse 边界，再生成场景契约。`StateManager` 的内存快照是 recovery primitive；当前 `getCurrentState()` / `getStateAt()` 仍通过 `ReplayEngine` 重放，不能宣传为已接入的快照恢复加速。
- canonical release assembly 以 discourse scene sequence 为主；仍存在按 `narrativeOrder` 排序的 runtime/legacy 路径。因此“`narrativeOrder` 从不使用”是不准确的；它不能作为因果 replay 顺序才是已核验不变量。
- Pass 1 是散文生成，Pass 2 是结构化分析。当前 AnalysisResult envelope 包含 `eventId`、`protocol`、`observations` 与 `analysis`；解析会校验协议、active fields、observations/payload 配对和证据。Pass 2 无 regex fallback；反馈尝试耗尽时场景会记录错误并进入 review/release 决策路径，不能泛化为所有外层处理立即终止。
- 28 个 built-in validators 注册在默认集合中；`GreyLineValidator` 已导出但不是默认注册项。Pass 2 static content schema 有 20 个字段，插件可通过 validator requirements 动态加入自己的 schema 要求。

## 作者 YAML 的当前最小拓扑

标准 Host loader 的当前路径合同是：

```text
nova.yaml
definitions/state_initial.yaml
definitions/entity-types.yaml
[optional] discourse-ledger.yaml
chapters/chapter_NN/[optional] _chapter.yaml
chapters/chapter_NN/E*.yaml
```

`state_initial.yaml` 与 `entity-types.yaml` 是当前 loader 所需输入；discourse ledger 和 chapter metadata 可缺省。实体目录按角色、地点、物品、派系、关系、规则、narrators、assertions 等路径加载。事件文件是 strict EventFile：`beats` 至少有一个非空条目；作者 YAML 的 wire Fact 与 runtime `Fact` 是不同表示，必须经 mapper 归一化。实体属性、生命周期和引用资格以项目自带 `definitions/entity-types.yaml` 为准，不能假定历史默认 catalog。

## 当前用户与运行时入口

- 生产 `AiSdkProvider` 在 `@novalistically/node-host`，默认 OpenAI-compatible base URL 为 `https://opencode.ai/zen/v1`，模型可由运行时配置或环境覆盖；CLI 不自动读取 `.env`。
- CLI 当前提供 validate/status/entity/graph/source/render/revise/render-tree/project-init 这一组 Host-bound 命令。不存在的历史命令或选项不能出现在使用指南中。
- Core 输出的是结构化 intents/records；文件写入由 Host repositories 负责。不要承诺 Core 直接写 `scenes/`、`.nova/responses/` 或 `.nova/derived/` 目录。

## 已知限制与证据边界

| 项目 | 当前结论 |
|---|---|
| Grey line | 类型与验证器存在，但不是默认 built-in validator。 |
| Thread 类型/声明 catalog | 有 schema/type；未成为通用项目加载与执行路径。部分 metadata 仍是 schema-only。 |
| Knowledge、relationship 与 rule | 各自有 schema/局部 replay 或 context 支持；文档必须区分 wire schema、runtime materialization 和未接线的 declaration semantics。 |
| Planner | 已从当前实现移除；历史 S8 目标不是当前能力。 |
| Live bench reference runner | 非空运行仍受未导入 helper 的当前缺陷阻塞；不要把 mock/reference fixture 结果表述为人工或 live-LLM 证据。 |
| 历史 Stage 3 与 corpus 数字 | 仅代表各自日期的快照；Dream of Red Chamber 当前 fixture 为四章 E01–E36，不应复用旧的 12/20-event 状态。 |

## 文档解释规则

- **current reference**：本页、`docs/architecture.md` 与 `docs/reference/` 中被标为当前的页面；必须与当前源码同步。
- **historical record**：`docs/archive/`、有日期的 audits/reports、阶段测量与竞品快照；保留原结论和日期，增加到本页的指针并显式标记不代表当前实现。
- **design-only / unverified**：未来协议、未接线 schema 或未经 live LLM 复核的宣称；必须明确为设计或未验证，不能写成运行时保证。

相关入口：[`架构`](./architecture.md)、[`完整接线图`](./reference/wiring.md)、[`API`](./reference/api.md)、[`YAML 合同`](./reference/yaml-contract/README.md)、[`历史归档`](./archive/README.md)。
