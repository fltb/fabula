# Workbench 产品化设计执行计划（config 统一 / pi-agent-core 内置 agent / 产品入口收口）

## Context

用户的四项要求：(1) **配置统一**——现在 API URL/key 走 dotenv，但 dotenv 应只服务于启动脚本，agent 与渲染相关配置要收进统一的 workbench 配置系统；(2) **内置 agent 换核**——workbench 后端内置 `@earendil-works/pi-agent-core`，走与外部 agent 相同的 MCP 等价工具入口（接口统一化，便于端到端测试），前端做可视化；(3) **调研本地 agent 运行时（codex 等）发现能力**——结论倾向不做；(4) **产品化收口**——README 强调 workbench 真入口、headless CLI 改名、单一 `npm start` 打开浏览器、首次引导设置、前端 UI 不像半成品、agent-first（用户看不懂产品也能靠内置 agent 聊天学会使用）。

前置事实（已核验）：本文件前身（旧版收敛计划，git 历史可查）已批准但**未执行**——git log 停在 `1443567 docs: add approved ...`，root package.json 仍依赖 `ai`/`@ai-sdk/openai-compatible`，无 `start` 脚本，CLI bin 仍为 `nova`。本计划取代旧版作为执行依据：保留其已验证的骨架（config collapse、provider 换底、agent 换核、CLI 改名、npm start、UI 收口），把每步写成零决策粒度，并按用户新要求修正偏差（见各 Stage 的「决策」注）。

本计划所有外部 API 均已对照发布包核验（`@earendil-works/pi-ai@0.84.1`、`@earendil-works/pi-agent-core@0.84.1`，npm registry dist-tags 均指向 0.84.1）。

---

## Approach

### Stage 1 — 配置统一：单一 `version: 1` + `renderPolicy` 域（要求 1）

目标：workbench.yaml 成为 agent/渲染/网络/限额的唯一配置源；dotenv 只保留在启动脚本；`NOVALISTICALLY_AI_*` 环境变量不再是任何运行时代码的回退来源。

#### 1.1 重写 `packages/workbench-protocol/src/configuration.ts`

删除全部遗留类型/常量：`WORKBENCH_CONFIGURATION_VERSION_V1/V2/V3`、`WorkbenchConfigurationVersion`、`WorkbenchConfigurationV1`（旧单 provider 形状）、`WorkbenchConfigurationV2`、`WorkbenchConfigurationV3`、`WorkbenchConfigurationInput`、`WorkbenchProjectConfigurationV1/V2/V3`、`WorkbenchRevisionMirrorConfigurationV2`、`WorkbenchTrustedPluginConfigurationV3`、`WorkbenchOperationLimitsV3`、`WorkbenchAgentConfigurationV3`、`WorkbenchProviderConfigurationV1/V2`、`WorkbenchNetworkConfigurationV1/V2`、`WorkbenchReferenceLimitsV2`、`DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2`、`DEFAULT_WORKBENCH_OPERATION_LIMITS_V3`、`DEFAULT_WORKBENCH_AGENT_CONFIGURATION_V3`、`normalizeWorkbenchConfiguration` 及其 helper（`copyProvider`/`copyNetwork`/`copyRevisionMirror`）。

保留：`NOVA_EXECUTION_MODE_VALUES`、`NovaStandaloneModeV1`、`NovaViaWorkbenchModeV1`、`NovaModeV1`、`WORKBENCH_DEVICE_CREDENTIAL_ENV`（这些是 CLI 模式契约，与配置无关）。

写入唯一规范形状（**属性顺序即 canonical YAML 顺序，逐字段照抄**）：

```typescript
export const WORKBENCH_CONFIGURATION_VERSION = 1 as const;
export type WorkbenchConfigurationVersion = typeof WORKBENCH_CONFIGURATION_VERSION;

export interface WorkbenchProjectConfigurationV1 {
  readonly projectId: string;
  readonly displayName: string;
  readonly root: string;
  readonly revisionMirror: { readonly mode: 'disabled' } | { readonly mode: 'git-best-effort'; readonly ref: string };
  readonly providerProfile: string;
  readonly trustedPlugins: readonly { readonly name: string; readonly version: string; readonly moduleHash: string; readonly required: boolean }[];
}

export interface WorkbenchOperationLimitsV1 {
  readonly maxQueuedPerProject: number;
  readonly maxConcurrentRendersPerProject: 1;
  readonly maxConcurrentRendersPerHost: number;
}

export interface WorkbenchAgentConfigurationV1 {
  readonly enabled: boolean;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}

export interface WorkbenchProviderConfigurationV1 {
  readonly kind: 'ai-sdk' | 'pi';
  readonly baseUrl: string | null;
  readonly model: string | null;
}

export interface WorkbenchNetworkConfigurationV1 {
  readonly mode: 'loopback' | 'lan' | 'unix';
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly unixSocket: string | null;
}

export interface WorkbenchReferenceLimitsV1 {
  readonly enabled: boolean;
  readonly maxFileBytes: number;
  readonly maxBytesPerProject: number;
  readonly maxItemsPerProject: number;
  readonly maxPendingJobsPerProject: number;
  readonly maxChunksPerProject: number;
  readonly maxExtractedCharactersPerProject: number;
  readonly maxChunkCharacters: number;
  readonly chunkOverlapCharacters: number;
  readonly extractionTimeoutMs: number;
  readonly mcpImportChunkBytes: number;
}

export interface WorkbenchRenderPolicyV1 {
  readonly pass1: { readonly temperature: number; readonly maxTokens: number };
  readonly pass2: { readonly temperature: number; readonly maxTokens: number; readonly seed: number };
}

export interface WorkbenchConfigurationV1 {
  readonly version: 1;
  readonly projects: readonly WorkbenchProjectConfigurationV1[];
  readonly defaultProjectId: string | null;
  readonly providers: Readonly<Record<string, WorkbenchProviderConfigurationV1>>;
  readonly network: WorkbenchNetworkConfigurationV1;
  readonly referenceLimits: WorkbenchReferenceLimitsV1;
  readonly operationLimits: WorkbenchOperationLimitsV1;
  readonly agent: WorkbenchAgentConfigurationV1;
  readonly renderPolicy: WorkbenchRenderPolicyV1;
}
```

决策：`providers.<profile>.kind` 取值改为 `'ai-sdk' | 'pi'`（保留 `'ai-sdk'` 为向后兼容已有 workbench.yaml，`'pi'` 为 pi-ai 后端；本阶段 setup/admin 只写 `'pi'`，校验器两个值都接受，生产构造按 kind 分支，未知 kind 视为校验错误）。默认常量去后缀：`DEFAULT_WORKBENCH_REFERENCE_LIMITS`、`DEFAULT_WORKBENCH_OPERATION_LIMITS`、`DEFAULT_WORKBENCH_AGENT_CONFIGURATION`、`DEFAULT_WORKBENCH_NETWORK`（`{mode:'loopback', port:8787, allowedHosts:[], allowedOrigins:[], unixSocket:null}`）、`DEFAULT_WORKBENCH_RENDER_POLICY`：

```typescript
export const DEFAULT_WORKBENCH_RENDER_POLICY: WorkbenchRenderPolicyV1 = {
  pass1: { temperature: 0.8, maxTokens: 10_000 },
  pass2: { temperature: 0.3, maxTokens: 12_000, seed: 42 },
};
```

数值必须与 core 现有硬编码一致（见 1.9）；Stage 1.10 加一个跨包断言测试防止漂移。`DEFAULT_WORKBENCH_REFERENCE_LIMITS`/`DEFAULT_WORKBENCH_OPERATION_LIMITS`/`DEFAULT_WORKBENCH_AGENT_CONFIGURATION` 值照抄当前 V3 默认常量（`enabled:false, maxTurns:16, maxToolCalls:64` 等，行号见 ConfigLandscape 报告）。

删除 `WorkbenchConfigurationInput` 与 `normalizeWorkbenchConfiguration`：所有读写直接操作规范形状，不再有迁移分支。

#### 1.2 `packages/workbench/src/contracts/configuration.ts`

- 删除 V2/V3 再导出块（当前 47-66 行区域：`WorkbenchConfigurationV2/V3`、`WorkbenchConfigurationInput`、`WorkbenchProjectConfigurationV2/V3`、`WorkbenchTrustedPluginConfigurationV3`、`normalizeWorkbenchConfiguration`、`DEFAULT_WORKBENCH_*_V2/V3`、`WORKBENCH_CONFIGURATION_VERSION_V2/V3`）。
- 删除 host 侧旧单 provider `WorkbenchConfigurationV1`（105-111 行区域）。
- `import { WorkbenchConfigurationV1, WORKBENCH_CONFIGURATION_VERSION, ... } from '@novalistically/workbench-protocol'` 并 re-export；`WorkbenchConfigurationVersion = 1`。
- 保留：`PROJECT_ACCESS_ROLES`、`PROJECT_ACCESS_ROLE_GRANTS`（35-44，不动）、`ConfigChangeRequestV1`、`ConfigOperationReceiptV1`、`WorkbenchProviderConfigurationV1`、`WorkbenchNetworkConfigurationV1`、全部 safe read views、全部 admin mutation request 类型。

#### 1.3 `packages/workbench/src/host/configuration-file-store.ts`

