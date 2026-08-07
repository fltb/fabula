# Fabula Workbench Product Convergence Plan

## Context

Productize Novalistically around the browser-first Workbench: collapse the draft V1/V2/V3 configuration ladder to one `version: 1` contract, replace `@ai-sdk/openai-compatible` + `ai` (Vercel AI SDK) with `@earendil-works/pi-ai` for provider abstraction and `@earendil-works/pi-agent-core` for the built-in agent loop, add a `renderPolicy` config domain, rename the headless CLI from `nova` to `fabula`, deliver a single `npm start` product entry, persist sessions/transcripts, and polish the agent-first UI.

## Approach

### Stage 1 — Configuration collapse (one clean `version: 1`)

No dependencies on other stages. Run first — widest blast radius.

**1.1** Rewrite `packages/workbench-protocol/src/configuration.ts`:
- Delete every legacy type and constant: `WORKBENCH_CONFIGURATION_VERSION_V1/V2/V3`, `WorkbenchConfigurationVersion`, `WorkbenchConfigurationV1` (legacy version-1 shape), `WorkbenchConfigurationV2`, `WorkbenchConfigurationV3`, `WorkbenchConfigurationInput`, `WorkbenchProjectConfigurationV1`, `WorkbenchProjectConfigurationV2`, `WorkbenchProjectConfigurationV3`, `WorkbenchRevisionMirrorConfigurationV2`, `WorkbenchTrustedPluginConfigurationV3`, `WorkbenchOperationLimitsV3`, `WorkbenchAgentConfigurationV3`, `WorkbenchProviderConfigurationV1/V2`, `WorkbenchNetworkConfigurationV1/V2`, `WorkbenchReferenceLimitsV2`, `DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2`, `DEFAULT_WORKBENCH_OPERATION_LIMITS_V3`, `DEFAULT_WORKBENCH_AGENT_CONFIGURATION_V3`, `normalizeWorkbenchConfiguration`, `copyProvider`, `copyNetwork`, `copyRevisionMirror`.
- Merge the surviving types into one `WorkbenchConfigurationV1` per the current V3 shape:

```typescript
export const WORKBENCH_CONFIGURATION_VERSION = 1 as const;
export interface WorkbenchConfigurationV1 {
  readonly version: 1;
  readonly projects: readonly {
    readonly projectId: string;
    readonly displayName: string;
    readonly root: string;
    readonly revisionMirror: { readonly mode: 'disabled' } | { readonly mode: 'git-best-effort'; readonly ref: string };
    readonly providerProfile: string;
    readonly trustedPlugins: readonly { readonly name: string; readonly version: string; readonly moduleHash: string; readonly required: boolean }[];
  }[];
  readonly defaultProjectId: string | null;
  readonly providers: Readonly<Record<string, { readonly kind: 'ai-sdk'; readonly baseUrl: string | null; readonly model: string | null }>>;
  readonly network: { readonly mode: 'loopback' | 'lan' | 'unix'; readonly port: number; readonly allowedHosts: readonly string[]; readonly allowedOrigins: readonly string[]; readonly unixSocket: string | null };
  readonly referenceLimits: { readonly enabled: boolean; readonly maxFileBytes: number; readonly maxBytesPerProject: number; readonly maxItemsPerProject: number; readonly maxPendingJobsPerProject: number; readonly maxChunksPerProject: number; readonly maxExtractedCharactersPerProject: number; readonly maxChunkCharacters: number; readonly chunkOverlapCharacters: number; readonly extractionTimeoutMs: number; readonly mcpImportChunkBytes: number };
  readonly operationLimits: { readonly maxQueuedPerProject: number; readonly maxConcurrentRendersPerProject: 1; readonly maxConcurrentRendersPerHost: number };
  readonly agent: { readonly enabled: boolean; readonly maxTurns: number; readonly maxToolCalls: number };
}
```

- Keep the property order exactly as declared above (the canonical YAML order).
- Rename unsuffixed default constants: `DEFAULT_WORKBENCH_REFERENCE_LIMITS`, `DEFAULT_WORKBENCH_OPERATION_LIMITS`, `DEFAULT_WORKBENCH_AGENT_CONFIGURATION`.

**1.2** Rewrite `packages/workbench/src/contracts/configuration.ts`:
- Delete the V2/V3 re-export block (lines 47-66: `WorkbenchConfigurationV2`, `WorkbenchConfigurationV3`, `WorkbenchConfigurationInput`, `WorkbenchProjectConfigurationV2`, `WorkbenchProjectConfigurationV3`, `WorkbenchTrustedPluginConfigurationV3`, `normalizeWorkbenchConfiguration`, `DEFAULT_WORKBENCH_*_V2/V3`, `WORKBENCH_CONFIGURATION_VERSION_V2/V3`).
- Delete the host-only `WorkbenchConfigurationV1` (lines 105-111, the old single-provider shape).
- Import the canonical `WorkbenchConfigurationV1` from `@novalistically/workbench-protocol` and re-export it.
- Keep: `PROJECT_ACCESS_ROLES`, `PROJECT_ACCESS_ROLE_GRANTS`, `WORKBENCH_CONFIGURATION_VERSION`, `ConfigChangeRequestV1`, `ConfigOperationReceiptV1`, `WorkbenchProviderConfigurationV1`, `WorkbenchNetworkConfigurationV1`, all safe read views, all admin mutation request types.

