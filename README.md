# Fabula

> 叙事工程系统：结构化 YAML → Event Sourcing 状态 → 双轮 LLM → 组装小说。
>
> 核心命题：**Fabula（故事发生的时序 + 因果 DAG）**是系统的核心创新——event sourcing + causal DAG + topological sort 做对了。上层 IR 层（Idea IR、Story IR）和 Genette 五维度（Order/Duration/Frequency/Mood/Voice）现已接入基准测试。

Fabula 是一个小说工程化引擎：作者定义角色、世界规则和事件（YAML 格式），系统通过 event sourcing 维护状态，为每个场景编译最小上下文，用双轮 LLM pipeline 渲染散文，通过 18+ 个结构化 validator 校验输出，最终组装成完整小说。

## 核心概念

| 概念 | 说明 |
|------|------|
| **Novel IR** | 多层中间表示：Idea IR → Story IR → Scene IR → Event IR → World State → Novel Text（类比 LLVM IR） |
| **Fabula / Syuzhet 分离** | *Fabula*（故事发生的因果链，causal DAG）vs *Syuzhet*（叙述顺序，discourse order）。topological sort on causal edges 驱动 replay，narrativeOrder 仅用于 Assembler |
| **Event Sourcing + Snapshots** | 每个叙事事件是不可变记录；状态通过 replay 派生。支持分支、回滚、DAG 因果排序 |
| **双轮渲染** | Pass 1：生成散文（temp 0.8）；Pass 2：结构化分析 JSON（temp 0.3, seed 42），12 个分析块供 validator 消费 |
| **分层验证** | 确定性 fact 通过 `compareFact()` 检查；语义维度通过 Pass 2 分析检查；作者意图通过 `narrativeChecklist` prompt 透传 |
| **传统小说为约束子集** | Schema 为最一般情况（现代小说）设计；传统小说不填现代特有字段，不是 parallel schema |

## 架构

```
YAML Definitions + Event Files
    ↓
EntityMapper → EntityRegistry
    ↓
StateManager (Event Sourcing + Snapshots + DAG causal edges, topological sort)
    ↓
ContextCompiler (5-layer priority, 8-dim relevance scoring)
    ↓
RenderPipeline (Pass 1: prose → Pass 2: 12-block structured analysis)
    ↓
PostRenderValidation (18+ validators consuming Pass 2 analysis)
    ↓
Assembler → output/novel.md
```

## 基准 (zhu-fu) 接线状态

`fixtures/zhu-fu/` (鲁迅《祝福》) 作为传统小说基准——7 个事件，全层接线：

| 层 | 内容 | E0-E6 |
|----|------|:--:|
| Event IR | precondition / postcondition / threadProgress / DAG | ✅ |
| World State | 角色、地点、关系、规则、state_initial | ✅ |
| S6 Genette | duration / frequency / voice / anachrony | ✅ |
| S1 narrativeChecklist | 每事件 3-4 项 must-include 维度 | ✅ |
| S2 greyLines | 11 个共享 motif，跨事件追踪 | ✅ |
| S4 sourceContext | 鲁迅原文摘录 (STYLE/FACT/MIXED) | ✅ |
| S7a Idea IR | thematicIntent + emotionalArc | ✅ nova.yaml |
| S7b Story IR | structuralFunction (Propp) + actantModel | ✅ 线程级 |

## 快速开始

```bash
npm install
npm run build          # tsc -b (types) + esbuild (JS bundle)
npm test               # vitest run (全包)
npm run bench          # 功能 + 性能基准
npm run typecheck      # tsc --noEmit
npm run lint           # biome check
```

排除 e2e（需要 live LLM proxy）:
```bash
npx vitest run --exclude '**/e2e.test.ts'
```

## Monorepo 结构

| 包 | 角色 | 关键依赖 |
|----|------|---------|
| `packages/core` | 引擎：types, state, validators, pipeline | yaml, zod, better-sqlite3 |
| `packages/cli` | CLI + MCP server | commander, core |
| `packages/bench` | 基准 + regression suite | tinybench, core |

构建顺序：`core → cli`（需要时 `bench`）。

## Fixtures

| Fixture | 描述 |
|---------|------|
| `fixtures/zhu-fu/` | 祝福 (鲁迅) — 7 事件，全层接线，传统小说基准 |
| `fixtures/zhu-fu-variants/` | 变种矩阵：layer-minimal / discourse-reorder / pov-switch / branch-A / branch-B / error-injection / extreme-damage |
| `fixtures/dream-of-red-chamber/` | 红楼梦 — 12 事件，40 角色，8 地点 |
| `fixtures/most-dangerous-game/` | 6 场景，3 章，分支点 |
| `fixtures/arcane-aftermath/` | 2 事件测试项目 |

## 文档

| 文件 | 用途 |
|------|------|
| `docs/TODO.md` | 活跃工作面（当前至 Stage 3，70+ 项） |
| `docs/report.md` | Stage 3 实现报告 |
| `docs/report/stage-3-audit.md` | 代码级交叉引用审计 |
| `docs/reference/stage-3/` | 叙事学参考：Genette 审计、IR 层映射、现代小说 survey、annotation 指南 |
| `docs/archive/PROJECT.md` | ⚠️ 历史——原始系统设计 |

## 状态

Stage 3 代码完成。1930 测试，110 测试文件，typecheck 干净。zhu-fu 全层接线完成，变种矩阵就绪。已明确延后：C2/C3（人类标注）、S8（前向 planner——设计假设不适用于已完成小说的 Novel IR）、Syuzhet/Discourse 层接线（`NarratorProfile` 完整类型存在但 fixture 未接）。

## License

GPL-3.0-only