- 删除 `validateConfigurationV2Shape`（302-427 区域）与遗留 V1 validator 块（827-940 区域）。
- 删除版本分发块（745-760 区域），替换为单一检查：`if (value.version !== 1) → CONFIG_INVALID`（`value` 先经 YAML parse + 未知 key 拒绝）。
- 删除 `PROJECT_KEYS_V1/V2/V3` → 保留一份 `PROJECT_KEYS`（V3 字段：`projectId/displayName/root/revisionMirror/providerProfile/trustedPlugins`）；删除 `CONFIGURATION_KEYS_V2/V3` → `CONFIGURATION_KEYS`（`version/projects/defaultProjectId/providers/network/referenceLimits/operationLimits/agent/renderPolicy`）；`NETWORK_KEYS`/`PROVIDER_KEYS`（`['kind','baseUrl','model']`）/`TRUSTED_PLUGIN_KEYS`/`OPERATION_LIMIT_KEYS`/`AGENT_KEYS`（`['enabled','maxTurns','maxToolCalls']`）/`REFERENCE_LIMIT_KEYS` 保留，新增 `RENDER_POLICY_KEYS`（`['pass1','pass2']`）、`RENDER_PASS_KEYS`（`['temperature','maxTokens']`）、`RENDER_PASS2_KEYS`（`['temperature','maxTokens','seed']`）。
- `validateConfigurationShape` 内 V3 shape validator（368-427 区域）改造为规范 V1 validator：`renderPolicy` 用 `numberField` 校验非负整数/有限数（temperature 允许 0≤t≤2 的有限数，maxTokens/seed 为非负整数）；`providers.<id>.kind` 校验 `'ai-sdk' | 'pi'`；其余校验逻辑（projectId 正则、root 绝对路径、defaultProjectId 注册、network 约束、`maxConcurrentRendersPerProject === 1`、agent/limits 非负整数）原样保留。
- `toPlain`（123-174）按新属性顺序输出 `version: 1` + 全部域（含 `renderPolicy`）；`serializeConfigurationYaml`（177-180）删除 `normalizeWorkbenchConfiguration()` 调用，直接序列化规范形状；`configurationRevision`（183-188）hash 覆盖新形状。
- `validateConfigurationTopology`（1040+）接收规范 V1 形状，逻辑不变。

#### 1.4 `packages/workbench/src/host/configuration-service.ts`

- 删除全部 `normalizeWorkbenchConfiguration` 调用（139/140/422/482 行区域）。
- `ActiveConfiguration.configuration: WorkbenchConfigurationV1`（87-90）。
- `computeChangedFields`（112-215）：两侧均为规范形状直接比较；新增 `renderPolicy.pass1.temperature` / `.pass1.maxTokens` / `.pass2.temperature` / `.pass2.maxTokens` / `.pass2.seed` 变更路径。
- `requiresRestart`（218-242）：`renderPolicy` 变更加入 restart-required 集合（采样影响 cache identity）。
- `apply`（322+）：candidate 类型为 `WorkbenchConfigurationV1`。

#### 1.5 `packages/workbench/src/host/setup-api.ts`

- 删除遗留 V1 draft 分支（336-445 区域），`EMPTY_DRAFT` 改为规范形状：`version:1, projects:[], defaultProjectId:null, providers:{}, network: DEFAULT_WORKBENCH_NETWORK, referenceLimits/operationLimits/agent/renderPolicy` 全部用默认常量。
- setup 各 handler 改为写规范形状：`validateProviderHandler` 写 `providers[<profile>] = {kind:'pi', baseUrl, model}`（profile 名默认 `'default'`，即 `DEFAULT_PROVIDER_PROFILE`）；`saveCredentialHandler` 仍写 credential store（key `ai-sdk:default` 保留——见 8.1，本轮不改 key 前缀，只删裸 key 回退）。
- `finishHandler`（679+）`configuration.apply({candidate: 规范形状, expectedRevision: null, origin: 'setup'})`，无迁移分支。

- `packages/workbench/src/host/workbench-launch.ts`（config 部分）

- 删除 `normalizeWorkbenchConfiguration` import 与调用（852 行区域）。
- 若存在 `WorkbenchConfigurationSeam` 类型别名（852 行区域，收敛 plan 曾命名，以实际代码为准）则删除，直接使用 `WorkbenchConfigurationV1`。
- `configuredProjects`（885-896）删除对 `activeConfiguration?.projects ?? env 预填` 的 env 分支依赖：**决策**——env 预填（`WORKBENCH_PROJECT_ROOT/PROJECT_ID/DISPLAY_NAME`）仅在 `activeConfiguration === null`（未配置）时生效，workbench.yaml 存在后 env 预填完全忽略（现状 `??` 已满足，保持并补注释）；删除 894-898 的 `providerProfile:'default'` 硬编码不再需要（预填形状已含 providerProfile）。
- `v1Candidate`（2042-2055 区域）仅剩与 admin 相关使用处：确认其消费者后，把 `provider`/`network` 从 `activeConfiguration.providers.default ?? null` / `activeConfiguration.network ?? 默认` 改为直接读规范形状（`providers.default` / `network`），若某处只剩死调用则整函数删除。
- provider 构造（876-882）与 agent 模型构造（1307-1335）改为按 `kind` 分支（`'pi'` → Stage 2/3 的 pi 构造；`'ai-sdk'` → 保留现有 `AiSdkProvider` 路径直到 Stage 2 完成后删除——Stage 2 会同时删 `AiSdkProvider`，届时 `'ai-sdk'` kind 仍可被校验但构造按 `'pi'` 兜底并告警，见 Stage 2.4 决策）。

#### 1.7 `packages/workbench-protocol/tests/configuration.test.ts`

删除 `normalizeWorkbenchConfiguration` 全套与 V1/V2/V3 迁移 fixtures。新增：
- canonical round-trip：`serialize → parse → serialize` 逐字节一致；
- defaults：`EMPTY_DRAFT` 形状（空 projects/providers）验证通过；
- `DEFAULT_WORKBENCH_RENDER_POLICY` 数值断言（0.8/10000/0.3/12000/42）。

#### 1.8 workbench 测试 fixtures 改 version

`version: 3` / `version: 2` → `version: 1` 并补 `renderPolicy` 域：
- `packages/workbench/tests/configuration-file-store.test.ts`（144/212 行区域，`baseConfigurationV3` → `baseConfiguration`）
- `packages/workbench/tests/configuration-service.test.ts`
- `packages/workbench/tests/launch-phase1a.test.ts`（1819 行区域 `v3Configuration` helper）
- `packages/workbench/tests/setup-api.test.ts`
- `packages/workbench/tests/agent-parity-matrix.test.ts`（607 行区域）
- `packages/workbench/tests/e2e/harness/host-fixture.ts`（`serializeV3ConfigYaml` → 写 `version: 1`，270 行区域）
- `packages/workbench/tests/e2e/plugin-snapshot.spec.ts`
- `packages/workbench/scripts/smoke-agent-live.mjs`：`DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2` import（37 行区域）→ `DEFAULT_WORKBENCH_REFERENCE_LIMITS`；如 smoke 构造配置对象则补 `renderPolicy`。

#### 1.9 renderPolicy 进 core（渲染采样可配置）

- `packages/core/src/types/editorial.ts`：`EditorialRuntime`（134-150）新增可选字段：
```typescript
readonly renderPolicy?: {
  readonly pass1Temperature?: number;
  readonly pass1MaxTokens?: number;
  readonly pass2Temperature?: number;
  readonly pass2MaxTokens?: number;
  readonly pass2Seed?: number;
};
```
- `packages/core/src/pipeline/render.ts`：
  - 构造函数新增 options 字段 `pass1Temperature?: number; pass1MaxTokens?: number; pass2Temperature?: number; pass2MaxTokens?: number; pass2Seed?: number`，存入私有字段；默认值 = 现有常量（Pass1 temp `0.8`（832/880）、Pass1 maxTokens `10_000`（345）、`PASS2_SAMPLING_CONFIG`（107-112）的 0.3/12000/42）。
  - Pass 1 请求构造（832/880）：`temperature: this.pass1Temperature`；Pass 1 maxTokens（345）：`opts.maxTokens ?? this.pass1MaxTokens`。
  - Pass 2 请求构造（1005-1010、1030、1084-1089、1100、1128、1160-1174）：全部 `seed: 42` 内联替换为 `this.pass2Seed`，`temperature`/`maxTokens` 用 `this.pass2Temperature`/`this.pass2MaxTokens`。
  - `samplingConfigHash`（423）：改为对**生效值**（`{pass1:{temperature,maxTokens}, pass2:{temperature,maxTokens,seed}, responseFormat}`）做 `sha256Canonical`——默认值与现状一致，默认配置下 cache identity 不变。保留 `PASS2_REFERENCE_POLICY_VERSION='1'`。
  - `buildPipeline()`（render-service.ts）把 `runtime.renderPolicy` 透传进 `RenderPipeline` options；`RenderPipelineOptions`（260-262/301-302）按上述新增字段扩展。
  - `EditorialRenderRequestV1`（152-171）不加字段——renderPolicy 只来自 `EditorialRuntime`（决策：渲染采样是 Host 级配置，不是单次请求参数）。

#### 1.10 dotenv 边界 + env-vs-file 优先级 + 防漂移断言

- `packages/bench/scripts/generate-reference.mjs:26` 与 `scripts/zhu-fu-live-fidelity-run.mjs:16` 删除 `import 'dotenv/config'`；两个脚本头部注释加「需在 shell 显式导出 `NOVALISTICALLY_AI_API_KEY/BASE_URL/MODEL`，不加载 .env」。（决策：dotenv 只保留在 `packages/workbench/scripts/dev.mjs`/`start.mjs`，与「dotenv 只负责启动脚本」一致。）
- `packages/workbench/scripts/smoke-agent-live.mjs:49-55` 保持显式 `process.env` 读取并 fail-closed（它本来就是独立 dev 工具，不加载 dotenv）。
- 新增跨包断言测试 `packages/workbench/tests/render-policy-defaults.test.ts`：断言 `DEFAULT_WORKBENCH_RENDER_POLICY`（protocol）与 core 默认采样常量（`PASS2_SAMPLING_CONFIG` + Pass1 默认）数值一致，防止两处默认漂移。
- `.env.example` 更新：删除/改写「Optional legacy development prefill」（`WORKBENCH_PROJECT_ROOT/PROJECT_ID/DISPLAY_NAME`）区块为 dev-only 说明；加一行说明「agent/渲染/网络/限额配置一律在 `$WORKBENCH_HOME/config/workbench.yaml`，启动脚本环境变量只负责路径/端口/mode」。