**1.3** Rewrite `packages/workbench/src/host/configuration-file-store.ts`:
- Delete `validateConfigurationV2Shape` (lines 315-428) and the legacy V1 validator block (lines 751-940).
- Delete the version dispatch block (lines 745-760): replace with a single version check: `if (value.version !== 1)` → `CONFIG_INVALID`.
- Delete `normalizeWorkbenchConfiguration` import; all reads and writes operate on the canonical V1 shape directly.
- Delete `PROJECT_KEYS_V1`, `PROJECT_KEYS_V2`, `PROJECT_KEYS_V3` arrays; keep the single V3 keys as `PROJECT_KEYS`.
- Delete `CONFIGURATION_KEYS_V2`, `CONFIGURATION_KEYS_V3` arrays; keep the V3 keys as `CONFIGURATION_KEYS`.
- Delete `WORKBENCH_CONFIGURATION_VERSION_V2`, `WORKBENCH_CONFIGURATION_VERSION_V3` imports; use `WORKBENCH_CONFIGURATION_VERSION = 1`.
- `serializeConfigurationYaml`: remove `normalizeWorkbenchConfiguration()` call — serialize the canonical shape directly.
- `toPlain`: emit `version: 1`.
- `configurationRevision`: hash over the canonical shape.
- `validateConfigurationTopology`: accept the canonical V1 shape directly.
- All validators (`validateConfigurationShape`, `validateConfigurationTopology`): `numberField` checks for non-negative integers on `maxTurns`, `maxToolCalls`, `maxQueuedPerProject`, `maxConcurrentRendersPerHost`, etc. — these already work (lines 639, 617, 398); keep them.

**1.4** Update `packages/workbench/src/host/configuration-service.ts`:
- Drop all `normalizeWorkbenchConfiguration` calls (lines 139, 140, 422, 482).
- `ActiveConfiguration.configuration` → typed as the canonical `WorkbenchConfigurationV1`.
- `computeChangedFields`: compare canonical shapes directly.
- `apply`: candidate type is `WorkbenchConfigurationV1` (no input union).

**1.5** Update `packages/workbench/src/host/admin-api.ts`:
- Drop `normalizeWorkbenchConfiguration` at every call site (lines 697, 1015, 1056, 1157, 1202, 1249, 1304, 1346, 1434).
- Import the canonical `WorkbenchConfigurationV1` type; drop V2/V3 type imports.

**1.6** Update `packages/workbench/src/host/setup-api.ts`:
- Replace `WorkbenchConfigurationV1 | V3` union (line 202) with the single canonical `WorkbenchConfigurationV1`.
- Delete the legacy draft shapes (lines 336-445: the old single-provider V1 `EMPTY_DRAFT` with `provider: null`). Replace with the canonical shape — `version: 1`, `projects: []`, `defaultProjectId: null`, `providers: {}`, `network`, `referenceLimits`, `operationLimits`, `agent` all with defaults.
- The setup wizard now writes the multi-provider shape directly; no migration branch.

**1.7** Update `packages/workbench/src/host/workbench-launch.ts`:
- Delete `normalizeWorkbenchConfiguration` import and call (line 852).
- `WorkbenchConfigurationSeam` → `WorkbenchConfigurationV1` directly.
- `activeConfiguration` is the canonical shape.
- `v1Candidate` (line 2042) builds the canonical shape.

**1.8** Rewrite `packages/workbench-protocol/tests/configuration.test.ts`:
- Delete the entire `normalizeWorkbenchConfiguration` suite and all V1/V2/V3 migration fixtures.
- Add a canonical round-trip test: serialize → parse → serialize matches.
- Add a defaults test: a minimal config with empty projects/providers validates correctly.
- Import only the canonical types.

**1.9** Update all test fixtures that write or assert `version: 3` / `version: 2`:
- `packages/workbench/tests/configuration-file-store.test.ts`: `'version: 3'` → `'version: 1'` (lines 144, 212); `baseConfigurationV3` → `baseConfiguration`.
- `packages/workbench/tests/configuration-service.test.ts`: same version-3 → version-1 changes.
- `packages/workbench/tests/launch-phase1a.test.ts`: `v3Configuration` helper (line 1819) → `baseConfiguration` with `version: 1`.
- `packages/workbench/tests/setup-api.test.ts`: any V1|V3 union → single V1.
- `packages/workbench/tests/agent-parity-matrix.test.ts`: `version: 3` → `version: 1` (line 607).
- `packages/workbench/tests/e2e/harness/host-fixture.ts`: `serializeV3ConfigYaml` → writes `version: 1` (line 270).
- `packages/workbench/tests/e2e/plugin-snapshot.spec.ts`: any V2/V3 references → V1.
- Drop `DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2` import from `packages/workbench/scripts/smoke-agent-live.mjs` (line 37); import `DEFAULT_WORKBENCH_REFERENCE_LIMITS` instead.

