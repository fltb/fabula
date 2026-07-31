# 配置

> ~350 字 — Novalistically 系统的所有配置选项。

## 环境变量

| 变量 | 必需 | 默认值 | 描述 |
|----------|----------|---------|-------------|
| `NOVALISTICALLY_AI_API_KEY` | 是 | — | LLM 提供商的 API 密钥 |
| `NOVALISTICALLY_AI_BASE_URL` | 否 | `https://opencode.ai/zen/v1` | OpenAI 兼容接口的 Base URL |
| `NOVALISTICALLY_AI_MODEL` | 否 | `deepseek-v4-flash-free` | 模型标识符 |

这些变量由 `AiSdkProvider`（`packages/core/src/ai/providers/ai-sdk.ts`）使用。`BASE_URL` 未设置时直接使用默认的 opencode zen 端点（没有按密钥前缀自动检测）；`API_KEY` 缺失时提供商会直接抛出错误。

## 项目结构

一个 Novalistically 项目是包含以下内容的目录：

```
my-novel/
├── nova.yaml                # 项目元数据（必需）
├── definitions/
│   ├── characters/          # 角色 YAML 文件
│   ├── locations/           # 地点 YAML 文件
│   ├── items/               # 物品 YAML 文件
│   ├── relationships/       # 关系 YAML 文件
│   ├── rules/               # 世界规则 YAML 文件
│   ├── state_initial.yaml   # 初始世界状态（必需）
│   └── discourse-ledger.yaml# 话语账本：chapters[].sceneIds 定义章节读者顺序（必需）
├── chapters/
│   └── chapter_01/
│       ├── _chapter.yaml    # 章节元数据（必需）
│       ├── E0_first.yaml    # 事件文件
│       └── E1_second.yaml
└── output/                  # 运行时生成
    └── validation.md        # 验证报告（由基准测试回归阶段写入）
```

`EntityMapper.loadProject()`（`packages/core/src/entity/mapper.ts`）**无条件**加载 `definitions/state_initial.yaml` 与 `definitions/discourse-ledger.yaml`——两者都通过 `readYamlFile()` 读取且未设 `optional`，缺少任一文件都会抛出 `ConfigError`。`discourse-ledger.yaml` 的 `chapters[].sceneIds` 是章节的读者顺序（discourse 顺序）；`state_initial.yaml` 中 `info`、`threads`、`worldFacts` 为必填键（可为空数组），`timeAnchors` 可选。每个章节目录的 `_chapter.yaml` 同样必需。

## nova.yaml

根配置文件，由 `projectConfigSchema`（`packages/core/src/schemas/project.ts`）严格校验——所有键均为 camelCase，未知键会被拒绝。以下为简化示例（键名与 `fixtures/zhu-fu/nova.yaml` 一致）：

```yaml
project: my-novel
schemaVersion: 1
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
- `schemaVersion` — 配置 schema 版本（默认 `1`）。可选。
- `defaultModel` — 渲染作业的模型标签（可按事件覆盖）。**注意：它不会被用作 CLI 渲染的 LLM 提供商回退默认**——`render-service.ts` 的 fallback provider 工厂只读取 `request.model`（即 CLI 的 `--model`）与 `NOVALISTICALLY_AI_MODEL` 环境变量，两者都缺失时抛 “no model configured”。CLI 渲染需要显式 `--model <真实模型>` 或导出 `NOVALISTICALLY_AI_MODEL`，外加 `NOVALISTICALLY_AI_API_KEY`。可选。
- `defaultLanguage` — 默认生成语言。示例：`zh-CN`, `en`。可选。
- `genre` — 系统上下文中的类型标签。示例：`literary`, `fantasy`。可选。
- `synopsis` — 项目梗概，为 LLM 提供故事背景。可选。
- `validatorOverrides` — 逐验证器配置覆盖。键为验证器名称，值为 `off`、`warning` 或 `error`。可选。
- `outputDir` — `.nova` 工作目录名（相对项目根，默认 `.nova`）。可选。
- `ideaIR` — 主题意图与情感弧（`thematicIntent`、`emotionalArc`）。可选。
- `renderSurface` — render surface 规划配置。可选。
- `plugins` — 插件开关与目录。可选。

以下字段目前**仅被 `projectConfigSchema` 接受，尚无运行时消费方**（schema-only；此处只说明 schema 契约，不描述行为）：
- `snapshotInterval` — `initializeProject()` 硬编码快照间隔为 20，不读取此值
- `tense` — 时态一致性检查读取的是事件级 `tense` 字段（`tense-consistency.ts`），项目级 `tense` 无消费方
- `defaultSceneTextTarget`、`circuitBreaker`、`reviewExpiry`、`concurrency`、`cacheEnabled`、`styleProfile`、`logLevel`、`traceLevel` — `RenderPipeline` 构造只使用请求/运行时等价项（`--concurrency`、`--trace`、`request.maxRounds` 等），这些项目配置字段尚未被消费
- 数值校验契约：`circuitBreaker.maxRetries` 为 `z.number()`（任意数字，**非整数限定**）；`concurrency` 与 `defaultSceneTextTarget` 为 `z.number().int().positive()`

## 定义

每个定义是 `definitions/` 下的一个 YAML 文件。角色在 `definitions/characters/{id}.yaml`，地点在 `definitions/locations/{id}.yaml`。

请参阅 `zhu-fu` 测试夹具（`fixtures/zhu-fu/`）以获取包含 8 个角色、4 个地点、7 个事件和世界规则的完整项目示例（单章 `chapter_01`）。

## CLI

构建后（`npm run build`），CLI 的二进制名为 `nova`（`packages/cli/package.json` 的 `bin` 字段）：

```bash
npx nova --help
```

可用命令包括 `project init`（项目初始化）、`render`（场景渲染）、`validate`（运行验证）、`review`（审查评论）、`assemble`（组装小说）、`bench`（基准测试）等。

**注意：** `nova project init <name>` 生成的脚手架**当前不可直接加载**——生成的 `nova.yaml` 使用 snake_case 键（`default_model`、`snapshot_interval`、`validator_overrides`、`circuit_breaker`、`review_expiry`），会被严格的 `projectConfigSchema` 拒绝；生成的 `definitions/state_initial.yaml` 同样使用 snake_case 键（`current_era`、`political_situation`），会被 `worldInitialStateSchema` 拒绝；并且它不创建必需的 `definitions/discourse-ledger.yaml` 与 `chapters/chapter_01/_chapter.yaml`。若要用该脚手架，需要先按上文格式改写两个文件的键名并补齐这两个必需文件。