### Stage 2 — Provider 换底：`AiSdkProvider`/AI SDK → `@earendil-works/pi-ai`（要求 2 前置）

目标：`NOVALISTICALLY_AI_*` 环境变量回退从运行时代码消失（凭据只走 credential store，baseUrl/model 只走 workbench.yaml）。

#### 2.1 依赖

- `packages/node-host/package.json`：加 `"@earendil-works/pi-ai": "^0.84.1"`；删 `"@ai-sdk/openai-compatible"` 与 `"ai"`。
- root `package.json` dependencies 删 `"@ai-sdk/openai-compatible"` 与 `"ai"`。
- `npm install` 更新 lockfile。

#### 2.2 删除 `packages/node-host/src/providers/ai-sdk.ts`，新建 `packages/node-host/src/providers/pi-provider.ts`

删除整个 `ai-sdk.ts`（含 `AiSdkClientOptions`/`createAiSdkModelClient`/`AiSdkProvider`/`AiSdkModelClient` 及 43-48 行的 env 回退）。

`pi-provider.ts` 内容（已对照 0.84.1 类型核验）：

```typescript
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const PI_DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
export const PI_DEFAULT_MODEL = 'deepseek-v4-flash-free';

export interface PiProviderStack {
  readonly models: MutableModels;
  readonly provider: Provider<Api>;
  readonly model: Model<Api>;
}

/** Build one provider + model for an OpenAI-compatible endpoint. `apiKey` may
 * be empty (unauthenticated local servers); callers that require auth must
 * check it before calling. Never reads process.env. */
export function createPiProviderStack(options: {
  readonly baseURL?: string | null;
  readonly apiKey?: string;
  readonly modelId?: string | null;
  readonly reasoning?: boolean;
  readonly maxTokens?: number;
  readonly contextWindow?: number;
}): PiProviderStack {
  const baseUrl = options.baseURL ?? PI_DEFAULT_BASE_URL;
  const modelId = options.modelId ?? PI_DEFAULT_MODEL;
  const apiKey = options.apiKey ?? '';
  const models = createModels();
  const provider = createProvider({
    id: 'pi-provider',
    name: 'Pi Provider',
    baseUrl,
    auth: {
      apiKey: {
        name: 'API Key',
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'openai-completions' as const,
        provider: 'pi-provider',
        baseUrl,
        reasoning: options.reasoning ?? true,
        input: ['text'] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: options.maxTokens ?? 32_000,
      },
    ],
    api: openAICompletionsApi(),
  });
  models.setProvider(provider);
  const model = models.getModel('pi-provider', modelId);
  if (model === undefined) throw new Error(`pi model not found: ${modelId}`);
  return { models, provider, model };
}
```

#### 2.3 新建 `packages/node-host/src/providers/pi-openai-compatible.ts`

实现 `LLMProvider`（core 契约，原 `AiSdkProvider` 的角色），供渲染管线使用：

```typescript
import { type CompletionRequest, type CompletionResponse, LLMError, type LLMProvider } from '@novalistically/core';
import { createPiProviderStack, PI_DEFAULT_BASE_URL, PI_DEFAULT_MODEL, type PiProviderStack } from './pi-provider.js';

export interface PiOpenAICompatibleProviderOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly model?: string;
  /** 决策：taskType 路由保留原 AiSdkProvider 的语义；未配置路由时用 model。 */
  readonly routing?: { readonly default?: string; readonly pass1?: string; readonly pass2?: string; readonly summary?: string };
}

export class PiOpenAICompatibleProvider implements LLMProvider {
  readonly name = 'pi-openai-compatible';
  readonly #stack: PiProviderStack;
  readonly #options: PiOpenAICompatibleProviderOptions;
  constructor(options: PiOpenAICompatibleProviderOptions = {}) {
    this.#options = options;
    this.#stack = createPiProviderStack({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      modelId: options.model ?? options.routing?.default ?? PI_DEFAULT_MODEL,
    });
  }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const modelId = this.#modelIdFor(request.taskType);
    const apiKey = this.#options.apiKey ?? '';
    if (!apiKey) throw new LLMError('apiKey is required', { provider: this.name });
    const model = this.#stack.models.getModel('pi-provider', modelId);
    if (model === undefined) throw new LLMError(`Model ${modelId} not found`, { provider: this.name });
    try {
      const result = await this.#stack.models.completeSimple(model, {
        systemPrompt: undefined,
        messages: request.messages.map((m) => ({
          role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: [{ type: 'text', text: m.content }],
          timestamp: Date.now(),
        })),
      }, {
        apiKey,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });
      const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return {
        id: result.responseId ?? this.name,
        model: modelId,
        content: text,
        usage: { promptTokens: result.usage.input, completionTokens: result.usage.output, totalTokens: result.usage.input + result.usage.output },
        finishReason: result.stopReason === 'error' ? 'error' : result.stopReason === 'length' ? 'length' : 'stop',
      };
    } catch (error) {
      throw new LLMError(`pi-ai error: ${(error as Error).message}`, { provider: this.name, cause: error });
    }
  }
  #modelIdFor(taskType?: string): string {
    const routing = this.#options.routing;
    if (!routing || !taskType) return this.#options.model ?? PI_DEFAULT_MODEL;
    if (taskType === 'pass1' && routing.pass1) return routing.pass1;
    if (taskType === 'pass2' && routing.pass2) return routing.pass2;
    if (taskType === 'summary' && routing.summary) return routing.summary;
    return routing.default ?? this.#options.model ?? PI_DEFAULT_MODEL;
  }
}
```

（`LLMError`/`CompletionRequest`/`CompletionResponse`/`LLMProvider` 字段名以 core 现有 `ai-sdk.ts` 的实际 import 为准，逐字段对齐；`Usage` 各字段是否可空按 core 类型定义处理。）

#### 2.4 替换调用点

- `packages/node-host/src/index.ts`：删 `AiSdkProvider`/`AiSdkModelClient`/`AiSdkProviderOptions`/`createAiSdkModelClient` 导出；新增 `export { PiOpenAICompatibleProvider, type PiOpenAICompatibleProviderOptions } from './providers/pi-openai-compatible.js'` 与 `export { createPiProviderStack, PI_DEFAULT_BASE_URL, PI_DEFAULT_MODEL, type PiProviderStack } from './providers/pi-provider.js'`。
- `packages/workbench/src/host/providers/provider-factory.ts`：`AiSdkProvider` import → `PiOpenAICompatibleProvider`；`createForProfile`（220-263）按 `configuration.kind` 分支——`'pi'`（新默认）构造 `new PiOpenAICompatibleProvider({baseURL: configuration.baseUrl ?? PI_DEFAULT_BASE_URL, apiKey, model: configuration.model ?? PI_DEFAULT_MODEL})`；`'ai-sdk'` 保留旧构造（AiSdkProvider 已删——**决策**：`'ai-sdk'` kind 读入后按 `'pi'` 构造并 `console.warn` 一次「legacy kind ai-sdk treated as pi」；`DEFAULT_AI_SDK_BASE_URL/MODEL` 常量删除，改用 `PI_DEFAULT_BASE_URL/PI_DEFAULT_MODEL`）。`create()`（213-217）走 `providers.default ?? 默认` 不变。
- `packages/cli/src/index.ts`：`AiSdkProvider` import → `PiOpenAICompatibleProvider`，构造处替换（与 provider-factory 相同模式；CLI 侧无 credential store，`apiKey` 来自 `NOVALISTICALLY_AI_API_KEY` env 或显式 option——保留 CLI 显式 env 语义，**不改**，CLI 不加载 dotenv 的既定行为不变）。
- `packages/bench/scripts/generate-reference.mjs`：`AiSdkProvider` → `PiOpenAICompatibleProvider`（env 显式传入不变）。

#### 2.5 测试

- `packages/node-host/tests/ai-sdk-provider.test.ts` → 删除，新建 `pi-openai-compatible-provider.test.ts`：用 `vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', ...)` 或 stub fetch 断言 `complete()` 的请求/响应映射（temperature/maxTokens/signal 透传、错误映射 `LLMError`、空 apiKey 抛错）。
- `packages/node-host/tests/ai-sdk-structured-output.test.ts` → 删除（pi-ai 以 `responseFormat`/grammar 处理结构化输出，不属于本交付；原测试覆盖的 Pass 2 JSON 由 `responseFormat: {type:'json_object'}` 经 samplingParams 在 render 层保证——见 1.9 保持 `responseFormat` 不变）。
- `packages/node-host/tests/agent-model.test.ts` → 删除（agent model 在 Stage 3 整体删除）。
- `packages/core/tests/public-contract.test.ts:64`：`AiSdkProvider` 断言改为 `PiOpenAICompatibleProvider`。

### Stage 3 — Agent 换核：AI SDK 手写 loop → `@earendil-works/pi-agent-core`（要求 2 核心）

目标：内置 agent 的驱动循环换成 pi-agent-core `Agent`；工具面仍是 `ProjectToolExecutor`（与外部 MCP 设备同一 registry、同一 scope 过滤），实现「pi agent 走 MCP 等价入口」；删除自写 harness 的模型循环。

**前端通信架构（回答「pi 有没有现成通信实现」）**：已核验 `@earendil-works/pi-agent-core@0.84.1` exports 只有主入口/`./node`/`./session/testing`，**无任何 UI/chat/web/transport 组件**（`AgentOptions.transport` 是会话持久化传输，非前端通道）。因此前端不 import 任何 pi 包；通信层就是既有 `browser-agent-chat-api.ts`（HTTP + SSE，secret-free DTO）：浏览器 POST run → Host 进程内跑 pi `Agent` → `agent.subscribe` 事件映射为 `AgentChatProgressEventV1` 经 SSE 推回。pi 只活在 Host 进程内，本 Stage 只换 Host 内部实现，前端契约不变。

#### 3.1 依赖

