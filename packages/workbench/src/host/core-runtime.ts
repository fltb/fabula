/**
 * Per-session Core runtime composition.
 *
 * The Core semantic runtime services are injected exactly once per project
 * session and shared by every consumer (HTTP, MCP, Yjs, internal Agents);
 * nothing is rebuilt per request. Deterministic compile results are memoized
 * by the immutable snapshot `sourceHash` so repeated reads over the same
 * accepted source never recompile, and the memo is bounded so a long-lived
 * session cannot grow without limit.
 *
 * This module holds no filesystem, Git, provider-credential, or database
 * handle of its own; the injected ports are the only I/O surface, and they
 * never cross the browser contract boundary.
 */

import {
  type CompileProjectOptions,
  type CoreRuntimeServices,
  compileProject,
  type PluginHooksManager,
  type ProjectCompilation,
  type ProjectSourceSnapshotV1,
} from '@novalistically/core';

/** Default bound on the per-session compile memo; oldest entries evict first. */
export const MAX_MEMOIZED_SNAPSHOTS = 8;

export interface ProjectCoreRuntimeOptions {
  readonly projectId: string;
  /**
   * Injected Core semantic ports (execution, render cache, state log /
   * snapshots, prompt templates, clock, ids, LLM provider). Constructed once
   * per project session and shared; never rebuilt per request.
   */
  readonly services: CoreRuntimeServices;
  /**
   * Deterministic compile hook. Defaults to Core's pure `compileProject`.
   * The hook MUST be a pure function of the snapshot: the memo key is the
   * `sourceHash` only, so callers must treat `options` as constant per
   * session (the session itself never passes options).
   */
  readonly compile?: (
    snapshot: ProjectSourceSnapshotV1,
    options?: CompileProjectOptions,
  ) => ProjectCompilation;
  /** Maximum memoized snapshots; default {@link MAX_MEMOIZED_SNAPSHOTS}. */
  readonly maxMemoizedSnapshots?: number;
  /**
   * Optional active plugin hooks manager (trusted node plugins). When
   * present, plugin identities feed validationIdentity/planHash/render cache
   * keys, plugin validators join the pipeline validator set and observation
   * hooks run around scenes — the same contract `EditorialRuntime` exposes.
   */
  readonly pluginHooksManager?: PluginHooksManager;
}

export interface ProjectCoreRuntime {
  readonly projectId: string;
  /** The injected Core semantic ports; shared by every session consumer. */
  readonly services: CoreRuntimeServices;
  /**
   * The active plugin hooks manager, when plugins are enabled and trusted
   * for this project. Render consumers read it from the runtime the same
   * way they read `EditorialRuntime.pluginHooksManager`.
   */
  readonly pluginHooksManager?: PluginHooksManager;
  /**
   * Memoized deterministic compile of a snapshot. A snapshot identity
   * (sourceHash) compiles at most once; a compile that throws is never
   * memoized. Options MUST be constant per session: the memo key is the
   * sourceHash only, so route-varying compiles belong on
   * {@link compileDetached}.
   */
  compile(snapshot: ProjectSourceSnapshotV1, options?: CompileProjectOptions): ProjectCompilation;
  /**
   * Deterministic compile that bypasses the sourceHash memo. Route-specific
   * compiles (per-source/route derived streams, plan 8.1) must use this so
   * they can never collide with the session's no-options memo entry.
   */
  compileDetached(
    snapshot: ProjectSourceSnapshotV1,
    options?: CompileProjectOptions,
  ): ProjectCompilation;
  /** True when this exact snapshot identity is already compiled here. */
  has(sourceHash: string): boolean;
  /** Source hashes currently held in the memo, most-recently-used first. */
  readonly memoizedHashes: readonly string[];
  readonly memoSize: number;
}

const REQUIRED_PORTS: readonly (keyof CoreRuntimeServices)[] = [
  'execution',
  'renderCache',
  'stateLog',
  'stateSnapshots',
  'promptTemplates',
  'clock',
  'ids',
  'llm',
];

/**
 * Compose the shared Core runtime for one project session. Fails closed on a
 * missing port or an empty project id: an incomplete runtime must never reach
 * a session where effects assume it is complete.
 */
export function createProjectCoreRuntime(options: ProjectCoreRuntimeOptions): ProjectCoreRuntime {
  const { projectId, services } = options;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError('ProjectCoreRuntime requires a non-empty projectId');
  }
  if (services === null || typeof services !== 'object') {
    throw new TypeError('ProjectCoreRuntime requires injected CoreRuntimeServices');
  }
  for (const port of REQUIRED_PORTS) {
    if (services[port] === undefined) {
      throw new TypeError(`ProjectCoreRuntime requires injected services.${port}`);
    }
  }

  const compile = options.compile ?? compileProject;
  const maxMemoized = Math.max(
    1,
    Math.floor(options.maxMemoizedSnapshots ?? MAX_MEMOIZED_SNAPSHOTS),
  );
  const memo = new Map<string, ProjectCompilation>();

  return {
    projectId,
    services,
    ...(options.pluginHooksManager === undefined
      ? {}
      : { pluginHooksManager: options.pluginHooksManager }),
    compile(snapshot, compileOptions) {
      const hash = snapshot.sourceHash;
      const existing = memo.get(hash);
      if (existing !== undefined) return existing;
      const compiled = compile(snapshot, compileOptions);
      memo.delete(hash); // refresh recency
      memo.set(hash, compiled);
      while (memo.size > maxMemoized) {
        const oldest = memo.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        memo.delete(oldest);
      }
      return compiled;
    },
    compileDetached(snapshot, compileOptions) {
      return compile(snapshot, compileOptions);
    },
    has(hash) {
      return memo.has(hash);
    },
    get memoizedHashes() {
      return [...memo.keys()];
    },
    get memoSize() {
      return memo.size;
    },
  };
}
