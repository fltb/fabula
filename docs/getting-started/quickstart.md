# 快速开始

> ~300 字 — 几分钟内上手 Novalistically。

## 前置条件

- Node.js 18+
- npm

## 安装

```bash
cd novalistically
npm install
```

这会安装所有工作空间包（`core`、`cli`、`bench`）并编译 TypeScript。

## 配置

复制示例环境文件并设置你的 API 密钥：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
NOVALISTICALLY_AI_API_KEY=your_api_key_here
```

默认情况下，系统使用：
- **Base URL：** `https://opencode.ai/zen/v1`（opencode zen 免费套餐）
- **模型：** `deepseek-v4-flash-free`

如果使用其他提供商，可以通过 `NOVALISTICALLY_AI_BASE_URL` 和 `NOVALISTICALLY_AI_MODEL` 覆盖。

## 运行现有测试夹具

`zhu-fu`（祝福 — "New Year's Sacrifice"）测试夹具是主要的回归测试夹具。运行基准测试套件：

```bash
npx vitest run packages/bench/tests/bench.test.ts
```

**预期输出（无需 LLM）：**

```
[Regression] 8/8 stages passed, 0 failed, 250ms total
[Perf] Load entities (N=100): 12ms
```

这会运行：
- **L1 验证**：加载 YAML 定义，构建 DAG，重放状态，运行全部 18 个验证器
- **L2 验证**：针对存储的参考数据运行后渲染验证（无 API 调用）
- **性能基准测试**：N=10、100、1000 事件下的吞吐量

## 查看结果

| 内容 | 位置 |
|------|------|
| 基准测试报告 | `output/bench/{timestamp}.md` |
| 核心验证报告 | `fixtures/zhu-fu/output/validation.md` |

## 生成参考数据（可选，需要 API 密钥）

```bash
node packages/bench/scripts/generate-reference.mjs zhu-fu
```

这会通过 AI 提供商运行完整流水线（Pass 1 + Pass 2），并将参考数据 `{prose, analysis}` 保存到 `fixtures/zhu-fu/reference/data/`。

## 后续步骤

- [配置](./getting-started/configuration.md) — 所有可用设置
- [第一个项目](./getting-started/first-project.md) — 创建你自己的叙事项目
- [添加验证器](../guides/adding-a-validator.md) — 扩展验证逻辑
- [基准测试工作流](../guides/bench-workflow.md) — 理解两阶段测试系统
