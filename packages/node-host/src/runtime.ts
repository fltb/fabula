import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type {
  Clock,
  CoreRuntimeServices,
  IdGenerator,
  LLMProvider,
  PromptTemplate,
  PromptTemplateCatalog,
} from '@novalistically/core';
import { FileRenderCacheRepository } from './cache/file-render-cache-repository.js';
import { FileExecutionRepository } from './execution/file-execution-repository.js';
import {
  FileStateLogRepository,
  FileStateSnapshotRepository,
} from './state/file-state-repositories.js';

/** Node-owned composition of Core's semantic runtime ports for one project. */
export interface FileCoreRuntimeOptions {
  readonly provider: LLMProvider;
  readonly promptTemplates?: readonly PromptTemplate[];
  readonly now?: () => string;
  readonly nextId?: (kind?: string) => string;
  /**
   * Explicit Workbench-owned artifact root. Standalone callers omit this and
   * retain the project-local `.nova` defaults.
   */
  readonly artifactRoot?: string;
}

class StaticPromptTemplateCatalog implements PromptTemplateCatalog {
  readonly #templates: readonly PromptTemplate[];

  constructor(templates: readonly PromptTemplate[]) {
    this.#templates = templates.map((template) => ({
      ...template,
      metadata: template.metadata ? { ...template.metadata } : undefined,
    }));
  }

  async get(input: {
    readonly name: string;
    readonly version?: string;
  }): Promise<PromptTemplate | null> {
    const template = this.#templates.find(
      (candidate) =>
        candidate.name === input.name &&
        (input.version === undefined || candidate.version === input.version),
    );
    return template
      ? {
          ...template,
          metadata: template.metadata ? { ...template.metadata } : undefined,
        }
      : null;
  }
}

class HostClock implements Clock {
  constructor(private readonly readNow: () => string) {}

  now(): string {
    return this.readNow();
  }
}

class HostIdGenerator implements IdGenerator {
  constructor(private readonly nextId: (kind?: string) => string) {}

  next(input?: { readonly kind?: string }): string {
    return this.nextId(input?.kind);
  }
}

/**
 * Composes project-private file repositories without leaking their paths into
 * Core. Callers provide the provider explicitly; this factory never reads
 * credentials or environment variables.
 */
export function createFileCoreRuntimeServices(
  projectRoot: string,
  options: FileCoreRuntimeOptions,
): CoreRuntimeServices {
  const artifactRoot = options.artifactRoot
    ? path.resolve(options.artifactRoot)
    : undefined;
  const repositoryRoot = artifactRoot ?? projectRoot;
  return {
    execution: new FileExecutionRepository(
      repositoryRoot,
      artifactRoot ? 'execution' : undefined,
    ),
    renderCache: new FileRenderCacheRepository(repositoryRoot, {
      relativeDirectory: artifactRoot ? 'render-cache' : undefined,
    }),
    stateLog: new FileStateLogRepository(
      repositoryRoot,
      artifactRoot ? 'state-log' : undefined,
    ),
    stateSnapshots: new FileStateSnapshotRepository(
      repositoryRoot,
      artifactRoot ? 'state-snapshots' : undefined,
    ),
    promptTemplates: new StaticPromptTemplateCatalog(options.promptTemplates ?? []),
    clock: new HostClock(options.now ?? (() => new Date().toISOString())),
    ids: new HostIdGenerator(options.nextId ?? ((kind) => `${kind ?? 'id'}_${randomUUID()}`)),
    llm: options.provider,
  };
}
