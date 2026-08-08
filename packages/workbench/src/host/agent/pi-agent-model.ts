import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
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