**1.10** Update docs: `.env.example` comment, `docs/reference/workbench-host.md` V3 references, `docs/current-state.md` config section — all `V3` → canonical shape.

### Stage 2 — Provider swap: Vercel AI SDK → @earendil-works/pi-ai

Depends on Stage 1 (needs settled `WorkbenchConfigurationV1` type with `providers` map for profile-aware construction).

**2.1** Add dependencies to `packages/node-host/package.json`:
```json
"@earendil-works/pi-ai": "^0.84.0"
```

Remove `"@ai-sdk/openai-compatible"` and `"ai"` from `dependencies`.

Remove `"@ai-sdk/openai-compatible"` and `"ai"` from root `package.json` `dependencies`.

Run `npm install` to update `package-lock.json`.

**2.2** Delete `packages/node-host/src/providers/ai-sdk.ts` entirely.

**2.3** Create `packages/node-host/src/providers/pi-openai-compatible.ts`:

```typescript
import { createModels, createProvider, envApiKeyAuth, type Context, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {
  type CompletionRequest,
  type CompletionResponse,
  LLMError,
  type LLMProvider,
} from '@novalistically/core';

export interface PiOpenAICompatibleProviderOptions {
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly routing?: {
    readonly default: string;
    readonly pass1?: string;
    readonly pass2?: string;
    readonly summary?: string;
  };
}

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash-free';

export class PiOpenAICompatibleProvider implements LLMProvider {
  readonly name = 'pi-openai-compatible';
  readonly #modelId: string;
  readonly #options: PiOpenAICompatibleProviderOptions;

  constructor(options: PiOpenAICompatibleProviderOptions = {}) {
    this.#options = options;
    this.#modelId = options.model ?? DEFAULT_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const baseURL = this.#options.baseURL ?? DEFAULT_BASE_URL;
    const apiKey = this.#options.apiKey ?? '';
    if (!apiKey) throw new LLMError('apiKey is required', { provider: this.name });

    const modelId = this.#modelIdFor(request.taskType);

    const provider = createProvider({
      id: 'pi-provider',
      name: 'Pi Provider',
      baseUrl: baseURL,
      auth: { apiKey: { name: 'API Key', resolve: async () => ({ auth: { apiKey } }) } },
      models: [{
        id: modelId,
        name: modelId,
        api: 'openai-completions',
        provider: 'pi-provider',
        baseUrl: baseURL,
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
      } satisfies Model<'openai-completions'>],
      api: openAICompletionsApi(),
    });

    const models = createModels();
    models.setProvider(provider);
    const model = models.getModel('pi-provider', modelId);
    if (!model) throw new LLMError(`Model ${modelId} not found`, { provider: this.name });

    const context: Context = {
      systemPrompt: undefined,
      messages: request.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: [{ type: 'text', text: m.content }],
        timestamp: Date.now(),
      })),
    };

    try {
      const result = await models.complete(model, context, {
        apiKey,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });

      const textContent = result.content.filter(b => b.type === 'text').map(b => b.text).join('');

      return {
        id: result.responseId ?? this.name,
        model: modelId,
        content: textContent,
        usage: {
          promptTokens: result.usage.input,
          completionTokens: result.usage.output,
          totalTokens: result.usage.totalTokens,
        },
        finishReason: result.stopReason ?? 'stop',
      };
    } catch (error) {
      throw new LLMError(`pi-ai error: ${(error as Error).message}`, {
        provider: this.name,
        cause: error,
      });
    }
  }

  #modelIdFor(taskType?: string): string {
    const routing = this.#options.routing;
    if (!routing || !taskType) return this.#modelId;
    if (taskType === 'pass1' && routing.pass1) return routing.pass1;
    if (taskType === 'pass2' && routing.pass2) return routing.pass2;
    if (taskType === 'summary' && routing.summary) return routing.summary;
    return routing.default;
  }
}
```

**2.4** Update `packages/node-host/src/index.ts`:
- Delete `AiSdkProvider`, `AiSdkModelClient`, `AiSdkProviderOptions`, `createAiSdkModelClient` exports.
- Add `export { PiOpenAICompatibleProvider } from './providers/pi-openai-compatible.js'` and its options type.