`packages/workbench/package.json` 加 `"@earendil-works/pi-agent-core": "^0.84.1"`（其 peer 依赖 `@earendil-works/pi-ai` 由 node-host 的依赖满足——**决策**：workbench 直接声明 `"@earendil-works/pi-ai": "^0.84.1"` 为依赖，避免 peer 解析歧义）。`npm install`。

#### 3.2 新建 `packages/workbench/src/host/agent/pi-agent-model.ts`

生产侧模型装配（供 launch 与 smoke 复用；测试注入脚本 stream，不经过此文件）：

```typescript
import type { Api, Model, StreamFn } from '@earendil-works/pi-ai';
import { createPiProviderStack } from '@novalistically/node-host';

export interface PiAgentModel {
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
}

/** Build the pi-ai model + streamFn for one project profile. Never reads process.env. */
export function createPiAgentModel(options: {
  readonly baseURL?: string | null;
  readonly apiKey?: string;
  readonly modelId?: string | null;
}): PiAgentModel {
  const stack = createPiProviderStack(options);
  return { model: stack.model, streamFn: stack.models.streamSimple.bind(stack.models) };
}
```

#### 3.3 `packages/workbench/src/host/agent/run-service.ts` 换核

接口变更（**保留**全部外层契约，仅替换 `model` 注入点）：

```typescript
// 删 import：AgentModelMessage / AgentToolSpec / WorkbenchAgentModelPort
// 增 import：
import { Agent, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';   // pi-ai re-export typebox
import type { Api, Model, StreamFn } from '@earendil-works/pi-ai';

export interface WorkbenchAgentRunServiceOptions {
  readonly projectId: string;
  readonly store: AgentStore;
  readonly executor: ProjectToolExecutor;
  /** pi-ai model + streamFn；测试注入脚本实现。 */
  readonly agentModel: { readonly model: Model<Api>; readonly streamFn: StreamFn };
  readonly operations: ProjectOperationService;
  readonly agent: { readonly maxTurns: number; readonly maxToolCalls: number };
  readonly isWorkflowComplete?: () => boolean | Promise<boolean>;
  readonly now?: () => string;
}
```

删除 `buildAgentSystemPrompt` 的 `AgentToolSpec[]` 参数依赖——签名改为 `buildAgentSystemPrompt(projectId: string, role: ProjectAccessRole, tools: readonly AgentTool[]): string`（`tools.map(t => `- ${t.name}: ${t.description}`)` 不变）。**决策（用户明确）**：提示词正文**保持现有英文内容不动**（只改参数类型），不翻译成中文、不重写——`buildAgentSystemPrompt` 的模板文字与现有 171-184 行区域逐字保持，仅 `AgentToolSpec` 引用替换为 `AgentTool`。

`sendMessage` 的 `initialMessages` 类型从 `AgentModelMessage[]` 改为 pi 的 `AgentMessage[]`：
```typescript
const initialMessages: AgentMessage[] = [{ role: 'user', content: input.message, timestamp: Date.now() }];
```
（`retry` 的 `firstUser.content` 读取不变。）

`runLoop` 内部（327-570 区域整体重写；外层 waitForRunRecord/transitionRun/failRun/publish 保留）：

```typescript
const scopes = PROJECT_ACCESS_ROLE_GRANTS[principal.role].scopes;
const caller = executor.callerForRole(principal);
const tools: AgentTool[] = executor.listTools(scopes).map((definition) => ({
  name: definition.name,
  description: definition.description,
  parameters: Type.Unsafe(definition.inputSchema as unknown as TSchema),
  label: definition.name,
  // 执行体里算好 bounded summary；details 携带 {ok, errorCode, summary} 供订阅者落库
  execute: async (toolCallId: string, params: unknown) => {
    const result = await executor.callTool(definition.name, caller, params);
    const summary = resultSummaryOf(result);
    return {
      content: [{ type: 'text', text: summary }],
      details: { ok: result.ok, errorCode: result.error?.code ?? null, summary },
    };
  },
}));
const toolNames = new Set(tools.map((t) => t.name));
const system = buildAgentSystemPrompt(projectId, principal.role, tools);

let failure: { code: AgentRunFailureCode; message: string } | null = null;
let toolCallsUsed = 0;
let turn = 0;
let current = started.record;
const assistantTextByTurn: string[] = [];   // 每 turn 累积（index = turn-1）
const callIndexByCallId = new Map<string, number>();   // toolCallId → callIndex（防并行/乱序）

const agent = new Agent({
  streamFn: options.agentModel.streamFn,
  initialState: {
    systemPrompt: system,
    model: options.agentModel.model,
    thinkingLevel: 'off',
    tools,
    messages: [],
  },
  // 决策：顺序执行（与旧 loop 逐一 await 语义一致；MCP 工具多带 authoring 副作用，
  // 并发执行会引入 store-first 顺序与 callIndex 不确定性）。
  toolExecution: 'sequential',
  beforeToolCall: async ({ toolCall }) => {
    if (ctx.signal.aborted) return { block: true, reason: 'ABORTED', terminate: true };
    if (!toolNames.has(toolCall.name)) {
      failure = { code: 'AGENT_TOOL_NOT_IN_CATALOG', message: `The model requested a tool outside the registry: ${toolCall.name}` };
      return { block: true, reason: 'TOOL_NOT_IN_CATALOG', terminate: true };
    }
    if (toolCallsUsed >= maxToolCalls) {
      failure = { code: 'AGENT_MAX_TOOL_CALLS_EXCEEDED', message: 'The run exceeded its tool-call budget.' };
      return { block: true, reason: 'MAX_TOOL_CALLS_EXCEEDED', terminate: true };
    }
    return undefined;
  },
  afterToolCall: async () => {
    if (options.isWorkflowComplete !== undefined && (await options.isWorkflowComplete())) {
      return { terminate: true };
    }
    return undefined;
  },
});
const onAbort = () => agent.abort();
ctx.signal.addEventListener('abort', onAbort, { once: true });
const unsubscribe = agent.subscribe((event: AgentEvent) => {
  switch (event.type) {
    case 'turn_start':
      turn += 1;
      if (turn > maxTurns) {
        failure = { code: 'AGENT_MAX_TURNS_EXCEEDED', message: 'The run exceeded its turn budget.' };
        agent.abort();
        return;
      }
      void store.checkpointRun({ runId, turn, at: now() });
      return;
    case 'message_update': {
      const e = event.assistantMessageEvent;
      if (e.type === 'text_delta') {
        assistantTextByTurn[turn - 1] = (assistantTextByTurn[turn - 1] ?? '') + e.delta;
        publish(runId, { type: 'assistant-text', runId, text: e.delta, at: now() });
      }
      return;
    }
    case 'tool_execution_start': {
      toolCallsUsed += 1;
      const callIndex = current.toolCalls;
      callIndexByCallId.set(event.toolCallId, callIndex);
      const pending = await store.appendToolCall({
        version: 1, runId, callIndex,
        toolName: event.toolName,
        sanitizedArgsHash: digestOf(event.args),
        resultRef: null, turn, status: 'pending', createdAt: now(),
      });
      publish(runId, { type: 'tool-call', runId, call: receiptViewOf(pending) });
      return;
    }
    case 'tool_execution_end': {
      const callIndex = callIndexByCallId.get(event.toolCallId);
      if (callIndex === undefined) return;   // 防御：未见过 start 的 end 不落库
      const details = (event.result?.details ?? {}) as { ok?: boolean; errorCode?: string | null; summary?: string | null };
      const summary = details.summary ?? null;
      const completed = await store.updateToolCallStatus({
        runId, callIndex,
        status: event.isError ? 'failed' : 'succeeded',
        resultRef: summary, at: now(),
      });
      publish(runId, { type: 'tool-call', runId, call: receiptViewOf(completed) });
      publish(runId, { type: 'tool-result', runId, callIndex, status: event.isError ? 'failed' : 'succeeded', resultSummary: summary, at: now() });
      current = { ...current, toolCalls: Math.max(current.toolCalls, callIndex + 1) };
      return;
    }
    case 'turn_end': {
      const text = assistantTextByTurn[turn - 1];
      if (text !== undefined && text.length > 0) {
        void store.appendMessage({ ... });   // Stage 4 落地，本 Stage 先留 TODO 占位，见 4.2
      }
      return;
    }
  }
});
try {
  await agent.prompt(initialMessages);
  await agent.waitForIdle();
} finally {
  ctx.signal.removeEventListener('abort', onAbort);
  unsubscribe();
}

if (ctx.signal.aborted) {
  const cancelled = await store.transitionRun({ runId, status: 'cancelled', expectedStatus: 'running', at: now() });
  publish(runId, { type: 'run-status', run: await runView(cancelled.record) });
  return { status: 'cancelled' };
}
if (failure === null && agent.state.errorMessage !== undefined && agent.state.errorMessage.length > 0) {
  failure = { code: 'AGENT_MODEL_ERROR', message: errorMessageOf(agent.state.errorMessage) };
}
if (failure !== null) {
  return failRun(runId, failure.code, failure.message);
}
const finalTurn = Math.max(1, turn);
const finished = await store.transitionRun({
  runId, status: 'succeeded', expectedStatus: 'running',
  turn: finalTurn, toolCalls: current.toolCalls, at: now(),
});
publish(runId, { type: 'run-status', run: await runView(finished.record) });
return {
  status: 'succeeded',
  result: { runId, conversationId: started.record.conversationId, projectId, status: 'succeeded', turn: finalTurn, toolCalls: current.toolCalls },
};
```

