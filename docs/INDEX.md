# Novalistically 文档

Novalistically 是一个叙事工程系统：结构化 YAML 定义 → 事件溯源状态 → Pass 2 分析 → LLM 散文 → 验证 → 组装小说。质量控制于**输出层面**：Pass 2 生成结构化自分析 JSON，验证器消费 Pass 2 分析（而非正则表达式扫描散文）进行语义检查，`compareFact()` 处理确定性检查。

## 我想...

- **[快速上手](./getting-started/quickstart.md)** — 5 分钟设置并完成首次渲染
- **[理解设计哲学](./philosophy.md)** — 为什么选择事件溯源？为什么需要 Pass 2？为什么在输出层面验证？
- **[理解架构](./architecture.md)** — 数据流、流水线拓扑、分层图、模块映射
- **[配置项目](./getting-started/configuration.md)** — .env、YAML 结构、AI 提供商设置
- **[创建第一部小说](./getting-started/first-project.md)** — 从 YAML 定义到渲染完成的散文

## 参考

- **[YAML 格式](./reference/yaml-format/)** — 事件、角色、规则、关系和场景定义的 schema
- **[渲染流水线](./reference/pipeline.md)** — Pass 1 散文（温度 0.8）+ Pass 2 分析（温度 0.3，种子 42）+ 缓存 + 验证 + 熔断器
- **[完整接线图](./reference/wiring.md)** — YAML→内部模型、Storage/state、strict discourse、job/contract、cache/Pass 1/Pass 2、release、surface wave 与 artifact ownership 的 current wiring
- **[Pass 2 分析](./reference/pass-2-analysis.md)** — 验证器消费的 14 个模块的 AnalysisResult JSON
- **[验证器](./reference/validators.md)** — 全部 20 个验证器：每个检查的内容、哪些消费 Pass 2 分析、哪些在渲染前运行
- **[状态管理](./reference/state-management.md)** — 事件溯源、DAG 因果边、ReplayEngine、快照、拓扑排序
- **[竞品分析](./reference/competitive-analysis.md)** — Novalistically 与其他叙事引擎（Novel Studio、Sudowrite、Novel-OS 等）在上下文编译、场景连续性、验证体系上的对比与独创性分析
- **[AI 提供商](./reference/ai-providers.md)** — AiSdkProvider（Vercel AI SDK）、MockPass2Provider（测试夹具）、配置、自动检测
- **[基准系统](./reference/bench.md)** — 回归（在 祝福 上的 L1+L2）、变体（错误注入 + 极端破坏）、性能（N=10/100/1000）、一致性（N-CED、S-CED、Pipeline F1）、外部数据集
- **[CLI 和 MCP](./reference/cli.md)** — CLI 命令（`nova render`、`nova validate`、`nova status`）、MCP 服务器
- **[程序化 API](./reference/api.md)** — `renderNovel()`、`validateProject()`、`diffProject()` 及所有其他可导入的 API 函数
- **[报告输出](./reference/reporter.md)** — 验证报告和基准报告的输出格式（JSON + Markdown）

## 指南

- **[添加验证器](./guides/adding-a-validator.md)** — 分步指南：实现 `Validator` 接口、声明分析需求、在 `ResultAggregator` 中注册
- **[扩展 Pass 2](./guides/extending-pass-2.md)** — 添加新的 AnalysisResult 模块：类型、schema、提示词、验证器
- **[基准工作流](./guides/bench-workflow.md)** — L1（渲染前）+ L2（渲染后带 Pass 2 分析）基准测试的工作原理及结果解读

## 架构决策

- [001：事实双重表示](./decisions/001-fact-dual-representation.md) — `Fact.value` 用于确定性比较，`Fact.narrativeHint` 用于由 Pass 2 消费的语义属性
- [002：DAG 因果边](./decisions/002-dag-causal-edges.md) — 因果边（后置条件→前置条件匹配）通过拓扑排序驱动 StateManager 回放，而非 `narrativeOrder`
- [003：动态分析模块](./decisions/003-dynamic-analysis-blocks.md) — 验证器通过 `getAnalysisRequirements()` 声明所需的分析模块；Pass 2 提示词自动生成
- [004：AI SDK 迁移](./decisions/004-ai-sdk-migration.md) — 使用 `createOpenAICompatible()` 的 Vercel AI SDK 以实现通用提供商兼容性

## 项目

- **[包映射](./architecture.md#package-structure)** — `packages/core`（引擎）、`packages/bench`（基准测试）、`packages/cli`（命令）
- **[贡献指南](./guides/adding-a-validator.md)** — 如何贡献、测试约定、构建顺序
- **[历史文档](./archive/README.md)** — 原始设计文档（保留供参考）
