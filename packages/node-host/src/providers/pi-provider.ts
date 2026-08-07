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
  const provider = createProvider<Api>({
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