关键语义（对照旧 loop 逐条保持）：
- **Catalog-only**：`beforeToolCall` block + `failure` 标记 → `prompt` 结束后 `failRun('AGENT_TOOL_NOT_IN_CATALOG')`。旧行为「run 以 typed code 失败」保持。
- **maxToolCalls**：`beforeToolCall` 计数 + block + failure 标记 → `failRun('AGENT_MAX_TOOL_CALLS_EXCEEDED')`。
- **maxTurns**：`turn_start` 计数，超限置 failure + `agent.abort()` → 结束后 `failRun('AGENT_MAX_TURNS_EXCEEDED')`。
- **isWorkflowComplete**：`afterToolCall` 返回 `{terminate:true}`（批量终止）；结束后走 succeeded。
- **取消**：`ctx.signal` → `agent.abort()`；结束后 `ctx.signal.aborted` 分支 → cancelled 转态（与旧一致）。
- **Store-first**：`tool_execution_start` 先 `appendToolCall` 再 publish；`tool_execution_end` 先 `updateToolCallStatus` 再 publish；`run-status` 一律在转态后 publish。SSE 事件名/载荷不变（本 Stage 不改 SSE 契约）。
- **模型错误**：`agent.prompt`/`waitForIdle` 抛错或 `agent.state.errorMessage` 非空 → `failRun('AGENT_MODEL_ERROR', errorMessageOf(...))`；`agent_end` 后检查 `agent.state.errorMessage`。
- `transcripts` map、`retry`、`cancel`、`history`、`snapshot`、`subscribeProgress`、`close` 全部不动。

`AgentTool` 的 `parameters` 用 `Type.Unsafe`（registry 的 JSON Schema 对象）；pi-ai `validateToolArguments` 对非 typebox schema 走 JSON-schema 校验+coercion（已核验 `utils/validation.js:247-267`），registry 的 `run()` 本身也会再校验输入。

#### 3.4 `packages/workbench/src/host/workbench-launch.ts`（agent 部分）

- 删 `createWorkbenchAgentModelAdapter`/`WorkbenchAgentModelPort` import；`WorkbenchLaunchConfig.agentModel`（218 行区域）类型改为 `{ readonly model: Model<Api>; readonly streamFn: StreamFn } | undefined`（测试注入 seam，语义不变）。
- 1307-1335 区域：`agentModel` 为空时用 `createPiAgentModel({ baseURL: profileConfig?.baseUrl, apiKey: await credentialStore.get(providerCredentialKey(profileId))..., modelId: profileConfig?.model })` 构造（try/catch 保留 fail-closed）；删除 `supportsToolCalls` 内部门控（1328 行区域；pi 模型全支持工具调用——决策：`agentChatEnabled = agent.enabled && agentReady`，门控只剩 config 门 + parity 门；模型 seam 不再有 `supportsToolCalls` 字段，若 `WorkbenchLaunchConfig` 存在同名选项一并删除）。
- 1364-1392：`createWorkbenchAgentRunService({ ..., model: agentModel, ... })` → `agentModel`。
- 1374-1383 `isWorkflowComplete` wiring 不变。

#### 3.5 删除 node-host 适配器

- 删除 `packages/node-host/src/agent/workbench-agent-model.ts` 整个文件。
- `packages/node-host/src/index.ts`：删 `createWorkbenchAgentModelAdapter`、`WorkbenchAgentModelPort`、`WorkbenchAgentModelRunRequest`、`AgentModelEvent`、`AgentModelMessage`、`AgentToolSpec` 导出。
- `packages/node-host/src/agent/` 目录若只剩此文件则整个删除目录。

#### 3.6 测试改造（脚本 stream 助手）

新建 `packages/workbench/tests/helpers/scripted-stream.ts`（所有 stub 模型测试共用）：

```typescript
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, ToolCall } from '@earendil-works/pi-ai';

export function assistantPartial(content: Array<{ type: 'text'; text: string } | ToolCall>): AssistantMessage {
  return {
    role: 'assistant', content,
    api: 'openai-completions', provider: 'pi-provider', model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: 'stop', timestamp: Date.now(),
  };
}
export function textDelta(text: string, partial: AssistantMessage): AssistantMessageEvent {
  return { type: 'text_delta', contentIndex: 0, delta: text, partial };
}
export function toolCallEnd(toolCall: ToolCall, partial: AssistantMessage): AssistantMessageEvent {
  return { type: 'toolcall_end', contentIndex: 0, toolCall, partial };
}
export function doneEvent(reason: 'stop' | 'toolUse' | 'length', message: AssistantMessage): AssistantMessageEvent {
  return { type: 'done', reason, message };
}
/** Scripted stream: yields events in order; result() returns the last partial. */
export function scriptedStream(events: AssistantMessageEvent[], finalMessage: AssistantMessage): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
    async result() { return finalMessage; },
  };
}
```

（已核验 loop 消费方式：`start` 事件 push `partial`；后续事件整体替换 `partial`；`done` 后调 `response.result()` 取最终 message，工具调用取自最终 message 的 `content`——所以脚本 stream 的 `finalMessage.content` 必须包含 toolCall 块。）

- `packages/workbench/tests/run-service.test.ts`：`StubModel implements WorkbenchAgentModelPort`（117 行区域）→ 改为按 `options.agentModel = { model: fakeModel, streamFn: (async function* () { ... }) }` 注入；脚本内容按原测试意图逐个转写（每 turn 一组事件：`text_delta` → `toolcall_end(nova_*)` → `done('toolUse')`；结束 turn：`done('stop')`）。`fakeModel` 用 `createPiProviderStack({apiKey: 'test'}).model` 或最小对象 `as Model<Api>`。
- `packages/workbench/tests/agent-parity-matrix.test.ts`：`agentModel` 注入点（581、652-659、1266-1289 区域）改为脚本 stream（同 helper）；5 个 parity 断言逻辑不动（工具面 parity、full chain、recovery、launch gate、capability persistence）。
- `packages/workbench/tests/browser-agent-chat-api.test.ts`：`scriptedModel`（152 行区域）→ 脚本 stream。
- `packages/workbench/tests/launch-phase1a.test.ts`：2227-2231 区域的 `agentModel` stub → `{ model, streamFn }`（finish-only：`done('stop')`）。
- `packages/workbench/scripts/smoke-agent-live.mjs`：删 `createWorkbenchAgentModelAdapter` import/使用（106、193-196 区域），改为 `createPiAgentModel({ baseURL: process.env.NOVALISTICALLY_AI_BASE_URL, modelId: process.env.NOVALISTICALLY_AI_MODEL, apiKey })` 注入 `agentModel`；`agentReady: true` 保留。
- 删除 `packages/node-host/tests/agent-model.test.ts`。

#### 3.8 reference 工具面接入内置 agent（「agent 完全接管一个人能做的事」补齐）

**现状（已核验）**：reference 工具（`nova_reference_list/get/search/chunk_get/content_read` 需 `mcp:reference:read`；`import_begin/chunk/commit/job_get/retry/delete` 需 `mcp:reference:write`）当前**对任何人不可达**——① `PROJECT_ACCESS_ROLE_GRANTS`（contracts/configuration.ts:35-44）只有 `mcp:read/render/author/submit`，reference scopes 不在任何 role；② `device-pairing.ts:66-72` 的 `AVAILABLE_MCP_SCOPES` 是 role grants 并集 + admin，reference scopes 因此不可签发；③ `registry.ts:4696-4699` 的 family 过滤要求 `options.reference !== undefined` 才注册 reference 工具，而 launch 的内置 agent executor（1344-1363）与 MCP 端点 registry（1661-1703）**都没传 reference**；④ 前端只有 `GET /references` 只读 API（browser-api.ts:45-46）且无任何 UI 消费。唯一使用 reference 的路径是 `nova_render` 的 referenceChunks 输入（registry.ts:806-815）。

**改动**：
1. `packages/workbench/src/contracts/configuration.ts` `PROJECT_ACCESS_ROLE_GRANTS` 扩展：`reader: +['mcp:reference:read']`；`author: +['mcp:reference:read','mcp:reference:write']`；`maintainer: +['mcp:reference:read','mcp:reference:write']`（reference 是项目内资料库，读写授权与 source 访问层级一致）。
2. `device-pairing.ts` `AVAILABLE_MCP_SCOPES`（66-72）自动跟随 role grants 并集——**无需改代码**，但新增断言测试：`AVAILABLE_MCP_SCOPES` 包含 `mcp:reference:read/write`。
3. `workbench-launch.ts` 两处 registry 构造传 reference port：内置 agent executor（1344-1363）与 MCP 端点 `resolveRegistry`（1661-1703）都加 `...(await referencePortFor(projectId) === undefined ? {} : { reference: await referencePortFor(projectId) })`（`referencePortFor` 已存在，1042-1055 区域，按 `referenceLimits.enabled` 决定是否创建；`undefined` 时不注册——保持现有 gate）。
4. `buildAgentSystemPrompt` 无需改：tools 列表自动含 reference 工具。
5. 测试更新：`agent-parity-matrix.test.ts` 的工具面 parity 断言（maintainer 工具集增加 11 个 reference 工具）；scope 派生/授权测试（`PROJECT_ACCESS_ROLE_GRANTS` 消费点：auth.ts `MCP_SCOPE_REQUIRED_ROLE` 反向表、transport discovery、device claim）；`launch-phase1a.test.ts` 若断言工具集/scope 集合则同步。
6. 前端**不加** reference 管理 UI（决策）：reference 导入/删除/读取由内置 agent（聊天）与外部 MCP agent 承担；`GET /references` 只读 API 保留现状。

#### 3.7 public-api manifest

`node scripts/check-public-api.mjs` 跑一次；按报错更新 `public-api.manifest.json`：`@novalistically/node-host` 删 `AiSdkProvider*`/`createAiSdkModelClient`/`createWorkbenchAgentModelAdapter`/agent model 类型，加 `PiOpenAICompatibleProvider`/`createPiProviderStack`/`PI_DEFAULT_*`；`@novalistically/workbench` 若导出 agent 相关则同步。

#### 3.8 reference 工具面接入内置 agent

### Stage 4 — 对话消息持久化 + 会话列表 API（要求 2/4）

目标：会话可列、可重开；前端能渲染历史消息流（agent-first UX 的数据基础）。

