# 配置

> ~350 字 — Novalistically 系统的所有配置选项。

> 本文为当前参考文档，与 [当前系统状态](../current-state.md) 保持同步。

## 环境变量

| 变量 | 必需 | 默认值 | 描述 |
|----------|----------|---------|-------------|
| `NOVALISTICALLY_AI_API_KEY` | 是 | — | LLM 提供商的 API 密钥 |
| `NOVALISTICALLY_AI_BASE_URL` | 否 | `https://opencode.ai/zen/v1` | OpenAI 兼容接口的 Base URL |
| `NOVALISTICALLY_AI_MODEL` | 否 | `deepseek-v4-flash-free` | 模型标识符 |

这些变量由 `@novalistically/node-host` 的 `AiSdkProvider`（`packages/node-host/src/providers/ai-sdk.ts`）使用。`BASE_URL` 未设置时直接使用默认的 opencode zen 端点（没有按密钥前缀自动检测）；`API_KEY` 缺失时 `AiSdkProvider` 构造即抛错（`API key not provided. Set NOVALISTICALLY_AI_API_KEY or provide apiKey.`）。CLI 不会自动读取 `.env`，需要把变量导出到 shell 环境。

## 项目结构

一个 Novalistically 项目是包含以下内容的目录：

```
my-novel/
├── nova.yaml                # 项目元数据（必需）
├── definitions/
│   ├── entity-types.yaml    # 实体类型目录（必需）：声明各实体类型允许的属性
│   ├── state_initial.yaml   # 初始世界状态（必需）
│   ├── discourse-ledger.yaml# 话语账本（可选）：chapters[].sceneIds 定义章节读者顺序
│   ├── characters/          # 角色 YAML 文件
│   ├── locations/           # 地点 YAML 文件
│   ├── items/               # 物品 YAML 文件
│   ├── factions/            # 阵营 YAML 文件
│   ├── relationships/       # 关系 YAML 文件
│   ├── rules/               # 世界规则 YAML 文件
│   ├── narrators/           # 叙述者档案 YAML 文件
│   └── assertions/          # 叙述者断言 YAML 文件
├── chapters/
│   └── chapter_01/
│       ├── _chapter.yaml    # 章节元数据（可选）
│       ├── E0_first.yaml    # 事件文件（strict EventFile，beats 至少一个非空条目）
│       └── E1_second.yaml
└── output/                  # 基准测试运行时生成
    └── validation.md        # 验证报告（由基准测试回归阶段写入）
```

`EntityMapper.loadProject()`（`packages/core/src/entity/mapper.ts`）**无条件**加载 `definitions/state_initial.yaml` 与 `definitions/entity-types.yaml`——两者都通过 `readYamlFile()` 读取且未设 `optional`，缺少任一文件都会抛出 `ConfigError`。`discourse-ledger.yaml` 与 `chapters/chapter_NN/_chapter.yaml` **可缺省**：ledger 缺省时编译器使用空的默认 ledger，`_chapter.yaml` 缺省时章节目录仍可加载。`state_initial.yaml` 中 `info`、`threads`、`worldFacts` 为必填键（可为空数组），`timeAnchors` 可选。事件文件是 strict `EventFile`：`beats` 至少需要一个非空条目。

## nova.yaml

根配置文件，由 `projectConfigSchema`（`packages/core/src/schemas/project.ts`）严格校验——所有键均为 camelCase，未知键会被拒绝。以下为简化示例（键名与 `fixtures/zhu-fu/nova.yaml` 一致）：

```yaml
project: my-novel
title: "My Novel"
author: "Author Name"
defaultModel: mock
defaultLanguage: en
genre: "literary"
synopsis: "A brief summary of the story."
tense: past
snapshotInterval: 3
defaultSceneTextTarget: 1200
```

