# 配置

> ~350 字 — Novalistically 系统的所有配置选项。

## 环境变量

| 变量 | 必需 | 默认值 | 描述 |
|----------|----------|---------|-------------|
| `NOVALISTICALLY_AI_API_KEY` | 是 | — | LLM 提供商的 API 密钥 |
| `NOVALISTICALLY_AI_BASE_URL` | 否 | `https://opencode.ai/zen/v1` | OpenAI 兼容接口的 Base URL |
| `NOVALISTICALLY_AI_MODEL` | 否 | `deepseek-v4-flash-free` | 模型标识符 |

这些变量由 `AiSdkProvider`（`packages/core/src/ai/providers/ai-sdk.ts`）使用。如果未设置 `BASE_URL`，提供商会根据 API 密钥前缀自动检测：
- `ocg-` → `https://opencode.ai/zen/go/v1`
- `sk-` → `https://api.deepseek.com/v1`
- 其他 → 使用默认值（如果未设置覆盖则抛出异常）

## 项目结构

一个 Novalistically 项目是包含以下内容的目录：

```
my-novel/
├── nova.yaml              # 项目元数据（必需）
├── definitions/
│   ├── characters/        # 角色 YAML 文件
│   ├── locations/         # 地点 YAML 文件
│   ├── items/             # 物品 YAML 文件
│   ├── relationships/     # 关系 YAML 文件
│   ├── rules/             # 世界规则 YAML 文件
│   └── state_initial.yaml # 初始世界状态
├── chapters/
│   └── chapter_01/
│       ├── _chapter.yaml  # 章节元数据
│       ├── E0_first.yaml  # 事件文件
│       └── E1_second.yaml
└── output/                # 运行时生成
    └── validation.md      # 验证报告
```

## nova.yaml

根配置文件。以下示例来自 `fixtures/zhu-fu/nova.yaml`：

```yaml
project: my-novel
title: "My Novel"
author: "Author Name"
default_model: mock
default_language: en
genre: "literary"
synopsis: "A brief summary of the story."
tense: past
snapshot_interval: 3
```

关键字段：
- `project` — 机器可读的项目标识符
- `default_model` — 所有场景的 LLM 模型（可按事件覆盖）
- `snapshot_interval` — 两次 WorldState 快照之间的事件数
- `tense` — 默认叙事时态（`past` | `present`）

## 定义

每个定义是 `definitions/` 下的一个 YAML 文件。角色在 `definitions/characters/{id}.yaml`，地点在 `definitions/locations/{id}.yaml`。

请参阅 `zhu-fu` 测试夹具（`fixtures/zhu-fu/`）以获取包含 8 个角色、4 个地点、7 个事件和世界规则的完整多章节项目示例。

## CLI

如果已安装 CLI 包：

```bash
npx novalistically --help
```

可用命令包括项目初始化、场景渲染和验证报告生成。