#### 4.1 `packages/workbench/src/persistence/schema.ts` 新增迁移 v5

```typescript
{
  version: 5,
  description: 'Agent conversation messages for transcript history',
  steps: [
    {
      kind: 'create-table',
      table: {
        name: 'agent_conversation_messages',
        columns: [
          { name: 'message_id', type: 'text', primaryKey: true },
          { name: 'conversation_id', type: 'text' },
          { name: 'run_id', type: 'text' },
          { name: 'role', type: 'text', values: ['user', 'assistant', 'tool_result'] },
          { name: 'content', type: 'text' },
          { name: 'tool_name', type: 'text', nullable: true },
          { name: 'call_index', type: 'integer', nullable: true },
          { name: 'created_at', type: 'text' },
        ],
      },
    },
    {
      kind: 'create-index',
      name: 'agent_conversation_messages_conversation_created',
      table: 'agent_conversation_messages',
      columns: ['conversation_id', 'created_at'],
    },
  ],
},
```

#### 4.2 `packages/workbench/src/persistence/agent-store.ts` 新增方法

按现有 `createAgentStore` 模式（26-63 区域）新增：
- `appendMessage(input: { messageId: string; conversationId: string; runId: string; role: 'user'|'assistant'|'tool_result'; content: string; toolName?: string | null; callIndex?: number | null; createdAt: string }): Promise<void>`
- `listMessages(input: { conversationId: string; limit?: number }): Promise<AgentConversationMessageRecordV1[]>`
- `listConversations(input: { projectId: string; principalUserId: string; limit?: number }): Promise<AgentConversationRecordV1[]>`（按 `updatedAt` 倒序）

`AgentConversationMessageRecordV1` 加入 `packages/workbench/src/contracts/persistence.ts`（字段同上表）。

#### 4.3 run-service 写入 + 接口扩展

- `sendMessage`：`createRun` 之后立即 `store.appendMessage({ messageId: randomUUID(), conversationId, runId, role: 'user', content: input.message, createdAt: at })`（store-first）。
- `runLoop` 订阅器补两处（Stage 3.3 的 TODO 位置）：
  - `turn_end`：`assistantTextByTurn[turn-1]` 非空 → `appendMessage({ role: 'assistant', content: <累积文本>, runId, conversationId, ... })`（每 turn 一条，不存增量）。
  - `tool_execution_end`：`appendMessage({ role: 'tool_result', content: <summary ?? 'error:'+code>, toolName, callIndex, runId, ... })`。
- `WorkbenchAgentRunService` 接口新增：
  - `listConversations(principalUserId: string): Promise<AgentChatConversationViewV1[]>`
  - `history()` 返回值扩展：`AgentChatHistoryV1` 增加 `readonly messages: readonly AgentChatMessageViewV1[]`（`store.listMessages` 按 `createdAt` 升序）。

#### 4.4 contracts + 路由

- `packages/workbench/src/contracts/agent-chat.ts`：
  - 新增 DTO：
```typescript
export interface AgentChatMessageViewV1 {
  readonly version: AgentChatContractVersion;
  readonly messageId: string;
  readonly runId: string;
  readonly role: 'user' | 'assistant' | 'tool_result';
  readonly content: string;
  readonly toolName: string | null;
  readonly callIndex: number | null;
  readonly createdAt: string;
}
```
  - `AgentChatHistoryV1` 增加 `readonly messages: readonly AgentChatMessageViewV1[]`。
  - 新增路由常量：`BROWSER_AGENT_CONVERSATIONS_LIST_PATH = ${BROWSER_API_BASE_PATH}/projects/:projectId/agent/conversations`（GET，与既有 POST 同路径不同方法）+ 响应 DTO `AgentChatConversationListResultV1 { version; conversations: readonly AgentChatConversationViewV1[] }`。
- `packages/workbench/src/host/browser-agent-chat-api.ts`：注册 `GET /api/v1/projects/:projectId/agent/conversations`（principal 过滤：`listConversations(principal.userId)`）；`history` handler 组装 `messages`。
- `packages/workbench/src/client/agent-chat-client.ts`（69-82 区域）新增：
  - `listConversations(): Promise<AgentChatConversationViewV1[]>`
  - `getHistory(conversationId): Promise<AgentChatHistoryV1>`（现 `history` 方法改名或复用——**决策**：保留 `history(conversationId)` 名称，返回类型加 `messages` 字段即可，前端无需改调用名）。

### Stage 5 — Agent-first 前端 + UI 收口（要求 4）

目标：打开 workbench 先见 agent chat；UI 有控件、有样式、无死面板、无半成品观感。

#### 5.1 `packages/workbench/src/client/AgentChat.tsx` 重写

- 布局：左侧会话列表栏 + 右侧消息区。会话栏：`listConversations()` 拉取（`updatedAt` 倒序），`+ 新会话` 按钮（`createConversation()`），点击会话 → `history(conversationId)` 加载（含 `messages`）。
- 消息区渲染：
  - `role: 'user'` → 右侧用户气泡；`role: 'assistant'` → `SolidMarkdown` 渲染（新增依赖 `solid-markdown@2.1.1`，加入 `packages/workbench/package.json` dependencies）；
  - `role: 'tool_result'` → 收进该 run 的 `<details>` 工具调用折叠区（复用 `AgentChatToolCallReceiptV1` 的展示：toolName + status + resultSummary + 时间）。
- 实时流：SSE handler（79-140 区域）改为**累积** `assistant-text` delta 进当前 assistant 消息（不再每条 delta 一个气泡）；`tool-call`/`tool-result` 事件更新当前 run 的 receipts。
- 编排：多行 textarea + 发送/取消按钮（运行中显示取消）；Enter 发送、Shift+Enter 换行。
- 空会话欢迎卡（agent-first 引导）：三张示例卡片点击即填入：
  - 「查看项目当前状态并告诉我下一步」
  - 「渲染第 1 章并发布」
  - 「检查有哪些待处理的评审或门禁」
- 产物链接：某 run 的 receipts 含 `nova_publish`（succeeded）时，在该 run 尾部渲染「查看发布产物」chip → `onViewChange('publication')`（App 已有回调）；`nova_render` 成功时 chip → 提示用户去 Publication/Review Hub 查看。
- 附件（**本阶段不实现，机制已定**）：见 5.5。

#### 5.2 死面板处理（scene-canvas 保留 + Inspector 删除）

- **scene-canvas 保留（决策修正）**：它不是占位 stub——是「生成散文采纳进 authoring manifest」的**唯一前端入口**：`SceneCanvas`（scene-canvas.tsx）展示 released scene revision（eventId/revisionId/proseHash）并提供 `Adopt into authoring manifest` 按钮 → `onRequestAdoption` → Host `prepareSceneAdoption`（scene-adoption.ts，真实能力：基于持久化 released revision 派生 claim，错误码 `REVISION_NOT_FOUND/INVALID/MISMATCH`）。删除它会丢掉「人工确认采纳」流程的入口。改为：**保留视图并样式化**——`WORKBENCH_VIEW_CATALOG` 中 label `'Scene Canvas'` 改为 `'Scene Adoption'`（glyph `◇` 不变），组件内部按 5.4 脚手架类样式化（`.card`/`.btn`/`.badge`），props/契约不动（`SceneAdoptionViewV1`/`onRequestAdoption`）。
- **Inspector 删除（决策保留）**：`App.tsx` 的 `Inspector`（494-524 区域）是「Selection」详情面板——设计意图是 Host 提供 canonical projection 后显示选中对象详情，但**从未接线**（无数据源、无选中事件，空态文案 `Selection details will appear after the Host supplies a canonical projection.` 是死承诺）。与 `WorkbenchShell` 的 Inspector 列一并删除，三列 grid 布局类改两列；graph-route 视图自身已有详情能力。`App.tsx` 删 `Inspector` 组件与相关 props（`initialInspectorPinned`/`onInspectorPinToggle` 若有独立消费一并删，以 grep 为准）。

#### 5.3 视图顺序 agent-first

- `App.tsx` `WORKBENCH_VIEW_CATALOG` 重排：`'agent-chat'` 放第一位（其后 project-home / source-studio / graph-route / review-hub / scene-canvas（label 'Scene Adoption'）/ publication）；`viewsFor` 保持目录序 → agent 启用时默认首个可见视图即 `agent-chat`，禁用时回落到 project-home。`DEFAULT_FEATURES` 不变（scene-canvas 仍是 always-on 视图）。
- `main.tsx` 的 WorkspaceRoute（564 行区域）`initialView` 逻辑不动（默认取首个可见视图）。

#### 5.4 视觉收口（styles.css + 视图组件）

- `packages/workbench/src/client/styles.css`（1215 行 shell chrome 已成型；视图类零规则）：新增共享脚手架类：`.view-panel`、`.view-header`、`.card`、`.card-title`、`.btn`、`.btn-primary`、`.btn-ghost`、`.badge`、`.empty-state`、`.hash-chip`；按语义为现有视图补类（agent-chat / source-studio / review-hub / publication / project-home / graph-route / scene-canvas）。
- `packages/workbench/src/client/source-studio.tsx`：裸 `h3` hash 标题 → `.hash-chip` + `shortHash()`；未样式化按钮统一 `.btn`/`.btn-primary`。
- `packages/workbench/src/client/scene-canvas.tsx`：adoption notice 区块改用 `.card`/`.btn`/`.badge` 类（含 `Adopt into authoring manifest` 按钮），`onRequestAdoption` 流程与契约不动。
- `packages/workbench/src/client/PublicationView.tsx` 发布表单（178-213 区域）：手写 JSON branch path 输入改为结构化表单——分支名文本输入 + 相对路径分段输入（`output/novel.md` 默认），客户端按 `assertSafePublicationRelativePath` 同规则校验（不允许 `..`/绝对路径/空段），产出与现 wire 请求完全相同的 `branchPath` 字段（wire 形状不变，后端不动）。
- SetupWizard 已完整（6 步），不动；`finish` 后跳转保持现有 login 流。
- 检查各视图无 `console.log`/占位文本/`TODO` 渲染残留（grep `placeholder=|TBD|coming soon` 于 `packages/workbench/src/client`，清掉）。

