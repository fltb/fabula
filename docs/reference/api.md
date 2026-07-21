# API 参考 — `@novalistically/core`

**入口：** `packages/core/src/index.ts`  
**类型定义：** `packages/core/src/types/`（19 个类型文件，通过 `types/index.ts` 重新导出）

## 包导出

`packages/core/src/index.ts` 导出的公共 API：

### 核心类

| 类 | 源文件 | 用途 |
|-------|--------|---------|
| `EntityMapper` | `packages/core/src/entity/mapper.ts` | 将项目 YAML 文件加载为类型化的 `NarrativeEvent[]`、`ProjectData` |
| `InMemoryEntityRegistry` | `packages/core/src/entity/registry.ts` | 所有实体（角色、地点、物品、概念、派系、规则）的内存注册表 |
| `ReplayEngine` | `packages/core/src/state/replay.ts` | 从创世事件开始回放 `NarrativeEvent[]`，使用 DAG 拓扑排序生成 `WorldState` |
| `StateManager` | `packages/core/src/state/manager.ts` | 协调 EventStore + SnapshotEngine，负责事件提交、快照和状态查询 |
| `ContextCompiler` | `packages/core/src/context/compiler.ts` | 编译 `ContextPackage`（8 层：系统上下文、场景规格、角色快照、关系、世界事实、知识边界、活跃线索、markdown） |
| `RenderPipeline` | `packages/core/src/pipeline/render.ts` | 两遍 LLM 渲染，含哈希链缓存、带反馈的重试机制和可选的双次运行验证 |
| `ResultAggregator` | `packages/core/src/validator/aggregator.ts` | 运行全部 18+ 个验证器（渲染前 + 渲染后）并收集 `ValidationIssue[]` |
| `AiSdkProvider` | `packages/core/src/ai/providers/ai-sdk.ts` | 使用 Vercel AI SDK 的生产环境 LLM 提供者 |
| `MockPass2Provider` | `packages/core/src/ai/providers/mock-pass2.ts` | 测试用提供者，支持预先编写的散文 + AnalysisResult |
| `MockProvider` | `packages/core/src/ai/providers/mock.ts` | 简单测试提供者，支持固定响应 |
| `ReviewManager` | `packages/core/src/review/index.ts` | 管理已渲染场景的审阅评论 |
| `FsStorage` | `packages/core/src/storage/fs-storage.ts` | 基于 Node.js 文件系统的 `Storage` 实现 |
| `MemoryStorage` | `packages/core/src/storage/memory-storage.ts` | 测试用的内存 `Storage` |
| `PluginLoader` | `packages/core/src/plugin/index.ts` | 加载外部验证器插件 |
| `SceneCollector` | `packages/core/src/assembler/index.ts` | 收集已渲染的场景以供组装 |

### 核心类型

| 类型 | 源文件 | 描述 |
|------|--------|-------------|
| `NarrativeEvent` | `types/event.ts` | 完整的事件规格，包含前提条件、后置条件、POV、线索进展、伏笔、关系/规则效果、话语元数据 |
| `CharacterDefinition` | `types/character.ts` | 角色 YAML 定义，包含角色类型、特质、语气、背景故事、别名 |
| `RuleDefinition` | `types/rule.ts` | 世界规则，包含 `ruleClass`、`logicalConsequences`、`evidenceChain` |
| `AnalysisContent` | `types/analysis.ts` | 12 个分析块的 Pass 2 分析：postconditions、preconditions、pov、inventedDetails、quality、threadProgressAchieved、foreshadowingDeployed、narrativeChecks、appearanceChecks、characterReferences、tenseDetected、conflictAnalysis |
| `AnalysisResult` | `types/analysis.ts` | `{ eventId, analysis: AnalysisContent }` — 完整的 Pass 2 输出 |
| `ValidationIssue` | `types/validator.ts` | `{ validator, severity, event, entity, attribute, message, fixSuggestion, fixAction, fixTarget }` |
| `PostRenderInput` | `types/validator.ts` | 渲染后验证器的输入：`{ event, worldState, prose, analysis }` |
| `PreRenderInput` | `types/validator.ts` | 渲染前验证器的输入：`{ event, worldState, events, entityRegistry, queryState, getKnowledge, getThreadProgress }` |
| `WorldState` | `types/world.ts` | 当前状态：实体、关系、知识、线索、规则、事实 |
| `ContextPackage` | `types/context.ts` | 为 LLM 渲染编译的 8 层上下文 |

### 核心函数

| 函数 | 源文件 | 用途 |
|----------|--------|---------|
| `compareFact(fact, stateValue)` | `entity/compare.ts` | 单一统一的事实比较函数 → `'match' \| 'mismatch' \| 'deferred'` |
| `buildAnalysisPrompt(input)` | `ai/prompts/render-analysis.ts` | 从场景上下文 + 散文构建 Pass 2 LLM 提示词 |
| `parseAnalysisJSONWithErrors(text)` | `schemas/analysis.ts` | 解析 + Zod 验证 Pass 2 JSON，返回 AnalysisResult 或详细错误 |
| `writeValidationReport(projectDir, report)` | `reporter/validation-reporter.ts` | 写入 `output/validation.md`，包含摘要和问题表格 |
| `calculateISS(input)` | `iss/score.ts` | 计算各维度的实现状态评分（Implementation Status Score） |
| `assembleNovel(options)` | `assembler/index.ts` | 将所有已渲染场景组装为最终的小说输出 |

