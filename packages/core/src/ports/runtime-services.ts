import type { LLMProvider } from '../ai/types.ts';
import type { CoreExecutionRepository } from './execution-repository.ts';
import type { RenderCacheRepository } from './render-cache-repository.ts';
import type { StateLogRepository, StateSnapshotRepository } from './state-repository.ts';

export interface PromptTemplate {
  readonly name: string;
  readonly version: string;
  readonly template: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PromptTemplateCatalog {
  get(input: { readonly name: string; readonly version?: string }): Promise<PromptTemplate | null>;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(input?: { readonly kind?: string }): string;
}

export interface CoreRuntimeServices {
  readonly execution: CoreExecutionRepository;
  readonly renderCache: RenderCacheRepository;
  readonly stateLog: StateLogRepository;
  readonly stateSnapshots: StateSnapshotRepository;
  readonly promptTemplates: PromptTemplateCatalog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly llm: LLMProvider;
}