**2.5** Update `packages/node-host/src/agent/workbench-agent-model.ts`:
- Delete all imports from `ai` and `@ai-sdk/openai-compatible`.
- Rewrite `createWorkbenchAgentModelAdapter` to use `@earendil-works/pi-ai` directly instead of Vercel AI SDK.
- The port interface (`WorkbenchAgentModelPort`, `AgentToolSpec`, `AgentModelMessage`, `AgentModelEvent`) is unchanged — only the implementation changes.
- Use `models.streamSimple(model, context, options)` from pi-ai. Build the provider similarly to `PiOpenAICompatibleProvider` but for streaming tool-calling. Map pi-ai streaming events to the existing `AgentModelEvent` types:

```typescript
// pseudocode
const s = models.streamSimple(model, context, { apiKey, signal: request.signal });
for await (const event of s) {
  switch (event.type) {
    case 'text_delta':
      yield { type: 'assistant-text', text: event.delta };
      break;
    case 'toolcall_start':
      // accumulate tool call
      break;
    case 'toolcall_delta':
      // accumulate partial args
      break;
    case 'toolcall_end':
      yield { type: 'tool-call', id: event.toolCall.id, name: event.toolCall.name, args: event.toolCall.arguments };
      break;
    case 'done':
      yield { type: 'finish', finishReason: event.reason };
      break;
    case 'error':
      // throw
      break;
  }
}
```

- Delete `createAiSdkModelClient` import. Pass `apiKey` from options directly to pi-ai calls — no separate client factory.
- `supportsToolCalls` defaults true (unchanged).

**2.6** Update `packages/workbench/src/host/provider-factory.ts`:
- Replace `AiSdkProvider` import with `PiOpenAICompatibleProvider`.
- `createForProfile`: construct `new PiOpenAICompatibleProvider({ baseURL: configuration.baseUrl ?? DEFAULT_AI_SDK_BASE_URL, apiKey, model: configuration.model ?? DEFAULT_AI_SDK_MODEL })`.
- `DEFAULT_AI_SDK_MODEL` → `deepseek-v4-flash-free` (same default, now the pi-ai model id).

**2.7** Update `packages/cli/src/index.ts`:
- Replace `AiSdkProvider` import with `PiOpenAICompatibleProvider`.
- Same constructor pattern: `new PiOpenAICompatibleProvider()` or with explicit options.

**2.8** Update `packages/bench/scripts/generate-reference.mjs`:
- Replace `AiSdkProvider` with `PiOpenAICompatibleProvider`.

**2.9** Delete or rewrite tests:
- `packages/node-host/tests/ai-sdk-provider.test.ts` → rename to `pi-openai-compatible-provider.test.ts`, rewrite with pi-ai mocks.
- `packages/node-host/tests/ai-sdk-structured-output.test.ts` → rewrite or delete (pi-ai handles json_object via its own response format mechanism).
- `packages/node-host/tests/agent-model.test.ts` → rewrite the mock away from `@ai-sdk/openai-compatible`.
- Delete the `vi.mock('@ai-sdk/openai-compatible', ...)` calls.

### Stage 3 — Agent cutover: Vercel AI SDK loop → pi-agent-core

Depends on Stage 2 (needs pi-ai available for the agent model).

**3.1** Add dependency to `packages/workbench/package.json`:
```json
"@earendil-works/pi-agent-core": "^0.84.0"
```

Remove `"ai"` and `"@ai-sdk/openai-compatible"` from `dependencies` (already done in Stage 2 if these were direct deps — they were only at the root + node-host level, not in workbench directly).

**3.2** Delete `packages/node-host/src/agent/workbench-agent-model.ts` entirely — the model port is now replaced by pi-agent-core's own provider abstraction.

**3.3** Rewrite `packages/workbench/src/host/agent/run-service.ts`:
- Keep the outer shell: `WorkbenchAgentRunService` interface, `createWorkbenchAgentRunService`, `AgentChatServiceError`, `AgentRunFailureCode`, the enqueue/store-first/SSE/cancel/retry contract.
- Replace the inner `runLoop` (lines ~272-540) with a pi-agent-core `Agent` instance.
- The bridge:
  - **Tools**: `executor.listTools(PROJECT_ACCESS_ROLE_GRANTS[principal.role].scopes)` → mapped to `AgentTool[]` with `Type.Unsafe(spec.inputSchema)` for `parameters`, `execute` delegates to `executor.callTool(name, callerOrRole, args)`.
  - **Principal**: `ProjectToolExecutorPrincipal {userId, role, capabilityVersion, expiresAt, sessionId?}` → passed through `beforeToolCall` for scope gating.
  - **Completion gate**: after each turn, if `options.isWorkflowComplete()` → return `terminate: true` from `afterToolCall` or `shouldStopAfterTurn`.
  - **Bounds**: `maxTurns` → pi-agent-core's own turn limit; `maxToolCalls` → enforced in `beforeToolCall` via a counter.
  - **Cancellation**: pi-agent-core's `Agent` accepts an `AbortSignal`; the run service passes `ctx.signal` through.
  - **SSE publishing**: pi-agent-core's `agent.subscribe(callback)` maps events to `AgentChatProgressEventV1` and publishes through the existing progress subscriber mechanism (store-first invariant preserved).
  - **Transcript**: pi-agent-core's `agent.state.messages` provides the durable `AgentMessage[]` transcript; store it in `agent_conversation_messages` after each turn.