#### 5.5 附件机制（决策：本阶段不实现，写下机制防后续返工）

前端「拖文件/图片进聊天」的落点设计（**不在本阶段交付**）：
- 新增浏览器路由 `POST /api/v1/projects/:projectId/agent/attachments`（multipart，`maxBytes = referenceLimits.maxFileBytes`），Host 存到 `$WORKBENCH_HOME/agent-attachments/<projectId>/<sha256>`（不经 SQLite），返回 `{ attachmentId }`；
- `SendAgentMessageRequestV1` 加可选 `attachmentIds: string[]`；run-service 把附件内容拼进 user message：文本文件直接 `content += "\n\n[附件 <name>]\n" + 文本`；图片（`image/*`）在 `AgentMessage` 里用 pi-ai `ImageContent`（`{type:'image', data: <base64>, mediaType}`）——**前提是模型 `input` 含 `'image'`**（默认 `deepseek-v4-flash-free` 为 text-only，需换视觉模型才生效）。
- 决策：MVP 只做纯文本聊天；「agent 找资料」路径 = `nova_source_*`（读项目文件）+ `nova_reference_*`（资料库，Stage 3.8 已接入内置 agent：聊天中即可导入/查询/删除 reference）+ `nova_status/entity/graph`，web 搜索/URL 抓取不在本阶段（见 Stage 7 边界）。前端 reference 只保留 `GET /references` 只读 API（现状，无 UI）；reference 管理界面不在本阶段（用户通过内置 agent 或外部 MCP agent 操作）。

### Stage 6 — 产品入口：CLI 改名 + `npm start` + README 重构（要求 4）

#### 6.1 CLI 改名 `nova` → `fabula`

- `packages/cli/package.json`：bin `{"nova": "./dist/index.js"}` → `{"fabula": "./dist/index.js"}`。
- `packages/cli/src/index.ts`：
  - `program.name('nova')`（237）→ `'fabula'`；description（238）`'Novalistically Node Host CLI'` → `'Fabula headless authoring CLI (the product UI is the Workbench; this CLI is for automation and testing)'`。
  - 用户可见字符串 `'nova '` → `'fabula '`：195、230-231、365、405-406、428-429、516、652、670、689、744、760、782、822、1152-1153、1258 行区域（含 `'Next step: run "nova ..."'` 全部）。
  - 57 行 `'Not in a Novalistically project directory (missing nova.yaml).'` → `'Not in a Fabula project directory (missing nova.yaml).'`。
  - **不改**：`nova_*` MCP 工具名（wire contract）、`nova.yaml` 文件名（provenance）、`NOVALISTICALLY_*` 环境变量名（cli 契约）。
- `public-api.manifest.json`：695 行 bin 条目 `"nova"` → `"fabula"`。
- `packages/cli/tests/bundle-boundary.test.ts`、`host-boundary.test.ts`、`workbench-commands.test.ts`：stdout 断言里的用户可见 `nova` → `fabula`；`nova_*` 断言不动。
- `npm install` 刷新 lockfile 的 bin 映射。

#### 6.2 `npm start` + start.mjs（URL 回显 + 自动开浏览器 + Windows）

- root `package.json` scripts 新增：
```json
"start": "npm run -w @novalistically/workbench build:host && node packages/workbench/scripts/start.mjs workbench",
"start:dev": "npm run -w @novalistically/workbench dev"
```
（`build:host` 是 workbench 包既有 script；`open` npm 依赖**不需要**，用平台 spawn。）
- `packages/workbench/scripts/start.mjs` 改造：
  - **stdout URL 监听（npm start 主路径）**：终端直接跑 `npm start` 时 fd3 不存在（npm 不传 fd3，`fstatSync(3)` 抛错 → `WORKBENCH_CONTROL_FD3='disabled'`），所以把 child stdio 改为 `['inherit','pipe','inherit', fd3可用时'inherit'否则'ignore']`，`child.stdout` 逐行匹配 `/\[workbench-host\] browser: (\S+)/` 并透传到 `process.stdout`。
  - **fd3 ready 帧解析（存在时优先）**：`WORKBENCH_CONTROL_FD3 === '3'` 时，`createReadStream(null, {fd: 3})` 按 `\n` 切 JSON-lines（帧格式已核验：`writeSync(3, JSON.stringify(frame)+'\n')`，main.ts:224-227），取 `{type:'ready', endpoint}`；与 stdout 监听同时挂，先到者胜。
  - 拿到 endpoint 后 `console.log(\`Fabula Workbench: ${endpoint}/\`)`；`mode === 'workbench'` 且 `WORKBENCH_OPEN_BROWSER !== 'false'` 时自动开浏览器：darwin `spawn('open', [url])`；win32 `spawn(process.env.COMSPEC ?? 'cmd', ['/c', 'start', '', url])`；linux `spawn('xdg-open', [url])`。开失败仅 `console.warn`，不退出。
  - **env 过滤**（防泄露，收敛 plan 6.4 保留）：child env 只透传 `/^(WORKBENCH_|NODE_|PATH$|HOME$|USER$|TMPDIR$|XDG_|LANG$|LC_)/` 匹配项 + 强制 `WORKBENCH_MODE`/`WORKBENCH_DEV=false`/`WORKBENCH_CONTROL_FD3`。
- Windows 支撑已核验：全部 package.json scripts 无 POSIX shell 命令；`/dev/null` 仅 main.ts:375 的 fd3 通道（`hasControlFd3()` 门控，Windows 自动 disabled → stdout 回退路径覆盖）；`node:sqlite`/Yjs/Vite 跨平台。README 注明：loopback 模式全平台支持；`unix` 网络模式为 darwin/linux 优先（Windows 下报清晰错误：`network.mode "unix" is not supported on this platform`——在 listener 构造处加一次 platform 检查）。

#### 6.3 README / docs 重构（workbench 第一）

`README.md` 重写为产品化结构（保留仓库边界/架构/测试内容，入口重排）：
1. 标题段：「Fabula — 叙事工程系统」→ 第一屏放 **「快速开始：`npm install && npm start`」**：构建 → 启动 → 自动打开浏览器 → 首次引导（owner 设置、添加项目、配置 provider 与 key、网络）→ 进入工作台与内置 agent 聊天。说明 key 通过设置界面存储，不写进 `.env`。
2. 「内置创作代理」段：一句话说明 agent 会通过工具完成 查看状态→编辑→校验→提交→渲染→评审→发布 全流程；用户只负责聊天和看产物。
3. 「外部 agent 接入」段：MCP endpoint `/mcp/projects/:projectId` + `nova_*` 72 工具目录（保持不变），外部 agent（含 codex CLI 等 MCP client）可直连。
4. 「Headless CLI（自动化/测试）」段：`npx fabula --help`；明确这是开发/测试工具，产品入口是 workbench；保留 project init/validate/render 等命令示例（`nova` → `fabula`、`NOVALISTICALLY_AI_*` env 显式导出说明不变）。
5. 「Windows」段：loopback 支持；unix socket 限 darwin/linux。
6. 其余（包边界、authoring topology、fixtures、license）保留并压缩。
- `docs/reference/cli.md`：binary `nova` → `fabula`（标题、`npx fabula --help`、命令表），`nova_*` MCP 工具列表不动，加一句「CLI 是 headless 自动化工具，产品入口是 Workbench」。
- `docs/reference/workbench-host.md`：入口命令 `start:workbench` → 指向 `npm start`；`test:e2e` 描述修正（140 行区域已过期：现在 Playwright 套件可跑）。
- `docs/audits/…:346` 的「test:e2e unrunnable」过期声明不动（历史记录不改写），但 `docs/current-state.md` 更新时用新事实覆盖。

#### 6.4 工程缺口收口

- root `package.json` `test` script 补 `&& npm run test:e2e`（当前 `npm test` 漏掉 workbench Playwright 套件——ProductSurface 核验）。**注意**：e2e 需要 `npm run build` 产物 + playwright 浏览器；若 CI 场景要避免，`test:e2e` 保持独立 script 但 root `test` 加上（与「全绿门禁」一致，`docs/current-state.md` 已记录 23/23 可跑）。
- `WORKBENCH_CONFIG_IMPORT`：README/.env.example/start.mjs 注释里声称存在但无实现——**决策**：删除所有提及（不做 dotenv→workbench.yaml 导入；配置来源 = setup wizard + admin + 手编文件）。

### Stage 7 — 运行时边界决策：不引入本地 agent 运行时发现（要求 3）

**决策：不实现 workbench 发现/托管本地 agent 运行时（codex CLI 等）。**

调研结论（2026-08-07 已核验）：
- codex CLI 是 Rust 本地编码 agent（npm 包装），可作 MCP server 被其他 agent 调用，并有官方 Python SDK（2026-05 起）——即它可以作为「外部 agent」接入本系统的 MCP 端点，无需 workbench 侧任何新代码。
- 我们自己的外部接入面已完备：`/mcp/projects/:projectId` Streamable-HTTP + 72 工具目录；内置 agent 与外部 device 共享同一 `ProjectToolExecutor`（同 registry、同 scope 过滤）。
- 引入「workbench 发现/托管本地运行时」需要：进程生命周期管理、沙箱/exec policy、凭据桥接、版本漂移处理——纯运维面，与叙事产品无关；且会把「自写 harness 问题」从模型循环扩展到运行时层。

边界声明（写入 `README.md`「外部 agent 接入」段 + `AGENTS.md` Gotcha + `docs/current-state.md`）：
- workbench 是 **MCP server**：外部 agent（任意 MCP client，包括 codex/claude-code 等）连入 `/mcp/projects/:projectId` 即获得与内置 agent 相同的工具面（按角色 scope 过滤）。
- 内置 agent（pi-agent-core）是**唯一**的进程内 agent；不发现、不派生、不托管任何外部本地运行时。
- 若未来出现真实需求（如「workbench 内直接驱动 codex 干工程活」），按新需求单独评审，不在本阶段预留接口。

