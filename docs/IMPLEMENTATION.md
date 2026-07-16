# Novalistically — 实现指南

> 从 PROJECT.md 提炼的开发路线图。读这个开始写代码。

---

## 一、这个系统做什么

把软件工程/DevOps 原则应用于长篇小说创作。

```
输入: 结构化的 YAML 意图声明（角色、规则、事件、前置/后置条件）
  │
  ├── EntityMapper   → 解析 YAML → 内部类型
  ├── StateManager   → Event Sourcing + 快照 + SQLite 索引
  ├── Validator      → 10 个检查器，事件 commit 前自动验证一致性
  ├── ContextCompiler → 从 State 中组装 LLM prompt 上下文
  ├── PromptAssembler → 组合 Context + Agent Prompt → LLM 调用
  └── Assembler      → 按 narrativeOrder 拼接 prose → novel.md
```

**核心原则**：
- 文件是唯一权威接口（YAML/MD 在磁盘上，任何工具都能读写）
- Core 是纯函数库，不持续运行
- 确定性优先（11 个 Validator 中 8 个不调用 LLM）

---

## 二、项目结构

```
~/projects/novalistically/
├── docs/                           # 设计文档
│   ├── IMPLEMENTATION.md           # 本文档
│   ├── PROJECT.md                  # 完整设计参考（~2800 行）
│   └── reference/                  # 原始讨论 + 研究资料
├── packages/                       # ★ 代码在这里
│   ├── core/                       # 核心引擎（纯函数库）
│   │   ├── src/
│   │   │   ├── entity/             # EntityMapper, EntityRegistry
│   │   │   ├── state/              # EventStore, SnapshotEngine, ReplayEngine
│   │   │   ├── validator/          # 10 个 Validator + ResultAggregator
│   │   │   ├── context/            # ContextCompiler, RelevanceEngine
│   │   │   ├── render/             # PromptAssembler
│   │   │   ├── assembler/          # SceneCollector, ProseConcatenator
│   │   │   ├── iss/                # Input Structure Score
│   │   │   └── mcp/                # MCP server tools
│   │   ├── schemas/                # Zod schemas（所有 YAML 格式的验证）
│   │   ├── tests/                  # 单元 + 集成测试
│   │   └── package.json
│   └── cli/                        # CLI 工具
│       ├── src/
│       │   ├── commands/           # validate, commit, render, status, diff
│       │   └── mcp-server.ts       # MCP server 入口
│       └── package.json
└── fixtures/                       # 测试用示例项目（Arcane 后传 demo）
```

**引擎与创作项目物理分离**：
- `~/projects/novalistically/` = 引擎代码（类似 Git 的安装目录）
- `~/projects/arcane-aftermath/` = 创作项目（类似 Git 仓库）
- AI agent（opencode）的工作目录 = 创作项目，永远不碰引擎代码

---

## 三、开发顺序

### Phase 1: Foundation（第 1-2 周）

**目标**: 能解析 YAML，管理状态，在文件系统上运行。

#### 1.1 Zod Schemas + EntityMapper

- [ ] 为所有 YAML 文件类型写 Zod schema（参考 PROJECT.md 附录 A）
- [ ] 实现 `EntityMapper`：扫描 `definitions/` + `events/` → 解析 YAML → 返回内部类型
- [ ] 实现 `EntityRegistry`：resolve(id) → Entity | null
- [ ] 测试：用 Arcane 后传 demo 的 5 个角色 + 2 条规则

**关键类型**: `Entity`, `EntityRegistry`, `CharacterDefinition`, `RuleDefinition`, `EventFile`

**文件位置**: `packages/core/schemas/`, `packages/core/src/entity/`

#### 1.2 StateManager（Event Store + 快照）

- [ ] 实现 `EventStore`：追加式日志，每事件一行 JSON
- [ ] 实现 `SnapshotEngine`：每 20 事件创建快照（JSON）
- [ ] 实现 `ReplayEngine`：getStateAt(narrativeOrder) → WorldState
- [ ] 实现 `SQLiteIndexer`：从 YAML 索引 entity/thread/rule
- [ ] 测试：创世事件 → 3 个常规事件 → replay → 验证状态正确