```typescript
// pseudocode for the new runLoop internals
const piAgent = new Agent({
  initialState: {
    systemPrompt: systemPromptFor(principal, tools),
    model: piModelFor(profileConfig, credentialKey),
    thinkingLevel: 'off',
    tools: piTools,
    messages: [],
  },
  streamFn: models.streamSimple.bind(models), // from pi-ai
  toolExecution: 'parallel',
  beforeToolCall: async ({ toolCall, args }) => {
    // scope gate: executor.callerForRole(principal)
    // tool-call budget check
    // if blocked: return { block: true, reason: '...', terminate: false }
    const known = tools.get(toolCall.name);
    if (!known) return { block: true, reason: 'TOOL_NOT_IN_CATALOG', terminate: false };
    if (toolCallsSoFar >= maxToolCalls) return { block: true, reason: 'MAX_TOOL_CALLS_EXCEEDED', terminate: true };
    return undefined; // allow
  },
  afterToolCall: async ({ toolCall, result, isError }) => {
    if (isWorkflowComplete) return { terminate: true };
    return undefined;
  },
});
```

**3.4** Update `packages/workbench/src/host/workbench-launch.ts`:
- Delete `createWorkbenchAgentModelAdapter` import (from `@novalistically/node-host`).
- Delete `WorkbenchAgentModelPort` import.
- Delete `agentModel` injection point on `WorkbenchLaunchConfig` (the `agentModel?: WorkbenchAgentModelPort` field and its wiring).
- Replace with pi-agent-core model construction: use `createProvider()` + model from pi-ai directly in the run-service factory.
- The `supportsToolCalls` gate is always true with pi-ai (all models in its catalog support tool calling per its README).

**3.5** Delete `WorkbenchAgentModelPort`, `WorkbenchAgentModelRunRequest`, `AgentModelEvent`, `AgentModelMessage`, `AgentToolSpec` types from `packages/node-host/src/agent/workbench-agent-model.ts` — these were only consumed by `run-service.ts` and now replaced by pi-agent-core's `AgentTool`, `AgentMessage`, etc.

**3.6** Update `packages/node-host/src/index.ts`:
- Delete `createWorkbenchAgentModelAdapter`, `WorkbenchAgentModelPort`, `AgentModelEvent`, `AgentModelMessage`, `AgentToolSpec` exports.

**3.7** Update smoke script `packages/workbench/scripts/smoke-agent-live.mjs`:
- Delete `createWorkbenchAgentModelAdapter` import and usage.
- Wire pi-agent-core directly inside the in-process Host.

**3.8** Update tests:
- `packages/workbench/tests/agent-parity-matrix.test.ts`: update the agent construction to use pi-agent-core.
- `packages/workbench/tests/run-service.test.ts`: the run-service interface is unchanged; update test setup to inject pi-agent-core.
- `packages/node-host/tests/agent-model.test.ts`: delete (model adapter no longer exists).

**3.9** Delete all generated bundle dirs under `packages/workbench/` that reference the old agent model — they will be regenerated on build.

### Stage 4 — Render sampling configuration

Depends on Stage 1 (needs the canonical `WorkbenchConfigurationV1` type). Independent of Stages 2-3.

**4.1** Add `renderPolicy` to `WorkbenchConfigurationV1` in `packages/workbench-protocol/src/configuration.ts`:

```typescript
export const DEFAULT_RENDER_POLICY = {
  pass1: { temperature: 0.8, maxTokens: 10_000 },
  pass2: { temperature: 0.3, maxTokens: 12_000, seed: 42 },
} as const;

export interface WorkbenchRenderPolicyV1 {
  readonly pass1: { readonly temperature: number; readonly maxTokens: number };
  readonly pass2: { readonly temperature: number; readonly maxTokens: number; readonly seed: number };
}
```

Add `renderPolicy` field to `WorkbenchConfigurationV1`:

```typescript
readonly renderPolicy: WorkbenchRenderPolicyV1;
```

Add `DEFAULT_WORKBENCH_RENDER_POLICY` constant. The config file store validator accepts `renderPolicy` as a known key; `numberField` validates each sub-field.

**4.2** In `packages/core/src/types/editorial.ts`, add to `EditorialRuntime`:

```typescript
renderPolicy?: {
  readonly pass1Temperature: number;
  readonly pass1MaxTokens: number;
  readonly pass2Temperature: number;
  readonly pass2MaxTokens: number;
  readonly pass2Seed: number;
};
```