### Stage 8 — 收口清理（安全/默认/文档）

#### 8.1 credential-store 清理

`packages/workbench/src/host/providers/credential-store.ts`：删 `LEGACY_AI_SDK_CREDENTIAL_KEY='ai-sdk'`（92 行）与 default profile 的裸 key 回退（500-503 区域）；只认 `ai-sdk:<profileId>` key。同步更新相关测试（credential-store 测试 + admin/launch 测试里用到裸 key 的地方）。**不改** key 前缀 `ai-sdk:`（wire 契约，setup 已写 `ai-sdk:default`）。

#### 8.2 `.env` / `.env.example`

`.env`（gitignored）里若有 `NOVALISTICALLY_AI_API_KEY` 等真实值，删除（凭据唯一来源 = credential store）；`.env.example` 按 1.10 更新（去掉 legacy prefill 为 dev-only、加 config 边界说明）。

#### 8.3 docs/current-state.md + AGENTS.md

- `docs/current-state.md`：记录本次收敛（config `version:1` 单一契约 + renderPolicy；`@earendil-works/pi-ai`/`pi-agent-core` 依赖；CLI 改名 `fabula`；`npm start` 入口；agent 消息持久化 v5；内置 agent 换核后 production 默认仍 `agentReady=false` 隐藏——parity/e2e 是确定性证据，live conformance 需单独跑）。
- `AGENTS.md`：Gotcha 增补——`nova.yaml`/`nova_*` 不改名；`createWorkbenchAgentModelAdapter` 已删除，用 `createPiAgentModel`；agent 系统提示词为中文；dotenv 只服务 workbench 启动脚本；`npm start` 是产品入口；不托管本地 agent 运行时。

---

## Critical files & anchors

- `packages/workbench-protocol/src/configuration.ts` — 规范 `WorkbenchConfigurationV1`（含 renderPolicy）唯一定义；删除 normalizeWorkbenchConfiguration 与全部 V1/V2/V3 遗留。
- `packages/workbench/src/host/agent/run-service.ts` — 换核主战场：`runLoop`（327-570 区域）从 `model.run()` 异步迭代改为 pi-agent-core `Agent` + 订阅器；外层契约（`WorkbenchAgentRunService`/`AgentRunFailureCode`/store-first/SSE/cancel/retry）逐条保持。
- `packages/workbench/src/host/agent/project-tool-executor.ts` — 工具面唯一来源：`listTools(scopes)`/`callTool`/`callerForRole` 不变，pi `AgentTool` 从这里映射，确保内置 agent 与外部 MCP 设备同一 registry。
- `packages/workbench/src/client/AgentChat.tsx` + `styles.css` — UI 收口主战场：会话列表/合并流式/markdown/欢迎卡 + 视图脚手架 CSS。
- `packages/workbench/scripts/start.mjs` — `npm start` 入口：fd3 ready 帧解析（或 stdout 回退）+ 平台开浏览器 + env 过滤。

## Verification

每阶段独立可验；全部命令在 monorepo root 用 `fnm exec --using=26.5.0 --` 前缀执行（`npm` 命令可省略前缀按 README 惯例）。

**Stage 1 后**：
```bash
npm run typecheck
npm test                                   # 根 vitest + workbench host/client
node scripts/check-public-api.mjs
```
定向：`npx vitest run packages/workbench-protocol/tests/configuration.test.ts packages/workbench/tests/render-policy-defaults.test.ts`。核验 `packages/workbench-protocol` round-trip 与 renderPolicy 数值断言通过；`configuration-file-store.test.ts` 的 `version: 1` fixture 通过。

**Stage 2 后**：
```bash
npm run typecheck && npm test
grep -rn "NOVALISTICALLY_AI_BASE_URL\|NOVALISTICALLY_AI_API_KEY\|NOVALISTICALLY_AI_MODEL" packages/node-host/src packages/workbench/src   # 期望仅剩注释/文档，无回退代码
```
定向：`npx vitest run packages/node-host/tests/pi-openai-compatible-provider.test.ts`。可选 live：`NOVALISTICALLY_AI_API_KEY=<key> npm run smoke:stage1:live`（bench 走 PiOpenAICompatibleProvider，非确定性 CI 证据）。

**Stage 3 后**：
```bash
npm run typecheck && npm test
npm run smoke:workbench-agent:live        # 需真实 key；agent 用 pi-agent-core 驱动，断言 nova_render+nova_publish receipts + output/novel.md
```
定向：`npx vitest run packages/workbench/tests/run-service.test.ts packages/workbench/tests/agent-parity-matrix.test.ts`——脚本 stream 驱动真实 pi Agent loop，5 个 parity 断言全绿（工具面 parity、full chain、recovery、launch gate、capability persistence）。
**Stage 3.8 reference 工具面验证**：parity 工具面断言中 maintainer 工具集包含全部 11 个 `nova_reference_*` 工具；`AVAILABLE_MCP_SCOPES` 断言包含 `mcp:reference:read/write`；手工（或 e2e）：起 host → 内置 agent 会话中让 agent 执行 `nova_reference_import_begin/chunk/commit` 导入一段文本 → `nova_reference_search` 能查到。

**Stage 4 后**：
定向：`npx vitest run packages/workbench/tests/browser-agent-chat-api.test.ts` + 新加断言：`history()` 返回 `messages` 含 user/assistant/tool_result 行；`listConversations` 按 principal 过滤、`updatedAt` 倒序。手工：起 host → 发一条消息 → 查 SQLite `agent_conversation_messages` 有行。

**Stage 5 后**（新行为端到端）：
```bash
npm run -w @novalistically/workbench dev   # 或 npm start（Stage 6 后）
```
浏览器验证：进入 workspace 默认落在 **Agent Chat**；左侧会话列表可见「新会话」；发消息 → 正文 markdown 渲染、流式累积成一条、工具调用 receipts 折叠可见；`nova_publish` 成功出现「查看发布产物」chip 且点击跳到 Publication；空会话显示三张欢迎卡；Source Studio/Publication 无裸 hash 标题、按钮有样式；无 scene-canvas、无 Inspector 占位。
e2e：`npm run test:e2e`（Playwright 23 项，含 browser 套件）。

**Stage 6 后**：
```bash
npm run build
node packages/cli/dist/index.js --help     # 显示 'fabula'，无 'nova' 用户可见字符串
npm start                                  # build:host → 启动 → stdout 回显 'Fabula Workbench: http://…' → darwin/win/linux 自动开浏览器
```
手工：未配置 Host 首次打开进 `/setup` 向导（6 步）→ finish → login → workspace。Windows（如可测）：`npm start` 用 `cmd /c start` 开浏览器、URL 走 stdout 回退。

**Stage 7 后**：文档检查——README「外部 agent 接入」段含 MCP 端点与边界声明；grep 全仓库无 agent 运行时发现代码。

**Stage 8 后**：
```bash
npm run typecheck && npm test && npm run build && npm run lint
grep -rn "LEGACY_AI_SDK_CREDENTIAL_KEY" packages/workbench/src   # 空
grep -rn "NOVALISTICALLY_AI_API_KEY" .env .env.example 2>/dev/null  # 无真实值
```

## Assumptions & contingencies

- **pi-ai/pi-agent-core 0.84.1 API 已按发布包核验**（Agent 选项、AgentEvent、AgentTool、AssistantMessageEvent、createProvider/createModels/streamSimple、Type.Unsafe 的 JSON-schema 校验回退）。若实现时发现某 API 细节漂移（如 `response.result()` 契约），以 `/tmp/pi-agent-inspect/` 的解包类型为准更新对应代码，不改变本计划的结构。
- **`Type.Unsafe(registryJsonSchema)` 若在 `validateToolArguments` 对个别 schema 构造报错**：pi 的 prepareToolCall 会把校验失败转成 error tool result（模型可见、可重试），且 registry `run()` 会二次校验——不阻断；若某工具频繁失败，给该工具加 `prepareArguments: (args) => args` 兼容垫片（pi 文档注明该字段是给非 typebox schema 的兼容入口）。
- **`providers.<id>.kind` 保留 `'ai-sdk'` 值**：仅向后兼容已有 workbench.yaml；生产构造统一走 pi（告警一次）。若用户明确要求删除该兼容值，只删 validator 分支即可。
- **renderPolicy 默认值必须与 core 现有硬编码一致**（0.8/10000/0.3/12000/42）；Stage 1.10 的跨包断言测试防漂移。若某 provider 实测不支持 seed 参数，pass2 seed 经 `samplingParams` 透传由 pi-ai 处理，不改结构。
- **root `npm test` 并入 `test:e2e`**：若执行环境没有 Playwright 浏览器二进制（CI 首次），先 `npx playwright install chromium`；仍失败则把 e2e 从 root `test` 拆回独立 script 并在 current-state 注明（不回退其他改动）。
- **系统提示词保持现有英文内容不动**（3.3，用户明确）：`buildAgentSystemPrompt` 模板文字逐字保留，仅参数类型从 `AgentToolSpec[]` 改为 `AgentTool[]`。若后续产品要求多语言，只换模板无结构影响。
- **reference 工具面（3.8）**：`referenceLimits.enabled`（默认 true）控制 reference port 是否创建；`false` 时不注册 reference 工具（现有 gate 保持，agent 工具集随之收缩，属预期行为）。若某 role 不应获得 reference 写权限（安全评审异议），回退方案：只给 maintainer 加 `mcp:reference:write`、author/reader 只加 `mcp:reference:read`——结构不变，仅 grants 数组内容不同。
- **附件机制（5.5）本阶段不实现**：若用户中途要求做，按 5.5 的机制单独排期（upload 路由 + ImageContent 映射 + 视觉模型前提），不阻塞本计划其余部分。