关键字段：
- `project` — 机器可读的项目标识符（必需）
- `title` — 作品标题（必需）
- `author` — 作者名称（必需）
- `defaultModel` — 渲染作业的模型标签：`render-service.ts` 以 `request.model ?? config.defaultModel ?? 'default'` 解析作业模型，并参与缓存身份判定（`isRenderCacheEnabled`）。它**不是** LLM provider 的实际模型——`AiSdkProvider` 的模型来自 `NOVALISTICALLY_AI_MODEL` 环境变量（默认 `deepseek-v4-flash-free`）。CLI 的 `render`/`revise` 没有 `--model` 选项；真实渲染需要导出 `NOVALISTICALLY_AI_API_KEY`（必要时加 `NOVALISTICALLY_AI_MODEL` / `NOVALISTICALLY_AI_BASE_URL`）。可选。
- `defaultLanguage` — 默认生成语言。示例：`zh-CN`, `en`。可选。
- `genre` — 系统上下文中的类型标签。示例：`literary`, `fantasy`。可选。
- `synopsis` — 项目梗概，为 LLM 提供故事背景。可选。
- `validatorOverrides` — 逐验证器配置覆盖。键为验证器名称，值为 `off`、`warning` 或 `error`。可选。
- `ideaIR` — 主题意图与情感弧（`thematicIntent`、`emotionalArc`）。可选。
- `renderSurface` — render surface 规划配置。可选。
- `plugins` — 插件开关（`enabled`）。可选。

`schemaVersion` 与 `outputDir` **不是**合法的项目配置键——`projectConfigSchema` 是 strict 模式，出现这两个键会被直接拒绝。

以下字段目前**仅被 `projectConfigSchema` 接受，尚无运行时消费方**（schema-only；此处只说明 schema 契约，不描述行为）：
- `snapshotInterval` — `StateManager`/`SnapshotEngine` 硬编码快照间隔为 20，不读取此值
- `tense` — 时态一致性检查读取的是事件级 `tense` 字段（`tense-consistency.ts`），项目级 `tense` 无消费方
- `defaultSceneTextTarget`、`circuitBreaker`、`reviewExpiry`、`concurrency`、`cacheEnabled`、`styleProfile`、`logLevel`、`traceLevel` — `RenderPipeline` 使用请求/运行时级等价项，这些项目配置字段尚未被消费
- 数值校验契约：`circuitBreaker.maxRetries` 为 `z.number()`（任意数字，**非整数限定**）；`concurrency` 与 `defaultSceneTextTarget` 为 `z.number().int().positive()`

## 定义

每个定义是 `definitions/` 下的一个 YAML 文件。实体定义目录：`characters/`、`locations/`、`items/`、`factions/`、`relationships/`、`rules/`、`narrators/`、`assertions/`（角色在 `definitions/characters/{id}.yaml`，地点在 `definitions/locations/{id}.yaml`，规则在 `definitions/rules/{id}.yaml`）。

请参阅 `zhu-fu` 测试夹具（`fixtures/zhu-fu/`）以获取包含 8 个角色、4 个地点、7 个事件（E0–E6）和世界规则的完整项目示例（单章 `chapter_01`）。

## CLI

构建后（`npm run build`），CLI 的二进制名为 `nova`（`packages/cli/package.json` 的 `bin` 字段）：

```bash
npx nova --help
```

可用命令：`validate`（运行验证）、`status`（项目状态）、`entity list/show`（实体检查）、`graph`（DAG 导出 dot/mermaid）、`source list/show/preview/apply`（源文件 CAS 操作）、`render [eventId]` / `revise [eventId]`（渲染与修订；选择器为事件 ID 位置参数、`--all` 或 `--chapter <n>`，`render` 另有 `--dry-run` 预览）、`render-tree`（游戏对话树渲染）、`project init <name>`（项目初始化）。CLI 不提供 `review`、`assemble`、`bench` 子命令。

`render`/`revise` 的默认 provider 是 `ai-sdk`（也可用 `--provider mock-pass2`，此时必须配合 `--reference-dir <directory>`）。模型与凭据经环境变量配置（见上文），没有 `--model` 选项。

**注意：** `nova project init <name>` 生成的脚手架**可直接加载**：`nova.yaml` 使用 camelCase 键（`project`、`title`、`author`、`defaultModel`、`defaultLanguage`、`snapshotInterval`），并创建必需的 `definitions/state_initial.yaml` 与 `definitions/entity-types.yaml`，以及 `definitions/characters/narrator.yaml`、可选的 `definitions/discourse-ledger.yaml`、`chapters/chapter_01/_chapter.yaml` 与带 `beats` 的 `chapters/chapter_01/E1.yaml`。脚手架不创建 Git 历史。