**4.3** In `packages/core/src/editorial/render-service.ts` `buildPipeline()`, read `renderPolicy` from `runtime` (or `request`) and pass through to `RenderPipelineOptions`:
- If `renderPolicy` is set, override the hardcoded `PASS2_SAMPLING_CONFIG` values (`temperature: 0.3`, `maxTokens: 12000`, `seed: 42`) and the Pass 1 defaults (`temperature: 0.8`, `maxTokens: 10000`).
- The pipeline already reads `maxTokens` from options (line 345); add `pass1MaxTokens`, `pass2Temperature`, `pass2MaxTokens`, `pass2Seed` to `RenderPipelineOptions` and store them as private fields.
- In `renderScene()` Pass 1 path: use `this.renderPolicy.pass1Temperature ?? 0.8`, `this.renderPolicy.pass1MaxTokens ?? this.maxTokens`.
- In Pass 2 path: use `this.renderPolicy.pass2Temperature ?? PASS2_SAMPLING_CONFIG.temperature`, etc.

**4.4** In `packages/workbench/src/host/workbench-launch.ts` project session construction, read `renderPolicy` from the active configuration and inject it into the `EditorialRuntime` when creating render pipelines.

### Stage 5 — CLI rename: nova → fabula

Independent of all other stages. Can run in parallel.

**5.1** In `packages/cli/package.json`: `"nova": "./dist/index.js"` → `"fabula": "./dist/index.js"`.

**5.2** In `packages/cli/src/index.ts`:
- `program.name('nova')` → `program.name('fabula')`.
- All `'nova source'`, `'nova operation'`, `'nova authoring'`, `'nova review'`, `'nova gate'` inline strings → `'fabula source'`, etc. (search for `"nova ` — ~10 occurrences).
- `'Next step: run "nova source submit"'` → `'Next step: run "fabula source submit"'` (and all similar user-facing guidance).
- `'Not in a Novalistically project directory (missing nova.yaml).'` → `'Not in a Fabula project directory (missing nova.yaml).'`.
- `'Novalistically Node Host CLI'` → `'Fabula CLI'`.

**5.3** In `public-api.manifest.json`: `"nova": "packages/cli/dist/index.js"` → `"fabula": "packages/cli/dist/index.js"`.

**5.4** In `scripts/bundle-check.mjs`: the `--help` path test uses the dist path, which is unchanged; no edit needed.

**5.5** In `packages/cli/tests/bundle-boundary.test.ts`: the `--help` test text may contain `nova` → update expectation to `fabula`.

**5.6** In `packages/cli/tests/host-boundary.test.ts`: any `nova` strings in stdout assertions → `fabula`.

**5.7** In `packages/cli/tests/workbench-commands.test.ts`: all `nova_*` tool names are UNCHANGED (they are the wire contract); only `nova source`, `nova operation`, etc. in user-facing guidance strings → `fabula`.

**5.8** In `packages/core/tests/public-contract.test.ts`: the test at line 64 expects `AiSdkProvider` in the export list — this name changes to `PiOpenAICompatibleProvider` (already handled in Stage 2). The CLI bin entry in `public-api.manifest.json` check updates to `fabula`.

**5.9** Regenerate `package-lock.json` (`npm install` picks up the bin rename).

### Stage 6 — Product entry: npm start + browser open

Depends on Stage 1 (config contract settled). Independent of Stages 2-5.

**6.1** Add `open@11.0.0` as a devDependency to the root `package.json`.

**6.2** Add root `package.json` scripts:

```json
"start": "npm run -w @novalistically/workbench build:host && node packages/workbench/scripts/start.mjs workbench",
"start:dev": "npm run -w @novalistically/workbench dev"
```

**6.3** Modify `packages/workbench/scripts/start.mjs`:
- After spawning the child process with `WORKBENCH_CONTROL_FD3`, add a control-frame parser on fd3 (if inherited) that extracts the `ready` frame's `endpoint` field.
- Echo the resolved URL to stdout: `console.log(\`Fabula Workbench: \${endpoint}\`)`.
- On darwin, auto-open the browser: `if (process.platform === 'darwin') spawn('open', [endpoint])`.
- `WORKBENCH_ASSETS_ROOT` defaults to `packages/workbench/dist/client` when not set explicitly.
- Filter child environment to only pass through known `WORKBENCH_*` variables (avoid leaking `NOVALISTICALLY_AI_API_KEY` into the child env — the Host reads credentials from the store).

**6.4** Add `start.mjs` environment filtering:
```javascript
const KNOWN_WORKBENCH_ENV = /^WORKBENCH_|^NODE_|^PATH$|^HOME$|^USER$|^TMPDIR$|^XDG_|^LANG$|^LC_/;
const childEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (KNOWN_WORKBENCH_ENV.test(key)) childEnv[key] = value;
}
childEnv.WORKBENCH_MODE = mode;
childEnv.WORKBENCH_DEV = 'false';
```

**6.5** Update `index.html` title: `Fabula Workbench` → keep, it's already set.

### Stage 7 — UI polish: conversation list, prose rendering, artifact links

Depends on Stage 3 (needs the pi-agent-core event types settled). Can run in parallel with Stage 4.