**关键类型**: `EventStore`, `Snapshot`, `WorldState`, `replay()`

**文件位置**: `packages/core/src/state/`

#### 1.3 CLI 基础

- [ ] `nova project init <name>` — 生成创作项目模板
- [ ] `nova validate` — 调用 EntityMapper + Zod 验证（标准模式）
- [ ] `nova validate --strict` — 加 ISS 检查
- [ ] `nova status` — 输出 PROJECT_STATUS.md
- [ ] `nova commit` — 触发 StateManager commit + git commit

**文件位置**: `packages/cli/src/commands/`

#### 1.4 Git 集成

- [ ] `nova commit` → 自动 `git commit`（用 isomorphic-git）
- [ ] `nova diff <event>` → 叙事 diff（状态变化，不是文件 diff）
- [ ] 明确标记：Narrative Branch ≠ Git Branch

---

### Phase 2: Validator Pipeline（第 3-4 周）

**目标**: 11 个 Validator 在 commit 前自动运行，阻断硬错误。

#### 2.1 确定性 Validator（8 个，不调用 LLM）

- [ ] `TimelineValidator` — 使用 StoryTimestamp 比较 + compareTimestamp
- [ ] `CharacterStateValidator` — 检查 dead/alive 状态一致性
- [ ] `KnowledgeValidator` — 检查 KnowledgeState 边界（角色是否知道不该知道的事）
- [ ] `WorldRuleValidator` — 执行 logical_consequences 中的 state_invariant/transition_constraint/progression
- [ ] `ForeshadowingValidator` — 检查伏笔是否超期
- [ ] `POVValidator` — 检查 POV 一致性（不可用 omniscient 时叙述 3P-limited 外的事）
- [ ] `BranchMergeValidator` — 检查分支汇合点的 precondition 一致性
- [ ] `ReachabilityValidator` — 从 Story Solver 吸收：检查分支可达性、Thread 完成性、伏笔回收、前置条件死锁
- [ ] `BranchMergeValidator` — 检查分支汇合点的 precondition 一致性

**每个 Validator 实现 `Validator` 接口**：
```typescript
interface Validator {
  name: string
  category: 'characterization' | 'factual_detail' | 'timeline_plot' | 'worldbuilding' | 'narrative_style'
  requiresLLM: boolean
  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[]
}
```

#### 2.2 LLM 辅助 Validator（3 个）

- [ ] `CausalityValidator` — LLM 辅助检查因果合理性（WARNING 级别）
- [ ] `FactualDetailValidator` — LLM 辅助检查事实细节（WARNING 级别）
- [ ] `VoiceDriftDetector` — LLM 必须，唯一需要调用 LLM 的 Validator（可选启用）

#### 2.3 ResultAggregator

- [ ] 收集 10 个 Validator 的输出
- [ ] 两级分级：只有 ERROR（确定性硬错误）阻断 commit；WARNING 不阻断
- [ ] 输出 ValidationSnapshot（供 StatusReport 使用）

---

### Phase 3: Context Compiler + Render（第 5-6 周）

**目标**: 从事件声明 → LLM 调用 → 生成 prose。

#### 3.1 Context Compiler

- [ ] `RelevanceEngine`：8 维评分算法（实体距离/时间接近度/Thread 关联/规则相关/用户固定 + 从 Yarn Spinner Saliency 吸收的 specificity_bonus/recency_penalty/thread_saturation）
- [ ] `ContextAssembler`：5 层优先级填充（L1-L5），截断到 token budget
- [ ] `ContextRenderer`：→ LLM 可读 markdown
- [ ] `ContextInspector`：审计日志（context_package.json）

#### 3.2 PromptAssembler

- [ ] 加载 Agent Prompt 模板（`agents/scribe/prompt.md`）
- [ ] 组合 Context Package + Agent Prompt + Render Request → FinalPrompt
- [ ] `--dry-run` 模式：保存 prompt 到 `.nova/dry-runs/`

#### 3.3 Agent Prompt 模板

