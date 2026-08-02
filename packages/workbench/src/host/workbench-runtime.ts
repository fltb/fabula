/**
 * Host-only project runtime registry: opens and closes `ProjectSession`s from
 * the validated configuration, replacing the launch-time fixed single-project
 * closure. The runtime owns only the open/close lifecycle and busy checks; it
 * never constructs Core runtimes or capabilities itself — a `createSession`
 * factory is injected so the integration owner composes the real
 * ProjectSession construction. Safe DTOs (project id, open flag) are the only
 * surface that crosses out of this module.
 */

import type { WorkbenchProjectConfigurationV1 } from '../contracts/configuration.js';
import type { ProjectSession, ProjectSessionRegistry } from './project-session.js';
import { createProjectSessionRegistry } from './project-session.js';

/** Narrow consumer port used by the owner admin surface. */
export interface RuntimeAdminPort {
  isOpen(projectId: string): boolean;
  listOpen(): readonly { readonly projectId: string }[];
  open(project: WorkbenchProjectConfigurationV1): { readonly projectId: string };
  close(projectId: string): Promise<boolean>;
}

export interface WorkbenchRuntimeOptions {
  /** Session registry; defaults to a fresh singleton-per-project registry. */
  readonly registry?: ProjectSessionRegistry;
  /** Constructs the real session for one registered project (integration owner). */
  readonly createSession: (project: WorkbenchProjectConfigurationV1) => ProjectSession;
  /** Optional close hook (e.g. MCP/Yjs teardown); runs before registry removal. */
  readonly closeSession?: (session: ProjectSession) => void | Promise<void>;
}

export interface WorkbenchRuntimeSyncResult {
  readonly opened: readonly string[];
  readonly closed: readonly string[];
  /** Projects the configuration removed but the runtime refused to close (busy). */
  readonly busy: readonly string[];
}

export class WorkbenchRuntimeBusyError extends Error {
  override readonly name = 'WorkbenchRuntimeBusyError';
  readonly code = 'PROJECT_BUSY';
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project "${projectId}" is busy and cannot be closed.`);
    this.projectId = projectId;
  }
}

export class WorkbenchRuntimeUnknownProjectError extends Error {
  override readonly name = 'WorkbenchRuntimeUnknownProjectError';
  readonly code = 'PROJECT_NOT_FOUND';
  readonly projectId: string;

  constructor(projectId: string) {
    super(`No configuration project "${projectId}" is open.`);
    this.projectId = projectId;
  }
}

/**
 * Open/close lifecycle over one {@link ProjectSessionRegistry}. A session is
 * keyed by project id (registry singleton); `close()` refuses busy sessions
 * and returns false when nothing was open. `sync()` reconciles the open set
 * with a validated configuration: newly registered projects open, removed
 * projects close unless busy.
 */
export class WorkbenchRuntime implements RuntimeAdminPort {
  readonly #registry: ProjectSessionRegistry;
  readonly #createSession: (project: WorkbenchProjectConfigurationV1) => ProjectSession;
  readonly #closeSession: ((session: ProjectSession) => void | Promise<void>) | undefined;

  constructor(options: WorkbenchRuntimeOptions) {
    if (typeof options.createSession !== 'function') {
      throw new TypeError('WorkbenchRuntime requires an injected createSession factory');
    }
    this.#registry = options.registry ?? createProjectSessionRegistry();
    this.#createSession = options.createSession;
    this.#closeSession = options.closeSession;
  }

  get registry(): ProjectSessionRegistry {
    return this.#registry;
  }

  get size(): number {
    return this.#registry.size;
  }

  get(projectId: string): ProjectSession | null {
    return this.#registry.get(projectId);
  }

  isOpen(projectId: string): boolean {
    return this.#registry.get(projectId) !== null;
  }

  listOpen(): readonly ProjectSession[] {
    return this.#registry.list();
  }

  /** Open (or return the existing) session for one registered project. */
  open(project: WorkbenchProjectConfigurationV1): ProjectSession {
    const existing = this.#registry.get(project.projectId);
    if (existing !== null) return existing;
    return this.#registry.register(this.#createSession(project));
  }

  /**
   * Close a project's session. Refuses (throws {@link WorkbenchRuntimeBusyError})
   * while the session has in-flight operations; returns false when the project
   * was not open.
   */
  async close(projectId: string): Promise<boolean> {
    const session = this.#registry.get(projectId);
    if (session === null) return false;
    if (session.busy) throw new WorkbenchRuntimeBusyError(projectId);
    if (this.#closeSession !== undefined) await this.#closeSession(session);
    return this.#registry.remove(projectId);
  }

  /** Close every open session; busy sessions are skipped and reported. */
  async closeAll(): Promise<readonly string[]> {
    const busy: string[] = [];
    for (const session of this.#registry.list()) {
      try {
        await this.close(session.projectId);
      } catch (error) {
        if (error instanceof WorkbenchRuntimeBusyError) busy.push(error.projectId);
        else throw error;
      }
    }
    return busy;
  }

  /**
   * Reconcile the open set with a validated configuration. Returns the opened
   * and closed project ids plus the ids that stayed open because they are
   * busy. Throws when a configured project cannot be opened.
   */
  async sync(
    projects: readonly WorkbenchProjectConfigurationV1[],
  ): Promise<WorkbenchRuntimeSyncResult> {
    const configured = new Set(projects.map((project) => project.projectId));
    const opened: string[] = [];
    const closed: string[] = [];
    const busy: string[] = [];
    for (const session of this.#registry.list()) {
      if (configured.has(session.projectId)) continue;
      try {
        if (await this.close(session.projectId)) closed.push(session.projectId);
      } catch (error) {
        if (error instanceof WorkbenchRuntimeBusyError) busy.push(error.projectId);
        else throw error;
      }
    }
    for (const project of projects) {
      if (this.#registry.get(project.projectId) === null) {
        this.#registry.register(this.#createSession(project));
        opened.push(project.projectId);
      }
    }
    return { opened, closed, busy };
  }
}

/** Create a fresh project runtime over the injected session factory. */
export function createWorkbenchRuntime(options: WorkbenchRuntimeOptions): WorkbenchRuntime {
  return new WorkbenchRuntime(options);
}