### 存储抽象层

所有文件系统 I/O 都通过 `Storage` 接口（`packages/core/src/storage/types.ts`）进行：`exists`、`read`、`readOptional`、`write`、`mkdirp`、`list`、`listFiles`、`remove`、`removeAll`。有两种实现：`FsStorage`（Node.js）和 `MemoryStorage`（测试用内存存储）。

## 完整渲染管道示例

```typescript
import {
  EntityMapper, InMemoryEntityRegistry,
  StateManager, ContextCompiler,
  RenderPipeline, FsStorage, AiSdkProvider,
  buildAndWriteOutputs,
} from '@novalistically/core';

// 1. 加载
const mapper = new EntityMapper(projectDir);
const data = mapper.loadProject();
const events = mapper.loadAllEvents(data.chapters);
const registry = new InMemoryEntityRegistry();
registry.load(projectDir);

// 2. 回放
const stateManager = new StateManager('.nova/snapshots');
for (const event of events) stateManager.commit(event);
const state = stateManager.getCurrentState();

// 3. 为每个事件编译上下文
const compiler = new ContextCompiler();
const jobs = events.filter(e => e.id !== 'system:genesis').map(ev => ({
  event: ev,
  stateBefore: stateManager.getStateAt(ev.narrativeOrder - 1),
  context: compiler.compile(ev, state, registry, {
    systemContext: { genre: 'literary', style: 'literary', narrativeRules: [] }
  }),
  chapter: 1,
}));

// 4. 渲染
const provider = new AiSdkProvider({ apiKey: process.env['NOVALISTICALLY_AI_API_KEY'] });
const pipeline = new RenderPipeline({
  provider, model: 'claude-sonnet-4-20250514',
  cacheDir: '.nova/render-cache', storage: new FsStorage(),
});
const results = await pipeline.renderAll(jobs);
buildAndWriteOutputs(new FsStorage(), projectDir, jobs, results);

// 5. 验证
const { validateNovel } = await import('@novalistically/core');
const { passed, results: validationResults, iss } = validateNovel(projectDir);
```

## 公开 API 清单与死代码检测

Monorepo 使用两层防御来防止意外公开内部代码和检测死代码：

### `public-api.manifest.json`

根目录下的 `public-api.manifest.json` 是每个工作区包的权威公开 API 表面。
它枚举了每个包入口的显式值导出和类型导出，以及类型桶（type barrel）文件。
任何未在此清单中声明的导出都被视为内部实现细节，不应被外部依赖。

```jsonc
// 结构示例
{
  "version": 1,
  "packages": {
    "@novalistically/core": {
      "entry": "packages/core/src/index.ts",
      "typeBarrels": ["packages/core/src/types/index.ts"],
      "values": ["EntityMapper", "ReplayEngine", "StateManager", …],
      "types": ["ErrorContext", "Storage", …]
    }
  }
}
```

### `scripts/check-public-api.mjs`

该脚本是一个离线确定性检查器，用于验证清单与实际源导出之间没有漂移。
针对每个包：

1. 验证清单中声明的每个值导出是否存在于入口源中
2. 验证清单中声明的每个类型导出是否存在于入口源中
3. 标记入口源中任何未声明的导出（需要添加到清单或设为内部）
4. 验证声明的类型桶文件存在且仅导出类型
5. 验证 `bin` 条目指向真实文件
6. 验证所有工作区包在清单中有条目

任何漂移都会导致非零退出码。

### `knip.json`

根目录下的 `knip.json` 配置了 [`knip`](https://github.com/webpro/knip) 死代码检测工具。
配置会检查以下每一项：

- **文件** — 每个工作区包中的未使用入口/项目文件
- **导出** — 包入口中未使用的导出
- **依赖** — `package.json` 中未声明的依赖
- **devDependencies** — 应仅作为 `devDependencies` 的依赖

排除项仅限于以下非生产目录和工件：

- `tests/`, `*.test.ts`, `*.test.mjs` — 测试套件
- `dist/` — 构建输出
- `coverage/` — 覆盖率报告
- `output/` — 生成的结果
- `.nova/` — 运行数据
- `.slim/` — 深度工作状态
- `bench-data/` — 下载的数据集
- `*.tsbuildinfo` — 类型脚本构建信息
- `fixtures/` — 测试夹具
- `**/results/` — 基准测试结果

没有对生产代码进行广泛排除。

### `dead-code:knip` 脚本

将公共 API 清单检查器和 Knip 串联到一条命令中：

```bash
npm run dead-code:knip
```

这首先运行 `scripts/check-public-api.mjs`（如果清单与导出不符则失败），
然后运行 `knip`（如果检测到死代码则失败）。