**7.1** Add `solid-markdown@2.1.1` to `packages/workbench/package.json` `dependencies`.

**7.2** Rewrite `packages/workbench/src/client/AgentChat.tsx`:
- Add a conversation list panel (left sidebar or top dropdown) showing `conversations: AgentChatConversationViewV1[]` loaded from the Host.
- Allow creating new conversations.
- Render assistant prose via `<SolidMarkdown>` component instead of plain text.
- Show per-run tool-call receipts in a collapsible section below each assistant message.
- Add artifact-target links: when a tool-call result references a published artifact (publication, scene revision, authoring revision), render it as a clickable link that navigates to the artifact view.

**7.3** Update `packages/workbench/src/client/agent-chat-client.ts`:
- Add `listConversations(projectId: string): Promise<readonly AgentChatConversationViewV1[]>` method.
- Add `getConversation(projectId: string, conversationId: string): Promise<AgentChatConversationViewV1>` method.

**7.4** Add server-side routes in `packages/workbench/src/host/browser-agent-chat-api.ts`:
- `GET /api/v1/projects/:projectId/agent/conversations` → list conversations for the principal.
- Wire to `AgentStore.listConversations`.

**7.5** Delete `packages/workbench/src/client/scene-canvas.tsx` — it is a 2.1KB stub showing an adoption notice only (no functional surface).

**7.6** Update `packages/workbench/src/client/App.tsx`:
- Remove `scene-canvas` from `WORKBENCH_VIEW_CATALOG` and `DEFAULT_VIEW_ORDER`.
- Remove the `scene-canvas` route in the workspace shell.
- Remove `SceneCanvas` import.

**7.7** Update `packages/workbench/src/client/preferences.ts`:
- Remove `'scene-canvas'` from the valid view id list.
- Remove `sceneCanvas`-related preferences if any.

**7.8** Update `packages/workbench/src/contracts/browser-api.ts`:
- Remove `'scene-canvas'` from `WorkbenchViewId`.

**7.9** Update `packages/workbench/src/host/workbench-launch.ts`:
- Remove `'scene-canvas'` from the feature-gated view list (line 1479).

**7.10** Delete the placeholder Inspector panel content in `App.tsx` — replace with a dynamic Inspector that shows selected entity/node details when `graph-route` is active and nothing otherwise.

### Stage 8 — Session persistence + transcript durability

Depends on Stage 3 (needs agent transcript messages). Independent of other UI stages.

**8.1** In `packages/workbench/src/persistence/schema.ts`, add migration step:

```typescript
{
  version: 4,
  description: 'Agent conversation messages and artifact targets',
  steps: [
    {
      kind: 'create-table',
      table: {
        name: 'agent_conversation_messages',
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'conversation_id', type: 'text' },
          { name: 'run_id', type: 'text' },
          { name: 'role', type: 'text' },           // 'user' | 'assistant' | 'tool_result'
          { name: 'content', type: 'text' },         // plain text or JSON-encoded content blocks
          { name: 'tool_call_id', type: 'text' },    // null for non-tool-result messages
          { name: 'tool_name', type: 'text' },
          { name: 'timestamp', type: 'integer' },
          { name: 'created_at', type: 'text' },
        ],
      },
    },
    {
      kind: 'create-index',
      name: 'agent_conversation_messages_conversation',
      table: 'agent_conversation_messages',
      columns: ['conversation_id', 'created_at'],
    },
  ],
},
{
  version: 5,
  description: 'Artifact target references for agent navigation',
  steps: [
    {
      kind: 'create-table',
      table: {
        name: 'artifact_targets',
        columns: [
          { name: 'conversation_id', type: 'text' },
          { name: 'run_id', type: 'text' },
          { name: 'call_index', type: 'integer' },
          { name: 'artifact_type', type: 'text' },  // 'publication' | 'scene' | 'revision'
          { name: 'artifact_id', type: 'text' },
          { name: 'label', type: 'text' },
        ],
        primaryKey: ['conversation_id', 'run_id', 'call_index', 'artifact_id'],
      },
    },
  ],
},
```

**8.2** In the run-service, after pi-agent-core completes a turn, persist the `agent.state.messages` diff to `agent_conversation_messages`.

**8.3** When `isWorkflowComplete()` returns true after a tool call → write an `artifact_targets` row with `artifact_type: 'publication'`, `artifact_id: publicationId`.

**8.4** Update `AgentChatClient` to load messages from the durable store when viewing conversation history.

**8.5** Sessions already persist to SQLite (`sessions` table via `AuthPersistence`) — no change needed. The `DEFAULT_SESSION_TTL_MS` is already set; session cookies survive Host restart because the store is durable.

### Stage 9 — SSE event renames

Depends on Stage 3 (event types). Must coordinate with Stage 7 (UI consumes events).