- [ ] `agents/scribe/prompt.md` — 统一模板：identity → capabilities → principles → prohibitions → output contract → checklist
- [ ] Output Contract: LLM 返回 JSON（prose + newFacts + threadProgress + foreshadowingPlanted）

#### 3.4 Scene 渲染

- [ ] `nova render E3b` — 完整渲染流程
- [ ] LLM 返回的 prose → `scenes/chapter-03/E3b.md`
- [ ] LLM 返回的 newFacts → Event Store（Validator 消费）
- [ ] LLM 原始响应 → `.nova/responses/E3b_2026-07-16.json`

---

### Phase 4: Assembler + ISS（第 7 周）

#### 4.1 Assembler

- [ ] `SceneCollector`：收集所有 committed scene 的 prose
- [ ] `NarrativeSorter`：按 narrativeOrder 排序
- [ ] `ProseConcatenator`：拼接 + 章节标题 → `output/novel.md`
- [ ] 每次 `nova commit` 后自动运行

#### 4.2 ISS（Input Structure Score）

- [ ] 六维评分计算（实体引用完整性/规则可执行性/前置条件深度/后置条件具体性/Thread 覆盖率/伏笔覆盖率）
- [ ] 反模式检测（单形容词 traits、死线程、空场景、未使用实体、孤立伏笔）
- [ ] `nova validate --strict` 强制执行反偷懒门槛

---

### Phase 5: MCP Server + 集成（第 8 周）

#### 5.1 MCP Server

- [ ] `mcp_nova_status()` → StatusReport
- [ ] `mcp_nova_validate(path)` 
- [ ] `mcp_nova_iss(path)` → ISS 分数 + 缺失项
- [ ] `mcp_nova_read_state(entity)` → 当前世界状态
- [ ] `mcp_nova_thread_status(thread)`
- [ ] `mcp_nova_render(event)`
- [ ] `mcp_nova_assemble()`

#### 5.2 next_actions + guidance

- [ ] `next_actions` 优先级排序算法
- [ ] `generateGuidance()` 自动生成自然语言指导
- [ ] StatusReport 注入 opencode 的 system prompt

---

### Phase 6: 测试 + Demo（第 9 周）

- [ ] 完成 Arcane 后传 demo：3 章，~8 个 events，全部通过 Validator，生成 novel.md
- [ ] ATANT benchmark：选 10 个代表性故事跑确定性 Validator
- [ ] 文档补全

---

## 四、关键技术决策速查

| 决策 | 选择 | 原因 |
|------|------|------|
| 语言 | TypeScript | 全栈统一 |
| 状态持久化 | 追加式 Event Store + 快照 JSON + SQLite 索引 | 事件溯源保证可追溯 |
| 版本控制 | Git（isomorphic-git 或 shell） | 作者拥有全部历史 |
| 知识图谱 | 不建独立图数据库 | SQLite 索引 + YAML 文件足够 |
| LLM 返回格式 | JSON（非自由文本或 [TAG]） | Zod 可直接验证 |
| 检查器架构 | 每个 Validator 独立函数，顺序执行 | 可插拔、可单独测试 |
| Context 组装 | 5 层优先级 + token budget 截断 | 确保最相关信息在 LLM context 中 |
| 前端 | opencode（MCP 连接） | 不需要自己写 UI |
| 插件系统 | 二期 | MVP 用手动规则文件即可 |

## 五、不要做的事（MVP 范围外）

- Web UI
- 实时协作
- 插件 Marketplace
- 自动修复（auto-fix）
- 可视化（分支图、时间线图）
- 多格式导出（EPUB, PDF, DOCX）
- 不可靠叙述者（Narrator 模型）
- 跨小说连续性（系列/共享宇宙）
- 自训练小模型

## 六、立即开始

```bash
cd ~/projects/novalistically
mkdir -p packages/core/src/{entity,state,validator,context,render,assembler,iss,mcp}
mkdir -p packages/core/schemas
mkdir -p packages/core/tests
mkdir -p packages/cli/src/commands
mkdir -p agents/scribe
mkdir -p fixtures/arcane-aftermath

# Phase 1.1: Zod schemas
# 从 PROJECT.md 附录 A 复制所有 YAML schema → Zod schema
```