**9.1** In `packages/workbench/src/contracts/agent-chat.ts`:
- `AgentChatAssistantTextEventV1.type: 'assistant-text'` → `'assistant_delta'`
- `AgentChatToolCallEventV1.type: 'tool-call'` → `'tool_call_staged'`
- `AgentChatToolResultEventV1.type: 'tool-result'` → `'tool_call_completed'`

**9.2** In `packages/workbench/src/host/agent/run-service.ts`: update event emission strings to match the new contract names.

**9.3** In `packages/workbench/src/client/AgentChat.tsx`: update `handleProgressEvent` switch cases to match the new event type strings.

### Stage 10 — Defaults, cleanup, and security

**10.1** In `packages/workbench/src/host/providers/credential-store.ts`:
- Delete the legacy bare `ai-sdk` key fallback (`LEGACY_AI_SDK_CREDENTIAL_KEY`, `get` fallback path).
- Only `ai-sdk:<profileId>` keys are supported.

**10.2** In `packages/workbench/src/host/agent/run-service.ts`: change the agent system prompt to Chinese (replace the English prompt at lines ~170-190).

**10.3** Scrub `.env` (and `.env.example`) for any live `NOVALISTICALLY_AI_API_KEY` value.

**10.4** Update `docs/current-state.md`:
- Record the completed product convergence.
- Record `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as runtime dependencies.
- Record `open@11.0.0` and `solid-markdown@2.1.1` as new UI dependencies.
- Record the CLI rename.
- Record the `version: 1` config contract as the single source of truth.
- Record the `renderPolicy` config domain.

**10.5** Update `AGENTS.md`:
- Record that `nova.yaml` project files and `nova_*` MCP tool names are NOT renamed (provenance filenames and wire contracts).
- Add Gotcha: the agent system prompt is in Chinese.
- Add Gotcha: `createWorkbenchAgentModelAdapter` no longer exists; use pi-agent-core directly.

## Critical files & anchors

- `packages/workbench-protocol/src/configuration.ts` — the single `WorkbenchConfigurationV1` type definition; every consumer imports from here or `contracts/configuration.ts`
- `packages/workbench/src/host/configuration-file-store.ts` — sole reader/writer of `workbench.yaml`; validator dispatch and serialization cutover
- `packages/node-host/src/providers/pi-openai-compatible.ts` — new file; the replacement for `AiSdkProvider`
- `packages/workbench/src/host/agent/run-service.ts` — the outer shell of the agent loop; interior replaced with pi-agent-core
- `packages/workbench/src/client/AgentChat.tsx` — the agent chat UI surface; conversation list + markdown prose + artifact links

## Verification

**After Stage 1:**
```bash
npm run typecheck                # all six packages compile
npm test                         # vitest + workbench suites pass
node scripts/check-public-api.mjs # manifest matches source exports
```
Verify that `packages/workbench-protocol/tests/configuration.test.ts` canonical round-trip passes.

**After Stage 2:**
```bash
NOVALISTICALLY_AI_API_KEY=<real-key> npm run smoke:stage1:live  # benchmark smoke still works
```
Verify the `PiOpenAICompatibleProvider` constructs from environment variables and completes a sample request.

**After Stage 3:**
```bash
npm run smoke:workbench-agent:live  # agent smoke with pi-agent-core
```
Verify that tool-call receipts and final publication match expectations.

**After Stage 5:**
```bash
npm run build
node packages/cli/dist/index.js --help  # shows 'fabula'
```

**After Stage 6:**
```bash
npm start   # builds host, starts Host, echoes URL, opens browser on darwin
```
Manual: browser loads the setup wizard on an unconfigured Host. Complete setup (owner, project, provider, network), finish, then login. Verify agent-chat appears when `agent.enabled` is true and a credential is configured.

**After Stage 7-8:**
Manual: create a conversation, send a message, verify the agent streams prose via markdown rendering. Verify conversation list shows past conversations. Verify tool-call receipts link to artifacts.

**End-to-end:**
```bash
npm start                          # from monorepo root
# Browser: complete setup wizard
# Browser: open agent chat → render a scene → publish
# Verify publication artifact appears and is readable
```

## Assumptions & contingencies

- **pi-ai v0.84.0 ships with `openai-completions` API support for the models we use (deepseek-v4-flash-free)** — verified from pi-ai README that it supports DeepSeek provider and OpenAI-compatible fallback. If the specific model id is not in pi-ai's built-in catalog, use `createProvider()` with a custom model definition (as shown in Stage 2.3).
- **pi-agent-core v0.84.0 `Agent` class supports the `beforeToolCall`/`afterToolCall`/`shouldStopAfterTurn` hooks** — verified from pi-agent-core README (lines ~213-299 show these options). If the Agent API has drifted, use the `agentLoop()` low-level function instead, which provides the same hooks.
- **`open@11.0.0` is acceptable as a new root devDependency** — if not, remove the auto-open feature and only echo the URL to stdout.
- **Chinese system prompt**: replace the English prompt in `run-service.ts` lines ~170-190. If the user prefers English, skip Step 10.2.
